import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getAddress, numberToHex, type Address, type Hex } from 'viem';
import type { ChainClient } from '../src/client/chain-client.ts';
import type { DexConnector, PoolState, SwapLog } from '../src/dex/types.ts';
import { ReadError } from '../src/errors.ts';
import { silentLogger } from '../src/logger.ts';
import { PoolTradeFeed } from '../src/market/trade-feed.ts';
import type { TradeFeedOptions } from '../src/market/types.ts';

const TOKEN: Address = '0x00000000000000000000000000000000000000Aa';
const QUOTE: Address = '0x00000000000000000000000000000000000000Bb';
const OURS: Address = '0x00000000000000000000000000000000000000C1';
const THEM: Address = '0x00000000000000000000000000000000000000D2';
const ROUTER: Address = '0x00000000000000000000000000000000000000E3';

const pool: PoolState = {
  dex: 'test',
  kind: 'v2',
  id: '0x00000000000000000000000000000000000000F4',
  address: '0x00000000000000000000000000000000000000F4',
  token0: TOKEN,
  token1: QUOTE,
  decimals0: 18,
  decimals1: 18,
  feeBps: 30,
  reserve0: 0n,
  reserve1: 0n,
  price0In1: 1,
  fetchedAt: 0,
};

const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;

/** A sell of `tokens` into the pool for `quote` out, as the pool records it (token is token0). */
function sell(n: number, block: number, tokens: bigint, quote: bigint): SwapLog {
  return { txHash: hash(n), logIndex: 0, blockNumber: BigInt(block), sender: ROUTER, recipient: ROUTER, amount0In: tokens, amount1In: 0n, amount0Out: 0n, amount1Out: quote };
}

interface Rig {
  feed: PoolTradeFeed;
  requests: Array<{ fromBlock: Hex; toBlock: Hex }>;
  swaps: SwapLog[];
  senders: Map<Hex, Address>;
  state: { head: number; failLogs: boolean };
}

function rig(options: Partial<TradeFeedOptions> = {}, maxLogRange = 100): Rig {
  const requests: Rig['requests'] = [];
  const swaps: SwapLog[] = [];
  const senders = new Map<Hex, Address>();
  const state = { head: 20, failLogs: false };
  const client = {
    logger: silentLogger,
    blockNumber: async () => state.head,
    publicClient: {
      request: async ({ params }: { params: [{ fromBlock: Hex; toBlock: Hex }] }) => {
        if (state.failLogs) throw new Error('rate limited');
        requests.push({ fromBlock: params[0].fromBlock, toBlock: params[0].toBlock });
        return [];
      },
      getTransaction: async ({ hash: h }: { hash: Hex }) => {
        const from = senders.get(h);
        if (!from) throw new Error('not found');
        return { from };
      },
      getBlock: async () => ({ timestamp: 1_700_000_000n }),
    },
  } as unknown as ChainClient;
  const connector = {
    swapLogFilter: () => ({ address: pool.address, topics: [] }),
    // Scripted: every swap whose block is inside the requested window.
    parseSwapLogs: () => {
      const last = requests[requests.length - 1]!;
      return swaps.filter((s) => s.blockNumber >= BigInt(last.fromBlock) && s.blockNumber <= BigInt(last.toBlock));
    },
  } as unknown as DexConnector;
  const feed = new PoolTradeFeed(
    { client, connector, pool, token: { address: TOKEN, symbol: 'TKN', decimals: 18 }, maxLogRange },
    { side: 'sell', exclude: [OURS], fromBlock: 10, ...options },
  );
  return { feed, requests, swaps, senders, state };
}

describe('PoolTradeFeed', () => {
  it('reports outside sells with the transaction sender as trader, and excludes our own', async () => {
    const r = rig();
    r.swaps.push(sell(1, 11, 5n * 10n ** 18n, 2n * 10n ** 18n), sell(2, 12, 10n ** 18n, 10n ** 18n));
    r.senders.set(hash(1), THEM).set(hash(2), OURS);
    const trades = await r.feed.poll();
    assert.equal(trades.length, 1);
    assert.deepEqual({ trader: trades[0]!.trader, quote: trades[0]!.quoteAmount, tokens: trades[0]!.tokenAmount }, { trader: getAddress(THEM), quote: 2, tokens: 5 });
  });

  it('never reports a swap in the opposite direction', async () => {
    const r = rig({ side: 'buy' });
    r.swaps.push(sell(1, 11, 10n ** 18n, 10n ** 18n));
    r.senders.set(hash(1), THEM);
    assert.equal((await r.feed.poll()).length, 0);
  });

  it('applies minQuote', async () => {
    const r = rig({ minQuote: 1.5 });
    r.swaps.push(sell(1, 11, 10n ** 18n, 10n ** 18n), sell(2, 12, 10n ** 18n, 2n * 10n ** 18n));
    r.senders.set(hash(1), THEM).set(hash(2), THEM);
    assert.deepEqual((await r.feed.poll()).map((t) => t.quoteAmount), [2]);
  });

  it('advances its cursor past what it read and bounds each scan', async () => {
    const r = rig({}, 5);
    await r.feed.poll();
    await r.feed.poll();
    assert.deepEqual(r.requests, [
      { fromBlock: numberToHex(10), toBlock: numberToHex(14) },
      { fromBlock: numberToHex(15), toBlock: numberToHex(19) },
    ]);
  });

  it('delivers at most maxResults, oldest first, and the rest on the next poll without loss', async () => {
    const r = rig({ maxResults: 2 });
    for (const [n, block] of [[1, 11], [2, 12], [3, 13]] as const) {
      r.swaps.push(sell(n, block, 10n ** 18n, 10n ** 18n));
      r.senders.set(hash(n), THEM);
    }
    assert.deepEqual((await r.feed.poll()).map((t) => t.block), [11, 12]);
    assert.deepEqual((await r.feed.poll()).map((t) => t.block), [13]);
    assert.deepEqual(await r.feed.poll(), []);
  });

  it('does not move past a swap whose sender could not be resolved, and does not duplicate the rest', async () => {
    const r = rig();
    r.swaps.push(sell(1, 11, 10n ** 18n, 10n ** 18n), sell(2, 12, 10n ** 18n, 10n ** 18n));
    r.senders.set(hash(1), THEM);
    assert.deepEqual((await r.feed.poll()).map((t) => t.block), [11]);
    r.senders.set(hash(2), THEM);
    assert.deepEqual((await r.feed.poll()).map((t) => t.block), [12]);
  });

  it('throws ReadError when logs cannot be read, leaving the cursor where it was', async () => {
    const r = rig();
    r.state.failLogs = true;
    await assert.rejects(r.feed.poll(), ReadError);
    r.state.failLogs = false;
    await r.feed.poll();
    assert.equal(r.requests[0]!.fromBlock, numberToHex(10));
  });
});

/**
 * Other people's trades on one pool, in block order, each delivered once.
 *
 * The trader is the transaction sender, resolved per swap: the Swap event's own
 * `sender` is the router, which would make every trade look like the same
 * address and make "exclude our own wallets" impossible.
 *
 * All state — the block cursor and the de-duplication window — belongs to the
 * feed instance. Two strategies watching one pool each own a feed, so one can
 * never advance past blocks the other has not read.
 */

import { formatLog, numberToHex, type Address, type Hex, type Log } from 'viem';
import type { ChainClient } from '../client/chain-client.ts';
import type { DexConnector, PoolState, SwapLog } from '../dex/types.ts';
import { ConfigError, ReadError } from '../errors.ts';
import { inBatches } from '../internal/async.ts';
import { sameAddress } from '../internal/address.ts';
import { formatAmount } from '../units.ts';
import type { ExternalTrade, TokenInfo, TradeFeed, TradeFeedOptions } from './types.ts';

export interface TradeFeedDeps {
  readonly client: ChainClient;
  readonly connector: DexConnector;
  /** Static pool facts: identity, token ordering and decimals. */
  readonly pool: PoolState;
  readonly token: TokenInfo;
  readonly maxLogRange: number;
}

const CACHE_LIMIT = 5_000;

export class PoolTradeFeed implements TradeFeed {
  private readonly deps: TradeFeedDeps;
  private readonly options: TradeFeedOptions;
  private readonly excluded: ReadonlySet<string>;
  private cursor: bigint | undefined;
  /** Delivered or classified swaps, by `hash:logIndex`, with their block for pruning. */
  private readonly seen = new Map<string, bigint>();
  private readonly senders = new Map<Hex, Address>();
  private readonly blockTimes = new Map<bigint, number>();

  constructor(deps: TradeFeedDeps, options: TradeFeedOptions) {
    if (options.maxResults !== undefined && (!Number.isInteger(options.maxResults) || options.maxResults < 1)) {
      throw new ConfigError('maxResults must be a positive integer');
    }
    if (options.fromBlock !== undefined && (!Number.isInteger(options.fromBlock) || options.fromBlock < 0)) {
      throw new ConfigError('fromBlock must be a non-negative integer');
    }
    this.deps = deps;
    this.options = options;
    this.excluded = new Set(Array.from(options.exclude ?? [], (a) => a.toLowerCase()));
    if (options.fromBlock !== undefined) this.cursor = BigInt(options.fromBlock);
  }

  async poll(): Promise<ExternalTrade[]> {
    const { client, connector, pool, token } = this.deps;
    const side = this.options.side;
    const minQuote = this.options.minQuote ?? 0;

    const latest = BigInt(await client.blockNumber());
    const from = this.cursor ?? latest;
    if (from > latest) return [];
    const range = BigInt(this.deps.maxLogRange);
    const to = from + range - 1n < latest ? from + range - 1n : latest;

    const logs = await this.fetchLogs(from, to);
    const tokenIs0 = sameAddress(pool.token0, token.address);
    const quoteDecimals = tokenIs0 ? pool.decimals1 : pool.decimals0;

    // Both legs must be non-zero in the scanned direction; that is also what
    // keeps a swap from appearing in the opposite direction's feed.
    const candidates = connector
      .parseSwapLogs(pool, logs)
      .map((swap) => ({ swap, key: `${swap.txHash}:${swap.logIndex}`, ...legs(swap, side, tokenIs0) }))
      .filter((c) => c.tokenMoved > 0n && c.quoteMoved > 0n && !this.seen.has(c.key));

    // Sequential passes, not concurrent: the transport coalesces concurrent reads
    // into one JSON-RPC batch, and running both would double its size.
    await this.warmSenders(candidates.map((c) => c.swap.txHash));
    await this.warmBlockTimes(candidates.map((c) => c.swap.blockNumber));

    const trades: ExternalTrade[] = [];
    let earliestUnresolved: bigint | undefined;
    for (const c of candidates) {
      const trader = this.senders.get(c.swap.txHash);
      if (!trader) {
        // Not classified: the cursor must not move past it, or it is lost for good.
        if (earliestUnresolved === undefined || c.swap.blockNumber < earliestUnresolved) earliestUnresolved = c.swap.blockNumber;
        continue;
      }
      this.seen.set(c.key, c.swap.blockNumber);
      const ours = this.excluded.has(trader.toLowerCase()) || this.excluded.has(c.swap.recipient.toLowerCase());
      const quoteAmount = formatAmount(c.quoteMoved, quoteDecimals);
      if (ours || quoteAmount < minQuote) continue;
      trades.push({
        hash: c.swap.txHash,
        logIndex: c.swap.logIndex,
        block: Number(c.swap.blockNumber),
        timestamp: this.blockTimes.get(c.swap.blockNumber) ?? Math.floor(Date.now() / 1000),
        trader,
        side,
        quoteAmount,
        tokenAmount: formatAmount(c.tokenMoved, token.decimals),
      });
    }

    let next = to + 1n;
    let delivered = trades;
    const limit = this.options.maxResults;
    if (limit !== undefined && trades.length > limit) {
      // Keep the oldest `limit`, extended to a whole block, and rewind so the
      // rest arrive next poll. Their keys are forgotten so they are not filtered.
      const cut = BigInt((trades[limit - 1] as ExternalTrade).block);
      delivered = trades.filter((t) => BigInt(t.block) <= cut);
      for (const t of trades) if (BigInt(t.block) > cut) this.seen.delete(`${t.hash}:${t.logIndex}`);
      next = cut + 1n;
    }
    if (earliestUnresolved !== undefined && earliestUnresolved < next) next = earliestUnresolved;
    if (earliestUnresolved !== undefined) {
      client.logger.warn('Could not resolve the sender of some swaps; they will be retried', { pool: pool.id });
    }
    this.cursor = next;
    for (const [key, block] of this.seen) if (block < next) this.seen.delete(key);
    return delivered;
  }

  private async fetchLogs(from: bigint, to: bigint): Promise<Log[]> {
    const filter = this.deps.connector.swapLogFilter(this.deps.pool);
    try {
      const raw = await this.deps.client.publicClient.request({
        method: 'eth_getLogs',
        params: [{ address: filter.address, topics: [...filter.topics], fromBlock: numberToHex(from), toBlock: numberToHex(to) }],
      });
      return raw.map((entry) => formatLog(entry));
    } catch (error) {
      throw new ReadError(`Could not read swap logs for ${this.deps.pool.id}: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
  }

  private async warmSenders(hashes: readonly Hex[]): Promise<void> {
    const missing = Array.from(new Set(hashes.filter((h) => !this.senders.has(h))));
    if (missing.length === 0) return;
    const found = await inBatches(missing, async (hash) => (await this.deps.client.publicClient.getTransaction({ hash })).from);
    if (this.senders.size > CACHE_LIMIT) this.senders.clear();
    for (const [hash, from] of found) this.senders.set(hash, from);
  }

  private async warmBlockTimes(blocks: readonly bigint[]): Promise<void> {
    const missing = Array.from(new Set(blocks.filter((b) => !this.blockTimes.has(b))));
    if (missing.length === 0) return;
    const found = await inBatches(missing, async (blockNumber) =>
      Number((await this.deps.client.publicClient.getBlock({ blockNumber })).timestamp),
    );
    if (this.blockTimes.size > CACHE_LIMIT) this.blockTimes.clear();
    for (const [block, time] of found) this.blockTimes.set(block, time);
  }
}

/**
 * Token and quote amounts moved in the scanned direction, from the pool's view:
 * a buy takes tokens out and puts quote in; a sell does the reverse.
 */
export function legs(swap: SwapLog, side: 'buy' | 'sell', tokenIs0: boolean): { tokenMoved: bigint; quoteMoved: bigint } {
  if (side === 'buy') {
    return {
      tokenMoved: tokenIs0 ? swap.amount0Out : swap.amount1Out,
      quoteMoved: tokenIs0 ? swap.amount1In : swap.amount0In,
    };
  }
  return {
    tokenMoved: tokenIs0 ? swap.amount0In : swap.amount1In,
    quoteMoved: tokenIs0 ? swap.amount1Out : swap.amount0Out,
  };
}

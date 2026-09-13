/**
 * Read-only verification against live Robinhood Chain mainnet and testnet.
 *
 * Nothing is signed or sent: every client is `readOnly`. Swaps are proven by
 * `eth_call` with a state override that funds a throwaway address, and each
 * simulated swap demands at least 99% of the SDK's own quote — so a call that
 * succeeds proves the calldata is valid AND the quote was accurate to 1%.
 *
 *   node scripts/smoke.ts
 */

import { getAddress, parseEther, zeroAddress, type Address } from 'viem';
import {
  applySlippage,
  createMarketMaker,
  generateWallet,
  robinhood,
  robinhoodTestnet,
  type MarketMaker,
} from '../src/index.ts';

const USDG = getAddress('0x5fc5360d0400a0fd4f2af552add042d716f1d168');
const MAINNET = {
  v2: '0x8803c117ccae7B5146297876c2A25DF135141C4d',
  v3: '0x69BfaF19C9f377BB306a89aEd9F6B07e2c1a8d9a',
  v4Id: '0xd313d79d9d6a714e7bdf02fc42a2c27ede7e51928ffd605126fe9e1192630cf8',
  v4Key: { currency0: zeroAddress, currency1: USDG, fee: 3000, tickSpacing: 60, hooks: zeroAddress },
};
const TESTNET_V3 = '0x9640AFcBc2310d011B7b71a76975e919D9B6Fa4A';

const results: Array<{ name: string; ok: boolean; detail: string; ms: number }> = [];

async function check(name: string, fn: () => Promise<string>): Promise<void> {
  const started = Date.now();
  try {
    results.push({ name, ok: true, detail: await fn(), ms: Date.now() - started });
  } catch (error) {
    results.push({ name, ok: false, detail: error instanceof Error ? error.message.split('\n')[0]! : String(error), ms: Date.now() - started });
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Simulate a native-ETH buy of `ethIn` from a funded throwaway address; demand ≥99% of the quote. */
async function simulateNativeBuy(mm: MarketMaker, poolRef: string, ethIn: string): Promise<string> {
  const match = await mm.dexes.resolve(poolRef as Address);
  assert(match, 'pool did not resolve');
  const { connector, pool } = match;
  const weth = getAddress(mm.chain.wrappedNative);
  const quoteIn = pool.kind === 'v4' ? zeroAddress : weth;
  const tokenOut = pool.token0.toLowerCase() === quoteIn.toLowerCase() ? pool.token1 : pool.token0;
  const amountIn = parseEther(ethIn);
  const quote = await connector.quote(pool, { tokenIn: quoteIn, tokenOut, amountIn });
  assert(quote.amountOut > 0n, 'quote returned zero');

  const trader = generateWallet().wallet.address;
  const call = connector.buildSwap({
    pool,
    recipient: trader,
    tokenIn: quoteIn,
    tokenOut,
    amountIn,
    minAmountOut: applySlippage(quote.amountOut, 1),
    nativeIn: pool.kind !== 'v4',
    nativeOut: false,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
  });
  assert(call.value === amountIn && !call.approvalSpender, 'native buy should need no approval');
  await mm.client.publicClient.call({
    account: trader,
    to: call.to,
    data: call.data,
    value: call.value,
    stateOverride: [{ address: trader, balance: parseEther('10') }],
  });
  return `${pool.kind} swap of ${ethIn} ETH executes with minOut = 99% of quote (${quote.amountOut} raw out)`;
}

async function main(): Promise<void> {
  const main = createMarketMaker({ chain: robinhood, readOnly: true });
  const test = createMarketMaker({ chain: robinhoodTestnet, readOnly: true });

  const prices: Record<string, number> = {};
  for (const [label, ref] of [['V2', MAINNET.v2], ['V3', MAINNET.v3], ['V4 by PoolKey', MAINNET.v4Key], ['V4 by PoolId', MAINNET.v4Id]] as const) {
    await check(`mainnet ${label}: resolve, price, quote both sides`, async () => {
      const market = await main.market(ref, { quote: USDG });
      const price = await market.price();
      const buy = await market.quoteBuy('1');
      const sell = await market.quoteSell('0.0005');
      assert(price > 100 && price < 100_000, `implausible ETH price ${price}`);
      assert(buy.rejection === undefined && buy.amountOut > 0, `buy quote rejected: ${buy.rejection}`);
      assert(sell.rejection === undefined && sell.amountOut > 0, `sell quote rejected: ${sell.rejection}`);
      prices[label] = price;
      return `${market.info.dex} ${market.info.token.symbol}/${market.info.quote.symbol} @ ${price.toFixed(2)}; 1 USDG → ${buy.amountOut.toPrecision(4)} ETH (impact ${(buy.priceImpact * 100).toFixed(3)}%); settles native: ${market.info.settlesInNative}`;
    });
  }

  await check('mainnet: V2, V3 and V4 agree on the ETH price within 3%', async () => {
    const values = Object.values(prices);
    assert(values.length === 4, 'not every venue priced');
    const spread = (Math.max(...values) - Math.min(...values)) / Math.min(...values);
    assert(spread < 0.03, `spread ${(spread * 100).toFixed(2)}%`);
    return `spread ${(spread * 100).toFixed(3)}% across ${values.length} readings`;
  });

  await check('mainnet: findPools discovers V2, V3 and V4 pools for USDG', async () => {
    const pools = await main.findPools(USDG);
    const kinds = new Set(pools.map((p) => p.dexKind));
    assert(kinds.has('v2') && kinds.has('v3') && kinds.has('v4'), `only found ${[...kinds].join(', ')}`);
    return `${pools.length} pools; deepest ${pools[0]!.dex} ${pools[0]!.pool} with ${pools[0]!.quoteDepth.toFixed(2)} quote depth`;
  });

  for (const [label, ref] of [['V2', MAINNET.v2], ['V3', MAINNET.v3], ['V4', MAINNET.v4Id]] as const) {
    await check(`mainnet ${label}: simulated native buy executes against the quote`, () => simulateNativeBuy(main, ref, '0.001'));
  }

  await check('mainnet V3: trade feed reads recent external swaps in both directions', async () => {
    const market = await main.market(MAINNET.v3);
    const head = await market.blockNumber();
    const buys = market.tradeFeed({ side: 'buy', fromBlock: head - 1_900 });
    const sells = market.tradeFeed({ side: 'sell', fromBlock: head - 1_900 });
    const [b, s] = [await buys.poll(), await sells.poll()];
    const sample = [...b, ...s][0];
    return `${b.length} buys, ${s.length} sells in ~1900 blocks${sample ? `; e.g. ${sample.side} ${sample.quoteAmount} by ${sample.trader}` : ''}`;
  });

  await check('mainnet: an unfunded buy fails in simulation and nothing is broadcast', async () => {
    const market = await main.market(MAINNET.v3);
    const result = await market.buy({ wallet: generateWallet().wallet, amount: '0.001' });
    assert(result.status === 'failed' && /Simulation failed/.test(result.error), `unexpected ${JSON.stringify(result)}`);
    return result.error.slice(0, 90);
  });

  await check('testnet Synthra V3: resolve, price, quote', async () => {
    const market = await test.market(TESTNET_V3);
    const price = await market.price();
    const quote = await market.quoteBuy('0.001');
    assert(price > 0 && quote.amountOut > 0, 'no price or quote');
    return `${market.info.token.symbol}/${market.info.quote.symbol} @ ${price}; 0.001 ${market.info.quote.symbol} → ${quote.amountOut.toPrecision(4)}`;
  });

  await check('testnet Synthra V3: simulated native buy executes against the quote', () => simulateNativeBuy(test, TESTNET_V3, '0.0001'));

  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed++;
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  (${r.ms}ms)\n      ${r.detail}`);
  }
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

await main();

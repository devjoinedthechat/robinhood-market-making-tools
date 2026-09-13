/**
 * Run a grid on a Robinhood Chain testnet pool until Ctrl+C.
 *
 *   PRIVATE_KEY=0x… POOL=0x… node examples/grid-testnet.ts
 *
 * Add PAPER=1 to simulate fills without signing anything.
 */

import {
  consoleLogger,
  createMarketMaker,
  gridStrategy,
  inventoryRebalanceStrategy,
  robinhoodTestnet,
  walletFromPrivateKey,
} from '../src/index.ts';

const privateKey = process.env.PRIVATE_KEY;
const pool = process.env.POOL;
if (!privateKey || !pool) {
  console.error('Set PRIVATE_KEY and POOL (a pool address, or a V4 PoolId).');
  process.exit(1);
}

const mm = createMarketMaker({ chain: robinhoodTestnet, logger: consoleLogger({ level: 'info' }) });
const market = await mm.market(pool);
const price = await market.price();
console.log(`${market.info.token.symbol}/${market.info.quote.symbol} on ${market.info.dex} @ ${price}`);

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());

const result = await mm.run({
  market,
  wallets: [walletFromPrivateKey(privateKey, 'maker')],
  strategies: [
    gridStrategy({ stepPercent: 1, levels: 5, orderSize: 0.0005 }),
    inventoryRebalanceStrategy({ targetPercent: 50, bandPercent: 10 }),
  ],
  risk: { maxSpend: 0.01, maxDrawdown: 0.002 },
  paper: process.env.PAPER === '1',
  signal: controller.signal,
  onEvent: (event) => {
    if (event.type === 'trade') {
      const r = event.result;
      console.log(`[${event.strategy}] ${r.side} ${r.status}`, r.status === 'filled' ? `${r.tokenAmount} @ ${r.price}` : r.error);
    }
    if (event.type === 'halted') console.log(`HALTED by ${event.limit}: ${event.message}`);
  },
});

console.log(`Run ${result.status}.`, result.trades, `net PnL ${result.ledger.netPnl} ${market.info.quote.symbol} (excludes gas)`);

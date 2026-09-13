import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigError, StrategyNotReadyError, WalletsBusyError } from '../src/errors.ts';
import { WalletLocks, runStrategies, type RunEvent } from '../src/strategy/runner.ts';
import type { Strategy } from '../src/strategy/types.ts';
import { FakeMarket, makeWallets } from './fakes.ts';

const wallets = makeWallets(2);

function market(): FakeMarket {
  const m = new FakeMarket({ prices: [1] });
  for (const w of wallets) m.setBalances(w, { native: 10 });
  return m;
}

const buyer = (count: number, amount = 0.1): Strategy => ({
  name: 'buyer',
  description: 'buys a fixed number of times',
  async run(ctx) {
    let fills = 0;
    for (let i = 0; i < count && !ctx.signal.aborted; i++) {
      const b = await ctx.fleet.findBuyer(amount);
      if (!b) break;
      if ((await ctx.market.buy({ wallet: b.wallet, amount })).status === 'filled') fills++;
      await ctx.sleep(0);
    }
    return { fills };
  },
});

const idle: Strategy = {
  name: 'idle',
  description: 'waits until stopped',
  async run(ctx) {
    while (!ctx.signal.aborted) await ctx.sleep(5);
  },
};

const thrower: Strategy = {
  name: 'thrower',
  description: 'fails',
  async run() {
    throw new Error('boom');
  },
};

describe('runStrategies', () => {
  it('completes, counts trades and emits events in order', async () => {
    const events: RunEvent['type'][] = [];
    const result = await runStrategies({ market: market(), wallets, strategies: buyer(3), onEvent: (e) => events.push(e.type) });
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.trades, { filled: 3, failed: 0, unknown: 0 });
    assert.equal(result.ledger.quoteSpent, 0.30000000000000004);
    assert.deepEqual(events, ['started', 'trade', 'trade', 'trade', 'strategy-finished', 'finished']);
  });

  it('halts every strategy when a shared risk limit trips', async () => {
    const result = await runStrategies({ market: market(), wallets, strategies: [buyer(10), idle], risk: { maxSpend: 0.25 } });
    assert.equal(result.status, 'halted');
    assert.equal(result.halt?.limit, 'spend-cap');
    assert.equal(result.trades.filled, 2);
    assert.deepEqual(
      result.strategies.map((s) => s.status),
      ['halted', 'halted'],
    );
  });

  it('stops when the caller aborts', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const result = await runStrategies({ market: market(), wallets, strategies: idle, signal: controller.signal });
    assert.equal(result.status, 'stopped');
  });

  it('stops siblings when a strategy fails, by default', async () => {
    const result = await runStrategies({ market: market(), wallets, strategies: [thrower, idle] });
    assert.equal(result.status, 'failed');
    assert.deepEqual(
      result.strategies.map((s) => [s.name, s.status]),
      [
        ['thrower', 'failed'],
        ['idle', 'stopped'],
      ],
    );
  });

  it('lets siblings finish with onStrategyError: continue', async () => {
    const result = await runStrategies({ market: market(), wallets, strategies: [thrower, buyer(2)], onStrategyError: 'continue' });
    assert.equal(result.status, 'failed');
    assert.equal(result.strategies[1]?.status, 'completed');
    assert.equal(result.trades.filled, 2);
  });

  it('refuses to start a strategy that is not ready, before trading or locking', async () => {
    const locks = new WalletLocks();
    const m = market();
    const notReady: Strategy = { ...buyer(1), validate: async () => ({ ready: false, reason: 'no funds' }) };
    await assert.rejects(runStrategies({ market: m, wallets, strategies: notReady, locks }), StrategyNotReadyError);
    assert.equal(m.orders.length, 0);
    assert.equal(locks.isHeld(wallets[0]!.address), false);
  });

  it('refuses a second run on the same wallets, and releases them afterwards', async () => {
    const locks = new WalletLocks();
    const controller = new AbortController();
    const first = runStrategies({ market: market(), wallets, strategies: idle, signal: controller.signal, locks });
    await new Promise((r) => setTimeout(r, 5));
    await assert.rejects(runStrategies({ market: market(), wallets: [wallets[1]!], strategies: idle, locks }), WalletsBusyError);
    controller.abort();
    await first;
    assert.equal(locks.isHeld(wallets[0]!.address), false);
  });

  it('labels duplicate strategies distinctly', async () => {
    const result = await runStrategies({ market: market(), wallets, strategies: [buyer(1), buyer(1)] });
    assert.deepEqual(
      result.strategies.map((s) => s.name),
      ['buyer', 'buyer#2'],
    );
  });

  it('returns stopped without running when the signal is already aborted', async () => {
    const m = market();
    const result = await runStrategies({ market: m, wallets, strategies: buyer(1), signal: AbortSignal.abort() });
    assert.equal(result.status, 'stopped');
    assert.equal(m.orders.length, 0);
  });

  it('rejects invalid input up front', async () => {
    await assert.rejects(runStrategies({ market: market(), wallets: [wallets[0]!, wallets[0]!], strategies: idle }), ConfigError);
    await assert.rejects(runStrategies({ market: market(), wallets, strategies: [] }), ConfigError);
    await assert.rejects(runStrategies({ market: market(), wallets, strategies: idle, risk: { maxSpend: 0 } }), ConfigError);
  });
});

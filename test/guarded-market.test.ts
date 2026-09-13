import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigError, RiskLimitError } from '../src/errors.ts';
import { GuardedMarket, type RiskLimits } from '../src/risk/guarded-market.ts';
import type { TradeResult } from '../src/market/types.ts';
import { FakeMarket, makeWallets } from './fakes.ts';

const [wallet] = makeWallets(1) as [ReturnType<typeof makeWallets>[number]];

function rig(limits: RiskLimits, options: { price?: number; paper?: boolean; now?: () => number } = {}) {
  const prices = [options.price ?? 1];
  const inner = new FakeMarket({ prices });
  inner.setBalances(wallet, { native: 100, token: 0 });
  const trades: TradeResult[] = [];
  const market = new GuardedMarket(inner, {
    limits,
    paper: options.paper ?? false,
    onTrade: (r) => trades.push(r),
    ...(options.now ? { now: options.now } : {}),
  });
  return {
    inner,
    market,
    trades,
    setPrice(value: number) {
      prices[0] = value;
    },
    buy: (amount: number) => market.buy({ wallet, amount }),
    sell: (amount: number | 'all') => market.sell({ wallet, amount }),
  };
}

async function refusedWith(promise: Promise<unknown>, limit: RiskLimitError['limit']): Promise<RiskLimitError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.ok(error instanceof RiskLimitError, `expected a ${limit} refusal, got ${String(error)}`);
  assert.equal(error.limit, limit);
  return error;
}

describe('drawdown limit', () => {
  it('never halts a run that is not losing', async () => {
    const r = rig({ maxDrawdown: 0.5 });
    for (let i = 0; i < 10; i++) await r.buy(1);
  });

  it('halts once the marked position is down more than the limit', async () => {
    const r = rig({ maxDrawdown: 0.5 });
    await r.buy(2);
    r.setPrice(0.5);
    await r.buy(0.1); // fills at 0.5 → marks 2.1 tokens at 0.5 against 2.1 paid
    const error = await refusedWith(r.buy(0.1), 'drawdown');
    assert.match(error.message, /not closed/);
  });

  it('nets what selling recovered', async () => {
    const r = rig({ maxDrawdown: 1 });
    await r.buy(3);
    r.setPrice(0.5);
    await r.sell(3); // recovers 1.5 of 3
    await refusedWith(r.buy(0.01), 'drawdown');
  });

  it('never blocks a sell — the exit stays open', async () => {
    const r = rig({ maxDrawdown: 0.01 });
    await r.buy(5);
    r.setPrice(0.1);
    await r.buy(0.01).catch(() => undefined);
    const out = await r.sell('all');
    assert.equal(out.status, 'filled');
  });
});

describe('spend cap', () => {
  it('refuses the buy that would exceed the cap, before it is sent', async () => {
    const r = rig({ maxSpend: 1 });
    await r.buy(0.6);
    await refusedWith(r.buy(0.6), 'spend-cap');
    assert.equal(r.inner.orders.length, 1);
    assert.equal(r.market.ledger.committedSpend, 0.6);
  });

  it('releases the commitment of a failed buy, so refusals cannot exhaust the budget', async () => {
    const r = rig({ maxSpend: 1 });
    r.inner.outcomes.push('failed', 'failed', 'failed');
    for (let i = 0; i < 3; i++) await r.buy(0.6);
    assert.equal(r.market.ledger.committedSpend, 0);
    assert.equal((await r.buy(0.6)).status, 'filled');
  });

  it('keeps the commitment of an unknown buy, which may still have spent', async () => {
    const r = rig({ maxSpend: 1 });
    r.inner.outcomes.push('unknown');
    await r.buy(0.6);
    await refusedWith(r.buy(0.6), 'spend-cap');
  });

  it('releases the commitment when the inner market throws', async () => {
    const r = rig({ maxSpend: 1 });
    r.inner.outcomes.push(new Error('boom'));
    await assert.rejects(r.buy(0.9), /boom/);
    assert.equal(r.market.ledger.committedSpend, 0);
  });
});

describe('liquidity floor', () => {
  it('arms on the first buy, follows depth up, and halts on a collapse', async () => {
    let now = 0;
    const r = rig({ liquidityFloorPct: 50 }, { now: () => now });
    await r.buy(0.1); // arms at depth 10
    r.inner.depth = 20;
    now += 20_000;
    await r.buy(0.1); // high-water 20
    r.inner.depth = 9;
    now += 20_000;
    const error = await refusedWith(r.buy(0.1), 'liquidity-floor');
    assert.equal(error.threshold, 10);
  });

  it('checks at most once per interval', async () => {
    let now = 0;
    const r = rig({ liquidityFloorPct: 50 }, { now: () => now });
    await r.buy(0.1);
    r.inner.depth = 1;
    now += 1_000;
    assert.equal((await r.buy(0.1)).status, 'filled');
  });

  it('does not halt on an unreadable pool', async () => {
    const r = rig({ liquidityFloorPct: 50 });
    r.inner.failSnapshot = true;
    assert.equal((await r.buy(0.1)).status, 'filled');
  });

  it('is disabled by 0', async () => {
    let now = 0;
    const r = rig({ liquidityFloorPct: 0 }, { now: () => now });
    await r.buy(0.1);
    r.inner.depth = 0.001;
    now += 60_000;
    assert.equal((await r.buy(0.1)).status, 'filled');
  });
});

describe('paper mode', () => {
  it('fills at spot without touching the inner market', async () => {
    const r = rig({}, { paper: true, price: 2 });
    const result = await r.buy(1);
    assert.equal(r.inner.orders.length, 0);
    assert.equal(result.status, 'filled');
    assert.ok(result.status === 'filled' && result.paper && result.tokenAmount === 0.5);
  });

  it('sells a real balance for "all"', async () => {
    const r = rig({}, { paper: true, price: 2 });
    r.inner.setBalances(wallet, { token: 3 });
    const result = await r.sell('all');
    assert.ok(result.status === 'filled' && result.tokenAmount === 3 && result.quoteAmount === 6);
  });
});

describe('reporting', () => {
  it('reports every trade, and survives a throwing handler', async () => {
    const inner = new FakeMarket();
    inner.setBalances(wallet, { native: 10 });
    const seen: string[] = [];
    const market = new GuardedMarket(inner, {
      limits: {},
      onTrade: (r) => {
        seen.push(r.status);
        throw new Error('handler bug');
      },
    });
    inner.outcomes.push('failed');
    await market.buy({ wallet, amount: 0.1 });
    await market.buy({ wallet, amount: 0.1 });
    assert.deepEqual(seen, ['failed', 'filled']);
  });

  it('rejects nonsensical limits up front', () => {
    const inner = new FakeMarket();
    assert.throws(() => new GuardedMarket(inner, { limits: { maxSpend: -1 } }), ConfigError);
    assert.throws(() => new GuardedMarket(inner, { limits: { liquidityFloorPct: 100 } }), ConfigError);
  });
});

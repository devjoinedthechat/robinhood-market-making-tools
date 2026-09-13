import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigError } from '../src/errors.ts';
import {
  absorbWallStrategy,
  dipBuyStrategy,
  gridStrategy,
  inventoryRebalanceStrategy,
  supportBuyStrategy,
  takeProfitStrategy,
  twapStrategy,
} from '../src/strategy/index.ts';
import { FakeMarket, externalSell, harness, makeWallets } from './fakes.ts';

const wallets = makeWallets(2);
const [w1] = wallets as [(typeof wallets)[number]];

function funded(prices: number[]): FakeMarket {
  const market = new FakeMarket({ prices });
  for (const w of wallets) market.setBalances(w, { native: 1, token: 1 });
  return market;
}

const sides = (market: FakeMarket) => market.orders.map((o) => o.side);

describe('grid', () => {
  it('trades once per rung crossing, and once for a multi-rung jump', async () => {
    const market = funded([100, 99, 99, 101, 104, 104]);
    const h = harness(market, wallets, 6);
    const metrics = await gridStrategy({ mid: 100, stepPercent: 1, levels: 5, orderSize: 0.005 }).run(h.ctx);
    assert.deepEqual(sides(market), ['buy', 'sell', 'sell']);
    assert.deepEqual({ buys: metrics?.buys, sells: metrics?.sells }, { buys: 1, sells: 2 });
  });

  it('stops quoting past the last rung', async () => {
    const market = funded([100, 110, 120, 130]);
    const h = harness(market, wallets, 4);
    await gridStrategy({ mid: 100, stepPercent: 1, levels: 2 }).run(h.ctx);
    assert.deepEqual(sides(market), ['sell']);
  });

  it('refuses to start with nothing on either side', async () => {
    const market = new FakeMarket();
    const readiness = await gridStrategy().validate!(harness(market, wallets).ctx);
    assert.equal(readiness.ready, false);
  });

  it('reports every bad parameter at once', () => {
    assert.throws(
      () => gridStrategy({ stepPercent: 0, levels: 0, orderSize: -1 }),
      (e: unknown) => e instanceof ConfigError && /stepPercent/.test(e.message) && /levels/.test(e.message) && /orderSize/.test(e.message),
    );
  });
});

describe('support-buy', () => {
  it('buys once per breach and re-arms only after the band is reclaimed', async () => {
    const market = funded([101, 99, 98, 100.5, 101.5, 99]);
    const h = harness(market, wallets, 20);
    const metrics = await supportBuyStrategy({ level: 100, rearmPercent: 1, amount: 0.01, maxBuys: 2 }).run(h.ctx);
    assert.deepEqual(sides(market), ['buy', 'buy']);
    assert.equal(metrics?.capReached, 1, 'ends when the cap is reached instead of idling');
    assert.equal(h.controller.signal.aborted, false);
  });
});

describe('take-profit', () => {
  it('sells a share of the largest holding once per breach', async () => {
    const market = new FakeMarket({ prices: [99, 101, 102, 99.4, 101] });
    market.setBalances(w1, { native: 1, token: 100 });
    const h = harness(market, wallets, 20);
    await takeProfitStrategy({ level: 100, rearmPercent: 0.5, percentOfHolding: 25, maxSells: 2 }).run(h.ctx);
    assert.deepEqual(
      market.orders.map((o) => o.amount),
      [25, 18.75],
    );
  });
});

describe('inventory-rebalance', () => {
  it('corrects toward the target, capped per trade', async () => {
    const market = new FakeMarket({ prices: [1] });
    market.setBalances(w1, { native: 1, token: 0 });
    const h = harness(market, [w1], 1);
    await inventoryRebalanceStrategy({ targetPercent: 50, bandPercent: 5, maxTradeQuote: 0.1 }).run(h.ctx);
    assert.deepEqual(market.orders, [{ side: 'buy', wallet: w1.address, amount: 0.1 }]);
  });

  it('does nothing inside the band', async () => {
    const market = new FakeMarket({ prices: [1] });
    market.setBalances(w1, { native: 0.52, token: 0.5 });
    const h = harness(market, [w1], 3);
    await inventoryRebalanceStrategy({ targetPercent: 50, bandPercent: 5 }).run(h.ctx);
    assert.equal(market.orders.length, 0);
  });

  it('rejects a band that could never trip on one side', () => {
    assert.throws(() => inventoryRebalanceStrategy({ targetPercent: 90, bandPercent: 20 }), ConfigError);
  });
});

describe('twap', () => {
  it('works every slice and finishes on its own', async () => {
    const market = new FakeMarket({ prices: [1] });
    market.setBalances(w1, { native: 5 });
    const h = harness(market, [w1]);
    const metrics = await twapStrategy({ side: 'buy', total: 1, slices: 4, durationMs: 4_000 }).run(h.ctx);
    assert.equal(market.orders.length, 4);
    assert.equal(h.sleeps.length, 3, 'no wait after the final slice');
    assert.equal(metrics?.shortBy, 0);
    for (const gap of h.sleeps) assert.ok(gap >= 900 && gap <= 1_100, `gap ${gap} outside ±10% jitter`);
  });

  it('stops short when a slice cannot be funded, and says by how much', async () => {
    const market = new FakeMarket({ prices: [1] });
    market.setBalances(w1, { native: 0.6 });
    const h = harness(market, [w1]);
    const metrics = await twapStrategy({ side: 'buy', total: 1, slices: 4, durationMs: 4_000 }).run(h.ctx);
    assert.equal(market.orders.length, 2);
    assert.equal(metrics?.shortBy, 0.5);
  });

  it('requires a total', () => {
    assert.throws(() => twapStrategy({ side: 'buy' } as never), ConfigError);
  });
});

describe('dip-buy', () => {
  it('buys back a share of external sells and excludes the fleet from the feed', async () => {
    const market = funded([1]);
    market.feeds.sell.push([externalSell(0.02)]);
    const h = harness(market, wallets, 2);
    await dipBuyStrategy({ buybackPercent: 30, maxBuyQuote: 0.015 }).run(h.ctx);
    assert.equal(market.orders.length, 1);
    assert.ok(Math.abs((market.orders[0]!.amount as number) - 0.006) < 1e-12);
    const feed = market.feedOptions[0]!;
    assert.equal(feed.side, 'sell');
    assert.deepEqual(new Set(feed.exclude), new Set(wallets.map((w) => w.address.toLowerCase())));
  });

  it('caps the buyback per event', async () => {
    const market = funded([1]);
    market.feeds.sell.push([externalSell(10)]);
    const h = harness(market, wallets, 1);
    await dipBuyStrategy({ buybackPercent: 30, maxBuyQuote: 0.015 }).run(h.ctx);
    assert.equal(market.orders[0]!.amount, 0.015);
  });
});

describe('absorb-wall', () => {
  it('answers a wall relative to depth, ignores small sells, and honours the cooldown', async () => {
    const market = funded([1]);
    market.depth = 10; // wall floor at 2% = 0.2
    market.feeds.sell.push([externalSell(0.1), externalSell(0.8)], [externalSell(0.9)]);
    const h = harness(market, wallets, 2);
    const metrics = await absorbWallStrategy({ wallPoolPercent: 2, responsePercent: 50, maxPerWall: 0.02 }).run(h.ctx);
    assert.equal(market.orders.length, 1);
    assert.equal(market.orders[0]!.amount, 0.02);
    assert.deepEqual({ seen: metrics?.wallsSeen, absorbed: metrics?.wallsAbsorbed }, { seen: 2, absorbed: 1 });
  });
});

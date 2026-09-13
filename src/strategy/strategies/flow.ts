/**
 * Flow strategies: respond to other traders' selling.
 *
 * Both watch the pool's swaps with the fleet excluded, so the fleet's own sells
 * are never mistaken for selling pressure. A strategy that reacted to price
 * alone could not tell an outside seller from itself, and would buy into its
 * own selling in a self-feeding loop.
 *
 *  - dip-buy answers steady flow: it buys back a share of external sell volume,
 *    capped per event.
 *  - absorb-wall answers a single sell that is large RELATIVE TO THE POOL, with a
 *    response that grows with the wall. An absolute threshold is deaf on a deep
 *    pool and hair-trigger on a thin one; depth is what makes a sell a wall.
 *
 * Buys are made from one funded wallet per response.
 */

import { assertParams, attempt, check, noteResult, worthGas } from '../support.ts';
import type { Readiness, Strategy, StrategyContext, StrategyMetrics } from '../types.ts';

export interface DipBuyParams {
  /** Share of external sell volume bought back, percent. Default 30. */
  readonly buybackPercent?: number;
  /** Ignore sells below this quote amount. Default 0.0003. */
  readonly minSellQuote?: number;
  /** Most quote spent answering one poll's sells. Default 0.015. */
  readonly maxBuyQuote?: number;
  /** Default 5000. */
  readonly checkIntervalMs?: number;
  readonly slippagePct?: number;
}

export interface AbsorbWallParams {
  /** A single sell worth at least this percent of quote depth is a wall. Default 2. */
  readonly wallPoolPercent?: number;
  /** Share of a wall answered at the trigger size, percent; grows with √severity. Default 50. */
  readonly responsePercent?: number;
  /** Most quote spent answering one wall. Default 0.02. */
  readonly maxPerWall?: number;
  /** No second answer inside this window, so a stepped sell is not paid at every step. Default 60000. */
  readonly cooldownMs?: number;
  /** Walls answered before the strategy ends. Default 10. */
  readonly maxWalls?: number;
  /** Default 5000. */
  readonly checkIntervalMs?: number;
  readonly slippagePct?: number;
}

async function feedReadiness(ctx: StrategyContext, fundable: number): Promise<Readiness> {
  if (!(await ctx.fleet.findBuyer(fundable))) {
    return { ready: false, reason: `no wallet can fund ${fundable} ${ctx.market.info.quote.symbol ?? 'quote'} plus gas` };
  }
  try {
    await ctx.market.tradeFeed({ side: 'sell', exclude: ctx.fleet.addresses }).poll();
  } catch (error) {
    return { ready: false, reason: `external trades cannot be observed: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { ready: true };
}

export function dipBuyStrategy(params: DipBuyParams = {}): Strategy {
  const buybackPercent = params.buybackPercent ?? 30;
  const minSellQuote = params.minSellQuote ?? 0.0003;
  const maxBuyQuote = params.maxBuyQuote ?? 0.015;
  const interval = params.checkIntervalMs ?? 5_000;
  assertParams('dip-buy', [
    check.between('buybackPercent', buybackPercent, 0, 100.0001),
    check.positive('minSellQuote', minSellQuote),
    check.positive('maxBuyQuote', maxBuyQuote),
    check.interval('checkIntervalMs', interval),
  ]);

  return {
    name: 'dip-buy',
    description: 'Buy back a share of external sell volume',

    validate: (ctx) => feedReadiness(ctx, maxBuyQuote),

    async run(ctx: StrategyContext): Promise<StrategyMetrics> {
      const feed = ctx.market.tradeFeed({
        side: 'sell',
        exclude: ctx.fleet.addresses,
        minQuote: minSellQuote,
        fromBlock: await ctx.market.blockNumber(),
        maxResults: 20,
      });
      let sellsSeen = 0;
      let buys = 0;

      while (!ctx.signal.aborted) {
        const sells = (await attempt(ctx, 'Trade feed poll', () => feed.poll())) ?? [];
        if (sells.length > 0) {
          sellsSeen += sells.length;
          const volume = sells.reduce((sum, s) => sum + s.quoteAmount, 0);
          // Capped: unbounded buyback is most dangerous exactly when someone dumps into a thin pool.
          const buyback = Math.min((volume * buybackPercent) / 100, maxBuyQuote);
          if (!worthGas(ctx, buyback)) {
            ctx.log.info('Buyback not worth its gas; skipping', { volume, buyback });
          } else {
            const buyer = await ctx.fleet.findBuyer(buyback);
            if (!buyer) ctx.log.warn('No wallet can fund the buyback', { buyback });
            else if (noteResult(ctx, 'Dip buy', await ctx.market.buy({ wallet: buyer.wallet, amount: buyback, slippagePct: params.slippagePct }))) buys++;
          }
        }
        await ctx.sleep(interval);
      }
      return { sellsSeen, buys };
    },
  };
}

export function absorbWallStrategy(params: AbsorbWallParams = {}): Strategy {
  const wallPoolPercent = params.wallPoolPercent ?? 2;
  const responsePercent = params.responsePercent ?? 50;
  const maxPerWall = params.maxPerWall ?? 0.02;
  const cooldownMs = params.cooldownMs ?? 60_000;
  const maxWalls = params.maxWalls ?? 10;
  const interval = params.checkIntervalMs ?? 5_000;
  assertParams('absorb-wall', [
    check.between('wallPoolPercent', wallPoolPercent, 0, 100),
    check.between('responsePercent', responsePercent, 0, 100.0001),
    check.positive('maxPerWall', maxPerWall),
    Number.isFinite(cooldownMs) && cooldownMs >= 0 ? undefined : 'cooldownMs must be non-negative',
    check.integer('maxWalls', maxWalls, 1),
    check.interval('checkIntervalMs', interval),
  ]);

  return {
    name: 'absorb-wall',
    description: 'Answer a sell that is large relative to the pool with a buy that scales with it',

    validate: (ctx) => feedReadiness(ctx, maxPerWall),

    async run(ctx: StrategyContext): Promise<StrategyMetrics> {
      const feed = ctx.market.tradeFeed({
        side: 'sell',
        exclude: ctx.fleet.addresses,
        fromBlock: await ctx.market.blockNumber(),
        maxResults: 20,
      });
      let wallsSeen = 0;
      let wallsAbsorbed = 0;
      let lastAbsorbAt = -Infinity;

      while (!ctx.signal.aborted && wallsAbsorbed < maxWalls) {
        // Depth is the denominator of the trigger, so it is read every pass:
        // judging against a stale depth goes deaf exactly as the pool thins.
        const snapshot = await attempt(ctx, 'Pool read', () => ctx.market.snapshot());
        const sells = snapshot && snapshot.quoteReserve > 0 ? ((await attempt(ctx, 'Trade feed poll', () => feed.poll())) ?? []) : [];
        const floor = snapshot ? snapshot.quoteReserve * (wallPoolPercent / 100) : Infinity;
        // The biggest single sell, not the sum: a spread of small sells is flow, not a wall.
        const wall = sells.filter((s) => s.quoteAmount >= floor).reduce<(typeof sells)[number] | undefined>(
          (a, b) => (a === undefined || b.quoteAmount > a.quoteAmount ? b : a),
          undefined,
        );

        if (wall) {
          wallsSeen++;
          if (Date.now() - lastAbsorbAt < cooldownMs) {
            ctx.log.info('Wall during cooldown; not answering', { wall: wall.quoteAmount });
          } else {
            // Share grows with √severity: a wall 9× the trigger gets 3× the share,
            // so one serious hit does not spend the whole budget.
            const severity = wall.quoteAmount / floor;
            const share = Math.min(1, (responsePercent / 100) * Math.sqrt(severity));
            const answer = Math.min(wall.quoteAmount * share, maxPerWall);
            const buyer = worthGas(ctx, answer) ? await ctx.fleet.findBuyer(answer) : undefined;
            if (!buyer) {
              ctx.log.warn('Wall not answered: not worth gas or no wallet can fund it', { answer });
            } else if (noteResult(ctx, 'Absorb wall', await ctx.market.buy({ wallet: buyer.wallet, amount: answer, slippagePct: params.slippagePct }))) {
              // The cooldown only starts when something landed; a revert must not mute the next wall.
              wallsAbsorbed++;
              lastAbsorbAt = Date.now();
            }
          }
        }
        await ctx.sleep(interval);
      }
      return { wallsSeen, wallsAbsorbed };
    },
  };
}

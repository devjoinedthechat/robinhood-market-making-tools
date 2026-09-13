/**
 * Grid: two-sided quoting around a mid.
 *
 * An AMM has no book to rest orders in, so the grid is a ladder of price rungs
 * stepped either side of the mid. Crossing a rung downwards buys, crossing one
 * upwards sells, and a round trip across the same rung captures the step.
 *
 * Each crossing trades ONCE: the current rung is tracked and a trade happens
 * only when it changes. A price that jumps several rungs trades once, not once
 * per rung — filling every skipped rung would put the whole ladder in at the
 * worst price of a fast move. Past the last rung the grid stops quoting rather
 * than building an unbounded position. The ladder does not follow price;
 * re-anchoring is the caller's decision, made by starting a new run.
 */

import { assertParams, check, noteResult, readPrice, worthGas } from '../support.ts';
import type { Readiness, Strategy, StrategyContext, StrategyMetrics } from '../types.ts';

export interface GridParams {
  /** Price the ladder is anchored to, quote per token. Default: spot at start. */
  readonly mid?: number;
  /** Spacing between rungs, percent of mid. Default 1. */
  readonly stepPercent?: number;
  /** Rungs either side of the mid. Default 5. */
  readonly levels?: number;
  /** Size of one order, in quote — the same risk on both sides. Default 0.005. */
  readonly orderSize?: number;
  /** Default 5000. */
  readonly checkIntervalMs?: number;
  readonly slippagePct?: number;
}

export function gridStrategy(params: GridParams = {}): Strategy {
  const stepPercent = params.stepPercent ?? 1;
  const levels = params.levels ?? 5;
  const orderSize = params.orderSize ?? 0.005;
  const checkIntervalMs = params.checkIntervalMs ?? 5_000;
  assertParams('grid', [
    check.positive('mid', params.mid),
    check.between('stepPercent', stepPercent, 0, 50),
    check.integer('levels', levels, 1),
    check.positive('orderSize', orderSize),
    check.interval('checkIntervalMs', checkIntervalMs),
  ]);

  return {
    name: 'grid',
    description: 'Two-sided quoting: buy each rung crossed down, sell each rung crossed up',

    async validate(ctx: StrategyContext): Promise<Readiness> {
      const [buyer, holders] = await Promise.all([ctx.fleet.findBuyer(orderSize), ctx.fleet.holders()]);
      if (!buyer && holders.length === 0) {
        return { ready: false, reason: 'the fleet holds neither quote to buy with nor tokens to sell' };
      }
      if (!buyer || holders.length === 0) {
        ctx.log.warn('Grid can only quote one side with current inventory', { canBuy: !!buyer, canSell: holders.length > 0 });
      }
      return { ready: true, detail: { canBuy: !!buyer, canSell: holders.length > 0 } };
    },

    async run(ctx: StrategyContext): Promise<StrategyMetrics> {
      let buys = 0;
      let sells = 0;
      let skipped = 0;

      const mid = params.mid ?? (await readPrice(ctx));
      if (mid === undefined) throw new Error('Could not read a price to anchor the grid on');
      const rungOf = (price: number): number =>
        Math.max(-levels, Math.min(levels, Math.round((((price - mid) / mid) * 100) / stepPercent)));
      ctx.log.info('Grid anchored', { mid, stepPercent, levels, orderSize });

      let current: number | undefined;
      while (!ctx.signal.aborted) {
        const price = await readPrice(ctx);
        if (price === undefined) {
          await ctx.sleep(checkIntervalMs);
          continue;
        }
        const rung = rungOf(price);
        if (current === undefined || rung === current) {
          current = rung;
          await ctx.sleep(checkIntervalMs);
          continue;
        }

        const movedDown = rung < current;
        ctx.log.info('Rung crossed', { from: current, to: rung, price, side: movedDown ? 'buy' : 'sell' });
        current = rung;

        if (movedDown) {
          const buyer = await ctx.fleet.findBuyer(orderSize);
          if (!buyer) {
            skipped++;
            ctx.log.warn('No wallet can fund the grid buy', { orderSize });
          } else if (noteResult(ctx, 'Grid buy', await ctx.market.buy({ wallet: buyer.wallet, amount: orderSize, slippagePct: params.slippagePct }))) {
            buys++;
          }
        } else {
          const [holder] = await ctx.fleet.holders();
          const tokens = holder ? Math.min(orderSize / price, holder.tokenBalance) : 0;
          if (!holder || !worthGas(ctx, tokens * price)) {
            skipped++;
            ctx.log.warn('Grid sell skipped: nothing worth selling', { tokens });
          } else if (noteResult(ctx, 'Grid sell', await ctx.market.sell({ wallet: holder.wallet, amount: tokens, slippagePct: params.slippagePct }))) {
            sells++;
          }
        }
        await ctx.sleep(checkIntervalMs);
      }
      return { buys, sells, skipped, mid };
    },
  };
}

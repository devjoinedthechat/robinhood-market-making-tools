/**
 * TWAP: work a target size into or out of the market in slices over a duration.
 *
 * Unlike the other strategies this has a definition of done: it stops when the
 * last slice is worked, and reports filled against target. A slice nobody can
 * fund stops the run SHORT rather than being skipped — a TWAP that quietly
 * drops slices honours its duration and not its size, and the shortfall only
 * shows up when someone reconciles balances.
 *
 * Slice timing is jittered ±10%: identical trades at a perfectly regular cadence
 * are the easiest pattern for other traders to anticipate and trade against.
 */

import { jitter } from '../../internal/async.ts';
import { assertParams, check, noteResult } from '../support.ts';
import type { Readiness, Strategy, StrategyContext, StrategyMetrics } from '../types.ts';

export interface TwapParams {
  readonly side: 'buy' | 'sell';
  /** Size to work: quote on a buy, tokens on a sell. */
  readonly total: number;
  /** Default 10. */
  readonly slices?: number;
  /** Default one hour. */
  readonly durationMs?: number;
  readonly slippagePct?: number;
}

export function twapStrategy(params: TwapParams): Strategy {
  const slices = params.slices ?? 10;
  const durationMs = params.durationMs ?? 3_600_000;
  assertParams('twap', [
    params.side === 'buy' || params.side === 'sell' ? undefined : "side must be 'buy' or 'sell'",
    check.positive('total', params.total) ?? (params.total === undefined ? 'total is required' : undefined),
    check.integer('slices', slices, 1),
    check.positive('durationMs', durationMs),
  ]);
  const sliceSize = params.total / slices;
  const gapMs = durationMs / slices;

  return {
    name: 'twap',
    description: 'Fill a target size in slices over a duration',

    async validate(ctx: StrategyContext): Promise<Readiness> {
      if (params.side === 'buy') {
        return (await ctx.fleet.findBuyer(sliceSize))
          ? { ready: true }
          : { ready: false, reason: `no wallet can fund a ${sliceSize} slice` };
      }
      const holders = await ctx.fleet.holders();
      const held = holders.reduce((sum, h) => sum + h.tokenBalance, 0);
      if (held <= 0) return { ready: false, reason: 'the fleet holds no tokens to sell' };
      if (held < params.total) ctx.log.warn('The fleet holds less than the TWAP total; it will stop short', { held, total: params.total });
      return { ready: true, detail: { held } };
    },

    async run(ctx: StrategyContext): Promise<StrategyMetrics> {
      let filled = 0;
      let worked = 0;
      let failed = 0;

      for (let i = 0; i < slices && !ctx.signal.aborted; i++) {
        if (params.side === 'buy') {
          const buyer = await ctx.fleet.findBuyer(sliceSize);
          if (!buyer) {
            ctx.log.error('No wallet can fund the next slice — stopping short', { slice: i + 1, filled });
            break;
          }
          const result = await ctx.market.buy({ wallet: buyer.wallet, amount: sliceSize, slippagePct: params.slippagePct });
          if (noteResult(ctx, `TWAP slice ${i + 1}/${slices}`, result) && result.status === 'filled') filled += result.quoteAmount;
          else failed++;
        } else {
          const [holder] = await ctx.fleet.holders();
          if (!holder) {
            ctx.log.error('The fleet holds nothing left to sell — stopping short', { slice: i + 1, filled });
            break;
          }
          const result = await ctx.market.sell({
            wallet: holder.wallet,
            amount: Math.min(sliceSize, holder.tokenBalance),
            slippagePct: params.slippagePct,
          });
          if (noteResult(ctx, `TWAP slice ${i + 1}/${slices}`, result) && result.status === 'filled') filled += result.tokenAmount;
          else failed++;
        }
        worked++;
        // No wait after the last slice: sleeping out the schedule would report time spent doing nothing.
        if (i < slices - 1) await ctx.sleep(jitter(gapMs, 0.1));
      }
      return { filled, target: params.total, slicesWorked: worked, slicesFailed: failed, slices, shortBy: Math.max(0, params.total - filled) };
    },
  };
}

/**
 * Inventory rebalance: hold the fleet near a target token/quote split.
 *
 * One-sided strategies ratchet the book toward all-token or all-quote, and a
 * book on one side cannot make a market. This one predicts nothing; it keeps
 * the book able to trade in both directions.
 *
 * The dead band is the design: rebalancing to an exact ratio trades every poll,
 * because every trade and every price move shifts the ratio. Corrections go to
 * the TARGET, not the band edge, so a slow drift does not become a stream of
 * small fee-paying trades.
 */

import { assertParams, check, noteResult, readPrice, worthGas } from '../support.ts';
import type { Readiness, Strategy, StrategyContext, StrategyMetrics } from '../types.ts';

export interface InventoryRebalanceParams {
  /** Share of book value to hold in the token. Default 50. */
  readonly targetPercent?: number;
  /** Drift tolerated before correcting, in percentage points. Default 5. */
  readonly bandPercent?: number;
  /** Largest single correction, in quote. Default: the whole drift. */
  readonly maxTradeQuote?: number;
  /** Default 30000. */
  readonly checkIntervalMs?: number;
  readonly slippagePct?: number;
}

export function inventoryRebalanceStrategy(params: InventoryRebalanceParams = {}): Strategy {
  const targetPercent = params.targetPercent ?? 50;
  const bandPercent = params.bandPercent ?? 5;
  const checkIntervalMs = params.checkIntervalMs ?? 30_000;
  assertParams('inventory-rebalance', [
    check.between('targetPercent', targetPercent, 0, 100),
    // A band wider than the distance to either edge can never trip on that side.
    check.between('bandPercent', bandPercent, 0, Math.min(targetPercent, 100 - targetPercent)),
    check.positive('maxTradeQuote', params.maxTradeQuote),
    check.interval('checkIntervalMs', checkIntervalMs),
  ]);

  return {
    name: 'inventory-rebalance',
    description: 'Keep the fleet near a target token/quote split',

    async validate(ctx: StrategyContext): Promise<Readiness> {
      const totals = await ctx.fleet.totals();
      if (totals.token <= 0 && totals.quote <= 0) return { ready: false, reason: 'the fleet holds neither side' };
      return { ready: true, detail: { ...totals } };
    },

    async run(ctx: StrategyContext): Promise<StrategyMetrics> {
      let buys = 0;
      let sells = 0;
      let corrections = 0;

      while (!ctx.signal.aborted) {
        const price = await readPrice(ctx);
        const totals = price === undefined ? undefined : await ctx.fleet.totals().catch(() => undefined);
        if (price === undefined || totals === undefined) {
          await ctx.sleep(checkIntervalMs);
          continue;
        }

        // Both sides in one unit, at the price the correcting trade will get.
        const tokenValue = totals.token * price;
        const book = tokenValue + totals.quote;
        const tokenPct = book > 0 ? (tokenValue / book) * 100 : 0;
        const drift = tokenPct - targetPercent;
        if (!(book > 0) || Math.abs(drift) <= bandPercent) {
          await ctx.sleep(checkIntervalMs);
          continue;
        }

        const correction = Math.abs(book * (targetPercent / 100) - tokenValue);
        const sized = params.maxTradeQuote === undefined ? correction : Math.min(correction, params.maxTradeQuote);
        corrections++;
        ctx.log.info('Inventory outside band — correcting', { tokenPct, targetPercent, correction: sized, side: drift > 0 ? 'sell' : 'buy' });

        if (drift > 0) {
          const [holder] = await ctx.fleet.holders();
          const tokens = holder ? Math.min(sized / price, holder.tokenBalance) : 0;
          if (holder && worthGas(ctx, tokens * price)) {
            if (noteResult(ctx, 'Rebalance sell', await ctx.market.sell({ wallet: holder.wallet, amount: tokens, slippagePct: params.slippagePct }))) sells++;
          } else {
            ctx.log.warn('Correction is not worth its gas; leaving it', { tokens });
          }
        } else {
          const buyer = await ctx.fleet.findBuyer(sized);
          if (buyer) {
            if (noteResult(ctx, 'Rebalance buy', await ctx.market.buy({ wallet: buyer.wallet, amount: sized, slippagePct: params.slippagePct }))) buys++;
          } else {
            ctx.log.warn('No single wallet can fund the correction', { needed: sized });
          }
        }
        await ctx.sleep(checkIntervalMs);
      }
      return { corrections, buys, sells };
    },
  };
}

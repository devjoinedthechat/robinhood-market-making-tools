/**
 * Level strategies: defend a price from below (support buy) or take profit into
 * strength above (take profit).
 *
 * Both fire ONCE per breach and then do nothing until price re-crosses the
 * level by a band. A level that simply fires "while price is beyond it" trades
 * on every poll: a falling market drains the fleet buying a decline it is not
 * moving, and a rally empties inventory at prices that only get better. The
 * re-arm band keeps a price sitting on the level from firing on noise.
 *
 * When the trade cap is reached the strategy ends and reports it, rather than
 * idling silently in a loop that can no longer act.
 */

import { assertParams, check, noteResult, readPrice, worthGas } from '../support.ts';
import type { Readiness, Strategy, StrategyContext, StrategyMetrics } from '../types.ts';

interface LevelShape {
  /** The price to act at, quote per token. Default: derived from spot at start. */
  readonly level?: number;
  /** Distance from spot for a derived level, percent. Default 2. */
  readonly levelPercent?: number;
  /** How far back across the level price must move to re-arm, percent. Default 0.5. */
  readonly rearmPercent?: number;
  /** Default 5000. */
  readonly checkIntervalMs?: number;
  readonly slippagePct?: number;
}

export interface SupportBuyParams extends LevelShape {
  /** Quote spent per defence. Default 0.01. */
  readonly amount?: number;
  /** Defences before the strategy ends. Default 10. */
  readonly maxBuys?: number;
}

export interface TakeProfitParams extends LevelShape {
  /** Fixed tokens per sale. Default: `percentOfHolding` of the largest holder. */
  readonly amount?: number;
  /** Share of the largest holding sold when no fixed amount is set. Default 25. */
  readonly percentOfHolding?: number;
  /** Sales before the strategy ends. Default 10. */
  readonly maxSells?: number;
}

function levelChecks(name: string, p: LevelShape): (string | undefined)[] {
  return [
    check.positive('level', p.level),
    check.between('levelPercent', p.levelPercent ?? 2, 0, 100),
    check.positive('rearmPercent', p.rearmPercent ?? 0.5),
    check.interval('checkIntervalMs', p.checkIntervalMs ?? 5_000),
  ].map((problem) => problem && `${problem} (${name})`);
}

async function resolveLevel(ctx: StrategyContext, p: LevelShape, direction: -1 | 1): Promise<number> {
  if (p.level !== undefined) return p.level;
  const price = await readPrice(ctx);
  if (price === undefined) throw new Error('Could not read a price to derive the level from; pass `level` explicitly');
  const level = price * (1 + (direction * (p.levelPercent ?? 2)) / 100);
  ctx.log.info('No level given; derived one from spot', { price, level });
  return level;
}

export function supportBuyStrategy(params: SupportBuyParams = {}): Strategy {
  const amount = params.amount ?? 0.01;
  const maxBuys = params.maxBuys ?? 10;
  const interval = params.checkIntervalMs ?? 5_000;
  assertParams('support-buy', [...levelChecks('support-buy', params), check.positive('amount', amount), check.integer('maxBuys', maxBuys, 1)]);

  return {
    name: 'support-buy',
    description: 'Fixed-size buy each time price breaks below a level',

    async validate(ctx: StrategyContext): Promise<Readiness> {
      return (await ctx.fleet.findBuyer(amount)) ? { ready: true } : { ready: false, reason: `no wallet can fund a ${amount} buy plus gas` };
    },

    async run(ctx: StrategyContext): Promise<StrategyMetrics> {
      const level = await resolveLevel(ctx, params, -1);
      const rearmAt = level * (1 + (params.rearmPercent ?? 0.5) / 100);
      let armed = true;
      let buys = 0;
      let breaches = 0;

      while (!ctx.signal.aborted && buys < maxBuys) {
        const price = await readPrice(ctx);
        if (price !== undefined) {
          if (!armed && price >= rearmAt) {
            armed = true;
            ctx.log.info('Level reclaimed — re-armed', { price, level });
          } else if (armed && price < level) {
            armed = false;
            breaches++;
            const buyer = await ctx.fleet.findBuyer(amount);
            if (!buyer) ctx.log.warn('Level broken but no wallet can fund the buy', { price, level });
            else if (noteResult(ctx, 'Support buy', await ctx.market.buy({ wallet: buyer.wallet, amount, slippagePct: params.slippagePct }))) buys++;
          }
        }
        await ctx.sleep(interval);
      }
      if (buys >= maxBuys) ctx.log.warn('Support buy cap reached — no longer defending this level', { maxBuys, breaches });
      return { buys, breaches, level, capReached: buys >= maxBuys ? 1 : 0 };
    },
  };
}

export function takeProfitStrategy(params: TakeProfitParams = {}): Strategy {
  const percentOfHolding = params.percentOfHolding ?? 25;
  const maxSells = params.maxSells ?? 10;
  const interval = params.checkIntervalMs ?? 5_000;
  assertParams('take-profit', [
    ...levelChecks('take-profit', params),
    check.positive('amount', params.amount),
    params.amount === undefined ? check.between('percentOfHolding', percentOfHolding, 0, 100.0001) : undefined,
    check.integer('maxSells', maxSells, 1),
  ]);

  return {
    name: 'take-profit',
    description: 'Sell into strength each time price clears a level',

    async validate(ctx: StrategyContext): Promise<Readiness> {
      return (await ctx.fleet.holders()).length > 0 ? { ready: true } : { ready: false, reason: 'no wallet holds the token' };
    },

    async run(ctx: StrategyContext): Promise<StrategyMetrics> {
      const level = await resolveLevel(ctx, params, 1);
      const rearmAt = level * (1 - (params.rearmPercent ?? 0.5) / 100);
      let armed = true;
      let sells = 0;
      let breaches = 0;

      while (!ctx.signal.aborted && sells < maxSells) {
        const price = await readPrice(ctx);
        if (price !== undefined) {
          if (!armed && price <= rearmAt) {
            armed = true;
            ctx.log.info('Price fell back below the level — re-armed', { price, level });
          } else if (armed && price > level) {
            armed = false;
            breaches++;
            // Largest holder first: one trade, one lot of gas, one lot of impact.
            const [holder] = await ctx.fleet.holders();
            const tokens = holder
              ? params.amount !== undefined
                ? Math.min(params.amount, holder.tokenBalance)
                : holder.tokenBalance * (percentOfHolding / 100)
              : 0;
            if (!holder || !worthGas(ctx, tokens * price)) ctx.log.warn('Level cleared but nothing worth selling', { tokens });
            else if (noteResult(ctx, 'Take profit', await ctx.market.sell({ wallet: holder.wallet, amount: tokens, slippagePct: params.slippagePct }))) sells++;
          }
        }
        await ctx.sleep(interval);
      }
      if (sells >= maxSells) ctx.log.warn('Take-profit cap reached', { maxSells, breaches });
      return { sells, breaches, level, capReached: sells >= maxSells ? 1 : 0 };
    },
  };
}

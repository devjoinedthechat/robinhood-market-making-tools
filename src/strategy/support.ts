/**
 * Helpers shared by the built-in strategies. Exported so custom strategies get
 * the same behaviour for free.
 */

import { BroadcastBlockedError, ConfigError, RiskLimitError } from '../errors.ts';
import type { TradeResult } from '../market/types.ts';
import type { StrategyContext } from './types.ts';

/**
 * Run a read that a polling loop can survive losing. Returns undefined (and
 * logs) on failure so the loop retries next tick. Errors that mean "stop" —
 * bad configuration, a blocked broadcast, a risk limit — are rethrown.
 */
export async function attempt<T>(ctx: StrategyContext, what: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ConfigError || error instanceof BroadcastBlockedError || error instanceof RiskLimitError) throw error;
    if (!ctx.signal.aborted) {
      ctx.log.warn(`${what} failed; retrying next tick`, { error: error instanceof Error ? error.message : String(error) });
    }
    return undefined;
  }
}

/** The current price, or undefined if it could not be read or is not positive. */
export async function readPrice(ctx: StrategyContext): Promise<number | undefined> {
  const price = await attempt(ctx, 'Price read', () => ctx.market.price());
  return price !== undefined && price > 0 ? price : undefined;
}

/**
 * Is a trade worth `quoteValue` worth its gas? Only answerable when the quote
 * is ETH; otherwise there is no price feed to compare against and the answer is yes.
 */
export function worthGas(ctx: StrategyContext, quoteValue: number): boolean {
  const { quoteIsEth, chain } = ctx.market.info;
  if (!(quoteValue > 0)) return false;
  return !quoteIsEth || quoteValue >= chain.estimatedSwapFee * 5;
}

/** Log a non-filled result the way every strategy should. Returns true when filled. */
export function noteResult(ctx: StrategyContext, what: string, result: TradeResult): boolean {
  switch (result.status) {
    case 'filled':
      ctx.log.info(`${what} filled`, { quote: result.quoteAmount, tokens: result.tokenAmount, price: result.price, hash: result.hash });
      return true;
    case 'failed':
      ctx.log.warn(`${what} failed`, { error: result.error, wallet: result.wallet });
      return false;
    case 'unknown':
      ctx.log.error(`${what} outcome unknown — it may still land; do not retry it`, { error: result.error, hash: result.hash });
      return false;
  }
}

type Problem = string | undefined;

/** Throw one ConfigError naming every problem, so a caller fixes them all at once. */
export function assertParams(strategy: string, problems: readonly Problem[]): void {
  const found = problems.filter((p): p is string => p !== undefined);
  if (found.length > 0) throw new ConfigError(`Invalid ${strategy} parameters: ${found.join('; ')}`);
}

export const check = {
  positive(name: string, value: number | undefined): Problem {
    return value === undefined || (Number.isFinite(value) && value > 0) ? undefined : `${name} must be a positive number`;
  },
  integer(name: string, value: number, min: number): Problem {
    return Number.isInteger(value) && value >= min ? undefined : `${name} must be a whole number of at least ${min}`;
  },
  /** Strictly between `min` and `max`. */
  between(name: string, value: number, min: number, max: number): Problem {
    return Number.isFinite(value) && value > min && value < max ? undefined : `${name} must be between ${min} and ${max}`;
  },
  interval(name: string, value: number, minMs = 250): Problem {
    return Number.isFinite(value) && value >= minMs ? undefined : `${name} must be at least ${minMs}ms`;
  },
};

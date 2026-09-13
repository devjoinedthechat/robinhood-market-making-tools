/**
 * The strategy contract.
 *
 * A strategy is a value — `{ name, validate?, run }` — produced by a factory
 * that validates its parameters up front. All per-run state lives in the
 * closure of one `run` call, so two runs can never share a stop flag, a price
 * high-water mark or a balance cache. (The engine this was extracted from had
 * singleton strategy instances and had to retrofit exactly that isolation.)
 */

import type { Logger, LogData } from '../logger.ts';
import type { TradingMarket } from '../market/types.ts';
import type { Fleet } from './fleet.ts';

export interface StrategyContext {
  /** The run's market: risk limits, paper mode and trade reporting already applied. */
  readonly market: TradingMarket;
  readonly fleet: Fleet;
  /** Aborted when the run is stopped, halted by a risk limit, or failed by a sibling strategy. */
  readonly signal: AbortSignal;
  readonly log: Logger;
  /** Sleep that returns early when `signal` aborts. Always use this, never a bare timer. */
  sleep(ms: number): Promise<void>;
}

export type Readiness = { readonly ready: true; readonly detail?: LogData } | { readonly ready: false; readonly reason: string };

export type StrategyMetrics = Readonly<Record<string, number>>;

export interface Strategy {
  readonly name: string;
  readonly description: string;
  /** Can this start with the fleet and market as they are? Places no trades. */
  validate?(ctx: StrategyContext): Promise<Readiness>;
  /**
   * Trade until `ctx.signal` aborts or the strategy's own goal is met.
   *
   * Trade outcomes arrive as results; thrown errors end the strategy. Do not
   * catch `RiskLimitError` — it is how a limit stops the run.
   */
  run(ctx: StrategyContext): Promise<StrategyMetrics | void>;
}

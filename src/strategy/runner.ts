/**
 * Run one or more strategies against one market as a single supervised unit.
 *
 *   validate every strategy  →  lock the wallets  →  run concurrently  →  classify
 *
 * Strategies share one GuardedMarket (so one budget, one drawdown ledger, one
 * liquidity guard) and one fleet. A risk limit halts the whole run. A strategy
 * failure stops the run by default, because strategies configured together are
 * a unit: an operator who believes a grid and a rebalance are both running,
 * while the rebalance silently died, is running a different strategy.
 *
 * Refusals before the first trade THROW (`StrategyNotReadyError`,
 * `WalletsBusyError`, `ConfigError`). Once trading starts, every ending is a
 * `RunResult` — including halts and failures.
 */

import { ConfigError, RiskLimitError, StrategyNotReadyError, WalletsBusyError, type RiskLimitKind } from '../errors.ts';
import { sleep } from '../internal/async.ts';
import { scopedLogger, silentLogger, type Logger } from '../logger.ts';
import type { MarketInfo, TradeResult, TradingMarket } from '../market/types.ts';
import { GuardedMarket, type LedgerSnapshot, type RiskLimits } from '../risk/guarded-market.ts';
import type { Wallet } from '../wallet.ts';
import { Fleet } from './fleet.ts';
import type { Strategy, StrategyContext, StrategyMetrics } from './types.ts';

export type RunStatus = 'completed' | 'stopped' | 'halted' | 'failed';

export interface StrategyOutcome {
  readonly name: string;
  readonly status: RunStatus;
  readonly metrics: StrategyMetrics;
  readonly error?: string;
}

export interface RunResult {
  /**
   * completed — every strategy reached its own end.
   * stopped   — the caller aborted the signal.
   * halted    — a risk limit stopped trading (see `halt`).
   * failed    — a strategy threw (see `strategies[].error`).
   */
  readonly status: RunStatus;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly halt?: { readonly limit: RiskLimitKind; readonly message: string };
  readonly trades: { readonly filled: number; readonly failed: number; readonly unknown: number };
  readonly ledger: LedgerSnapshot;
  readonly strategies: readonly StrategyOutcome[];
}

export type RunEvent =
  | { readonly type: 'started'; readonly strategies: readonly string[]; readonly wallets: number; readonly paper: boolean; readonly market: MarketInfo }
  | { readonly type: 'trade'; readonly strategy: string; readonly result: TradeResult }
  | { readonly type: 'strategy-finished'; readonly outcome: StrategyOutcome }
  | { readonly type: 'halted'; readonly limit: RiskLimitKind; readonly message: string }
  | { readonly type: 'finished'; readonly result: RunResult };

export interface RunOptions {
  readonly market: TradingMarket;
  /** Wallets the run may trade. Every address is locked for the run's duration. */
  readonly wallets: readonly Wallet[];
  readonly strategies: Strategy | readonly Strategy[];
  /** `liquidityFloorPct` defaults to 50; pass 0 to disable it. */
  readonly risk?: RiskLimits;
  /** Simulate fills at spot; nothing is signed. */
  readonly paper?: boolean;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: RunEvent) => void;
  /** What a thrown strategy error does to its siblings. Default `'stop-run'`. */
  readonly onStrategyError?: 'stop-run' | 'continue';
  readonly logger?: Logger;
  /** Share one registry between runs to refuse overlapping wallets. `MarketMaker.run` supplies one. */
  readonly locks?: WalletLocks;
}

/**
 * Which wallets are being traded, and by whom. In-process only: it cannot see
 * another process trading the same keys.
 */
export class WalletLocks {
  private readonly held = new Map<string, string>();

  /** Reserve every address or none. Synchronous, so two runs starting together cannot both win. */
  acquire(addresses: readonly string[], owner: string): () => void {
    const keys = addresses.map((a) => a.toLowerCase());
    const busy = keys.filter((k) => this.held.has(k));
    if (busy.length > 0) throw new WalletsBusyError(busy, this.held.get(busy[0] as string) as string);
    for (const key of keys) this.held.set(key, owner);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const key of keys) if (this.held.get(key) === owner) this.held.delete(key);
    };
  }

  isHeld(address: string): boolean {
    return this.held.has(address.toLowerCase());
  }
}

function isStrategyList(value: Strategy | readonly Strategy[]): value is readonly Strategy[] {
  return Array.isArray(value);
}

/** Distinct labels for events, so two grids in one run can be told apart. */
function labelsFor(strategies: readonly Strategy[]): string[] {
  const counts = new Map<string, number>();
  return strategies.map((s) => {
    const n = (counts.get(s.name) ?? 0) + 1;
    counts.set(s.name, n);
    return n === 1 ? s.name : `${s.name}#${n}`;
  });
}

/** The same market, with every trade reported under one strategy's label. */
function attributed(market: TradingMarket, report: (result: TradeResult) => void): TradingMarket {
  return {
    info: market.info,
    snapshot: () => market.snapshot(),
    price: () => market.price(),
    quoteBuy: (amount, slippagePct) => market.quoteBuy(amount, slippagePct),
    quoteSell: (amount, slippagePct) => market.quoteSell(amount, slippagePct),
    tokenBalances: (addresses) => market.tokenBalances(addresses),
    quoteBalances: (addresses) => market.quoteBalances(addresses),
    nativeBalances: (addresses) => market.nativeBalances(addresses),
    blockNumber: () => market.blockNumber(),
    tradeFeed: (options) => market.tradeFeed(options),
    async buy(order) {
      const result = await market.buy(order);
      report(result);
      return result;
    },
    async sell(order) {
      const result = await market.sell(order);
      report(result);
      return result;
    },
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runStrategies(options: RunOptions): Promise<RunResult> {
  const strategies = isStrategyList(options.strategies) ? [...options.strategies] : [options.strategies];
  if (strategies.length === 0) throw new ConfigError('At least one strategy is required');
  for (const s of strategies) {
    if (!s || typeof s.name !== 'string' || typeof s.run !== 'function') throw new ConfigError('Every strategy needs a name and a run function');
  }
  const addresses = options.wallets.map((w) => w.address.toLowerCase());
  if (new Set(addresses).size !== addresses.length) throw new ConfigError('The same wallet was passed twice');

  const logger = options.logger ?? silentLogger;
  const emit = (event: RunEvent): void => {
    try {
      options.onEvent?.(event);
    } catch (error) {
      logger.warn('onEvent handler threw', { error: message(error) });
    }
  };

  const labels = labelsFor(strategies);
  const startedAt = Date.now();
  const trades = { filled: 0, failed: 0, unknown: 0 };
  const guarded = new GuardedMarket(options.market, {
    limits: { ...options.risk, liquidityFloorPct: options.risk?.liquidityFloorPct ?? 50 },
    paper: options.paper ?? false,
    logger,
  });
  const fleet = new Fleet(guarded, options.wallets);

  const internal = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, internal.signal]) : internal.signal;
  const contexts: StrategyContext[] = strategies.map((_, i) => {
    const label = labels[i] as string;
    return {
      market: attributed(guarded, (result) => {
        trades[result.status === 'filled' ? 'filled' : result.status]++;
        emit({ type: 'trade', strategy: label, result });
      }),
      fleet,
      signal,
      log: scopedLogger(logger, label),
      sleep: (ms) => sleep(ms, signal),
    };
  });

  const finish = (status: RunStatus, outcomes: StrategyOutcome[], halt?: RunResult['halt']): RunResult => {
    const result: RunResult = {
      status,
      startedAt,
      finishedAt: Date.now(),
      ...(halt ? { halt } : {}),
      trades: { ...trades },
      ledger: guarded.ledger,
      strategies: outcomes,
    };
    emit({ type: 'finished', result });
    return result;
  };

  if (options.signal?.aborted) {
    return finish('stopped', labels.map((name) => ({ name, status: 'stopped', metrics: {} })));
  }

  for (let i = 0; i < strategies.length; i++) {
    const readiness = await strategies[i]?.validate?.(contexts[i] as StrategyContext);
    if (readiness && !readiness.ready) throw new StrategyNotReadyError(labels[i] as string, readiness.reason);
  }

  const release = options.locks?.acquire(addresses, labels.join('+')) ?? (() => {});
  let halt: RunResult['halt'];
  try {
    emit({ type: 'started', strategies: labels, wallets: options.wallets.length, paper: options.paper ?? false, market: options.market.info });

    const outcomes = await Promise.all(
      strategies.map(async (strategy, i): Promise<StrategyOutcome> => {
        const name = labels[i] as string;
        let outcome: StrategyOutcome;
        try {
          const metrics = (await strategy.run(contexts[i] as StrategyContext)) ?? {};
          // Returning after the run was aborted — by the caller, a limit or a failed sibling — is a stop, not a completion.
          outcome = { name, status: halt ? 'halted' : signal.aborted ? 'stopped' : 'completed', metrics };
        } catch (error) {
          if (error instanceof RiskLimitError) {
            if (!halt) {
              halt = { limit: error.limit, message: error.message };
              emit({ type: 'halted', limit: error.limit, message: error.message });
            }
            internal.abort();
            outcome = { name, status: 'halted', metrics: {}, error: error.message };
          } else if (signal.aborted && (halt || options.signal?.aborted)) {
            // Interrupted by the stop itself, not a failure of its own.
            outcome = { name, status: halt ? 'halted' : 'stopped', metrics: {}, error: message(error) };
          } else {
            if ((options.onStrategyError ?? 'stop-run') === 'stop-run') internal.abort();
            outcome = { name, status: 'failed', metrics: {}, error: message(error) };
          }
        }
        emit({ type: 'strategy-finished', outcome });
        return outcome;
      }),
    );

    const status: RunStatus = halt
      ? 'halted'
      : outcomes.some((o) => o.status === 'failed')
        ? 'failed'
        : options.signal?.aborted
          ? 'stopped'
          : 'completed';
    return finish(status, outcomes, halt);
  } finally {
    release();
  }
}

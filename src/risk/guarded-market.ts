/**
 * Risk limits and paper trading, as a decorator over any TradingMarket.
 *
 * Every strategy trades through the market it is handed, so limits enforced
 * here bind all of them — including ones written later — and a set of
 * strategies sharing one GuardedMarket shares one budget. A limit implemented
 * per strategy is a limit some strategy forgets.
 *
 * Limits are checked before a BUY and never before a sell: they exist to stop
 * money leaving, and blocking an exit would trap the position being unwound.
 */

import { ConfigError, RiskLimitError } from '../errors.ts';
import { silentLogger, type Logger } from '../logger.ts';
import { parseAmount, formatAmount, type Amount } from '../units.ts';
import type {
  BuyOrder,
  MarketInfo,
  PoolSnapshot,
  SellOrder,
  TradeFeed,
  TradeFeedOptions,
  TradeQuote,
  TradeResult,
  TradingMarket,
} from '../market/types.ts';

export interface RiskLimits {
  /** Most quote asset buys may commit over the run. */
  readonly maxSpend?: number;
  /** Halt once the run is down this much, in quote, marked at the last fill price. Excludes gas. */
  readonly maxDrawdown?: number;
  /**
   * Halt when quote-side pool depth falls below this percent of its high-water
   * mark. A draining pool looks like a falling price — exactly what dip and
   * support strategies buy. 0 disables it.
   */
  readonly liquidityFloorPct?: number;
}

export interface GuardedMarketOptions {
  readonly limits: RiskLimits;
  /** Simulate fills at spot instead of trading. Models neither price impact nor fees. */
  readonly paper?: boolean;
  readonly onTrade?: (result: TradeResult) => void;
  readonly logger?: Logger;
  /** Minimum time between liquidity checks. Default 15s. */
  readonly liquidityCheckIntervalMs?: number;
  readonly now?: () => number;
}

/** What the run has done, from its own fills. */
export interface LedgerSnapshot {
  /** Quote committed to buys that filled or whose outcome is unknown. */
  readonly committedSpend: number;
  readonly quoteSpent: number;
  readonly quoteReceived: number;
  /** Tokens bought this run and not yet sold. */
  readonly inventory: number;
  readonly markPrice: number;
  /** quoteReceived + inventory × markPrice − quoteSpent. Excludes gas. */
  readonly netPnl: number;
}

export function validateRiskLimits(limits: RiskLimits): void {
  const problems: string[] = [];
  if (limits.maxSpend !== undefined && !(Number.isFinite(limits.maxSpend) && limits.maxSpend > 0)) {
    problems.push('maxSpend must be a positive number');
  }
  if (limits.maxDrawdown !== undefined && !(Number.isFinite(limits.maxDrawdown) && limits.maxDrawdown > 0)) {
    problems.push('maxDrawdown must be a positive number');
  }
  const floor = limits.liquidityFloorPct;
  if (floor !== undefined && !(Number.isFinite(floor) && floor >= 0 && floor < 100)) {
    problems.push('liquidityFloorPct must be at least 0 and below 100');
  }
  if (problems.length > 0) throw new ConfigError(`Invalid risk limits: ${problems.join('; ')}`);
}

export class GuardedMarket implements TradingMarket {
  readonly info: MarketInfo;
  private readonly inner: TradingMarket;
  private readonly limits: RiskLimits;
  private readonly paper: boolean;
  private readonly onTrade: ((result: TradeResult) => void) | undefined;
  private readonly logger: Logger;
  private readonly checkIntervalMs: number;
  private readonly now: () => number;

  private committed = 0;
  private quoteSpent = 0;
  private quoteReceived = 0;
  private inventory = 0;
  private markPrice = 0;
  private depthHighWater: number | undefined;
  private lastDepthCheck = -Infinity;

  constructor(inner: TradingMarket, options: GuardedMarketOptions) {
    validateRiskLimits(options.limits);
    this.inner = inner;
    this.info = inner.info;
    this.limits = options.limits;
    this.paper = options.paper ?? false;
    this.onTrade = options.onTrade;
    this.logger = options.logger ?? silentLogger;
    this.checkIntervalMs = options.liquidityCheckIntervalMs ?? 15_000;
    this.now = options.now ?? Date.now;
  }

  get ledger(): LedgerSnapshot {
    return {
      committedSpend: this.committed,
      quoteSpent: this.quoteSpent,
      quoteReceived: this.quoteReceived,
      inventory: this.inventory,
      markPrice: this.markPrice,
      netPnl: this.netPnl(),
    };
  }

  async buy(order: BuyOrder): Promise<TradeResult> {
    await this.guardLiquidity();
    // Before the spend cap: a run past its loss limit should stop for THAT reason.
    this.guardDrawdown();
    const amount = this.humanQuote(order.amount);
    this.commit(amount);

    let result: TradeResult;
    try {
      result = this.paper ? await this.paperBuy(order, amount) : await this.inner.buy(order);
    } catch (error) {
      this.committed -= amount; // a throw means nothing was broadcast
      throw error;
    }
    // A failed buy spent no quote (a reverted swap refunds it). An UNKNOWN one
    // may have: its commitment stays, so in-flight trades cannot slip past the cap.
    if (result.status === 'failed') this.committed -= amount;
    this.record(result);
    return result;
  }

  async sell(order: SellOrder): Promise<TradeResult> {
    const result = this.paper ? await this.paperSell(order) : await this.inner.sell(order);
    this.record(result);
    return result;
  }

  snapshot(): Promise<PoolSnapshot> {
    return this.inner.snapshot();
  }

  price(): Promise<number> {
    return this.inner.price();
  }

  quoteBuy(amount: Amount, slippagePct?: number): Promise<TradeQuote> {
    return this.inner.quoteBuy(amount, slippagePct);
  }

  quoteSell(amount: Amount, slippagePct?: number): Promise<TradeQuote> {
    return this.inner.quoteSell(amount, slippagePct);
  }

  tokenBalances(addresses: readonly string[]): Promise<number[]> {
    return this.inner.tokenBalances(addresses);
  }

  quoteBalances(addresses: readonly string[]): Promise<number[]> {
    return this.inner.quoteBalances(addresses);
  }

  nativeBalances(addresses: readonly string[]): Promise<number[]> {
    return this.inner.nativeBalances(addresses);
  }

  blockNumber(): Promise<number> {
    return this.inner.blockNumber();
  }

  tradeFeed(options: TradeFeedOptions): TradeFeed {
    return this.inner.tradeFeed(options);
  }

  // ── limits ───────────────────────────────────────────────────────────────

  private commit(amount: number): void {
    const cap = this.limits.maxSpend;
    if (cap === undefined) {
      this.committed += amount;
      return;
    }
    if (this.committed + amount > cap) {
      throw new RiskLimitError(
        'spend-cap',
        this.committed + amount,
        cap,
        `Spend cap reached: ${this.committed} of ${cap} ${this.quoteSymbol()} committed; a buy of ${amount} would exceed it`,
      );
    }
    this.committed += amount;
  }

  private guardDrawdown(): void {
    const limit = this.limits.maxDrawdown;
    if (limit === undefined) return;
    if (this.markPrice <= 0 && this.inventory > 0) return; // nothing priced yet
    const pnl = this.netPnl();
    if (pnl < 0 && -pnl > limit) {
      throw new RiskLimitError(
        'drawdown',
        -pnl,
        limit,
        `Drawdown limit reached: down ${(-pnl).toPrecision(6)} ${this.quoteSymbol()} against a limit of ${limit}. ` +
          'Marked at the last fill price; the position is not closed.',
      );
    }
  }

  /**
   * The baseline is the depth at the first check and follows depth UP, so a
   * pool that grew is not judged against the thin market it started as.
   * Checked at most once per interval: a pull does not reverse in seconds.
   */
  private async guardLiquidity(): Promise<void> {
    const floor = this.limits.liquidityFloorPct;
    if (!floor) return;
    const now = this.now();
    if (this.depthHighWater !== undefined && now - this.lastDepthCheck < this.checkIntervalMs) return;

    let depth: number;
    try {
      depth = (await this.inner.snapshot()).quoteReserve;
    } catch (error) {
      // An unreadable pool is not a drained one — but a guard that silently does
      // nothing is indistinguishable from one that is watching, so say so.
      this.logger.warn('Liquidity guard could not read the pool; not checked for this trade', {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (!(depth > 0)) {
      this.logger.warn('Liquidity guard read zero depth; not checked for this trade');
      return;
    }
    this.lastDepthCheck = now;
    if (this.depthHighWater === undefined || depth > this.depthHighWater) {
      if (this.depthHighWater === undefined) {
        this.logger.info('Liquidity guard armed', { depth, haltsBelow: depth * (floor / 100) });
      }
      this.depthHighWater = depth;
      return;
    }
    const threshold = this.depthHighWater * (floor / 100);
    if (depth < threshold) {
      throw new RiskLimitError(
        'liquidity-floor',
        depth,
        threshold,
        `Pool liquidity collapsed: ${depth} ${this.quoteSymbol()} of depth, down from ${this.depthHighWater}; refusing to buy into it`,
      );
    }
  }

  // ── ledger ───────────────────────────────────────────────────────────────

  private record(result: TradeResult): void {
    if (result.status === 'filled') {
      if (result.price > 0) this.markPrice = result.price;
      if (result.side === 'buy') {
        this.quoteSpent += result.quoteAmount;
        this.inventory += result.tokenAmount;
      } else {
        this.quoteReceived += result.quoteAmount;
        this.inventory = Math.max(0, this.inventory - result.tokenAmount);
      }
    }
    try {
      this.onTrade?.(result);
    } catch (error) {
      this.logger.warn('onTrade handler threw', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private netPnl(): number {
    return this.quoteReceived + this.inventory * this.markPrice - this.quoteSpent;
  }

  // ── paper ────────────────────────────────────────────────────────────────

  private async paperBuy(order: BuyOrder, amount: number): Promise<TradeResult> {
    const price = await this.paperPrice();
    if (!price) return { status: 'failed', side: 'buy', wallet: order.wallet.address, error: 'Paper fill could not be priced' };
    return { status: 'filled', side: 'buy', wallet: order.wallet.address, quoteAmount: amount, tokenAmount: amount / price, price, paper: true };
  }

  private async paperSell(order: SellOrder): Promise<TradeResult> {
    const wallet = order.wallet.address;
    const price = await this.paperPrice();
    if (!price) return { status: 'failed', side: 'sell', wallet, error: 'Paper fill could not be priced' };
    let tokens: number;
    if (order.amount === 'all') {
      const [balance] = await this.inner.tokenBalances([wallet]);
      tokens = balance ?? 0;
    } else {
      tokens = formatAmount(parseAmount(order.amount, this.info.token.decimals), this.info.token.decimals);
    }
    if (!(tokens > 0)) return { status: 'failed', side: 'sell', wallet, error: 'Nothing to sell' };
    return { status: 'filled', side: 'sell', wallet, quoteAmount: tokens * price, tokenAmount: tokens, price, paper: true };
  }

  private async paperPrice(): Promise<number | undefined> {
    try {
      const price = await this.inner.price();
      return price > 0 ? price : undefined;
    } catch {
      return undefined;
    }
  }

  private humanQuote(amount: Amount): number {
    return formatAmount(parseAmount(amount, this.info.quote.decimals), this.info.quote.decimals);
  }

  private quoteSymbol(): string {
    return this.info.quote.symbol ?? this.info.quote.address;
  }
}

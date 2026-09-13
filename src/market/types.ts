/**
 * The market contract strategies program against.
 *
 * `TradingMarket` is deliberately small and free of viem clients, so a strategy
 * can be tested against an in-memory fake and a risk wrapper can decorate any
 * implementation without knowing how it trades.
 */

import type { Address, Hex } from 'viem';
import type { DexKind } from '../chains.ts';
import { ConfigError } from '../errors.ts';
import type { Amount } from '../units.ts';
import type { Wallet } from '../wallet.ts';

export interface TokenInfo {
  readonly address: Address;
  readonly symbol: string | undefined;
  readonly decimals: number;
}

export interface MarketChainInfo {
  readonly id: string;
  readonly chainId: number;
  readonly testnet: boolean;
  readonly nativeSymbol: string;
  /** Native amount a wallet keeps aside per transaction for gas. */
  readonly feeHeadroom: number;
  /** Rough native cost of one swap. */
  readonly estimatedSwapFee: number;
}

export interface MarketInfo {
  readonly chain: MarketChainInfo;
  readonly dex: string;
  readonly dexKind: DexKind;
  /** Pool identity: an address on V2/V3, a PoolId on V4. */
  readonly pool: Address | Hex;
  /** The token being made a market in. */
  readonly token: TokenInfo;
  /** The asset it is priced in. The zero address is native ETH (V4 only). */
  readonly quote: TokenInfo;
  /**
   * Buys spend and sells receive native ETH: WETH-quoted V2/V3 pools (wrapped
   * by the router) and ETH-quoted V4 pools. Otherwise the quote token itself.
   */
  readonly settlesInNative: boolean;
  /** The quote is ETH or WETH, so quote amounts compare directly with gas costs. */
  readonly quoteIsEth: boolean;
  readonly feeBps: number;
}

export interface PoolSnapshot {
  /** Quote per token. */
  readonly price: number;
  /** Tradable depth, human units. */
  readonly tokenReserve: number;
  readonly quoteReserve: number;
  readonly fetchedAt: number;
}

export type TradeSide = 'buy' | 'sell';

/**
 * The outcome of one trade. Three states, not a boolean: `unknown` means the
 * transaction was broadcast and its outcome could not be established. It may
 * still land, so it must never be retried as though it had failed.
 */
export type TradeResult =
  | {
      readonly status: 'filled';
      readonly side: TradeSide;
      readonly wallet: Address;
      /** Quote spent (buy) or received (sell), read from the receipt. */
      readonly quoteAmount: number;
      /** Tokens received (buy) or sold (sell), read from the receipt. */
      readonly tokenAmount: number;
      /** Realised price, quote per token. */
      readonly price: number;
      readonly hash?: Hex;
      readonly block?: number;
      readonly feeNative?: number;
      /** Simulated fill; nothing was signed. */
      readonly paper?: true;
    }
  | { readonly status: 'failed'; readonly side: TradeSide; readonly wallet: Address; readonly error: string; readonly hash?: Hex }
  | { readonly status: 'unknown'; readonly side: TradeSide; readonly wallet: Address; readonly error: string; readonly hash?: Hex };

export interface BuyOrder {
  readonly wallet: Wallet;
  /** Quote asset to spend, human units. */
  readonly amount: Amount;
  /** Defaults to the trading policy's `defaultSlippagePct`. */
  readonly slippagePct?: number;
}

export interface SellOrder {
  readonly wallet: Wallet;
  /** Tokens to sell, human units, or `'all'` for the wallet's exact balance. */
  readonly amount: Amount | 'all';
  readonly slippagePct?: number;
  /** An explicit floor on quote received; takes precedence over slippage. */
  readonly minQuoteOut?: Amount;
}

export interface TradeQuote {
  readonly side: TradeSide;
  readonly amountIn: number;
  readonly amountOut: number;
  /** What the trade would accept at the given slippage. */
  readonly minAmountOut: number;
  /** Execution price versus spot, as a fraction: 0.01 is 1%. */
  readonly priceImpact: number;
  /** Quote per token at this size. */
  readonly price: number;
  readonly slippagePct: number;
  /** Why the trade would be refused before sending, or undefined if it would be sent. */
  readonly rejection: string | undefined;
}

/** A swap on this pool by someone outside the excluded set. */
export interface ExternalTrade {
  readonly hash: Hex;
  readonly logIndex: number;
  readonly block: number;
  /** Unix seconds. */
  readonly timestamp: number;
  /** The transaction sender — the trader, not the router. */
  readonly trader: Address;
  readonly side: TradeSide;
  readonly quoteAmount: number;
  readonly tokenAmount: number;
}

export interface TradeFeedOptions {
  readonly side: TradeSide;
  /** Addresses whose trades are never reported — normally your own fleet. */
  readonly exclude?: Iterable<string>;
  /** Ignore trades below this quote amount. */
  readonly minQuote?: number;
  /** First block to scan. Defaults to the chain head at the first poll. */
  readonly fromBlock?: number;
  /** Deliver at most this many per poll; the rest arrive on the next poll, oldest first. */
  readonly maxResults?: number;
}

/** A cursor over a pool's swaps. Each feed keeps its own position; two feeds never share one. */
export interface TradeFeed {
  poll(): Promise<ExternalTrade[]>;
}

export interface TradingMarket {
  readonly info: MarketInfo;
  snapshot(): Promise<PoolSnapshot>;
  /** Quote per token. Throws `ReadError` when the pool cannot be read. */
  price(): Promise<number>;
  quoteBuy(amount: Amount, slippagePct?: number): Promise<TradeQuote>;
  quoteSell(amount: Amount, slippagePct?: number): Promise<TradeQuote>;
  /** Never throws for a market or chain failure — returns `failed`/`unknown`. Throws `ConfigError` for bad input. */
  buy(order: BuyOrder): Promise<TradeResult>;
  sell(order: SellOrder): Promise<TradeResult>;
  tokenBalances(addresses: readonly string[]): Promise<number[]>;
  /** Balances of what buys spend: native ETH when `settlesInNative`, the quote token otherwise. */
  quoteBalances(addresses: readonly string[]): Promise<number[]>;
  nativeBalances(addresses: readonly string[]): Promise<number[]>;
  blockNumber(): Promise<number>;
  tradeFeed(options: TradeFeedOptions): TradeFeed;
}

/**
 * Trade-time safety policy.
 *
 * Slippage above a cap is REFUSED with `ConfigError`, not silently clamped:
 * being told 60% and given 50% is a preview that does not describe the trade.
 */
export interface TradingPolicy {
  readonly defaultSlippagePct: number;
  readonly maxBuySlippagePct: number;
  readonly maxSellSlippagePct: number;
  /**
   * Refuse a trade whose quoted price impact exceeds this. AMMs have no depth
   * floor of their own: a pool will quote a trade that consumes 99% of it.
   */
  readonly maxPriceImpactPct: number;
  /** Must outlive the executor's worst case (3 attempts × 45s) or a replacement can mine past it. */
  readonly deadlineSeconds: number;
  /** Most blocks one trade-feed poll scans. */
  readonly maxLogRange: number;
}

export const DEFAULT_TRADING_POLICY: TradingPolicy = {
  defaultSlippagePct: 5,
  maxBuySlippagePct: 15,
  maxSellSlippagePct: 50,
  maxPriceImpactPct: 10,
  deadlineSeconds: 195,
  maxLogRange: 2_000,
};

export function resolveTradingPolicy(overrides: Partial<TradingPolicy> = {}): TradingPolicy {
  const pick = <K extends keyof TradingPolicy>(key: K): TradingPolicy[K] => overrides[key] ?? DEFAULT_TRADING_POLICY[key];
  const policy: TradingPolicy = {
    defaultSlippagePct: pick('defaultSlippagePct'),
    maxBuySlippagePct: pick('maxBuySlippagePct'),
    maxSellSlippagePct: pick('maxSellSlippagePct'),
    maxPriceImpactPct: pick('maxPriceImpactPct'),
    deadlineSeconds: pick('deadlineSeconds'),
    maxLogRange: pick('maxLogRange'),
  };
  const problems: string[] = [];
  const pct = (name: keyof TradingPolicy, value: number): void => {
    if (!Number.isFinite(value) || value < 0 || value > 100) problems.push(`${name} must be between 0 and 100`);
  };
  pct('defaultSlippagePct', policy.defaultSlippagePct);
  pct('maxBuySlippagePct', policy.maxBuySlippagePct);
  pct('maxSellSlippagePct', policy.maxSellSlippagePct);
  pct('maxPriceImpactPct', policy.maxPriceImpactPct);
  if (policy.defaultSlippagePct > Math.min(policy.maxBuySlippagePct, policy.maxSellSlippagePct)) {
    problems.push('defaultSlippagePct cannot exceed maxBuySlippagePct or maxSellSlippagePct');
  }
  if (!Number.isFinite(policy.deadlineSeconds) || policy.deadlineSeconds < 30) problems.push('deadlineSeconds must be at least 30');
  if (!Number.isInteger(policy.maxLogRange) || policy.maxLogRange < 1) problems.push('maxLogRange must be a positive integer');
  if (problems.length > 0) throw new ConfigError(`Invalid trading policy: ${problems.join('; ')}`);
  return policy;
}

/**
 * In-memory doubles. Strategies, the risk wrapper and the runner depend only on
 * `TradingMarket`, which is what makes all of them testable without a chain.
 */

import type { Address } from 'viem';
import { robinhood } from '../src/chains.ts';
import { ReadError } from '../src/errors.ts';
import type {
  BuyOrder,
  ExternalTrade,
  MarketInfo,
  PoolSnapshot,
  SellOrder,
  TradeFeed,
  TradeFeedOptions,
  TradeQuote,
  TradeResult,
  TradeSide,
  TradingMarket,
} from '../src/market/types.ts';
import { silentLogger, type Logger } from '../src/logger.ts';
import { walletFromPrivateKey, type Wallet } from '../src/wallet.ts';
import { Fleet } from '../src/strategy/fleet.ts';
import type { StrategyContext } from '../src/strategy/types.ts';

export const TOKEN: Address = '0x00000000000000000000000000000000000000Aa';

export function makeWallets(count: number): Wallet[] {
  return Array.from({ length: count }, (_, i) => walletFromPrivateKey(`0x${(i + 1).toString(16).padStart(64, '0')}`, `w${i + 1}`));
}

export function marketInfo(overrides: Partial<MarketInfo> = {}): MarketInfo {
  return {
    chain: {
      id: robinhood.id,
      chainId: robinhood.chainId,
      testnet: false,
      nativeSymbol: 'ETH',
      feeHeadroom: robinhood.feeHeadroom,
      estimatedSwapFee: robinhood.estimatedSwapFee,
    },
    dex: 'fake',
    dexKind: 'v3',
    pool: '0x00000000000000000000000000000000000000Bb',
    token: { address: TOKEN, symbol: 'TKN', decimals: 18 },
    quote: { address: robinhood.wrappedNative, symbol: 'WETH', decimals: 18 },
    settlesInNative: true,
    quoteIsEth: true,
    feeBps: 30,
    ...overrides,
  };
}

type Outcome = 'filled' | 'failed' | 'unknown' | Error;

export interface RecordedOrder {
  readonly side: TradeSide;
  readonly wallet: Address;
  readonly amount: number | string;
}

export class FakeMarket implements TradingMarket {
  readonly info: MarketInfo;
  readonly orders: RecordedOrder[] = [];
  readonly feedOptions: TradeFeedOptions[] = [];
  /** Queued outcomes for the next trades; filled when empty. */
  readonly outcomes: Outcome[] = [];
  /** Batches returned by successive polls of any feed for a side. */
  readonly feeds: Record<TradeSide, ExternalTrade[][]> = { buy: [], sell: [] };
  depth = 10;
  failPrice = false;
  failSnapshot = false;
  priceReads = 0;

  private readonly prices: number[];
  private readonly native = new Map<string, number>();
  private readonly quote = new Map<string, number>();
  private readonly token = new Map<string, number>();

  constructor(options: { prices?: number[]; info?: Partial<MarketInfo> } = {}) {
    this.prices = options.prices ?? [1];
    this.info = marketInfo(options.info);
  }

  setBalances(wallet: Wallet, balances: { native?: number; quote?: number; token?: number }): this {
    const key = wallet.address.toLowerCase();
    if (balances.native !== undefined) this.native.set(key, balances.native);
    if (balances.quote !== undefined) this.quote.set(key, balances.quote);
    if (balances.token !== undefined) this.token.set(key, balances.token);
    return this;
  }

  balanceOf(wallet: Wallet): { native: number; quote: number; token: number } {
    const key = wallet.address.toLowerCase();
    return { native: this.native.get(key) ?? 0, quote: this.quote.get(key) ?? 0, token: this.token.get(key) ?? 0 };
  }

  /** The price trades fill at: the most recently read one. */
  get currentPrice(): number {
    return this.prices[Math.min(Math.max(0, this.priceReads - 1), this.prices.length - 1)] as number;
  }

  async price(): Promise<number> {
    if (this.failPrice) throw new ReadError('fake price failure');
    const price = this.prices[Math.min(this.priceReads, this.prices.length - 1)] as number;
    this.priceReads++;
    return price;
  }

  async snapshot(): Promise<PoolSnapshot> {
    if (this.failSnapshot) throw new ReadError('fake snapshot failure');
    return { price: this.currentPrice, tokenReserve: this.depth / this.currentPrice, quoteReserve: this.depth, fetchedAt: 0 };
  }

  async quoteBuy(amount: number | string): Promise<TradeQuote> {
    const a = Number(amount);
    return { side: 'buy', amountIn: a, amountOut: a / this.currentPrice, minAmountOut: 0, priceImpact: 0, price: this.currentPrice, slippagePct: 5, rejection: undefined };
  }

  async quoteSell(amount: number | string): Promise<TradeQuote> {
    const a = Number(amount);
    return { side: 'sell', amountIn: a, amountOut: a * this.currentPrice, minAmountOut: 0, priceImpact: 0, price: this.currentPrice, slippagePct: 5, rejection: undefined };
  }

  async buy(order: BuyOrder): Promise<TradeResult> {
    const wallet = order.wallet.address;
    const amount = Number(order.amount);
    this.orders.push({ side: 'buy', wallet, amount });
    const outcome = this.outcomes.shift() ?? 'filled';
    if (outcome instanceof Error) throw outcome;
    if (outcome !== 'filled') return { status: outcome, side: 'buy', wallet, error: `fake ${outcome}` };
    const key = wallet.toLowerCase();
    const price = this.currentPrice;
    const spend = this.info.settlesInNative ? this.native : this.quote;
    spend.set(key, (spend.get(key) ?? 0) - amount);
    this.token.set(key, (this.token.get(key) ?? 0) + amount / price);
    return { status: 'filled', side: 'buy', wallet, quoteAmount: amount, tokenAmount: amount / price, price };
  }

  async sell(order: SellOrder): Promise<TradeResult> {
    const wallet = order.wallet.address;
    const key = wallet.toLowerCase();
    const held = this.token.get(key) ?? 0;
    const amount = order.amount === 'all' ? held : Math.min(Number(order.amount), held);
    this.orders.push({ side: 'sell', wallet, amount: order.amount === 'all' ? 'all' : Number(order.amount) });
    const outcome = this.outcomes.shift() ?? 'filled';
    if (outcome instanceof Error) throw outcome;
    if (outcome !== 'filled') return { status: outcome, side: 'sell', wallet, error: `fake ${outcome}` };
    const price = this.currentPrice;
    this.token.set(key, held - amount);
    const receive = this.info.settlesInNative ? this.native : this.quote;
    receive.set(key, (receive.get(key) ?? 0) + amount * price);
    return { status: 'filled', side: 'sell', wallet, quoteAmount: amount * price, tokenAmount: amount, price };
  }

  async tokenBalances(addresses: readonly string[]): Promise<number[]> {
    return addresses.map((a) => this.token.get(a.toLowerCase()) ?? 0);
  }

  async quoteBalances(addresses: readonly string[]): Promise<number[]> {
    const source = this.info.settlesInNative ? this.native : this.quote;
    return addresses.map((a) => source.get(a.toLowerCase()) ?? 0);
  }

  async nativeBalances(addresses: readonly string[]): Promise<number[]> {
    return addresses.map((a) => this.native.get(a.toLowerCase()) ?? 0);
  }

  async blockNumber(): Promise<number> {
    return 100;
  }

  tradeFeed(options: TradeFeedOptions): TradeFeed {
    this.feedOptions.push(options);
    return { poll: async () => this.feeds[options.side].shift() ?? [] };
  }
}

export function externalSell(quoteAmount: number, overrides: Partial<ExternalTrade> = {}): ExternalTrade {
  return {
    hash: `0x${'ab'.repeat(32)}`,
    logIndex: 0,
    block: 100,
    timestamp: 0,
    trader: '0x00000000000000000000000000000000000000Cc',
    side: 'sell',
    quoteAmount,
    tokenAmount: quoteAmount,
    ...overrides,
  };
}

export interface Harness {
  readonly ctx: StrategyContext;
  readonly controller: AbortController;
  readonly warnings: string[];
  sleeps: number[];
}

/** A strategy context whose sleeps return immediately and abort the run after `maxSleeps`. */
export function harness(market: TradingMarket, wallets: readonly Wallet[], maxSleeps = 50): Harness {
  const controller = new AbortController();
  const warnings: string[] = [];
  const h: Harness = {
    controller,
    warnings,
    sleeps: [],
    ctx: {
      market,
      fleet: new Fleet(market, wallets, { random: () => 0 }),
      signal: controller.signal,
      log: capture(warnings),
      async sleep(ms: number) {
        h.sleeps.push(ms);
        if (h.sleeps.length >= maxSleeps) controller.abort();
      },
    },
  };
  return h;
}

function capture(into: string[]): Logger {
  return { ...silentLogger, warn: (m) => into.push(m), error: (m) => into.push(m) };
}

/**
 * The wallets a run trades with, and the balance questions strategies ask of them.
 */

import { ConfigError } from '../errors.ts';
import type { TradingMarket } from '../market/types.ts';
import type { Wallet } from '../wallet.ts';

export interface BuyerCandidate {
  readonly wallet: Wallet;
  /** Balance of what buys spend (native ETH or the quote token). */
  readonly quoteBalance: number;
  readonly nativeBalance: number;
}

export interface Holding {
  readonly wallet: Wallet;
  readonly tokenBalance: number;
}

export interface FleetOptions {
  /** Source of randomness for spreading buys across wallets. Injectable for tests. */
  readonly random?: () => number;
}

export class Fleet {
  readonly wallets: readonly Wallet[];
  private readonly market: TradingMarket;
  private readonly own: ReadonlySet<string>;
  private readonly random: () => number;

  constructor(market: TradingMarket, wallets: readonly Wallet[], options: FleetOptions = {}) {
    if (wallets.length === 0) throw new ConfigError('A fleet needs at least one wallet');
    this.market = market;
    this.wallets = wallets;
    this.own = new Set(wallets.map((w) => w.address.toLowerCase()));
    this.random = options.random ?? Math.random;
  }

  /** Lower-cased addresses of every wallet in the fleet — what trade feeds exclude. */
  get addresses(): ReadonlySet<string> {
    return this.own;
  }

  owns(address: string): boolean {
    return this.own.has(address.toLowerCase());
  }

  /**
   * A wallet that can fund a buy of `quoteAmount` AND pay gas for it.
   *
   * The scan starts at a random wallet so load spreads across the fleet instead
   * of draining the first funded wallet. Balances are read fresh every call.
   */
  async findBuyer(quoteAmount: number): Promise<BuyerCandidate | undefined> {
    const addresses = this.wallets.map((w) => w.address);
    const native = await this.market.nativeBalances(addresses);
    const { settlesInNative } = this.market.info;
    const quote = settlesInNative ? native : await this.market.quoteBalances(addresses);
    const headroom = this.market.info.chain.feeHeadroom;
    const count = this.wallets.length;
    const start = Math.min(count - 1, Math.floor(this.random() * count));
    for (let k = 0; k < count; k++) {
      const i = (start + k) % count;
      const nativeBalance = native[i] ?? 0;
      const quoteBalance = quote[i] ?? 0;
      const nativeNeeded = headroom + (settlesInNative ? quoteAmount : 0);
      if (nativeBalance >= nativeNeeded && quoteBalance >= quoteAmount) {
        return { wallet: this.wallets[i] as Wallet, quoteBalance, nativeBalance };
      }
    }
    return undefined;
  }

  /** Wallets holding at least `minTokens` (and more than zero), largest first. */
  async holders(minTokens = 0): Promise<Holding[]> {
    const balances = await this.market.tokenBalances(this.wallets.map((w) => w.address));
    return this.wallets
      .map((wallet, i) => ({ wallet, tokenBalance: balances[i] ?? 0 }))
      .filter((h) => h.tokenBalance > 0 && h.tokenBalance >= minTokens)
      .sort((a, b) => b.tokenBalance - a.tokenBalance);
  }

  /** Fleet-wide token and quote holdings. */
  async totals(): Promise<{ token: number; quote: number }> {
    const addresses = this.wallets.map((w) => w.address);
    const [tokens, quotes] = await Promise.all([this.market.tokenBalances(addresses), this.market.quoteBalances(addresses)]);
    const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
    return { token: sum(tokens), quote: sum(quotes) };
  }
}

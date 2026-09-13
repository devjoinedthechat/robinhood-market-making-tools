/**
 * The front door: one chain client, its DEXes, a trading policy and a wallet
 * lock registry, bundled so the common path is three calls.
 *
 *   const mm = createMarketMaker({ chain: robinhoodTestnet });
 *   const market = await mm.market(poolAddressOrId);
 *   const result = await mm.run({ market, wallets, strategies: gridStrategy() });
 *
 * Everything here is also usable piece by piece: `ChainClient`, `DexRegistry`,
 * `resolveMarket`, `GuardedMarket` and `runStrategies` are exported.
 */

import { getAddress, type Address, type Hex } from 'viem';
import type { DexKind, RobinhoodChain } from './chains.ts';
import { ChainClient, type ChainClientOptions } from './client/chain-client.ts';
import { DexRegistry } from './dex/registry.ts';
import { poolDepth, type V4PoolKey } from './dex/types.ts';
import { ZERO_ADDRESS, sameAddress, toAddress } from './internal/address.ts';
import type { Market } from './market/market.ts';
import { resolveMarket } from './market/resolve.ts';
import { resolveTradingPolicy, type TradingPolicy } from './market/types.ts';
import { runStrategies, WalletLocks, type RunOptions, type RunResult } from './strategy/runner.ts';
import { formatAmount } from './units.ts';

export interface MarketMakerOptions extends ChainClientOptions {
  /** Overrides for slippage caps, the price-impact limit and swap deadlines. */
  readonly trading?: Partial<TradingPolicy>;
}

export interface PoolCandidate {
  readonly dex: string;
  readonly dexKind: DexKind;
  /** Pass this to `market()`. An address on V2/V3, a PoolId on V4. */
  readonly pool: Address | Hex;
  readonly quote: Address;
  readonly feeBps: number;
  /** Quote per token. */
  readonly price: number;
  /** Tradable quote-side depth, human units. */
  readonly quoteDepth: number;
}

export class MarketMaker {
  readonly client: ChainClient;
  readonly dexes: DexRegistry;
  readonly policy: TradingPolicy;
  private readonly locks = new WalletLocks();

  constructor(options: MarketMakerOptions) {
    this.policy = resolveTradingPolicy(options.trading);
    this.client = new ChainClient(options);
    this.dexes = new DexRegistry(this.client);
  }

  get chain(): RobinhoodChain {
    return this.client.chain;
  }

  /**
   * A market on a pool, named by address (V2/V3), PoolId (V4) or PoolKey (V4,
   * which avoids scanning logs for the key). Pass `quote` when neither pool
   * token is a recognised quote asset.
   */
  market(ref: string | V4PoolKey, options: { readonly quote?: string } = {}): Promise<Market> {
    return resolveMarket(this.client, this.dexes, ref, { ...options, policy: this.policy });
  }

  /**
   * Tradable pools for a token, deepest first. Without `quote`, searches
   * against WETH (V2/V3/V4) and native ETH (V4). Hooked V4 pools cannot be
   * discovered by pair and must be named by PoolId.
   */
  async findPools(token: string, quote?: string): Promise<PoolCandidate[]> {
    const tokenAddress = toAddress(token, 'Token');
    const quotes = quote === undefined ? [getAddress(this.chain.wrappedNative), ZERO_ADDRESS] : [toAddress(quote, 'Quote')];
    const matches = (await Promise.all(quotes.map((q) => this.dexes.findPools(tokenAddress, q)))).flat();
    return matches
      .filter(({ connector, pool }) => connector.isTradable(pool))
      .map(({ pool }): PoolCandidate => {
        const tokenIs0 = sameAddress(pool.token0, tokenAddress);
        const { depth0, depth1 } = poolDepth(pool);
        return {
          dex: pool.dex,
          dexKind: pool.kind,
          pool: pool.id,
          quote: tokenIs0 ? pool.token1 : pool.token0,
          feeBps: pool.feeBps,
          price: tokenIs0 ? pool.price0In1 : pool.price0In1 > 0 ? 1 / pool.price0In1 : 0,
          quoteDepth: formatAmount(tokenIs0 ? depth1 : depth0, tokenIs0 ? pool.decimals1 : pool.decimals0),
        };
      })
      .sort((a, b) => b.quoteDepth - a.quoteDepth);
  }

  /** Run strategies with this instance's wallet locks, so two runs can never trade one wallet. */
  run(options: Omit<RunOptions, 'locks'>): Promise<RunResult> {
    return runStrategies({ logger: this.client.logger, ...options, locks: this.locks });
  }
}

export function createMarketMaker(options: MarketMakerOptions): MarketMaker {
  return new MarketMaker(options);
}

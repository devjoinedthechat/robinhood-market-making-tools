/**
 * Turn a pool reference into a Market: find the owning DEX and decide which
 * side is the token and which is the quote.
 */

import type { Address, Hex } from 'viem';
import type { RobinhoodChain } from '../chains.ts';
import type { ChainClient } from '../client/chain-client.ts';
import type { DexRegistry, PoolMatch } from '../dex/registry.ts';
import type { V4PoolKey } from '../dex/types.ts';
import { ConfigError, PoolNotFoundError } from '../errors.ts';
import { isZeroAddress, sameAddress, toAddress, toPoolRef } from '../internal/address.ts';
import { Market } from './market.ts';
import type { TradingPolicy } from './types.ts';

export interface QuoteSideChoice {
  readonly token: Address;
  readonly quote: Address;
  /** Neither side, or both, was recognisable as a quote asset; the choice is a convention. */
  readonly ambiguous: boolean;
}

function quoteRank(address: Address, chain: RobinhoodChain): number {
  if (isZeroAddress(address) || sameAddress(address, chain.wrappedNative)) return 2;
  return chain.knownQuoteTokens[address.toLowerCase()] ? 1 : 0;
}

/**
 * Which pool token is the quote.
 *
 * Decided by rank, never by token0/token1 order: on a pool where neither side is
 * ETH, sort order carries no information, and picking token0 inverted every
 * price and PnL figure on roughly half of real pairs.
 */
export function chooseQuoteSide(token0: Address, token1: Address, chain: RobinhoodChain, explicitQuote?: Address): QuoteSideChoice {
  if (explicitQuote) {
    if (sameAddress(explicitQuote, token0)) return { token: token1, quote: token0, ambiguous: false };
    if (sameAddress(explicitQuote, token1)) return { token: token0, quote: token1, ambiguous: false };
    throw new ConfigError(`Quote ${explicitQuote} is not one of the pool's tokens (${token0} / ${token1})`);
  }
  const rank0 = quoteRank(token0, chain);
  const rank1 = quoteRank(token1, chain);
  if (rank0 > rank1) return { token: token1, quote: token0, ambiguous: false };
  if (rank1 > rank0) return { token: token0, quote: token1, ambiguous: false };
  // Two recognised quote assets (WETH/USDG) keep token0 as quote; two unknown
  // tokens assume token1. Either way the caller should name the quote.
  return rank0 > 0 ? { token: token1, quote: token0, ambiguous: true } : { token: token0, quote: token1, ambiguous: true };
}

export interface ResolveMarketOptions {
  /** The quote side, for pools where it cannot be inferred. */
  readonly quote?: string;
  readonly policy: TradingPolicy;
}

export async function resolveMarket(
  client: ChainClient,
  registry: DexRegistry,
  ref: string | V4PoolKey,
  options: ResolveMarketOptions,
): Promise<Market> {
  let match: PoolMatch | null;
  let label: string;
  if (typeof ref === 'string') {
    const poolRef: Address | Hex = toPoolRef(ref);
    label = poolRef;
    match = await registry.resolve(poolRef);
  } else {
    const v4 = registry.v4;
    if (!v4) throw new ConfigError(`${client.chain.name} has no Uniswap V4 deployment`);
    label = `V4 key ${ref.currency0}/${ref.currency1}/${ref.fee}/${ref.tickSpacing}/${ref.hooks}`;
    const pool = await v4.getPoolByKey(ref);
    match = pool ? { connector: v4, pool } : null;
  }

  if (!match) {
    const dexes = client.chain.dexes.map((d) => d.label).join(', ');
    throw new PoolNotFoundError(
      label,
      `${label} is not an initialised pool on any configured DEX on ${client.chain.name} (${dexes}). ` +
        'A V4 pool is named by its 64-character PoolId or its PoolKey, not an address.',
    );
  }

  const { pool, connector } = match;
  const explicit = options.quote === undefined ? undefined : toAddress(options.quote, 'Quote');
  const choice = chooseQuoteSide(pool.token0, pool.token1, client.chain, explicit);
  if (choice.ambiguous) {
    client.logger.warn('Could not tell which pool token is the quote; pass `quote` to be sure', {
      pool: pool.id,
      assumedQuote: choice.quote,
    });
  }
  const tokenIs0 = sameAddress(choice.token, pool.token0);
  const [tokenSymbol, quoteSymbol] = await Promise.all([client.tokenSymbol(choice.token), client.tokenSymbol(choice.quote)]);

  return new Market({
    client,
    connector,
    pool,
    token: { address: choice.token, symbol: tokenSymbol, decimals: tokenIs0 ? pool.decimals0 : pool.decimals1 },
    quote: { address: choice.quote, symbol: quoteSymbol, decimals: tokenIs0 ? pool.decimals1 : pool.decimals0 },
    policy: options.policy,
  });
}

/**
 * The DEX connector contract.
 *
 * A connector knows how to read a pool, quote a swap and build its calldata.
 * It never signs or sends: execution belongs to the executor, and trading
 * policy (slippage, impact limits, fill accounting) belongs to the Market.
 */

import type { Address, Hex, Log } from 'viem';
import type { DexDeployment, DexKind } from '../chains.ts';

/** Concentrated-liquidity state shared by V3 and V4 pools. */
export interface ConcentratedState {
  readonly fee: number;
  readonly sqrtPriceX96: bigint;
  readonly tick: number;
  readonly liquidity: bigint;
  readonly tickSpacing: number;
}

/** The five fields whose hash is a V4 pool's identity. */
export interface V4PoolKey {
  readonly currency0: Address;
  readonly currency1: Address;
  readonly fee: number;
  readonly tickSpacing: number;
  readonly hooks: Address;
}

export interface PoolState {
  readonly dex: string;
  readonly kind: DexKind;
  /**
   * The pool's identity: its address on V2/V3, its PoolId on V4. Key anything
   * pool-specific on this, never on `address`.
   */
  readonly id: Address | Hex;
  /**
   * The contract the pool lives in and emits logs from: the pool itself on
   * V2/V3, the PoolManager singleton on V4 (shared by every V4 pool).
   */
  readonly address: Address;
  readonly token0: Address;
  readonly token1: Address;
  readonly decimals0: number;
  readonly decimals1: number;
  readonly feeBps: number;
  /**
   * Raw reserves. Exact for V2. For V3, the pool's ERC-20 balances (includes
   * out-of-range liquidity). For V4, virtual reserves from liquidity and price.
   * Use `poolDepth` for tradable depth.
   */
  readonly reserve0: bigint;
  readonly reserve1: bigint;
  /** Spot price of token0 in token1, decimal-adjusted. */
  readonly price0In1: number;
  readonly concentrated?: ConcentratedState;
  readonly v4Key?: V4PoolKey;
  readonly fetchedAt: number;
}

export interface QuoteParams {
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountIn: bigint;
}

export interface DexQuote {
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  /** Execution price versus spot, as a fraction: 0.01 is 1%. */
  readonly priceImpact: number;
  readonly insufficientLiquidity: boolean;
}

export interface SwapParams {
  readonly pool: PoolState;
  /** Receives the output. */
  readonly recipient: Address;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountIn: bigint;
  /** Minimum acceptable output, slippage already applied. */
  readonly minAmountOut: bigint;
  /** V2/V3: pay native ETH (tokenIn must be WETH). Ignored by V4, whose pool currency decides. */
  readonly nativeIn: boolean;
  /** V2/V3: receive native ETH (tokenOut must be WETH). Ignored by V4. */
  readonly nativeOut: boolean;
  /** Unix seconds. */
  readonly deadline: bigint;
}

export interface SwapCall {
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
  /** Contract that needs an ERC-20 allowance for `tokenIn`; undefined when paying native. */
  readonly approvalSpender?: Address;
  /** V4: after approving Permit2 (`approvalSpender`), Permit2 must also approve this spender. */
  readonly permit2Spender?: Address;
  readonly estimatedGas: bigint;
}

/** One decoded swap, amounts from the pool's point of view. */
export interface SwapLog {
  readonly txHash: Hex;
  readonly logIndex: number;
  readonly blockNumber: bigint;
  readonly sender: Address;
  readonly recipient: Address;
  readonly amount0In: bigint;
  readonly amount1In: bigint;
  readonly amount0Out: bigint;
  readonly amount1Out: bigint;
}

export interface DexConnector {
  readonly id: string;
  readonly kind: DexKind;
  readonly deployment: DexDeployment;
  /** A pool by reference — an address on V2/V3, a PoolId on V4 — or null if it is not one of this DEX's. */
  getPool(ref: Address | Hex): Promise<PoolState | null>;
  /** Every pool this DEX has for the pair (one per fee tier on V3/V4). */
  findPools(tokenA: Address, tokenB: Address): Promise<PoolState[]>;
  /** Initialised and quotable. NOT "has in-range liquidity" — see the V3 connector. */
  isTradable(pool: PoolState): boolean;
  quote(pool: PoolState, params: QuoteParams): Promise<DexQuote>;
  buildSwap(params: SwapParams): SwapCall;
  /** The `eth_getLogs` filter that selects this pool's swaps and nothing else. */
  swapLogFilter(pool: PoolState): SwapLogFilter;
  parseSwapLogs(pool: PoolState, logs: readonly Log[]): SwapLog[];
}

export interface SwapLogFilter {
  readonly address: Address;
  readonly topics: readonly Hex[];
}

const Q96 = 2n ** 96n;

/**
 * Tradable depth per side, in raw units.
 *
 * V2 reserves are the depth. For V3 neither obvious number is: ERC-20 balances
 * include out-of-range liquidity (reserve-implied price disagreed with slot0 by
 * up to 8x on live pools), while virtual reserves can exceed what the pool
 * holds. So take the virtual reserves and scale BOTH sides down by the same
 * factor until neither exceeds the balance: the implied price is preserved and
 * the figures never claim more than the pool owns.
 */
export function poolDepth(pool: PoolState): { depth0: bigint; depth1: bigint } {
  if (pool.kind !== 'v3') return { depth0: pool.reserve0, depth1: pool.reserve1 };
  const state = pool.concentrated;
  if (!state || state.liquidity <= 0n || state.sqrtPriceX96 <= 0n) return { depth0: 0n, depth1: 0n };

  const virtual0 = (state.liquidity * Q96) / state.sqrtPriceX96;
  const virtual1 = (state.liquidity * state.sqrtPriceX96) / Q96;
  if (virtual0 <= 0n || virtual1 <= 0n) return { depth0: 0n, depth1: 0n };

  let num = 1n;
  let den = 1n;
  if (pool.reserve0 * den < virtual0 * num) {
    num = pool.reserve0;
    den = virtual0;
  }
  if (pool.reserve1 * den < virtual1 * num) {
    num = pool.reserve1;
    den = virtual1;
  }
  return { depth0: (virtual0 * num) / den, depth1: (virtual1 * num) / den };
}

/** Decimal-adjusted price of token0 in token1 from a Q64.96 square-root price. */
export function priceFromSqrtPriceX96(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  if (sqrtPriceX96 === 0n) return 0;
  const ratio = Number(sqrtPriceX96) / Number(Q96);
  return ratio * ratio * 10 ** (decimals0 - decimals1);
}

/** Execution price versus spot, as a fraction, from human amounts. */
export function priceImpact(spotOutPerIn: number, amountInHuman: number, amountOutHuman: number): number {
  if (!(spotOutPerIn > 0) || !(amountInHuman > 0)) return 0;
  return Math.max(0, 1 - amountOutHuman / amountInHuman / spotOutPerIn);
}

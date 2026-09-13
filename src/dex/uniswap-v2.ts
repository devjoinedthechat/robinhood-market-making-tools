/**
 * Uniswap V2-compatible pools.
 *
 * Swaps use the `…SupportingFeeOnTransferTokens` router variants so tokens with
 * a transfer tax do not revert on the router's own output check.
 */

import { decodeEventLog, encodeFunctionData, getAddress, toEventSelector, type Address, type Hex, type Log } from 'viem';
import type { DexDeployment } from '../chains.ts';
import type { ChainClient } from '../client/chain-client.ts';
import { UNISWAP_V2_FACTORY_ABI, UNISWAP_V2_PAIR_ABI, UNISWAP_V2_ROUTER_ABI } from '../client/abis.ts';
import { ConfigError } from '../errors.ts';
import { ZERO_ADDRESS, isPoolId, sameAddress } from '../internal/address.ts';
import type { DexConnector, DexQuote, PoolState, QuoteParams, SwapCall, SwapLog, SwapLogFilter, SwapParams } from './types.ts';

const SWAP_GAS = 180_000n;
const SWAP_TOPIC = toEventSelector('Swap(address,uint256,uint256,uint256,uint256,address)');

export class UniswapV2Connector implements DexConnector {
  readonly kind = 'v2' as const;
  readonly id: string;
  readonly deployment: DexDeployment;
  private readonly client: ChainClient;
  private readonly factory: Address;
  private readonly router: Address;
  private readonly feeBps: number;
  private readonly wrappedNative: Address;

  constructor(deployment: DexDeployment, client: ChainClient) {
    if (deployment.kind !== 'v2') throw new ConfigError(`${deployment.id} is not a V2 deployment`);
    this.deployment = deployment;
    this.client = client;
    this.id = deployment.id;
    this.factory = getAddress(deployment.factory);
    this.router = getAddress(deployment.router);
    this.feeBps = deployment.feeBps ?? 30;
    this.wrappedNative = getAddress(client.chain.wrappedNative);
  }

  async getPool(ref: Address | Hex): Promise<PoolState | null> {
    if (isPoolId(ref)) return null;
    const pair = getAddress(ref);
    try {
      const [token0, token1, factory, reserves] = await this.client.publicClient.multicall({
        contracts: [
          { address: pair, abi: UNISWAP_V2_PAIR_ABI, functionName: 'token0' },
          { address: pair, abi: UNISWAP_V2_PAIR_ABI, functionName: 'token1' },
          { address: pair, abi: UNISWAP_V2_PAIR_ABI, functionName: 'factory' },
          { address: pair, abi: UNISWAP_V2_PAIR_ABI, functionName: 'getReserves' },
        ],
        allowFailure: false,
        multicallAddress: this.client.chain.multicall3,
      });
      if (!sameAddress(factory, this.factory)) return null;
      const [decimals0, decimals1] = await Promise.all([this.client.tokenDecimals(token0), this.client.tokenDecimals(token1)]);
      const [reserve0, reserve1] = reserves;
      return {
        dex: this.id,
        kind: 'v2',
        id: pair,
        address: pair,
        token0: getAddress(token0),
        token1: getAddress(token1),
        decimals0,
        decimals1,
        feeBps: this.feeBps,
        reserve0,
        reserve1,
        price0In1: priceFromReserves(reserve0, reserve1, decimals0, decimals1),
        fetchedAt: Date.now(),
      };
    } catch (error) {
      this.client.logger.debug('Not a V2 pair, or the read failed', { pool: pair, error: String(error) });
      return null;
    }
  }

  async findPools(tokenA: Address, tokenB: Address): Promise<PoolState[]> {
    const pair = await this.client.publicClient.readContract({
      address: this.factory,
      abi: UNISWAP_V2_FACTORY_ABI,
      functionName: 'getPair',
      args: [getAddress(tokenA), getAddress(tokenB)],
    });
    if (sameAddress(pair, ZERO_ADDRESS)) return [];
    const pool = await this.getPool(pair);
    return pool ? [pool] : [];
  }

  isTradable(pool: PoolState): boolean {
    return pool.reserve0 > 0n && pool.reserve1 > 0n;
  }

  /** Constant-product math, identical to the pair contract's `getAmountOut`. */
  async quote(pool: PoolState, params: QuoteParams): Promise<DexQuote> {
    const inputIs0 = sameAddress(params.tokenIn, pool.token0);
    if (!inputIs0 && !sameAddress(params.tokenIn, pool.token1)) {
      throw new ConfigError(`Token ${params.tokenIn} is not in pool ${pool.id}`);
    }
    const reserveIn = inputIs0 ? pool.reserve0 : pool.reserve1;
    const reserveOut = inputIs0 ? pool.reserve1 : pool.reserve0;
    const { amountIn } = params;
    if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) {
      return { amountIn, amountOut: 0n, priceImpact: 1, insufficientLiquidity: true };
    }
    const amountInWithFee = amountIn * BigInt(10_000 - this.feeBps);
    const amountOut = (amountInWithFee * reserveOut) / (reserveIn * 10_000n + amountInWithFee);
    const spot = Number(reserveOut) / Number(reserveIn);
    const executed = Number(amountOut) / Number(amountIn);
    return {
      amountIn,
      amountOut,
      priceImpact: spot > 0 ? Math.max(0, 1 - executed / spot) : 1,
      // amountOut < reserveOut always holds for constant product; flag instead a
      // trade that would drain most of the output side, which is reachable.
      insufficientLiquidity: amountOut <= 0n || amountOut * 10n >= reserveOut * 9n,
    };
  }

  buildSwap(params: SwapParams): SwapCall {
    const { amountIn, minAmountOut, recipient, deadline } = params;
    const path: Address[] = [getAddress(params.tokenIn), getAddress(params.tokenOut)];

    if (params.nativeIn) {
      if (!sameAddress(params.tokenIn, this.wrappedNative)) throw new ConfigError('nativeIn requires tokenIn to be WETH');
      return {
        to: this.router,
        data: encodeFunctionData({
          abi: UNISWAP_V2_ROUTER_ABI,
          functionName: 'swapExactETHForTokensSupportingFeeOnTransferTokens',
          args: [minAmountOut, path, recipient, deadline],
        }),
        value: amountIn,
        estimatedGas: SWAP_GAS,
      };
    }
    if (params.nativeOut) {
      if (!sameAddress(params.tokenOut, this.wrappedNative)) throw new ConfigError('nativeOut requires tokenOut to be WETH');
      return {
        to: this.router,
        data: encodeFunctionData({
          abi: UNISWAP_V2_ROUTER_ABI,
          functionName: 'swapExactTokensForETHSupportingFeeOnTransferTokens',
          args: [amountIn, minAmountOut, path, recipient, deadline],
        }),
        value: 0n,
        approvalSpender: this.router,
        estimatedGas: SWAP_GAS,
      };
    }
    return {
      to: this.router,
      data: encodeFunctionData({
        abi: UNISWAP_V2_ROUTER_ABI,
        functionName: 'swapExactTokensForTokensSupportingFeeOnTransferTokens',
        args: [amountIn, minAmountOut, path, recipient, deadline],
      }),
      value: 0n,
      approvalSpender: this.router,
      estimatedGas: SWAP_GAS,
    };
  }

  swapLogFilter(pool: PoolState): SwapLogFilter {
    return { address: pool.address, topics: [SWAP_TOPIC] };
  }

  parseSwapLogs(pool: PoolState, logs: readonly Log[]): SwapLog[] {
    const trades: SwapLog[] = [];
    for (const entry of logs) {
      if (!sameAddress(entry.address, pool.address) || !entry.transactionHash) continue;
      try {
        const decoded = decodeEventLog({ abi: UNISWAP_V2_PAIR_ABI, data: entry.data, topics: entry.topics });
        if (decoded.eventName !== 'Swap') continue;
        const a = decoded.args;
        trades.push({
          txHash: entry.transactionHash,
          logIndex: entry.logIndex ?? 0,
          blockNumber: entry.blockNumber ?? 0n,
          sender: a.sender,
          recipient: a.to,
          amount0In: a.amount0In,
          amount1In: a.amount1In,
          amount0Out: a.amount0Out,
          amount1Out: a.amount1Out,
        });
      } catch {
        // not a Swap log
      }
    }
    return trades;
  }
}

/** Decimal-adjusted price of token0 in token1 from reserves. */
export function priceFromReserves(reserve0: bigint, reserve1: bigint, decimals0: number, decimals1: number): number {
  if (reserve0 === 0n) return 0;
  return Number(reserve1) / 10 ** decimals1 / (Number(reserve0) / 10 ** decimals0);
}

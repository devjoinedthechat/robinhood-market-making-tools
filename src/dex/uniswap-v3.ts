/**
 * Uniswap V3-compatible pools (Uniswap V3 on mainnet, Synthra V3 on testnet).
 *
 * Quotes come from QuoterV2 via eth_call — exact and tick-crossing aware. Swaps
 * go through SwapRouter02's `exactInputSingle`, wrapped in `multicall` so a
 * deadline can be attached and WETH unwrapped on the way out.
 */

import { decodeEventLog, encodeFunctionData, getAddress, toEventSelector, type Address, type Hex, type Log } from 'viem';
import type { DexDeployment } from '../chains.ts';
import type { ChainClient } from '../client/chain-client.ts';
import {
  ERC20_ABI,
  SWAP_ROUTER02_ADDRESS_THIS,
  UNISWAP_V3_FACTORY_ABI,
  UNISWAP_V3_POOL_ABI,
  UNISWAP_V3_QUOTER_V2_ABI,
  UNISWAP_V3_SWAP_ROUTER02_ABI,
} from '../client/abis.ts';
import { ConfigError } from '../errors.ts';
import { ZERO_ADDRESS, isPoolId, sameAddress, sortTokens } from '../internal/address.ts';
import {
  priceFromSqrtPriceX96,
  priceImpact,
  type DexConnector,
  type DexQuote,
  type PoolState,
  type QuoteParams,
  type SwapCall,
  type SwapLog,
  type SwapLogFilter,
  type SwapParams,
} from './types.ts';

const SWAP_GAS = 220_000n;
const SWAP_TOPIC = toEventSelector('Swap(address,address,int256,int256,uint160,uint128,int24)');
const DEFAULT_FEE_TIERS = [100, 500, 3000, 10000] as const;

export class UniswapV3Connector implements DexConnector {
  readonly kind = 'v3' as const;
  readonly id: string;
  readonly deployment: DexDeployment;
  private readonly client: ChainClient;
  private readonly factory: Address;
  private readonly router: Address;
  private readonly quoter: Address;
  private readonly feeTiers: readonly number[];
  private readonly wrappedNative: Address;

  constructor(deployment: DexDeployment, client: ChainClient) {
    if (deployment.kind !== 'v3') throw new ConfigError(`${deployment.id} is not a V3 deployment`);
    if (!deployment.quoter) throw new ConfigError(`V3 deployment ${deployment.id} needs a quoter address`);
    this.deployment = deployment;
    this.client = client;
    this.id = deployment.id;
    this.factory = getAddress(deployment.factory);
    this.router = getAddress(deployment.router);
    this.quoter = getAddress(deployment.quoter);
    this.feeTiers = deployment.feeTiers ?? DEFAULT_FEE_TIERS;
    this.wrappedNative = getAddress(client.chain.wrappedNative);
  }

  async getPool(ref: Address | Hex): Promise<PoolState | null> {
    if (isPoolId(ref)) return null;
    const pool = getAddress(ref);
    const client = this.client.publicClient;
    try {
      const [token0, token1, factory, fee, liquidity, slot0, tickSpacing] = await client.multicall({
        contracts: [
          { address: pool, abi: UNISWAP_V3_POOL_ABI, functionName: 'token0' },
          { address: pool, abi: UNISWAP_V3_POOL_ABI, functionName: 'token1' },
          { address: pool, abi: UNISWAP_V3_POOL_ABI, functionName: 'factory' },
          { address: pool, abi: UNISWAP_V3_POOL_ABI, functionName: 'fee' },
          { address: pool, abi: UNISWAP_V3_POOL_ABI, functionName: 'liquidity' },
          { address: pool, abi: UNISWAP_V3_POOL_ABI, functionName: 'slot0' },
          { address: pool, abi: UNISWAP_V3_POOL_ABI, functionName: 'tickSpacing' },
        ],
        allowFailure: false,
        multicallAddress: this.client.chain.multicall3,
      });
      if (!sameAddress(factory, this.factory)) return null;
      const t0 = getAddress(token0);
      const t1 = getAddress(token1);
      const [decimals0, decimals1, balance0, balance1] = await Promise.all([
        this.client.tokenDecimals(t0),
        this.client.tokenDecimals(t1),
        client.readContract({ address: t0, abi: ERC20_ABI, functionName: 'balanceOf', args: [pool] }),
        client.readContract({ address: t1, abi: ERC20_ABI, functionName: 'balanceOf', args: [pool] }),
      ]);
      const sqrtPriceX96 = slot0[0];
      return {
        dex: this.id,
        kind: 'v3',
        id: pool,
        address: pool,
        token0: t0,
        token1: t1,
        decimals0,
        decimals1,
        // `fee` is in hundredths of a basis point: 3000 = 0.30% = 30 bps.
        feeBps: Number(fee) / 100,
        reserve0: balance0,
        reserve1: balance1,
        price0In1: priceFromSqrtPriceX96(sqrtPriceX96, decimals0, decimals1),
        concentrated: { fee: Number(fee), sqrtPriceX96, tick: Number(slot0[1]), liquidity, tickSpacing: Number(tickSpacing) },
        fetchedAt: Date.now(),
      };
    } catch (error) {
      this.client.logger.debug('Not a V3 pool, or the read failed', { pool, error: String(error) });
      return null;
    }
  }

  async findPools(tokenA: Address, tokenB: Address): Promise<PoolState[]> {
    const [a, b] = sortTokens(getAddress(tokenA), getAddress(tokenB));
    const found = await this.client.publicClient.multicall({
      contracts: this.feeTiers.map((fee) => ({
        address: this.factory,
        abi: UNISWAP_V3_FACTORY_ABI,
        functionName: 'getPool' as const,
        args: [a, b, fee] as const,
      })),
      allowFailure: true,
      multicallAddress: this.client.chain.multicall3,
    });
    const addresses = found.flatMap((r) => (r.status === 'success' && !sameAddress(r.result, ZERO_ADDRESS) ? [r.result] : []));
    const pools = await Promise.all(addresses.map((address) => this.getPool(address)));
    return pools.filter((p): p is PoolState => p !== null);
  }

  /**
   * Initialised — NOT "has liquidity at the current tick".
   *
   * `liquidity` is only what is in range at the current price. A launch seeds
   * one-sided liquidity entirely above spot, so in-range liquidity is zero and
   * the pool is still perfectly tradable: the first buy crosses into the range.
   * The quoter is the authority on whether a swap fills.
   */
  isTradable(pool: PoolState): boolean {
    return (pool.concentrated?.sqrtPriceX96 ?? 0n) > 0n;
  }

  async quote(pool: PoolState, params: QuoteParams): Promise<DexQuote> {
    const state = pool.concentrated;
    const inputIs0 = sameAddress(params.tokenIn, pool.token0);
    if (!inputIs0 && !sameAddress(params.tokenIn, pool.token1)) {
      throw new ConfigError(`Token ${params.tokenIn} is not in pool ${pool.id}`);
    }
    const empty: DexQuote = { amountIn: params.amountIn, amountOut: 0n, priceImpact: 1, insufficientLiquidity: true };
    if (!state || params.amountIn <= 0n || !this.isTradable(pool)) return empty;

    try {
      const { result } = await this.client.publicClient.simulateContract({
        address: this.quoter,
        abi: UNISWAP_V3_QUOTER_V2_ABI,
        functionName: 'quoteExactInputSingle',
        args: [
          {
            tokenIn: getAddress(params.tokenIn),
            tokenOut: getAddress(params.tokenOut),
            amountIn: params.amountIn,
            fee: state.fee,
            sqrtPriceLimitX96: 0n,
          },
        ],
      });
      const amountOut = result[0];
      const spot = inputIs0 ? pool.price0In1 : pool.price0In1 > 0 ? 1 / pool.price0In1 : 0;
      const decimalsIn = inputIs0 ? pool.decimals0 : pool.decimals1;
      const decimalsOut = inputIs0 ? pool.decimals1 : pool.decimals0;
      return {
        amountIn: params.amountIn,
        amountOut,
        priceImpact: priceImpact(spot, Number(params.amountIn) / 10 ** decimalsIn, Number(amountOut) / 10 ** decimalsOut),
        insufficientLiquidity: amountOut <= 0n,
      };
    } catch (error) {
      // QuoterV2 reverts when the swap cannot be filled.
      this.client.logger.debug('V3 quoter reverted', { pool: pool.id, error: String(error) });
      return empty;
    }
  }

  buildSwap(params: SwapParams): SwapCall {
    const state = params.pool.concentrated;
    if (!state) throw new ConfigError('V3 swap requires concentrated pool state');
    const tokenIn = getAddress(params.tokenIn);
    const tokenOut = getAddress(params.tokenOut);
    if (params.nativeIn && !sameAddress(tokenIn, this.wrappedNative)) throw new ConfigError('nativeIn requires tokenIn to be WETH');
    if (params.nativeOut && !sameAddress(tokenOut, this.wrappedNative)) throw new ConfigError('nativeOut requires tokenOut to be WETH');

    // When unwrapping, the swap delivers WETH to the router, and unwrapWETH9 forwards ETH.
    const swap = encodeFunctionData({
      abi: UNISWAP_V3_SWAP_ROUTER02_ABI,
      functionName: 'exactInputSingle',
      args: [
        {
          tokenIn,
          tokenOut,
          fee: state.fee,
          recipient: params.nativeOut ? SWAP_ROUTER02_ADDRESS_THIS : params.recipient,
          amountIn: params.amountIn,
          amountOutMinimum: params.minAmountOut,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    const calls: Hex[] = [swap];
    if (params.nativeOut) {
      calls.push(
        encodeFunctionData({ abi: UNISWAP_V3_SWAP_ROUTER02_ABI, functionName: 'unwrapWETH9', args: [params.minAmountOut, params.recipient] }),
      );
    }
    if (params.nativeIn) {
      calls.push(encodeFunctionData({ abi: UNISWAP_V3_SWAP_ROUTER02_ABI, functionName: 'refundETH', args: [] }));
    }
    return {
      to: this.router,
      data: encodeFunctionData({ abi: UNISWAP_V3_SWAP_ROUTER02_ABI, functionName: 'multicall', args: [params.deadline, calls] }),
      value: params.nativeIn ? params.amountIn : 0n,
      ...(params.nativeIn ? {} : { approvalSpender: this.router }),
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
        const decoded = decodeEventLog({ abi: UNISWAP_V3_POOL_ABI, data: entry.data, topics: entry.topics });
        if (decoded.eventName !== 'Swap') continue;
        const a = decoded.args;
        // Signed from the pool's perspective: positive flows in.
        trades.push({
          txHash: entry.transactionHash,
          logIndex: entry.logIndex ?? 0,
          blockNumber: entry.blockNumber ?? 0n,
          sender: a.sender,
          recipient: a.recipient,
          amount0In: a.amount0 > 0n ? a.amount0 : 0n,
          amount1In: a.amount1 > 0n ? a.amount1 : 0n,
          amount0Out: a.amount0 < 0n ? -a.amount0 : 0n,
          amount1Out: a.amount1 < 0n ? -a.amount1 : 0n,
        });
      } catch {
        // not a Swap log
      }
    }
    return trades;
  }
}

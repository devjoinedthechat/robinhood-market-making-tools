/**
 * Uniswap V4 pools.
 *
 * V4 is not "V3 at a different address". Three differences reach this interface:
 *
 *  1. A POOL IS NOT A CONTRACT. Every pool lives inside one PoolManager and is
 *     named by `PoolId = keccak256(abi.encode(PoolKey))`. `PoolState.id` is that
 *     PoolId; `PoolState.address` is the PoolManager.
 *  2. STATE IS READ THROUGH `extsload`. Neither Robinhood network has a StateView,
 *     so pool storage is read directly — identically on both.
 *  3. HOOKS MAKE LOCAL MATH WRONG. A hook can change what a swap returns, so
 *     quotes come from simulating the real swap inside the PoolManager with a
 *     quoter injected by state override (never deployed, costs nothing).
 *
 * Reserves are virtual (from liquidity and price), never `balanceOf(PoolManager)`:
 * the singleton holds every pool's funds at once.
 */

import {
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  parseAbiItem,
  toEventSelector,
  zeroAddress,
  type Address,
  type Hex,
  type Log,
} from 'viem';
import type { DexDeployment } from '../chains.ts';
import type { ChainClient } from '../client/chain-client.ts';
import { ConfigError, ReadError } from '../errors.ts';
import { isPoolId, isZeroAddress, sameAddress, sortTokens } from '../internal/address.ts';
import { V4_QUOTER_ARTIFACT } from './v4-quoter-artifact.ts';
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
  type V4PoolKey,
} from './types.ts';

const Q96 = 2n ** 96n;
const SWAP_GAS = 260_000n;

/** v4-core `Pool.State` lives in the PoolManager's `pools` mapping at slot 6. */
const POOLS_SLOT = 6n;
const SLOT0_OFFSET = 0n;
const LIQUIDITY_OFFSET = 3n;

const POOL_MANAGER_ABI = parseAbi(['function extsload(bytes32 slot) view returns (bytes32)']);
const UNIVERSAL_ROUTER_ABI = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);
const SWAP_EVENT = parseAbi([
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
]);
const INITIALIZE_EVENT = parseAbiItem(
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
);
const SWAP_TOPIC = toEventSelector('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)');

/** UniversalRouter command and v4-periphery actions. */
const COMMAND_V4_SWAP = '0x10';
const ACTIONS = '0x060c0f'; // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL

const POOL_KEY_COMPONENTS = [
  { name: 'currency0', type: 'address' },
  { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
] as const;

const EXACT_INPUT_SINGLE = [
  {
    type: 'tuple',
    components: [
      { name: 'poolKey', type: 'tuple', components: POOL_KEY_COMPONENTS },
      { name: 'zeroForOne', type: 'bool' },
      { name: 'amountIn', type: 'uint128' },
      { name: 'amountOutMinimum', type: 'uint128' },
      { name: 'hookData', type: 'bytes' },
    ],
  },
] as const;

/** Where the quoter is injected for one eth_call. No real contract occupies it. */
const QUOTER_SCRATCH_ADDRESS: Address = '0x00000000000000000000000000000000000dc0de';

/** `PoolId = keccak256(abi.encode(PoolKey))`. */
export function poolIdOf(key: V4PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

/** Storage slot of one field of a pool's state, for `extsload`. */
export function poolStateSlot(poolId: Hex, offset: bigint): Hex {
  const base = BigInt(keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [poolId, POOLS_SLOT])));
  return `0x${(base + offset).toString(16).padStart(64, '0')}`;
}

/** Unpack `Slot0`: sqrtPriceX96 in the low 160 bits, then a signed 24-bit tick. */
export function decodeSlot0(word: Hex): { sqrtPriceX96: bigint; tick: number } {
  const packed = BigInt(word);
  return {
    sqrtPriceX96: packed & ((1n << 160n) - 1n),
    tick: Number(BigInt.asIntN(24, (packed >> 160n) & ((1n << 24n) - 1n))),
  };
}

/** Smallest log window the PoolId → PoolKey scan shrinks to after RPC errors before giving up. */
const MIN_SCAN_WINDOW = 10_000n;

export class UniswapV4Connector implements DexConnector {
  readonly kind = 'v4' as const;
  readonly id: string;
  readonly deployment: DexDeployment;
  readonly poolManager: Address;
  private readonly client: ChainClient;
  private readonly router: Address;
  private readonly permit2: Address;
  private readonly tiers: readonly { fee: number; tickSpacing: number }[];
  /** PoolId → PoolKey. A PoolId is a hash, so the key cannot be recovered from it. */
  private readonly keys = new Map<string, V4PoolKey>();

  constructor(deployment: DexDeployment, client: ChainClient) {
    if (deployment.kind !== 'v4') throw new ConfigError(`${deployment.id} is not a V4 deployment`);
    if (!deployment.poolManager || !deployment.permit2) {
      throw new ConfigError(`V4 deployment ${deployment.id} needs poolManager and permit2 addresses`);
    }
    this.deployment = deployment;
    this.client = client;
    this.id = deployment.id;
    this.poolManager = getAddress(deployment.poolManager);
    this.router = getAddress(deployment.router);
    this.permit2 = getAddress(deployment.permit2);
    this.tiers = deployment.v4Tiers ?? [
      { fee: 100, tickSpacing: 1 },
      { fee: 500, tickSpacing: 10 },
      { fee: 3000, tickSpacing: 60 },
      { fee: 10000, tickSpacing: 200 },
    ];
  }

  // ── pool reads ───────────────────────────────────────────────────────────

  /** A pool named by its key — no log scan needed. Null if it is not initialised. */
  async getPoolByKey(key: V4PoolKey): Promise<PoolState | null> {
    const normalized = normalizeKey(key);
    const id = poolIdOf(normalized);
    this.keys.set(id, normalized);
    return this.describe(id, normalized);
  }

  async getPool(ref: Address | Hex): Promise<PoolState | null> {
    if (!isPoolId(ref)) return null;
    const id = ref.toLowerCase() as Hex;
    const key = this.keys.get(id) ?? (await this.scanForKey(id));
    return key ? this.describe(id, key) : null;
  }

  /** Every hookless pool for the pair. Hooked pools must be named by PoolId or key. */
  async findPools(tokenA: Address, tokenB: Address): Promise<PoolState[]> {
    const [currency0, currency1] = sortTokens(getAddress(tokenA), getAddress(tokenB));
    const pools = await Promise.all(
      this.tiers.map(async ({ fee, tickSpacing }) => {
        try {
          return await this.getPoolByKey({ currency0, currency1, fee, tickSpacing, hooks: zeroAddress });
        } catch (error) {
          this.client.logger.debug('V4 pool probe failed', { fee, error: String(error) });
          return null;
        }
      }),
    );
    return pools.filter((p): p is PoolState => p !== null);
  }

  /** Initialised; the quoter decides fills (see the V3 connector's note). */
  isTradable(pool: PoolState): boolean {
    return (pool.concentrated?.sqrtPriceX96 ?? 0n) > 0n;
  }

  /**
   * Recover a PoolKey from its id via the pool's `Initialize` event.
   *
   * The id is an indexed topic, so this is a filtered query. It starts with the
   * whole chain and halves the window whenever the RPC refuses, walking back
   * from the head. Throws `ReadError` if the scan cannot complete: "could not
   * look" must not be reported as "no such pool".
   */
  private async scanForKey(poolId: Hex): Promise<V4PoolKey | null> {
    const client = this.client.publicClient;
    const latest = await client.getBlockNumber();
    let window = latest + 1n;
    let to = latest;
    for (;;) {
      const from = to + 1n > window ? to + 1n - window : 0n;
      try {
        const logs = await client.getLogs({
          address: this.poolManager,
          event: INITIALIZE_EVENT,
          args: { id: poolId },
          fromBlock: from,
          toBlock: to,
          strict: true,
        });
        const found = logs[0];
        if (found) {
          const key = normalizeKey(found.args);
          this.keys.set(poolId, key);
          return key;
        }
        if (from === 0n) return null;
        to = from - 1n;
      } catch (error) {
        if (window <= MIN_SCAN_WINDOW) {
          throw new ReadError(`Could not scan for V4 pool ${poolId}: ${error instanceof Error ? error.message : String(error)}`, {
            cause: error,
          });
        }
        window /= 2n;
      }
    }
  }

  private async describe(poolId: Hex, key: V4PoolKey): Promise<PoolState | null> {
    const [slot0Word, liquidityWord] = await this.client.publicClient.multicall({
      contracts: [
        { address: this.poolManager, abi: POOL_MANAGER_ABI, functionName: 'extsload', args: [poolStateSlot(poolId, SLOT0_OFFSET)] },
        { address: this.poolManager, abi: POOL_MANAGER_ABI, functionName: 'extsload', args: [poolStateSlot(poolId, LIQUIDITY_OFFSET)] },
      ],
      allowFailure: false,
      multicallAddress: this.client.chain.multicall3,
    });
    const { sqrtPriceX96, tick } = decodeSlot0(slot0Word);
    if (sqrtPriceX96 === 0n) return null; // uninitialised pools read as zero
    const liquidity = BigInt(liquidityWord);

    const [decimals0, decimals1] = await Promise.all([
      this.client.tokenDecimals(key.currency0),
      this.client.tokenDecimals(key.currency1),
    ]);
    return {
      dex: this.id,
      kind: 'v4',
      id: poolId,
      address: this.poolManager,
      token0: key.currency0,
      token1: key.currency1,
      decimals0,
      decimals1,
      feeBps: key.fee / 100,
      reserve0: liquidity > 0n ? (liquidity * Q96) / sqrtPriceX96 : 0n,
      reserve1: liquidity > 0n ? (liquidity * sqrtPriceX96) / Q96 : 0n,
      price0In1: priceFromSqrtPriceX96(sqrtPriceX96, decimals0, decimals1),
      concentrated: { fee: key.fee, sqrtPriceX96, tick, liquidity, tickSpacing: key.tickSpacing },
      v4Key: key,
      fetchedAt: Date.now(),
    };
  }

  // ── quoting ──────────────────────────────────────────────────────────────

  /**
   * Simulate the real swap inside the PoolManager. The injected quoter swaps and
   * reverts with the deltas, so no state changes and no approval is needed —
   * and any hook on the pool is accounted for.
   */
  async quote(pool: PoolState, params: QuoteParams): Promise<DexQuote> {
    const key = pool.v4Key;
    if (!key) throw new ConfigError('V4 quote requires a pool key');
    const empty: DexQuote = { amountIn: params.amountIn, amountOut: 0n, priceImpact: 1, insufficientLiquidity: true };
    if (params.amountIn <= 0n) return empty;
    const zeroForOne = sameAddress(params.tokenIn, key.currency0);

    let amount0: bigint;
    let amount1: bigint;
    try {
      const { result } = await this.client.publicClient.simulateContract({
        address: QUOTER_SCRATCH_ADDRESS,
        abi: V4_QUOTER_ARTIFACT.abi,
        functionName: 'quoteExactInputSingle',
        args: [this.poolManager, key, zeroForOne, params.amountIn, '0x'],
        stateOverride: [{ address: QUOTER_SCRATCH_ADDRESS, code: V4_QUOTER_ARTIFACT.deployedBytecode }],
      });
      [amount0, amount1] = result;
    } catch (error) {
      this.client.logger.debug('V4 quote simulation reverted', { pool: pool.id, error: String(error) });
      return empty;
    }

    // Deltas are the trader's: negative paid in, positive received.
    const out = zeroForOne ? amount1 : amount0;
    if (out <= 0n) return empty;
    const spot = zeroForOne ? pool.price0In1 : pool.price0In1 > 0 ? 1 / pool.price0In1 : 0;
    const decimalsIn = zeroForOne ? pool.decimals0 : pool.decimals1;
    const decimalsOut = zeroForOne ? pool.decimals1 : pool.decimals0;
    return {
      amountIn: params.amountIn,
      amountOut: out,
      priceImpact: priceImpact(spot, Number(params.amountIn) / 10 ** decimalsIn, Number(out) / 10 ** decimalsOut),
      insufficientLiquidity: false,
    };
  }

  // ── swapping ─────────────────────────────────────────────────────────────

  /**
   * A V4 swap through the UniversalRouter. The router pulls input via Permit2,
   * hence `approvalSpender: permit2` AND `permit2Spender: router`. Paying native
   * is decided by the pool's own currency (address zero), not by `nativeIn`.
   */
  buildSwap(params: SwapParams): SwapCall {
    const key = params.pool.v4Key;
    if (!key) throw new ConfigError('V4 swap requires a pool key');
    const zeroForOne = sameAddress(params.tokenIn, key.currency0);
    const currencyIn = zeroForOne ? key.currency0 : key.currency1;
    const currencyOut = zeroForOne ? key.currency1 : key.currency0;

    const swap = encodeAbiParameters(EXACT_INPUT_SINGLE, [
      { poolKey: key, zeroForOne, amountIn: params.amountIn, amountOutMinimum: params.minAmountOut, hookData: '0x' },
    ]);
    const settle = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [currencyIn, params.amountIn]);
    const take = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [currencyOut, params.minAmountOut]);
    const input = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [ACTIONS, [swap, settle, take]]);

    const payingNative = isZeroAddress(currencyIn);
    return {
      to: this.router,
      data: encodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, functionName: 'execute', args: [COMMAND_V4_SWAP, [input], params.deadline] }),
      value: payingNative ? params.amountIn : 0n,
      ...(payingNative ? {} : { approvalSpender: this.permit2, permit2Spender: this.router }),
      estimatedGas: SWAP_GAS,
    };
  }

  /** Filtered by PoolId topic, so the node returns this pool's swaps and not every V4 pool's. */
  swapLogFilter(pool: PoolState): SwapLogFilter {
    return { address: this.poolManager, topics: [SWAP_TOPIC, pool.id] };
  }

  /**
   * Swap logs for ONE pool. Every V4 pool emits from the same PoolManager, so
   * the PoolId topic is all that separates this pool's trades from the rest.
   */
  parseSwapLogs(pool: PoolState, logs: readonly Log[]): SwapLog[] {
    const wanted = pool.id.toLowerCase();
    const trades: SwapLog[] = [];
    for (const entry of logs) {
      if (entry.topics[0] !== SWAP_TOPIC || entry.topics[1]?.toLowerCase() !== wanted) continue;
      if (!sameAddress(entry.address, this.poolManager) || !entry.transactionHash) continue;
      try {
        const { args } = decodeEventLog({ abi: SWAP_EVENT, data: entry.data, topics: entry.topics });
        trades.push({
          txHash: entry.transactionHash,
          logIndex: entry.logIndex ?? 0,
          blockNumber: entry.blockNumber ?? 0n,
          sender: args.sender,
          // V4 has no recipient in the event; the router is the sender.
          recipient: args.sender,
          // Trader deltas: negative means the trader paid it into the pool.
          amount0In: args.amount0 < 0n ? -args.amount0 : 0n,
          amount1In: args.amount1 < 0n ? -args.amount1 : 0n,
          amount0Out: args.amount0 > 0n ? args.amount0 : 0n,
          amount1Out: args.amount1 > 0n ? args.amount1 : 0n,
        });
      } catch {
        // not decodable as a V4 Swap
      }
    }
    return trades;
  }
}

function normalizeKey(key: { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string }): V4PoolKey {
  const currency0 = getAddress(key.currency0);
  const currency1 = getAddress(key.currency1);
  if (currency0.toLowerCase() >= currency1.toLowerCase()) {
    throw new ConfigError('Invalid V4 pool key: currency0 must sort below currency1');
  }
  return { currency0, currency1, fee: Number(key.fee), tickSpacing: Number(key.tickSpacing), hooks: getAddress(key.hooks) };
}

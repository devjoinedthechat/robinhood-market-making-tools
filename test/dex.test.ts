import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeAbiParameters, decodeFunctionData, getAddress, parseAbi, zeroAddress, type Address, type Hex } from 'viem';
import { robinhood } from '../src/chains.ts';
import type { ChainClient } from '../src/client/chain-client.ts';
import { UNISWAP_V3_SWAP_ROUTER02_ABI } from '../src/client/abis.ts';
import { poolDepth, type PoolState } from '../src/dex/types.ts';
import { UniswapV2Connector } from '../src/dex/uniswap-v2.ts';
import { UniswapV3Connector } from '../src/dex/uniswap-v3.ts';
import { UniswapV4Connector, decodeSlot0, poolIdOf, poolStateSlot } from '../src/dex/uniswap-v4.ts';
import { silentLogger } from '../src/logger.ts';

const USDG = getAddress('0x5fc5360d0400a0fd4f2af552add042d716f1d168');
const WETH = getAddress(robinhood.wrappedNative);
const WALLET: Address = '0x000000000000000000000000000000000000bEEF';
const client = { chain: robinhood, logger: silentLogger } as unknown as ChainClient;
const deployment = (id: string) => robinhood.dexes.find((d) => d.id === id)!;

function pool(overrides: Partial<PoolState>): PoolState {
  return {
    dex: 'test',
    kind: 'v2',
    id: '0x0000000000000000000000000000000000000001',
    address: '0x0000000000000000000000000000000000000001',
    token0: USDG,
    token1: WETH,
    decimals0: 6,
    decimals1: 18,
    feeBps: 30,
    reserve0: 0n,
    reserve1: 0n,
    price0In1: 0,
    fetchedAt: 0,
    ...overrides,
  };
}

describe('Uniswap V4 encoding', () => {
  it('derives the PoolId of the live mainnet ETH/USDG 0.30% pool', () => {
    // Recorded from Robinhood Chain mainnet: extsload at this id's slot0 holds a
    // non-zero price, which only happens if the id derivation is correct.
    const id = poolIdOf({ currency0: zeroAddress, currency1: USDG, fee: 3000, tickSpacing: 60, hooks: zeroAddress });
    assert.equal(id, '0xd313d79d9d6a714e7bdf02fc42a2c27ede7e51928ffd605126fe9e1192630cf8');
  });

  it('offsets pool state slots from the mapping base', () => {
    const id: Hex = `0x${'12'.repeat(32)}`;
    assert.equal(BigInt(poolStateSlot(id, 3n)) - BigInt(poolStateSlot(id, 0n)), 3n);
  });

  it('decodes a packed slot0 with a negative tick', () => {
    const sqrtPriceX96 = 79_228_162_514_264_337_593_543_950_336n; // 2^96
    const tick = -204_200;
    const packed = sqrtPriceX96 | (BigInt.asUintN(24, BigInt(tick)) << 160n);
    assert.deepEqual(decodeSlot0(`0x${packed.toString(16).padStart(64, '0')}`), { sqrtPriceX96, tick });
  });

  it('pays native ETH into an ETH-quoted pool and needs no approval', () => {
    const connector = new UniswapV4Connector(deployment('uniswap-v4'), client);
    const key = { currency0: zeroAddress, currency1: USDG, fee: 3000, tickSpacing: 60, hooks: zeroAddress } as const;
    const v4Pool = pool({ kind: 'v4', token0: zeroAddress, token1: USDG, v4Key: key });
    const call = connector.buildSwap({
      pool: v4Pool,
      recipient: WALLET,
      tokenIn: zeroAddress,
      tokenOut: USDG,
      amountIn: 10n ** 15n,
      minAmountOut: 1n,
      nativeIn: false,
      nativeOut: false,
      deadline: 1n,
    });
    assert.equal(call.value, 10n ** 15n);
    assert.equal(call.approvalSpender, undefined);
    const { args } = decodeFunctionData({ abi: parseAbi(['function execute(bytes, bytes[], uint256)']), data: call.data });
    assert.equal(args[0], '0x10');
    const [actions] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], (args[1] as Hex[])[0] as Hex);
    assert.equal(actions, '0x060c0f');
  });

  it('routes an ERC-20 input through Permit2 with two approvals', () => {
    const connector = new UniswapV4Connector(deployment('uniswap-v4'), client);
    const key = { currency0: zeroAddress, currency1: USDG, fee: 3000, tickSpacing: 60, hooks: zeroAddress } as const;
    const call = connector.buildSwap({
      pool: pool({ kind: 'v4', token0: zeroAddress, token1: USDG, v4Key: key }),
      recipient: WALLET,
      tokenIn: USDG,
      tokenOut: zeroAddress,
      amountIn: 1_000_000n,
      minAmountOut: 1n,
      nativeIn: false,
      nativeOut: false,
      deadline: 1n,
    });
    assert.equal(call.value, 0n);
    assert.equal(call.approvalSpender, getAddress(robinhood.dexes[2]!.permit2!));
    assert.equal(call.permit2Spender, getAddress(robinhood.dexes[2]!.router));
  });

  it('filters swap logs by PoolId so other V4 pools are never read as this one', () => {
    const connector = new UniswapV4Connector(deployment('uniswap-v4'), client);
    const id: Hex = `0x${'aa'.repeat(32)}`;
    const filter = connector.swapLogFilter(pool({ kind: 'v4', id }));
    assert.equal(filter.topics[1], id);
  });
});

describe('Uniswap V3 calldata', () => {
  it('unwraps WETH to the wallet on a native-out sell', () => {
    const connector = new UniswapV3Connector(deployment('uniswap-v3'), client);
    const call = connector.buildSwap({
      pool: pool({ kind: 'v3', concentrated: { fee: 500, sqrtPriceX96: 1n, tick: 0, liquidity: 1n, tickSpacing: 10 } }),
      recipient: WALLET,
      tokenIn: USDG,
      tokenOut: WETH,
      amountIn: 1_000_000n,
      minAmountOut: 5n,
      nativeIn: false,
      nativeOut: true,
      deadline: 99n,
    });
    const outer = decodeFunctionData({ abi: UNISWAP_V3_SWAP_ROUTER02_ABI, data: call.data });
    assert.equal(outer.functionName, 'multicall');
    const [deadline, inner] = outer.args as [bigint, Hex[]];
    assert.equal(deadline, 99n);
    const swap = decodeFunctionData({ abi: UNISWAP_V3_SWAP_ROUTER02_ABI, data: inner[0]! });
    const unwrap = decodeFunctionData({ abi: UNISWAP_V3_SWAP_ROUTER02_ABI, data: inner[1]! });
    assert.equal((swap.args![0] as { recipient: Address }).recipient, '0x0000000000000000000000000000000000000002');
    assert.equal(unwrap.functionName, 'unwrapWETH9');
    assert.deepEqual(unwrap.args, [5n, WALLET]);
    assert.equal(call.approvalSpender, getAddress(deployment('uniswap-v3').router));
  });
});

describe('Uniswap V2 quotes', () => {
  const connector = new UniswapV2Connector(deployment('uniswap-v2'), client);

  it('matches the pair contract getAmountOut', async () => {
    const p = pool({ reserve0: 1_000_000_000n, reserve1: 10n ** 18n });
    const q = await connector.quote(p, { tokenIn: USDG, tokenOut: WETH, amountIn: 1_000_000n });
    const withFee = 1_000_000n * 9_970n;
    assert.equal(q.amountOut, (withFee * 10n ** 18n) / (1_000_000_000n * 10_000n + withFee));
    assert.equal(q.insufficientLiquidity, false);
    assert.ok(q.priceImpact > 0 && q.priceImpact < 0.01);
  });

  it('flags a trade that would drain the output side', async () => {
    const p = pool({ reserve0: 1_000n, reserve1: 1_000n });
    const q = await connector.quote(p, { tokenIn: USDG, tokenOut: WETH, amountIn: 1_000_000n });
    assert.equal(q.insufficientLiquidity, true);
  });
});

describe('poolDepth', () => {
  it('scales V3 virtual reserves down to the balance without changing the implied price', () => {
    const q96 = 2n ** 96n;
    const p = pool({
      kind: 'v3',
      reserve0: 1_000n,
      reserve1: 10n ** 12n,
      concentrated: { fee: 500, sqrtPriceX96: q96, tick: 0, liquidity: 10n ** 9n, tickSpacing: 10 },
    });
    const { depth0, depth1 } = poolDepth(p);
    assert.ok(depth0 <= p.reserve0 && depth1 <= p.reserve1);
    assert.equal(depth0, depth1, 'price 1.0 must be preserved');
  });
});

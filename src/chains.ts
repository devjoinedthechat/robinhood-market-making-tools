/**
 * Robinhood Chain deployments.
 *
 * Pure data, no functions, so a chain definition can be serialised, logged or
 * diffed. Addresses were established from on-chain evidence (swap logs, pool
 * `factory()` reads and router/quoter cross-checks), not from name searches: a
 * public testnet explorer returns dozens of look-alike contracts.
 */

import type { Address } from 'viem';

export type DexKind = 'v2' | 'v3' | 'v4';

export interface DexDeployment {
  /** Stable id, e.g. `uniswap-v3`. */
  readonly id: string;
  readonly label: string;
  readonly kind: DexKind;
  /** V2/V3 factory. For V4, the PoolManager singleton takes its place. */
  readonly factory: Address;
  /** V2 router, V3 SwapRouter02, or V4 UniversalRouter. */
  readonly router: Address;
  /** V3 QuoterV2. */
  readonly quoter?: Address;
  /** V2 swap fee in basis points. */
  readonly feeBps?: number;
  /** V3 fee tiers probed when discovering pools. */
  readonly feeTiers?: readonly number[];
  /** V4 PoolManager. */
  readonly poolManager?: Address;
  /** V4 Permit2, which UniversalRouter pulls tokens through. */
  readonly permit2?: Address;
  /**
   * V4 (fee, tickSpacing) pairs probed when discovering hookless pools.
   * Hooked pools cannot be discovered this way and must be named by PoolId.
   */
  readonly v4Tiers?: readonly { readonly fee: number; readonly tickSpacing: number }[];
}

export interface QuoteToken {
  readonly symbol: string;
  readonly decimals: number;
}

export interface RobinhoodChain {
  readonly id: 'robinhood' | 'robinhood-testnet';
  readonly name: string;
  readonly chainId: number;
  readonly testnet: boolean;
  readonly nativeSymbol: 'ETH';
  readonly nativeDecimals: 18;
  /** Public endpoints, best first. Override with `rpcUrls` on the client. */
  readonly rpcUrls: readonly string[];
  readonly explorerUrl: string;
  readonly wrappedNative: Address;
  readonly multicall3: Address;
  /**
   * Tokens recognised as the quote side of a pool. Keyed by LOWER-CASE address.
   * The zero address is native ETH, which Uniswap V4 uses as a currency directly.
   */
  readonly knownQuoteTokens: Readonly<Record<string, QuoteToken>>;
  readonly dexes: readonly DexDeployment[];
  /** Native amount a wallet keeps aside per transaction for gas. */
  readonly feeHeadroom: number;
  /** Rough native cost of one swap, for "is this trade worth its gas" checks. */
  readonly estimatedSwapFee: number;
  readonly confirmations: number;
}

const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';
const V3_FEE_TIERS = [100, 500, 3000, 10000] as const;

/**
 * Uniswap V4 is byte-identical on mainnet and testnet: both were deployed
 * through the canonical CREATE2 factory. Neither chain has a StateView or a
 * V4Quoter, so pools are read through `extsload` and quotes come from the SDK's
 * own simulated quoter (see dex/uniswap-v4.ts).
 */
const UNISWAP_V4: DexDeployment = {
  id: 'uniswap-v4',
  label: 'Uniswap V4',
  kind: 'v4',
  factory: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  router: '0x8876789976decbfcbbbe364623c63652db8c0904',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  v4Tiers: [
    { fee: 100, tickSpacing: 1 },
    { fee: 500, tickSpacing: 10 },
    { fee: 3000, tickSpacing: 60 },
    { fee: 10000, tickSpacing: 200 },
  ],
};

export const robinhood: RobinhoodChain = {
  id: 'robinhood',
  name: 'Robinhood Chain',
  chainId: 4663,
  testnet: false,
  nativeSymbol: 'ETH',
  nativeDecimals: 18,
  rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'],
  explorerUrl: 'https://robinhoodchain.blockscout.com',
  wrappedNative: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  multicall3: MULTICALL3,
  knownQuoteTokens: {
    '0x0000000000000000000000000000000000000000': { symbol: 'ETH', decimals: 18 },
    '0x0bd7d308f8e1639fab988df18a8011f41eacad73': { symbol: 'WETH', decimals: 18 },
    '0x5fc5360d0400a0fd4f2af552add042d716f1d168': { symbol: 'USDG', decimals: 6 },
    // A widely used quote asset here; without it VIRTUAL pairs resolve with
    // token and quote inverted on roughly half of all pools.
    '0xc6911796042b15d7fa4f6cde69e245ddcd3d9c31': { symbol: 'VIRTUAL', decimals: 18 },
  },
  dexes: [
    {
      id: 'uniswap-v2',
      label: 'Uniswap V2',
      kind: 'v2',
      factory: '0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f',
      router: '0x89e5db8b5aa49aa85ac63f691524311aeb649eba',
      feeBps: 30,
    },
    {
      id: 'uniswap-v3',
      label: 'Uniswap V3',
      kind: 'v3',
      factory: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa',
      router: '0xcaf681a66d020601342297493863e78c959e5cb2',
      quoter: '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7',
      feeTiers: V3_FEE_TIERS,
    },
    UNISWAP_V4,
  ],
  // Orbit L2 gas is ~0.02 gwei; the headroom is generous on purpose.
  feeHeadroom: 0.0002,
  estimatedSwapFee: 0.00002,
  confirmations: 1,
};

export const robinhoodTestnet: RobinhoodChain = {
  id: 'robinhood-testnet',
  name: 'Robinhood Chain Testnet',
  chainId: 46630,
  testnet: true,
  nativeSymbol: 'ETH',
  nativeDecimals: 18,
  rpcUrls: ['https://rpc.testnet.chain.robinhood.com'],
  explorerUrl: 'https://explorer.testnet.chain.robinhood.com',
  wrappedNative: '0x33e4191705c386532ba27cBF171Db86919200B94',
  multicall3: MULTICALL3,
  knownQuoteTokens: {
    '0x0000000000000000000000000000000000000000': { symbol: 'ETH', decimals: 18 },
    '0x33e4191705c386532ba27cbf171db86919200b94': { symbol: 'WETH', decimals: 18 },
    // A testnet mock with 18 decimals, not USDC's usual 6. Read from the contract.
    '0xbf4479c07dc6fdc6daa764a0cca06969e894275f': { symbol: 'USDC', decimals: 18 },
  },
  dexes: [
    {
      // There is no canonical Uniswap V2 on testnet; the busiest V3 deployment
      // is Synthra's fork, verified by router/quoter factory() and WETH9() reads.
      id: 'synthra-v3',
      label: 'Synthra V3',
      kind: 'v3',
      factory: '0x911b4000D3422F482F4062a913885f7b035382Df',
      router: '0x3Ce954107b1A675826B33bF23060Dd655e3758fE',
      quoter: '0x231606c321A99DE81e28fE48B07a93F1ba49e713',
      feeTiers: V3_FEE_TIERS,
    },
    UNISWAP_V4,
  ],
  feeHeadroom: 0.0002,
  estimatedSwapFee: 0.00002,
  confirmations: 1,
};

export const chains = { robinhood, robinhoodTestnet } as const;

export function explorerTxUrl(chain: RobinhoodChain, hash: string): string {
  return `${chain.explorerUrl}/tx/${hash}`;
}

export function explorerAddressUrl(chain: RobinhoodChain, address: string): string {
  return `${chain.explorerUrl}/address/${address}`;
}

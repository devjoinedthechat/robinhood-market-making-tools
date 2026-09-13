/**
 * Reads, balances and plain transfers on one Robinhood Chain network.
 *
 * Balances are human units (ETH, UI token amounts). A read that fails throws
 * `ReadError`; it never reports zero, because a failed lookup and an empty
 * wallet must stay distinguishable.
 */

import {
  createPublicClient,
  defineChain,
  fallback,
  formatUnits,
  http,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
} from 'viem';
import type { RobinhoodChain } from '../chains.ts';
import { ConfigError, ReadError } from '../errors.ts';
import { isZeroAddress, toAddress } from '../internal/address.ts';
import { silentLogger, type Logger } from '../logger.ts';
import { parseAmount, type Amount } from '../units.ts';
import type { Wallet } from '../wallet.ts';
import { ERC20_ABI, MULTICALL3_ABI } from './abis.ts';
import { encodeTransfer } from './erc20.ts';
import { TransactionExecutor, type ExecResult } from './executor.ts';

export interface ChainClientOptions {
  readonly chain: RobinhoodChain;
  /** Endpoints, best first. Reads fail over down the list; transactions go to the first. */
  readonly rpcUrls?: readonly string[];
  /** A custom viem transport for everything (e.g. WebSocket, or a test double). Overrides `rpcUrls`. */
  readonly transport?: Transport;
  readonly logger?: Logger;
  /** Refuse every broadcast with `BroadcastBlockedError`. Reads, quotes and simulations still work. */
  readonly readOnly?: boolean;
}

export type TxOutcome =
  | { readonly status: 'confirmed'; readonly hash: Hex; readonly block: number; readonly feeNative: number }
  | { readonly status: 'failed'; readonly error: string; readonly hash?: Hex }
  | { readonly status: 'unknown'; readonly error: string; readonly hash?: Hex };

/**
 * Robinhood Chain's public RPC rejects a JSON-RPC batch of 150 calls outright,
 * failing every call in it. Capping the transport's batch here means no caller
 * can build an oversized one by accident.
 */
const RPC_BATCH_SIZE = 100;

/** Addresses per multicall; beyond this nodes refuse on gas or response size. */
const MULTICALL_CHUNK = 150;

function toViemChain(chain: RobinhoodChain, rpcUrls: readonly string[]): Chain {
  return defineChain({
    id: chain.chainId,
    name: chain.name,
    nativeCurrency: { name: 'Ether', symbol: chain.nativeSymbol, decimals: chain.nativeDecimals },
    rpcUrls: { default: { http: [...rpcUrls] } },
    blockExplorers: { default: { name: 'Blockscout', url: chain.explorerUrl } },
    contracts: { multicall3: { address: chain.multicall3 } },
    testnet: chain.testnet,
  });
}

function toOutcome(result: ExecResult): TxOutcome {
  switch (result.status) {
    case 'confirmed':
      return { status: 'confirmed', hash: result.hash, block: result.block, feeNative: result.feeNative };
    case 'failed':
      return result.hash ? { status: 'failed', error: result.error, hash: result.hash } : { status: 'failed', error: result.error };
    case 'unknown':
      return result.hash ? { status: 'unknown', error: result.error, hash: result.hash } : { status: 'unknown', error: result.error };
  }
}

export class ChainClient {
  readonly chain: RobinhoodChain;
  readonly viemChain: Chain;
  readonly publicClient: PublicClient;
  readonly executor: TransactionExecutor;
  readonly logger: Logger;
  readonly readOnly: boolean;

  private readonly decimalsCache = new Map<string, number>();
  private readonly symbolCache = new Map<string, string>();

  constructor(options: ChainClientOptions) {
    this.chain = options.chain;
    this.logger = options.logger ?? silentLogger;
    this.readOnly = options.readOnly ?? false;

    const rpcUrls = options.rpcUrls ?? options.chain.rpcUrls;
    const primary = rpcUrls[0];
    if (!options.transport) {
      if (!primary) throw new ConfigError('At least one RPC URL is required');
      for (const url of rpcUrls) {
        if (!/^https?:\/\//i.test(url)) throw new ConfigError(`RPC URL must be http(s): ${url}`);
      }
    }

    this.viemChain = toViemChain(options.chain, primary ? rpcUrls : options.chain.rpcUrls);

    const readTransport =
      options.transport ??
      (rpcUrls.length === 1
        ? http(primary, { batch: { batchSize: RPC_BATCH_SIZE }, retryCount: 2 })
        : // `rank: false` keeps the declared order, so a paid endpoint listed
          // first is not demoted for being one hop slower than a public one.
          fallback(
            rpcUrls.map((url) => http(url, { batch: { batchSize: RPC_BATCH_SIZE }, retryCount: 2 })),
            { rank: false, retryCount: 1 },
          ));
    // No transport-level retries on submission: the executor decides when a
    // state-changing call goes back on the wire.
    const submitTransport = options.transport ?? http(primary, { retryCount: 0 });

    this.publicClient = createPublicClient({ chain: this.viemChain, transport: readTransport });
    const submitClient = createPublicClient({ chain: this.viemChain, transport: submitTransport });

    this.executor = new TransactionExecutor({
      publicClient: this.publicClient,
      submitClient,
      chainId: options.chain.chainId,
      nativeDecimals: options.chain.nativeDecimals,
      confirmations: options.chain.confirmations,
      logger: this.logger,
      readOnly: this.readOnly,
    });
  }

  // ── reads ────────────────────────────────────────────────────────────────

  async blockNumber(): Promise<number> {
    return read('block number', async () => Number(await this.publicClient.getBlockNumber()));
  }

  async nativeBalance(address: string): Promise<number> {
    const [balance] = await this.nativeBalances([address]);
    return balance as number;
  }

  async nativeBalances(addresses: readonly string[]): Promise<number[]> {
    const owners = addresses.map((a) => toAddress(a, 'Wallet'));
    const values = await this.batchedBalances(
      owners,
      (chunk) =>
        this.publicClient.multicall({
          contracts: chunk.map((owner) => ({
            address: this.chain.multicall3,
            abi: MULTICALL3_ABI,
            functionName: 'getEthBalance' as const,
            args: [owner] as const,
          })),
          allowFailure: true,
          multicallAddress: this.chain.multicall3,
        }),
      (owner) => this.publicClient.getBalance({ address: owner }),
      'native balance',
    );
    return values.map((wei) => Number(formatUnits(wei, this.chain.nativeDecimals)));
  }

  async tokenDecimals(token: string): Promise<number> {
    if (isZeroAddress(token)) return this.chain.nativeDecimals;
    const key = token.toLowerCase();
    const cached = this.decimalsCache.get(key) ?? this.chain.knownQuoteTokens[key]?.decimals;
    if (cached !== undefined) return cached;
    const decimals = await read(`decimals() of ${token}`, () =>
      this.publicClient.readContract({ address: toAddress(token, 'Token'), abi: ERC20_ABI, functionName: 'decimals' }),
    );
    this.decimalsCache.set(key, Number(decimals));
    return Number(decimals);
  }

  /**
   * The token's ticker, or undefined when it has none. Plenty of real ERC-20s
   * have no `symbol()`; that is an answer, not a failure.
   */
  async tokenSymbol(token: string): Promise<string | undefined> {
    if (isZeroAddress(token)) return this.chain.nativeSymbol;
    const key = token.toLowerCase();
    const known = this.chain.knownQuoteTokens[key]?.symbol;
    if (known) return known;
    const cached = this.symbolCache.get(key);
    if (cached !== undefined) return cached || undefined;
    try {
      const symbol = await this.publicClient.readContract({
        address: toAddress(token, 'Token'),
        abi: ERC20_ABI,
        functionName: 'symbol',
      });
      this.symbolCache.set(key, symbol);
      return symbol || undefined;
    } catch {
      this.symbolCache.set(key, '');
      return undefined;
    }
  }

  async tokenBalance(token: string, owner: string): Promise<number> {
    const [balance] = await this.tokenBalances(token, [owner]);
    return balance as number;
  }

  async tokenBalances(token: string, owners: readonly string[]): Promise<number[]> {
    if (isZeroAddress(token)) return this.nativeBalances(owners);
    const tokenAddress = toAddress(token, 'Token');
    const decimals = await this.tokenDecimals(tokenAddress);
    const addresses = owners.map((o) => toAddress(o, 'Wallet'));
    const values = await this.batchedBalances(
      addresses,
      (chunk) =>
        this.publicClient.multicall({
          contracts: chunk.map((owner) => ({
            address: tokenAddress,
            abi: ERC20_ABI,
            functionName: 'balanceOf' as const,
            args: [owner] as const,
          })),
          allowFailure: true,
          multicallAddress: this.chain.multicall3,
        }),
      (owner) => this.publicClient.readContract({ address: tokenAddress, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] }),
      `balanceOf(${tokenAddress})`,
    );
    return values.map((raw) => Number(formatUnits(raw, decimals)));
  }

  /** Exact balance in raw units — use wherever a whole balance must be moved. */
  async tokenBalanceRaw(token: string, owner: string): Promise<bigint> {
    const address = toAddress(owner, 'Wallet');
    if (isZeroAddress(token)) return read('native balance', () => this.publicClient.getBalance({ address }));
    return read(`balanceOf(${token})`, () =>
      this.publicClient.readContract({ address: toAddress(token, 'Token'), abi: ERC20_ABI, functionName: 'balanceOf', args: [address] }),
    );
  }

  // ── transfers ────────────────────────────────────────────────────────────

  async transferNative(from: Wallet, to: string, amount: Amount): Promise<TxOutcome> {
    const value = parseAmount(amount, this.chain.nativeDecimals);
    if (value <= 0n) return { status: 'failed', error: `Amount ${amount} rounds to zero` };
    return toOutcome(await this.executor.execute(from, { to: toAddress(to, 'Recipient'), value }));
  }

  async transferToken(from: Wallet, to: string, token: string, amount: Amount): Promise<TxOutcome> {
    const tokenAddress = toAddress(token, 'Token');
    const raw = parseAmount(amount, await this.tokenDecimals(tokenAddress));
    if (raw <= 0n) return { status: 'failed', error: `Amount ${amount} rounds below one unit of ${tokenAddress}` };
    return toOutcome(
      await this.executor.execute(from, { to: tokenAddress, data: encodeTransfer(toAddress(to, 'Recipient'), raw) }),
    );
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * Multicall in chunks, then fill whatever the batch could not resolve one
   * address at a time, and throw if any still fails. A failed call is left
   * unresolved rather than read as 0.
   */
  private async batchedBalances(
    owners: readonly Address[],
    multicall: (chunk: readonly Address[]) => Promise<ReadonlyArray<{ status: 'success'; result: bigint } | { status: 'failure' }>>,
    single: (owner: Address) => Promise<bigint>,
    what: string,
  ): Promise<bigint[]> {
    const values: (bigint | null)[] = owners.map(() => null);
    for (let offset = 0; offset < owners.length; offset += MULTICALL_CHUNK) {
      const chunk = owners.slice(offset, offset + MULTICALL_CHUNK);
      try {
        const results = await multicall(chunk);
        results.forEach((r, i) => {
          if (r.status === 'success') values[offset + i] = r.result;
        });
      } catch (error) {
        this.logger.debug('Multicall chunk failed; falling back to single reads', { what, error: String(error) });
      }
    }
    const missing = values.flatMap((v, i) => (v === null ? [i] : []));
    if (missing.length > 0) {
      const settled = await Promise.allSettled(missing.map((i) => single(owners[i] as Address)));
      const failed: string[] = [];
      settled.forEach((result, k) => {
        const index = missing[k] as number;
        if (result.status === 'fulfilled') values[index] = result.value;
        else failed.push(`${owners[index]} (${result.reason instanceof Error ? result.reason.message : String(result.reason)})`);
      });
      if (failed.length > 0) {
        throw new ReadError(`Could not read ${what} for ${failed.length} address(es): ${failed.slice(0, 3).join('; ')}`);
      }
    }
    return values as bigint[];
  }
}

async function read<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ReadError || error instanceof ConfigError) throw error;
    throw new ReadError(`Could not read ${what}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

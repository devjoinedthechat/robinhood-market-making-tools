/**
 * Which configured DEX owns a pool, and every pool for a pair.
 *
 * V2 pairs and V3 pools both expose `factory()`, so ownership is a single read.
 * A V4 PoolId has no contract to ask; each V4 connector is asked instead.
 */

import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  getAddress,
  type Address,
  type Hex,
} from 'viem';
import type { DexDeployment } from '../chains.ts';
import type { ChainClient } from '../client/chain-client.ts';
import { UNISWAP_V2_PAIR_ABI } from '../client/abis.ts';
import { ReadError } from '../errors.ts';
import { sleep } from '../internal/async.ts';
import { isPoolId } from '../internal/address.ts';
import type { DexConnector, PoolState } from './types.ts';
import { UniswapV2Connector } from './uniswap-v2.ts';
import { UniswapV3Connector } from './uniswap-v3.ts';
import { UniswapV4Connector } from './uniswap-v4.ts';

export interface PoolMatch {
  readonly connector: DexConnector;
  readonly pool: PoolState;
}

/**
 * Did the contract answer (revert, no code), or did the node never answer?
 * They warrant opposite conclusions: a revert means "not a pool", a transport
 * failure says nothing about the pool at all.
 */
function isContractLevelFailure(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  if (error.walk((e) => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError)) return true;
  const message = error.message.toLowerCase();
  return message.includes('reverted') || message.includes('returned no data');
}

export function createConnector(deployment: DexDeployment, client: ChainClient): DexConnector {
  switch (deployment.kind) {
    case 'v2':
      return new UniswapV2Connector(deployment, client);
    case 'v3':
      return new UniswapV3Connector(deployment, client);
    case 'v4':
      return new UniswapV4Connector(deployment, client);
  }
}

export class DexRegistry {
  private readonly client: ChainClient;
  private readonly list: readonly DexConnector[];
  private readonly byFactory = new Map<string, DexConnector>();

  constructor(client: ChainClient) {
    this.client = client;
    // Chain definitions are data this SDK ships; a bad one throws here rather
    // than being skipped with a warning and failing far from the cause.
    this.list = client.chain.dexes.map((deployment) => createConnector(deployment, client));
    for (const connector of this.list) {
      if (connector.kind !== 'v4') this.byFactory.set(connector.deployment.factory.toLowerCase(), connector);
    }
  }

  get connectors(): readonly DexConnector[] {
    return this.list;
  }

  connector(id: string): DexConnector | undefined {
    return this.list.find((c) => c.id === id);
  }

  /** The V4 connector, if this chain has one. */
  get v4(): UniswapV4Connector | undefined {
    return this.list.find((c): c is UniswapV4Connector => c instanceof UniswapV4Connector);
  }

  /**
   * The pool behind `ref` and the DEX that owns it, or null when no configured
   * DEX owns it. Throws `ReadError` when the RPC could not answer — which is not
   * evidence that the pool is unsupported.
   */
  async resolve(ref: Address | Hex): Promise<PoolMatch | null> {
    if (isPoolId(ref)) {
      for (const connector of this.list) {
        if (connector.kind !== 'v4') continue;
        const pool = await connector.getPool(ref);
        if (pool) return { connector, pool };
      }
      return null;
    }

    const address = getAddress(ref);
    const readFactory = (): Promise<Address> =>
      this.client.publicClient.readContract({ address, abi: UNISWAP_V2_PAIR_ABI, functionName: 'factory' });

    let factory: Address;
    try {
      factory = await readFactory();
    } catch (error) {
      if (isContractLevelFailure(error)) return null;
      // Observed on Robinhood Chain under load: a burst of lookups is throttled
      // and every pool looks unsupported. One retry clears the transient case.
      await sleep(500);
      try {
        factory = await readFactory();
      } catch (retryError) {
        if (isContractLevelFailure(retryError)) return null;
        throw new ReadError(`Could not read factory() of ${address}`, { cause: retryError });
      }
    }
    const connector = this.byFactory.get(factory.toLowerCase());
    if (!connector) return null;
    const pool = await connector.getPool(address);
    return pool ? { connector, pool } : null;
  }

  /** Every pool for a pair across all configured DEXes. A DEX whose lookup fails is skipped and logged. */
  async findPools(tokenA: Address, tokenB: Address): Promise<PoolMatch[]> {
    const perDex = await Promise.all(
      this.list.map(async (connector) => {
        try {
          return (await connector.findPools(tokenA, tokenB)).map((pool) => ({ connector, pool }));
        } catch (error) {
          this.client.logger.warn('Pool discovery failed for a DEX', { dex: connector.id, error: String(error) });
          return [];
        }
      }),
    );
    return perDex.flat();
  }
}

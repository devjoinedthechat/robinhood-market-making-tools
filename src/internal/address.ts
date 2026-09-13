import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { ConfigError } from '../errors.ts';

export const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function isZeroAddress(address: string): boolean {
  return /^0x0{40}$/i.test(address);
}

/** Uniswap ordering: token0 < token1. */
export function sortTokens(a: Address, b: Address): [Address, Address] {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

/**
 * A 32-byte Uniswap V4 PoolId rather than a 20-byte address.
 *
 * Both arrive as hex strings and the type system cannot tell them apart, so
 * this is the runtime discriminator. A V4 pool is not a contract: it is an
 * entry inside the PoolManager, named by the hash of its key.
 */
export function isPoolId(ref: string): ref is Hex {
  return /^0x[0-9a-fA-F]{64}$/.test(ref);
}

export function toAddress(value: string, what: string): Address {
  if (!isAddress(value, { strict: false })) {
    throw new ConfigError(`${what} is not a valid address: ${value}`);
  }
  return getAddress(value);
}

/** Checksummed address, or a lower-cased V4 PoolId. */
export function toPoolRef(ref: string): Address | Hex {
  if (isPoolId(ref)) return ref.toLowerCase() as Hex;
  return toAddress(ref, 'Pool reference');
}

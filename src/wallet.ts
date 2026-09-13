/**
 * Wallets are viem local accounts with an optional label.
 *
 * A `Wallet` deliberately does not carry its private key. It can be logged,
 * put in an event or passed to a strategy without that ever being a leak.
 * Any viem `LocalAccount` works — a private key, an HD derivation, or a custom
 * signer built with `toAccount` (for example one backed by a KMS).
 */

import type { Address, Hex, LocalAccount } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ConfigError } from './errors.ts';

export interface Wallet {
  readonly address: Address;
  readonly account: LocalAccount;
  readonly label?: string;
}

export function walletFromAccount(account: LocalAccount, label?: string): Wallet {
  return label === undefined ? { address: account.address, account } : { address: account.address, account, label };
}

export function walletFromPrivateKey(privateKey: string, label?: string): Wallet {
  const trimmed = privateKey.trim();
  const hex = (trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new ConfigError('Invalid private key: expected 32 bytes of hex');
  }
  return walletFromAccount(privateKeyToAccount(hex), label);
}

/** A fresh random wallet. The key is returned separately so the caller decides where it lives. */
export function generateWallet(label?: string): { wallet: Wallet; privateKey: Hex } {
  const privateKey = generatePrivateKey();
  return { wallet: walletFromPrivateKey(privateKey, label), privateKey };
}

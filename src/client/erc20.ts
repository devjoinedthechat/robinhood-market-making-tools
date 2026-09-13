/**
 * ERC-20 and Permit2 allowances.
 */

import { encodeFunctionData, maxUint256, type Address, type Hex } from 'viem';
import type { Wallet } from '../wallet.ts';
import { ERC20_ABI, PERMIT2_ABI } from './abis.ts';
import type { ExecResult, TransactionExecutor } from './executor.ts';
import type { ChainClient } from './chain-client.ts';

type NotConfirmed = Exclude<ExecResult, { status: 'confirmed' }>;

function withError(result: NotConfirmed, error: string): NotConfirmed {
  return { ...result, error };
}

function encodeApprove(spender: Address, amount: bigint): Hex {
  return encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender, amount] });
}

export function encodeTransfer(to: Address, amount: bigint): Hex {
  return encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [to, amount] });
}

/**
 * Make sure `spender` may pull at least `required` of `token` from `wallet`.
 * Returns null when no transaction was needed.
 *
 * Approves the maximum once so later trades skip the extra transaction.
 * USDT-style tokens revert on a non-zero → non-zero approval; rather than always
 * paying for a reset, the direct re-approval is tried first (its simulation
 * fails unsigned if the token needs the reset). When the reset IS needed, both
 * transactions run under one hold of the wallet lock.
 */
export async function ensureAllowance(
  client: ChainClient,
  executor: TransactionExecutor,
  wallet: Wallet,
  token: Address,
  spender: Address,
  required: bigint,
): Promise<ExecResult | null> {
  const current = await client.publicClient.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [wallet.address, spender],
  });
  if (current >= required) return null;

  const approveMax = { to: token, data: encodeApprove(spender, maxUint256) };

  if (current === 0n) {
    const approval = await executor.execute(wallet, approveMax);
    return approval.status === 'confirmed' ? approval : withError(approval, `Approval failed: ${approval.error}`);
  }

  const direct = await executor.execute(wallet, approveMax);
  if (direct.status === 'confirmed') return direct;
  // Something is on the wire and may yet land; a reset now could race it.
  if (direct.status === 'unknown') return withError(direct, `Approval outcome unknown: ${direct.error}`);

  const [reset, approval] = await executor.executeSequence(wallet, [
    { to: token, data: encodeApprove(spender, 0n) },
    approveMax,
  ]);
  if (!reset || reset.status !== 'confirmed') {
    return reset ? withError(reset, `Allowance reset failed: ${reset.error}`) : { status: 'failed', error: 'Allowance reset was not attempted' };
  }
  if (!approval || approval.status !== 'confirmed') {
    // The reset landed: the wallet is now at allowance 0, strictly worse than before. Say so.
    const detail = approval ? approval.error : 'approval was not attempted';
    const message = `Approval failed after the reset landed — ${wallet.address} now has allowance 0 for ${spender} on ${token}: ${detail}`;
    return approval ? withError(approval, message) : { status: 'failed', error: message };
  }
  return approval;
}

/**
 * Ensure Permit2 lets `spender` (the UniversalRouter) move `token` for `wallet`.
 *
 * A V4 swap needs TWO approvals: ERC-20 → Permit2, then Permit2 → router.
 * Permit2 allowances expire, so the expiry is checked, not just the amount.
 */
export async function ensurePermit2Allowance(
  client: ChainClient,
  executor: TransactionExecutor,
  wallet: Wallet,
  permit2: Address,
  token: Address,
  spender: Address,
  required: bigint,
): Promise<ExecResult | null> {
  try {
    const [amount, expiration] = await client.publicClient.readContract({
      address: permit2,
      abi: PERMIT2_ABI,
      functionName: 'allowance',
      args: [wallet.address, token, spender],
    });
    if (amount >= required && BigInt(expiration) > BigInt(Math.floor(Date.now() / 1000))) return null;
  } catch {
    // A failed read is not evidence of an allowance: approve.
  }
  const data = encodeFunctionData({
    abi: PERMIT2_ABI,
    functionName: 'approve',
    // uint160 max amount and uint48 max expiry: what Permit2 treats as unlimited.
    args: [token, spender, (1n << 160n) - 1n, Number((1n << 48n) - 1n)],
  });
  const approval = await executor.execute(wallet, { to: permit2, data });
  return approval.status === 'confirmed' ? approval : withError(approval, `Permit2 approval failed: ${approval.error}`);
}

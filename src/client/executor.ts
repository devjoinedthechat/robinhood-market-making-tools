/**
 * Transaction execution: simulate, price, sign, send, confirm — and never place
 * the same transaction twice.
 *
 * Two invariants make a duplicate impossible:
 *
 *  1. A payload is signed BEFORE it is broadcast and its hash recorded then, so a
 *     lost send response still leaves a hash to look a receipt up with. Every
 *     recovery path reads that list.
 *  2. A payload that has been on the wire is never re-sent under a different
 *     nonce. Retries re-send the identical bytes (same hash, idempotent) or
 *     replace them at the SAME nonce with higher fees.
 *
 * When the outcome genuinely cannot be established, the result is
 * `status: 'unknown'` rather than a failure. Treating "we don't know" as "it
 * didn't happen" is exactly how a position gets opened or closed twice.
 *
 * Sends are serialised per wallet so concurrent callers never race a nonce.
 */

import {
  BaseError,
  InsufficientFundsError,
  NonceTooLowError,
  WaitForTransactionReceiptTimeoutError,
  formatUnits,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
  type ReplacementReason,
  type TransactionReceipt,
} from 'viem';
import { sendRawTransaction } from 'viem/actions';
import { BroadcastBlockedError } from '../errors.ts';
import { KeyedMutex, sleep } from '../internal/async.ts';
import type { Logger } from '../logger.ts';
import type { Wallet } from '../wallet.ts';

export interface TxRequest {
  readonly to: Address;
  readonly data?: Hex;
  readonly value?: bigint;
  /** Skip estimation and use this gas limit. */
  readonly gas?: bigint;
}

export interface ExecOptions {
  /** Broadcast attempts, replacements included. Default 3. */
  readonly maxAttempts?: number;
  /** How long to wait for a receipt before replacing with higher fees. Default 45s. */
  readonly receiptTimeoutMs?: number;
  /** Multiplier on the gas estimate. Default 1.2. */
  readonly gasMultiplier?: number;
}

export type ExecResult =
  | {
      readonly status: 'confirmed';
      readonly hash: Hex;
      readonly block: number;
      readonly gasUsed: bigint;
      readonly feeNative: number;
      readonly logs: TransactionReceipt['logs'];
      readonly nonce: number;
    }
  | {
      readonly status: 'failed';
      readonly error: string;
      readonly hash?: Hex;
      readonly block?: number;
      readonly feeNative?: number;
      readonly nonce?: number;
    }
  | {
      /** Broadcast, outcome not established. It may still land: do NOT retry. */
      readonly status: 'unknown';
      readonly error: string;
      readonly hash?: Hex;
      readonly nonce: number;
    };

export interface Fees {
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
}

export interface ExecutorDeps {
  /** Reads, estimation and receipts. */
  readonly publicClient: PublicClient;
  /** The endpoint transactions are submitted to; pending nonces are read from it too. */
  readonly submitClient: PublicClient;
  readonly chainId: number;
  readonly nativeDecimals: number;
  readonly confirmations: number;
  readonly logger: Logger;
  readonly readOnly: boolean;
}

/** How a rejected broadcast should be handled. The two nonce cases mean opposite things. */
export type BroadcastFailure = 'already-known' | 'nonce-too-low' | 'insufficient-funds' | 'underpriced' | 'other';

const DEFAULTS = { maxAttempts: 3, receiptTimeoutMs: 45_000, gasMultiplier: 1.2 } as const;

/** How long a locally observed mined nonce outranks the node's pending count. */
const NONCE_MEMORY_MS = 60_000;

/** Multiply a bigint by a float with 4 decimal places of precision. */
function scale(value: bigint, factor: number): bigint {
  return (value * BigInt(Math.round(factor * 10_000))) / 10_000n;
}

/** Nodes only accept a replacement priced at ≥110% of the pending transaction. */
function clearsReplacementFloor(next: bigint, current: bigint): boolean {
  return next * 10n >= current * 11n;
}

/** The most useful one-line description of a viem error. */
export function describeError(error: unknown): string {
  if (error instanceof BaseError) {
    const details = (error as BaseError & { details?: string }).details;
    const meta = (error as BaseError & { metaMessages?: string[] }).metaMessages;
    return Array.from(new Set([error.shortMessage, details, meta?.[0]].filter(Boolean))).join(' — ');
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Raw node wording from every layer of the cause chain, lower-cased. */
function nodeDetails(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof BaseError; depth++) {
    const details = (current as BaseError & { details?: string }).details;
    if (details) parts.push(details);
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(' ').toLowerCase();
}

/**
 * Classify a rejected broadcast.
 *
 * viem's typed errors are the primary signal; raw node wording is consulted for
 * what viem does not model — notably "already known", which viem folds into
 * NonceTooLowError even though it means our own transaction is already pooled.
 */
export function classifyBroadcastError(error: unknown): BroadcastFailure {
  const details = nodeDetails(error);
  if (/already known|transaction already imported|already exists|known transaction/.test(details)) {
    return 'already-known';
  }
  const typed =
    error instanceof BaseError
      ? error.walk((e) => e instanceof NonceTooLowError || e instanceof InsufficientFundsError)
      : null;
  if (typed instanceof NonceTooLowError) return 'nonce-too-low';
  if (typed instanceof InsufficientFundsError) return 'insufficient-funds';

  if (/nonce too low|invalid nonce|nonce is too low|oldnonce/.test(details)) return 'nonce-too-low';
  if (/insufficient funds|not enough funds|gas \* price \+ value/.test(details)) return 'insufficient-funds';
  if (/replacement transaction underpriced|fee too low|underpriced|gas price too low/.test(details)) return 'underpriced';

  const message = describeError(error).toLowerCase();
  if (message.includes('already known')) return 'already-known';
  if (message.includes('nonce too low')) return 'nonce-too-low';
  if (message.includes('insufficient funds')) return 'insufficient-funds';
  if (message.includes('underpriced') || message.includes('fee too low')) return 'underpriced';
  return 'other';
}

/** Fees raised by `factor`. The +1 keeps a bump from being a no-op after integer truncation. */
export function bumpFees(fees: Fees, factor: number): Fees {
  return {
    maxFeePerGas: scale(fees.maxFeePerGas, factor) + 1n,
    maxPriorityFeePerGas: scale(fees.maxPriorityFeePerGas, factor) + 1n,
  };
}

/**
 * The bumped fees capped to what the wallet can pay, or null when no
 * replacement that clears the node's 110% floor is affordable.
 *
 * Bumping past the balance gets the replacement rejected while the original
 * stays pending — the worst of both outcomes.
 */
export function capFeesToBalance(target: Fees, current: Fees, gas: bigint, spendable: bigint): Fees | null {
  if (gas <= 0n) return target;
  const cap = spendable / gas;
  if (target.maxFeePerGas <= cap) return target;
  if (!clearsReplacementFloor(cap, current.maxFeePerGas)) return null;
  const priority = target.maxPriorityFeePerGas < cap ? target.maxPriorityFeePerGas : cap;
  if (!clearsReplacementFloor(priority, current.maxPriorityFeePerGas)) return null;
  return { maxFeePerGas: cap, maxPriorityFeePerGas: priority };
}

interface SignedTx {
  readonly raw: Hex;
  readonly hash: Hex;
}

type Resolved = Required<ExecOptions>;

export class TransactionExecutor {
  private readonly deps: ExecutorDeps;
  private readonly mutex = new KeyedMutex();
  /** Highest nonce seen mined per wallet — covers the node's receipt-indexing lag. */
  private readonly consumed = new Map<string, { nonce: number; at: number }>();

  constructor(deps: ExecutorDeps) {
    this.deps = deps;
  }

  /** Execute one transaction. Never throws for an on-chain or RPC failure — only `BroadcastBlockedError`. */
  execute(wallet: Wallet, request: TxRequest, options: ExecOptions = {}): Promise<ExecResult> {
    const opts: Resolved = { ...DEFAULTS, ...options };
    return this.mutex.run(wallet.address.toLowerCase(), () => this.executeLocked(wallet, request, opts));
  }

  /**
   * Several transactions from one wallet without releasing its lock between them.
   *
   * Needed where a sequence is only correct as a unit — an allowance reset then
   * re-approval leaves allowance 0 in between, and anything else trading that
   * wallet in the gap reverts. Stops at the first result that is not confirmed.
   */
  executeSequence(wallet: Wallet, requests: readonly TxRequest[], options: ExecOptions = {}): Promise<ExecResult[]> {
    const opts: Resolved = { ...DEFAULTS, ...options };
    return this.mutex.run(wallet.address.toLowerCase(), async () => {
      const results: ExecResult[] = [];
      for (const request of requests) {
        const result = await this.executeLocked(wallet, request, opts);
        results.push(result);
        if (result.status !== 'confirmed') break;
      }
      return results;
    });
  }

  private async executeLocked(wallet: Wallet, request: TxRequest, opts: Resolved): Promise<ExecResult> {
    const { publicClient, submitClient, logger } = this.deps;
    const address = wallet.address;

    // 1. Gas estimation is the simulation: a reverting call fails here, unsigned.
    let gas: bigint;
    try {
      gas =
        request.gas ??
        scale(
          await publicClient.estimateGas({
            account: wallet.account,
            to: request.to,
            data: request.data,
            value: request.value,
          }),
          opts.gasMultiplier,
        );
    } catch (error) {
      const message = describeError(error);
      logger.debug('Simulation failed', { to: request.to, error: message });
      return { status: 'failed', error: `Simulation failed: ${message}` };
    }

    // After the simulation on purpose: a read-only client still validates the call.
    if (this.deps.readOnly) {
      throw new BroadcastBlockedError(`transaction from ${address} to ${request.to}`);
    }

    // 2. Fees
    let fees: Fees;
    try {
      const estimate = await publicClient.estimateFeesPerGas();
      fees = { maxFeePerGas: estimate.maxFeePerGas, maxPriorityFeePerGas: estimate.maxPriorityFeePerGas };
    } catch (error) {
      return { status: 'failed', error: `Fee estimation failed: ${describeError(error)}` };
    }

    // 3. Nonce, from the endpoint we submit to.
    let nonce: number;
    try {
      nonce = await this.readNonce(submitClient, address);
    } catch (error) {
      return { status: 'failed', error: `Nonce lookup failed: ${describeError(error)}` };
    }

    /** Every hash signed for this call, recorded before any broadcast. */
    const attempted: Hex[] = [];
    /** True once a node has acknowledged holding one of them. */
    let broadcast = false;
    let signed: SignedTx | null = null;
    let lastError = 'unknown error';

    for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
      if (!signed) {
        try {
          signed = await this.sign(wallet, request, gas, nonce, fees);
        } catch (error) {
          return { status: 'failed', error: `Signing failed: ${describeError(error)}`, nonce };
        }
        if (!attempted.includes(signed.hash)) attempted.push(signed.hash);
      }

      try {
        await sendRawTransaction(submitClient, { serializedTransaction: signed.raw });
        broadcast = true;
        logger.debug('Transaction broadcast', { hash: signed.hash, nonce, attempt: attempt + 1 });
      } catch (error) {
        lastError = describeError(error);
        const kind = classifyBroadcastError(error);

        if (kind === 'already-known') {
          // The node already holds THIS transaction. Advancing the nonce here is
          // what turns one trade into two — wait for its receipt instead.
          broadcast = true;
        } else if (kind === 'nonce-too-low') {
          const mined = await this.pollMinedReceipt(attempted);
          if (mined) return this.fromReceipt(mined, nonce);
          if (broadcast) {
            return this.unresolved(attempted, nonce, address, `${lastError} (nonce ${nonce} is already consumed)`);
          }
          // Nothing of ours reached a node, so the nonce was merely stale.
          try {
            nonce = await this.readNonce(submitClient, address);
          } catch (nonceError) {
            return { status: 'failed', error: `Nonce refresh failed: ${describeError(nonceError)}`, nonce };
          }
          signed = null;
          continue;
        } else if (kind === 'insufficient-funds') {
          const mined = await this.pollMinedReceipt(attempted);
          if (mined) return this.fromReceipt(mined, nonce);
          // After a broadcast this is almost always an unaffordable replacement
          // while the original is still live — not a clean failure.
          if (broadcast) return this.unresolved(attempted, nonce, address, lastError);
          return { status: 'failed', error: lastError, nonce };
        } else if (kind === 'underpriced') {
          const bumped = await this.affordableBump(address, fees, gas, request.value ?? 0n, 1.3);
          if (!bumped) {
            logger.warn('Replacement underpriced and no fee headroom left', { nonce, wallet: address });
            continue;
          }
          fees = bumped;
          signed = null;
          continue;
        } else {
          // Transport failure. The payload is unchanged, so re-sending the SAME
          // bytes is idempotent — never rebuild it here.
          logger.warn('Broadcast failed, retrying the identical transaction', { attempt: attempt + 1, error: lastError });
          await sleep(1_000 * (attempt + 1));
          continue;
        }
      }

      // 4. Receipt; on timeout, replace at the same nonce with higher fees.
      let replacedReason: ReplacementReason | undefined;
      try {
        const receipt = await publicClient.waitForTransactionReceipt({
          hash: signed.hash,
          confirmations: this.deps.confirmations,
          timeout: opts.receiptTimeoutMs,
          onReplaced: (replacement) => {
            replacedReason = replacement.reason;
          },
        });
        // Only 'repriced' is our own fee bump. A 'cancelled'/'replaced' nonce
        // belongs to someone else, and booking their receipt as our fill would
        // record a trade that never happened.
        if (replacedReason && replacedReason !== 'repriced') {
          this.noteConsumed(address, nonce);
          return {
            status: 'failed',
            hash: receipt.transactionHash,
            block: Number(receipt.blockNumber),
            nonce,
            error: `Nonce ${nonce} was ${replacedReason} by another sender — this transaction did not execute`,
          };
        }
        return this.fromReceipt(receipt, nonce);
      } catch (error) {
        if (error instanceof WaitForTransactionReceiptTimeoutError) {
          lastError = `Timed out after ${opts.receiptTimeoutMs}ms waiting for ${signed.hash}`;
          const bumped = await this.affordableBump(address, fees, gas, request.value ?? 0n, 1.25);
          if (!bumped) {
            // Replacing costs more than the wallet holds; keep waiting on what is out there.
            logger.warn('Receipt timeout with no fee headroom to replace; still waiting', { hash: signed.hash, nonce });
            continue;
          }
          logger.warn('Receipt timeout, replacing at the same nonce with higher fees', { hash: signed.hash, nonce });
          fees = bumped;
          signed = null;
          continue;
        }
        const mined = await this.pollMinedReceipt(attempted, 2, 1_500);
        if (mined) return this.fromReceipt(mined, nonce);
        lastError = describeError(error);
        logger.warn('Waiting for receipt failed', { hash: signed.hash, error: lastError });
      }
    }

    // Out of attempts: one last, patient look at everything broadcast.
    const mined = await this.pollMinedReceipt(attempted, 4, 2_500);
    if (mined) return this.fromReceipt(mined, nonce);
    if (broadcast) return this.unresolved(attempted, nonce, address, lastError);
    return { status: 'failed', error: lastError, nonce };
  }

  /** Signed locally, so the hash is known before any network call. */
  private async sign(wallet: Wallet, request: TxRequest, gas: bigint, nonce: number, fees: Fees): Promise<SignedTx> {
    const raw = await wallet.account.signTransaction({
      type: 'eip1559',
      chainId: this.deps.chainId,
      to: request.to,
      data: request.data,
      value: request.value ?? 0n,
      gas,
      nonce,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });
    return { raw, hash: keccak256(raw) };
  }

  private async readNonce(client: PublicClient, address: Address): Promise<number> {
    const pending = await client.getTransactionCount({ address, blockTag: 'pending' });
    // A receipt can be visible before the pending count reflects it. The memory
    // expires so a re-orged-out transaction cannot strand the wallet forever.
    const seen = this.consumed.get(address.toLowerCase());
    if (!seen || Date.now() - seen.at > NONCE_MEMORY_MS) return pending;
    return Math.max(pending, seen.nonce + 1);
  }

  private noteConsumed(address: Address, nonce: number): void {
    const key = address.toLowerCase();
    const current = this.consumed.get(key);
    if (!current || nonce > current.nonce) this.consumed.set(key, { nonce, at: Date.now() });
  }

  private async affordableBump(address: Address, fees: Fees, gas: bigint, value: bigint, factor: number): Promise<Fees | null> {
    const target = bumpFees(fees, factor);
    let balance: bigint;
    try {
      balance = await this.deps.publicClient.getBalance({ address });
    } catch {
      return target; // cannot check — proceed rather than stall
    }
    return capFeesToBalance(target, fees, gas, balance > value ? balance - value : 0n);
  }

  /**
   * A mined receipt among `hashes`, retried with backoff: on load-balanced RPCs
   * the node reporting a consumed nonce is often not the one that indexed the receipt.
   */
  private async pollMinedReceipt(hashes: readonly Hex[], attempts = 3, delayMs = 2_000): Promise<TransactionReceipt | null> {
    if (hashes.length === 0) return null;
    for (let i = 0; i < attempts; i++) {
      for (const hash of hashes) {
        try {
          return await this.deps.publicClient.getTransactionReceipt({ hash });
        } catch {
          // not mined, or not indexed on this node yet
        }
      }
      if (i < attempts - 1) await sleep(delayMs);
    }
    return null;
  }

  private unresolved(attempted: readonly Hex[], nonce: number, address: Address, reason: string): ExecResult {
    const hash = attempted[attempted.length - 1];
    this.deps.logger.warn('Transaction outcome could not be determined — do not retry it', { wallet: address, nonce, hash, reason });
    return {
      status: 'unknown',
      nonce,
      ...(hash ? { hash } : {}),
      error: `${reason}. The transaction may still be mined — resolve nonce ${nonce} on ${address} before trading this wallet again.`,
    };
  }

  private fromReceipt(receipt: TransactionReceipt, nonce: number): ExecResult {
    // viem yields null for effectiveGasPrice when a node omits it, whatever its types say.
    const price = (receipt.effectiveGasPrice as bigint | null) ?? 0n;
    const feeNative = Number(formatUnits(receipt.gasUsed * price, this.deps.nativeDecimals));
    this.noteConsumed(receipt.from, nonce);
    const block = Number(receipt.blockNumber);

    // Anything that is not an affirmative success is a failure.
    if (receipt.status !== 'success') {
      return { status: 'failed', hash: receipt.transactionHash, block, feeNative, nonce, error: 'Transaction reverted on-chain' };
    }
    this.deps.logger.debug('Transaction confirmed', { hash: receipt.transactionHash, block, feeNative });
    return {
      status: 'confirmed',
      hash: receipt.transactionHash,
      block,
      gasUsed: receipt.gasUsed,
      feeNative,
      logs: receipt.logs,
      nonce,
    };
  }
}

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BaseError,
  InsufficientFundsError,
  NonceTooLowError,
  WaitForTransactionReceiptTimeoutError,
  keccak256,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  TransactionExecutor,
  bumpFees,
  capFeesToBalance,
  classifyBroadcastError,
  type ExecResult,
} from '../src/client/executor.ts';
import { BroadcastBlockedError } from '../src/errors.ts';
import { KeyedMutex } from '../src/internal/async.ts';
import { silentLogger } from '../src/logger.ts';
import { walletFromAccount } from '../src/wallet.ts';

describe('classifyBroadcastError', () => {
  it('reads viem typed errors through the cause chain', () => {
    assert.equal(classifyBroadcastError(new BaseError('send', { cause: new NonceTooLowError() })), 'nonce-too-low');
    assert.equal(classifyBroadcastError(new BaseError('send', { cause: new InsufficientFundsError() })), 'insufficient-funds');
  });

  it('treats "already known" as our own pooled transaction even when viem calls it NonceTooLow', () => {
    // viem's real shape: the node's wording becomes the typed error's details via its cause.
    const error = new NonceTooLowError({ cause: new BaseError('rpc', { details: 'already known' }) });
    assert.equal(classifyBroadcastError(error), 'already-known');
  });

  it('recognises underpriced replacements from node wording', () => {
    assert.equal(classifyBroadcastError(new BaseError('send', { details: 'replacement transaction underpriced' })), 'underpriced');
  });

  it('falls back to other for anything unrecognised', () => {
    assert.equal(classifyBroadcastError(new Error('socket hang up')), 'other');
  });
});

describe('fee bumps', () => {
  it('bumps both fields and never produces a no-op', () => {
    assert.deepEqual(bumpFees({ maxFeePerGas: 100n, maxPriorityFeePerGas: 10n }, 1.25), { maxFeePerGas: 126n, maxPriorityFeePerGas: 13n });
    assert.deepEqual(bumpFees({ maxFeePerGas: 0n, maxPriorityFeePerGas: 0n }, 1.25), { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
  });

  it('keeps a target the wallet can afford', () => {
    const target = { maxFeePerGas: 130n, maxPriorityFeePerGas: 13n };
    assert.deepEqual(capFeesToBalance(target, { maxFeePerGas: 100n, maxPriorityFeePerGas: 10n }, 1_000n, 1_000_000n), target);
  });

  it('caps to the balance when the cap still clears the 110% replacement floor', () => {
    const capped = capFeesToBalance({ maxFeePerGas: 130n, maxPriorityFeePerGas: 13n }, { maxFeePerGas: 100n, maxPriorityFeePerGas: 10n }, 1_000n, 120_000n);
    assert.deepEqual(capped, { maxFeePerGas: 120n, maxPriorityFeePerGas: 13n });
  });

  it('refuses a replacement the node would reject anyway', () => {
    assert.equal(capFeesToBalance({ maxFeePerGas: 130n, maxPriorityFeePerGas: 13n }, { maxFeePerGas: 100n, maxPriorityFeePerGas: 10n }, 1_000n, 105_000n), null);
  });
});

describe('KeyedMutex', () => {
  it('serialises work per key and runs different keys concurrently', async () => {
    const mutex = new KeyedMutex();
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const task = (key: string, label: string) =>
      mutex.run(key, async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        order.push(label);
        active--;
      });
    await Promise.all([task('a', 'a1'), task('a', 'a2'), task('a', 'a3')]);
    assert.equal(maxActive, 1);
    assert.deepEqual(order, ['a1', 'a2', 'a3']);

    maxActive = 0;
    await Promise.all([task('x', 'x'), task('y', 'y')]);
    assert.equal(maxActive, 2);
    assert.equal(mutex.size, 0);
  });
});

// ── the executor against scripted RPC doubles ───────────────────────────────

const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const wallet = walletFromAccount(account);
const REQUEST = { to: '0x000000000000000000000000000000000000dEaD', value: 1n } as const;

interface Script {
  /** Behaviour of each successive eth_sendRawTransaction; returning normally means accepted. */
  sends?: Array<() => void>;
  /** What waitForTransactionReceipt does for a hash. */
  wait?: (hash: Hex, onReplaced: (r: { reason: string }) => void) => unknown;
  /** Hashes getTransactionReceipt can find. */
  mined?: (hash: Hex) => boolean;
  estimateGas?: () => Promise<bigint>;
  readOnly?: boolean;
}

function receipt(hash: Hex, status: 'success' | 'reverted' = 'success') {
  return { status, transactionHash: hash, blockNumber: 9n, gasUsed: 21_000n, effectiveGasPrice: 2n, from: wallet.address, logs: [] };
}

function executor(script: Script): { exec: TransactionExecutor; sent: Hex[] } {
  const sent: Hex[] = [];
  const sends = [...(script.sends ?? [])];
  const publicClient = {
    estimateGas: script.estimateGas ?? (async () => 21_000n),
    estimateFeesPerGas: async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 1n }),
    getBalance: async () => 10n ** 18n,
    waitForTransactionReceipt: async ({ hash, onReplaced }: { hash: Hex; onReplaced: (r: { reason: string }) => void }) =>
      script.wait ? script.wait(hash, onReplaced) : receipt(hash),
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (script.mined?.(hash)) return receipt(hash);
      throw new Error('receipt not found');
    },
  };
  const submitClient = {
    getTransactionCount: async () => 7,
    request: async ({ method, params }: { method: string; params: [Hex] }) => {
      assert.equal(method, 'eth_sendRawTransaction');
      sent.push(params[0]);
      sends.shift()?.();
      return keccak256(params[0]);
    },
  };
  const exec = new TransactionExecutor({
    publicClient: publicClient as unknown as PublicClient,
    submitClient: submitClient as unknown as PublicClient,
    chainId: 46630,
    nativeDecimals: 18,
    confirmations: 1,
    logger: silentLogger,
    readOnly: script.readOnly ?? false,
  });
  return { exec, sent };
}

function expectStatus<S extends ExecResult['status']>(result: ExecResult, status: S): Extract<ExecResult, { status: S }> {
  assert.equal(result.status, status, `expected ${status}, got ${result.status}: ${'error' in result ? result.error : ''}`);
  return result as Extract<ExecResult, { status: S }>;
}

describe('TransactionExecutor', () => {
  it('confirms a transaction and reports the fee paid', async () => {
    const { exec, sent } = executor({});
    const result = expectStatus(await exec.execute(wallet, REQUEST), 'confirmed');
    assert.equal(sent.length, 1);
    assert.equal(result.nonce, 7);
    assert.equal(result.hash, keccak256(sent[0] as Hex));
    assert.equal(result.feeNative, 42_000 / 1e18);
  });

  it('waits for the receipt when the node already holds the transaction, sending nothing new', async () => {
    const { exec, sent } = executor({
      sends: [() => {
        throw new BaseError('rpc', { details: 'already known' });
      }],
    });
    expectStatus(await exec.execute(wallet, REQUEST), 'confirmed');
    assert.equal(sent.length, 1);
  });

  it('re-sends the IDENTICAL bytes after a lost response, and finds the mined receipt instead of trading twice', async () => {
    const { exec, sent } = executor({
      sends: [
        () => {
          throw new Error('socket hang up');
        },
        () => {
          throw new BaseError('rpc', { cause: new NonceTooLowError() });
        },
      ],
      mined: () => true,
    });
    expectStatus(await exec.execute(wallet, REQUEST), 'confirmed');
    assert.equal(sent.length, 2);
    assert.equal(sent[0], sent[1], 'the retry must be the same signed transaction');
  });

  it('reports UNKNOWN, not failed, when a broadcast transaction cannot be found', async () => {
    const { exec } = executor({
      wait: (hash) => {
        throw new WaitForTransactionReceiptTimeoutError({ hash });
      },
      sends: [
        () => {},
        () => {
          throw new BaseError('rpc', { cause: new NonceTooLowError() });
        },
      ],
      mined: () => false,
    });
    const result = expectStatus(await exec.execute(wallet, REQUEST), 'unknown');
    assert.match(result.error, /may still be mined/);
    assert.ok(result.hash);
  });

  it('reports a reverted receipt as failed, with its hash', async () => {
    const { exec } = executor({ wait: (hash) => receipt(hash, 'reverted') });
    const result = expectStatus(await exec.execute(wallet, REQUEST), 'failed');
    assert.ok(result.hash);
  });

  it('never books another sender’s transaction at our nonce as our fill', async () => {
    const { exec } = executor({
      wait: (hash, onReplaced) => {
        onReplaced({ reason: 'cancelled' });
        return receipt(hash);
      },
    });
    const result = expectStatus(await exec.execute(wallet, REQUEST), 'failed');
    assert.match(result.error, /cancelled by another sender/);
  });

  it('returns a simulation failure without signing anything', async () => {
    const { exec, sent } = executor({
      estimateGas: async () => {
        throw new Error('execution reverted: STF');
      },
    });
    const result = expectStatus(await exec.execute(wallet, REQUEST), 'failed');
    assert.match(result.error, /Simulation failed/);
    assert.equal(sent.length, 0);
  });

  it('throws BroadcastBlockedError on a read-only client after simulating, sending nothing', async () => {
    const { exec, sent } = executor({ readOnly: true });
    await assert.rejects(exec.execute(wallet, REQUEST), BroadcastBlockedError);
    assert.equal(sent.length, 0);
  });
});

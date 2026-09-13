import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { V4_QUOTER_ARTIFACT } from '../src/dex/v4-quoter-artifact.ts';

describe('embedded V4 quoter', () => {
  it('was compiled from the Solidity source in this repository', () => {
    const source = readFileSync(new URL('../contracts/V4Quoter.sol', import.meta.url), 'utf8');
    const hash = `0x${createHash('sha256').update(source.replace(/\r\n/g, '\n').replace(/\s+$/, '\n'), 'utf8').digest('hex')}`;
    assert.equal(hash, V4_QUOTER_ARTIFACT.sourceHash, 'contracts/V4Quoter.sol changed — run node scripts/build-quoter.mjs');
  });

  it('carries runtime bytecode', () => {
    assert.match(V4_QUOTER_ARTIFACT.deployedBytecode, /^0x([0-9a-f]{2})+$/);
    assert.ok(V4_QUOTER_ARTIFACT.deployedBytecode.length > 1_000);
  });

  it('exposes only the quote entry point and its callback', () => {
    const functions = V4_QUOTER_ARTIFACT.abi.filter((e) => e.type === 'function').map((e) => ('name' in e ? e.name : ''));
    assert.deepEqual([...functions].sort(), ['quoteExactInputSingle', 'unlockCallback']);
    assert.ok(V4_QUOTER_ARTIFACT.abi.every((e) => !('stateMutability' in e) || (e.stateMutability as string) !== 'payable'));
  });
});

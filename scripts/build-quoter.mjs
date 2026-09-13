#!/usr/bin/env node
/**
 * Compile contracts/V4Quoter.sol → src/dex/v4-quoter-artifact.ts.
 *
 * The quoter's runtime bytecode is injected into an eth_call by state override,
 * so the SDK ships it as a TypeScript constant. This script is the only way that
 * constant should change. Everything that could vary between machines is pinned:
 * exact solc version, optimizer runs, evmVersion 'paris' (no PUSH0/MCOPY/TSTORE,
 * so the bytecode runs on any ArbOS version) and no metadata hash, so anyone can
 * reproduce the bytes from the source alone.
 *
 *   npm install --no-save solc@0.8.28
 *   node scripts/build-quoter.mjs            # write the artifact
 *   node scripts/build-quoter.mjs --check    # fail if the committed artifact is stale
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const SOLC_VERSION = '0.8.28';
const SOURCE = new URL('../contracts/V4Quoter.sol', import.meta.url);
const TARGET = new URL('../src/dex/v4-quoter-artifact.ts', import.meta.url);
const SETTINGS = {
  optimizer: { enabled: true, runs: 200 },
  evmVersion: 'paris',
  metadata: { bytecodeHash: 'none' },
  outputSelection: { '*': { '*': ['abi', 'evm.deployedBytecode.object'] } },
};
const EXPECTED_FUNCTIONS = ['quoteExactInputSingle', 'unlockCallback'];

function fail(message) {
  console.error(`build-quoter: ${message}`);
  process.exit(1);
}

let solc;
try {
  solc = createRequire(import.meta.url)('solc');
} catch {
  fail(`solc is not installed. Run: npm install --no-save solc@${SOLC_VERSION}`);
}
if (!solc.version().startsWith(SOLC_VERSION)) fail(`expected solc ${SOLC_VERSION}, got ${solc.version()}`);

const source = readFileSync(SOURCE, 'utf8');
// Line endings normalised so a CRLF checkout hashes the same as a POSIX one.
const sourceHash = `0x${createHash('sha256').update(source.replace(/\r\n/g, '\n').replace(/\s+$/, '\n'), 'utf8').digest('hex')}`;

const output = JSON.parse(
  solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'V4Quoter.sol': { content: source } }, settings: SETTINGS })),
);
const diagnostics = output.errors ?? [];
if (diagnostics.length > 0) fail(`compiler reported:\n${diagnostics.map((d) => d.formattedMessage).join('\n')}`);

const compiled = output.contracts['V4Quoter.sol'].V4Quoter;
const functions = compiled.abi.filter((e) => e.type === 'function').map((e) => e.name).sort();
if (JSON.stringify(functions) !== JSON.stringify(EXPECTED_FUNCTIONS)) {
  fail(`unexpected quoter functions ${functions.join(', ')} — a quoter must never grow a state-changing entry point`);
}

const abi = JSON.stringify(compiled.abi, null, 2)
  .replace(/"([A-Za-z_][A-Za-z0-9_]*)":/g, '$1:')
  .replace(/"/g, "'");

const artifact = `/**
 * Compiled V4Quoter (contracts/V4Quoter.sol). GENERATED — do not edit by hand.
 *
 * Regenerate with \`node scripts/build-quoter.mjs\` (needs solc ${SOLC_VERSION}).
 * test/quoter-artifact.test.ts fails if the Solidity source no longer matches
 * \`sourceHash\`, so a changed contract cannot ship with stale bytecode.
 *
 * Embedded rather than read from disk so the SDK works unchanged under every
 * bundler and in every runtime: there is no path to resolve.
 */

export const V4_QUOTER_ARTIFACT = {
  sourceHash: '${sourceHash}',
  compiler: 'solc ${SOLC_VERSION} (optimizer ${SETTINGS.optimizer.runs} runs, evm ${SETTINGS.evmVersion})',
  abi: ${abi},
  deployedBytecode:
    '0x${compiled.evm.deployedBytecode.object}',
} as const;
`;

if (process.argv.includes('--check')) {
  if (readFileSync(TARGET, 'utf8') !== artifact) fail('src/dex/v4-quoter-artifact.ts is stale — run node scripts/build-quoter.mjs');
  console.log('build-quoter: artifact matches source');
} else {
  writeFileSync(TARGET, artifact);
  console.log(`build-quoter: wrote ${(compiled.evm.deployedBytecode.object.length / 2).toString()} runtime bytes, source ${sourceHash}`);
}

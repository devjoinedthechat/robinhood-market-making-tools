/**
 * Architectural guarantees, enforced rather than documented.
 *
 * The engine this SDK came from read `process.env` at import, resolved files
 * against `process.cwd()`, found contract artifacts by walking `__dirname`, and
 * wrote to a SQLite file as a side effect of trading. Each of those broke some
 * host. These tests keep them from coming back.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : [];
  });
}

const files = walk(SRC).map((path) => ({ path, rel: relative(SRC, path), code: readFileSync(path, 'utf8') }));

/** Lower layers may never import higher ones. */
function layerOf(rel: string): number {
  if (rel.startsWith('internal/') || !rel.includes('/')) {
    if (rel === 'market-maker.ts') return 6;
    if (rel === 'index.ts') return 7;
    return 0;
  }
  const order = ['client', 'dex', 'market', 'risk', 'strategy'];
  return order.indexOf(rel.split('/')[0] as string) + 1;
}

function relativeImports(code: string): string[] {
  return Array.from(code.matchAll(/(?:from|import)\s+'(\.[^']+)'/g), (m) => m[1] as string);
}

describe('architecture', () => {
  it('has no host coupling: no environment, filesystem, process or console access in src', () => {
    const forbidden: Array<[RegExp, string]> = [
      [/process\.(env|cwd|exit|argv)/, 'process access'],
      [/from 'node:/, 'a Node builtin'],
      [/from '(fs|path|os|child_process|crypto)'/, 'a Node builtin'],
      [/\brequire\(/, 'require()'],
      [/import\.meta/, 'import.meta'],
      [/__dirname|__filename/, '__dirname'],
      [/@solana|better-sqlite3|dotenv/, 'a dependency from the parent engine'],
    ];
    for (const file of files) {
      for (const [pattern, what] of forbidden) {
        assert.ok(!pattern.test(file.code), `${file.rel} uses ${what}`);
      }
      if (file.rel !== 'logger.ts') assert.ok(!/\bconsole\./.test(file.code), `${file.rel} writes to the console`);
    }
  });

  it('keeps layers acyclic: client → dex → market → risk → strategy → front door', () => {
    for (const file of files) {
      for (const spec of relativeImports(file.code)) {
        const target = relative(SRC, resolve(dirname(file.path), spec));
        assert.ok(
          layerOf(target) <= layerOf(file.rel),
          `${file.rel} (layer ${layerOf(file.rel)}) imports ${target} (layer ${layerOf(target)})`,
        );
      }
    }
  });

  it('uses explicit .ts extensions on every relative import', () => {
    for (const file of files) {
      for (const spec of relativeImports(file.code)) assert.match(spec, /\.ts$/, `${file.rel} imports ${spec}`);
    }
  });

  it('ships no runtime dependencies besides the viem peer', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0);
    assert.deepEqual(Object.keys(pkg.peerDependencies ?? {}), ['viem']);
  });

  it('exposes the documented public API', async () => {
    const api = await import('../src/index.ts');
    for (const name of ['createMarketMaker', 'robinhood', 'robinhoodTestnet', 'runStrategies', 'GuardedMarket', 'walletFromPrivateKey', 'poolIdOf']) {
      assert.ok(name in api, `missing export ${name}`);
    }
    assert.deepEqual(Object.keys(api.strategies).sort(), ['absorbWall', 'dipBuy', 'grid', 'inventoryRebalance', 'supportBuy', 'takeProfit', 'twap']);
  });
});

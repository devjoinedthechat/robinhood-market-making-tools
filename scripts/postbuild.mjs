/**
 * Finish the two build outputs.
 *
 * 1. Mark each with its module format. The package root is `"type": "module"`,
 *    so without a nested package.json Node would load the CommonJS build as ESM
 *    and fail on the first `require`.
 *
 * 2. Rewrite `.ts` specifiers in declaration files. `rewriteRelativeImportExtensions`
 *    rewrites emitted JavaScript but leaves `.d.ts` files importing `./chains.ts`.
 *    NodeNext consumers tolerate that; Node10 and older TypeScript versions do not.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));

writeFileSync(join(dist, 'cjs/package.json'), `${JSON.stringify({ type: 'commonjs' })}\n`);
writeFileSync(join(dist, 'esm/package.json'), `${JSON.stringify({ type: 'module' })}\n`);

const SPECIFIER = /((?:from|import)\s*\(?\s*['"])(\.{1,2}\/[^'"]+)\.ts(['"])/g;

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (name.endsWith('.d.ts')) {
      const before = readFileSync(path, 'utf8');
      const after = before.replace(SPECIFIER, '$1$2.js$3');
      if (after !== before) writeFileSync(path, after);
    }
  }
}
walk(dist);

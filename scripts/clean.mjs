/**
 * Remove dist/ before a build.
 *
 * `rm -rf dist` would do the same, but npm runs scripts through cmd.exe on
 * Windows, where `rm` is not a command and the build fails before tsc starts.
 */
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

rmSync(fileURLToPath(new URL('../dist/', import.meta.url)), { recursive: true, force: true });

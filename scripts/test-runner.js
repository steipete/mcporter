#!/usr/bin/env node
// Lightweight wrapper to translate `--filter foo` into Vitest include globs so
// callers can run `pnpm test --filter my-test` without hitting the Vitest CLI
// "Unknown option --filter" error.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const translated = [];
const positional = [];

for (let i = 0; i < args.length; i += 1) {
  const token = args[i];
  if (token === '--filter' || token === '-f') {
    const pattern = args[i + 1];
    if (!pattern) {
      console.error('[test-runner] --filter requires a pattern');
      process.exit(1);
    }
    positional.push(pattern);
    i += 1; // skip pattern
    continue;
  }
  translated.push(token);
}

const require = createRequire(import.meta.url);
const vitestPkg = require.resolve('vitest/package.json');
const vitestRoot = path.dirname(vitestPkg);
const vitestBin = path.join(vitestRoot, 'vitest.mjs');

const result = spawnSync(process.execPath, [vitestBin, 'run', ...positional, ...translated], {
  stdio: 'inherit',
  env: process.env,
});

process.exit(result.status ?? 1);

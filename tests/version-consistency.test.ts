import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { MCPORTER_VERSION } from '../src/runtime.js';

const pkg = createRequire(import.meta.url)('../package.json');

describe('version consistency', () => {
  it('matches package.json', () => {
    expect(MCPORTER_VERSION).toBe(pkg.version);
  });
});

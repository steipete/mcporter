import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadServerDefinitions } from '../src/config.js';
import { resolveEnvPlaceholders, resolveEnvValue, withEnvOverrides } from '../src/env.js';

const FIXTURE_PATH = path.resolve(__dirname, 'fixtures', 'mcporter.json');

describe('loadServerDefinitions', () => {
  it('parses all Sweetistics servers', async () => {
    const servers = await loadServerDefinitions({
      configPath: FIXTURE_PATH,
      rootDir: '/repo',
    });
    expect(servers).toHaveLength(9);
    const names = servers.map((server) => server.name);
    expect(names).toContain('vercel');
    const signoz = servers.find((server) => server.name === 'signoz');
    expect(signoz).toBeDefined();
    expect(signoz?.command.kind).toBe('stdio');
    expect(signoz?.env?.SIGNOZ_URL).toBe(`\${SIGNOZ_URL:-http://localhost:3301}`);
    const vercel = servers.find((server) => server.name === 'vercel');
    expect(vercel?.tokenCacheDir).toBe(path.join(os.homedir(), '.mcporter', 'vercel'));
  });

  it('resolves HTTP headers with environment placeholders', async () => {
    process.env.LINEAR_API_KEY = 'linear-secret';
    const servers = await loadServerDefinitions({ configPath: FIXTURE_PATH });
    const linear = servers.find((server) => server.name === 'linear');
    expect(linear?.command.kind).toBe('http');
    expect(linear?.command.kind === 'http' ? linear.command.headers?.Authorization : undefined).toBe(
      `Bearer \${LINEAR_API_KEY}`
    );
  });
});

describe('environment utilities', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('resolveEnvValue respects default syntax', () => {
    expect(resolveEnvValue(`\${MISSING_VAR:-fallback}`)).toBe('fallback');
    process.env.MISSING_VAR = 'present';
    expect(resolveEnvValue(`\${MISSING_VAR:-fallback}`)).toBe('present');
  });

  it('resolveEnvPlaceholders enforces presence', () => {
    process.env.TEST_TOKEN = 'abc';
    expect(resolveEnvPlaceholders(`Bearer \${TEST_TOKEN}`)).toBe('Bearer abc');
    expect(() => resolveEnvPlaceholders(`Bearer \${NOT_SET}`)).toThrow();
  });

  it('withEnvOverrides applies temporary overrides', async () => {
    delete process.env.SIGNOZ_URL;
    await withEnvOverrides({ SIGNOZ_URL: `\${SIGNOZ_URL:-http://localhost:3301}` }, async () => {
      expect(process.env.SIGNOZ_URL).toBe('http://localhost:3301');
    });
    expect(process.env.SIGNOZ_URL).toBeUndefined();
  });
});

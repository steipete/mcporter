import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadServerDefinitions } from '../src/config.js';

const FIXTURE_ROOT = path.resolve(__dirname, 'fixtures', 'imports');

let homedirSpy: { mockRestore(): void } | undefined;

beforeEach(() => {
  const fakeHome = path.join(FIXTURE_ROOT, 'home');
  fs.mkdirSync(fakeHome, { recursive: true });
  homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  process.env.APPDATA = path.join(fakeHome, 'AppData', 'Roaming');
  fs.mkdirSync(process.env.APPDATA, { recursive: true });
  const sourceCodex = path.join(FIXTURE_ROOT, '.codex', 'config.toml');
  const targetCodex = path.join(fakeHome, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(targetCodex), { recursive: true });
  fs.copyFileSync(sourceCodex, targetCodex);
});

afterEach(() => {
  homedirSpy?.mockRestore();
  process.env.HOME = undefined;
  process.env.USERPROFILE = undefined;
  process.env.APPDATA = undefined;
});

describe('config imports', () => {
  it('merges external configs with first-wins precedence', async () => {
    const configPath = path.join(FIXTURE_ROOT, 'config', 'mcporter.json');
    const servers = await loadServerDefinitions({
      configPath,
      rootDir: FIXTURE_ROOT,
    });

    const names = servers.map((server) => server.name).sort();
    expect(names).toEqual(['claude-only', 'codex-only', 'cursor-only', 'local-only', 'shared']);

    const shared = servers.find((server) => server.name === 'shared');
    expect(shared?.command.kind).toBe('http');
    expect(shared?.command.kind === 'http' ? shared.command.url.toString() : undefined).toBe(
      'https://cursor.local/mcp'
    );

    const cursorOnly = servers.find((server) => server.name === 'cursor-only');
    expect(cursorOnly?.command.kind).toBe('http');
    expect(cursorOnly?.command.kind === 'http' ? cursorOnly.command.url.toString() : undefined).toBe(
      'https://local.override/cursor'
    );

    const codexOnly = servers.find((server) => server.name === 'codex-only');
    expect(codexOnly?.command.kind).toBe('stdio');
    expect(codexOnly?.command.kind === 'stdio' ? codexOnly.command.command : undefined).toBe('codex-cli');
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadServerDefinitions } from '../src/config.js';

const FIXTURE_ROOT = path.resolve(__dirname, 'fixtures', 'imports');

let homedirSpy: { mockRestore(): void } | undefined;
let fakeHomeDir: string | undefined;

function ensureFakeHomeDir(): string {
  if (!fakeHomeDir) {
    throw new Error('fakeHomeDir not initialized');
  }
  return fakeHomeDir;
}

beforeEach(() => {
  fakeHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcporter-home-'));
  homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHomeDir);
  process.env.HOME = fakeHomeDir;
  process.env.USERPROFILE = fakeHomeDir;
  process.env.APPDATA = path.join(fakeHomeDir, 'AppData', 'Roaming');
  fs.mkdirSync(process.env.APPDATA, { recursive: true });
  const sourceCodex = path.join(FIXTURE_ROOT, '.codex', 'config.toml');
  const targetCodex = path.join(fakeHomeDir, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(targetCodex), { recursive: true });
  fs.copyFileSync(sourceCodex, targetCodex);

  const sourceWindsurf = path.join(FIXTURE_ROOT, '.codeium', 'windsurf', 'mcp_config.json');
  const targetWindsurf = path.join(fakeHomeDir, '.codeium', 'windsurf', 'mcp_config.json');
  fs.mkdirSync(path.dirname(targetWindsurf), { recursive: true });
  fs.copyFileSync(sourceWindsurf, targetWindsurf);

  const sourceVscode = path.join(FIXTURE_ROOT, 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
  const vscodeTargets = [
    path.join(fakeHomeDir, 'Library', 'Application Support', 'Code', 'User', 'mcp.json'),
    path.join(fakeHomeDir, '.config', 'Code', 'User', 'mcp.json'),
    path.join(process.env.APPDATA ?? fakeHomeDir, 'Code', 'User', 'mcp.json'),
  ];
  for (const target of vscodeTargets) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(sourceVscode, target);
  }
});

afterEach(() => {
  homedirSpy?.mockRestore();
  process.env.HOME = undefined;
  process.env.USERPROFILE = undefined;
  process.env.APPDATA = undefined;
  if (fakeHomeDir) {
    fs.rmSync(fakeHomeDir, { recursive: true, force: true });
    fakeHomeDir = undefined;
  }
});

describe('config imports', () => {
  it('merges external configs with first-wins precedence', async () => {
    const configPath = path.join(FIXTURE_ROOT, 'config', 'mcporter.json');
    const servers = await loadServerDefinitions({
      configPath,
      rootDir: FIXTURE_ROOT,
    });
    const homeDir = ensureFakeHomeDir();

    const names = servers.map((server) => server.name).sort();
    expect(names).toEqual([
      'claude-only',
      'codex-only',
      'cursor-only',
      'local-only',
      'shared',
      'vscode-only',
      'windsurf-only',
    ]);

    const shared = servers.find((server) => server.name === 'shared');
    expect(shared?.command.kind).toBe('http');
    expect(shared?.command.kind === 'http' ? shared.command.url.toString() : undefined).toBe(
      'https://cursor.local/mcp'
    );
    expect(shared?.source).toEqual({
      kind: 'import',
      path: path.join(FIXTURE_ROOT, '.cursor', 'mcp.json'),
    });

    const cursorOnly = servers.find((server) => server.name === 'cursor-only');
    expect(cursorOnly?.command.kind).toBe('http');
    expect(cursorOnly?.command.kind === 'http' ? cursorOnly.command.url.toString() : undefined).toBe(
      'https://local.override/cursor'
    );
    expect(cursorOnly?.source).toEqual({
      kind: 'local',
      path: configPath,
    });

    const codexOnly = servers.find((server) => server.name === 'codex-only');
    expect(codexOnly?.command.kind).toBe('stdio');
    expect(codexOnly?.command.kind === 'stdio' ? codexOnly.command.command : undefined).toBe('codex-cli');
    expect(codexOnly?.command.kind === 'stdio' ? codexOnly.command.args : undefined).toEqual(['--run']);
    const codexSourcePaths = [
      path.join(homeDir, '.codex', 'config.toml'),
      path.join(FIXTURE_ROOT, '.codex', 'config.toml'),
    ];
    expect(codexOnly?.source?.kind).toBe('import');
    expect(codexSourcePaths).toContain(codexOnly?.source?.path);

    const windsurfOnly = servers.find((server) => server.name === 'windsurf-only');
    expect(windsurfOnly?.command.kind).toBe('stdio');
    expect(windsurfOnly?.command.kind === 'stdio' ? windsurfOnly.command.command : undefined).toBe('windsurf-cli');
    expect(windsurfOnly?.source).toEqual({
      kind: 'import',
      path: path.join(homeDir, '.codeium', 'windsurf', 'mcp_config.json'),
    });

    const vscodeOnly = servers.find((server) => server.name === 'vscode-only');
    expect(vscodeOnly?.command.kind).toBe('stdio');
    expect(vscodeOnly?.command.kind === 'stdio' ? vscodeOnly.command.command : undefined).toBe('code-mcp');
    const expectedVscodePaths = [
      path.join(homeDir, 'Library', 'Application Support', 'Code', 'User', 'mcp.json'),
      path.join(homeDir, '.config', 'Code', 'User', 'mcp.json'),
      path.join(process.env.APPDATA ?? homeDir, 'Code', 'User', 'mcp.json'),
    ];
    expect(vscodeOnly?.source?.kind).toBe('import');
    expect(expectedVscodePaths).toContain(vscodeOnly?.source?.path);
  });

  it('loads Codex servers from the user config when the project lacks a .codex directory', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcporter-imports-'));
    try {
      const tempConfigDir = path.join(tempRoot, 'config');
      fs.mkdirSync(tempConfigDir, { recursive: true });
      fs.copyFileSync(path.join(FIXTURE_ROOT, 'config', 'mcporter.json'), path.join(tempConfigDir, 'mcporter.json'));

      const servers = await loadServerDefinitions({
        configPath: path.join(tempConfigDir, 'mcporter.json'),
        rootDir: tempRoot,
      });
      const homeDir = ensureFakeHomeDir();
      const codexOnly = servers.find((server) => server.name === 'codex-only');
      expect(codexOnly).toBeDefined();
      expect(codexOnly?.source).toEqual({
        kind: 'import',
        path: path.join(homeDir, '.codex', 'config.toml'),
      });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

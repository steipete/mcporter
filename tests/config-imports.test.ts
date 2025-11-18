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
  process.env.XDG_CONFIG_HOME = path.join(fakeHomeDir, '.config');
  fs.mkdirSync(process.env.APPDATA, { recursive: true });
  const sourceCodex = path.join(FIXTURE_ROOT, '.codex', 'config.toml');
  const targetCodex = path.join(fakeHomeDir, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(targetCodex), { recursive: true });
  fs.copyFileSync(sourceCodex, targetCodex);

  const sourceWindsurf = path.join(FIXTURE_ROOT, '.codeium', 'windsurf', 'mcp_config.json');
  const targetWindsurf = path.join(fakeHomeDir, '.codeium', 'windsurf', 'mcp_config.json');
  fs.mkdirSync(path.dirname(targetWindsurf), { recursive: true });
  fs.copyFileSync(sourceWindsurf, targetWindsurf);

  const sourceOpencode = path.join(FIXTURE_ROOT, '.config', 'opencode', 'opencode.jsonc');
  const targetOpencode = path.join(fakeHomeDir, '.config', 'opencode', 'opencode.jsonc');
  fs.mkdirSync(path.dirname(targetOpencode), { recursive: true });
  fs.copyFileSync(sourceOpencode, targetOpencode);

  const sourceClaudeSettings = path.join(FIXTURE_ROOT, 'home', '.claude', 'settings.json');
  const targetClaudeSettings = path.join(fakeHomeDir, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(targetClaudeSettings), { recursive: true });
  fs.copyFileSync(sourceClaudeSettings, targetClaudeSettings);

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
  process.env.XDG_CONFIG_HOME = undefined;
  process.env.OPENCODE_CONFIG = undefined;
  process.env.OPENCODE_CONFIG_DIR = undefined;
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
      'claude-home',
      'claude-local',
      'claude-only',
      'claude-overridden',
      'claude-shared',
      'codex-only',
      'cursor-only',
      'local-only',
      'opencode-only',
      'opencode-user-only',
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
      importKind: 'cursor',
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
      importKind: 'windsurf',
    });

    const claudeLocal = servers.find((server) => server.name === 'claude-local');
    expect(claudeLocal?.command.kind).toBe('stdio');
    expect(claudeLocal?.command.kind === 'stdio' ? claudeLocal.command.command : undefined).toBe('claude-local-cli');
    expect(claudeLocal?.source).toEqual({
      kind: 'import',
      path: path.join(FIXTURE_ROOT, '.claude', 'settings.local.json'),
      importKind: 'claude-code',
    });

    const claudeOverridden = servers.find((server) => server.name === 'claude-overridden');
    expect(claudeOverridden?.command.kind).toBe('stdio');
    expect(claudeOverridden?.command.kind === 'stdio' ? claudeOverridden.command.command : undefined).toBe(
      'claude-local-cli'
    );
    expect(claudeOverridden?.source).toEqual({
      kind: 'import',
      path: path.join(FIXTURE_ROOT, '.claude', 'settings.local.json'),
      importKind: 'claude-code',
    });

    const claudeShared = servers.find((server) => server.name === 'claude-shared');
    expect(claudeShared?.command.kind).toBe('stdio');
    expect(claudeShared?.command.kind === 'stdio' ? claudeShared.command.command : undefined).toBe('claude-shared-cli');
    expect(claudeShared?.source).toEqual({
      kind: 'import',
      path: path.join(FIXTURE_ROOT, '.claude', 'settings.json'),
      importKind: 'claude-code',
    });

    const claudeHome = servers.find((server) => server.name === 'claude-home');
    expect(claudeHome?.command.kind).toBe('stdio');
    expect(claudeHome?.command.kind === 'stdio' ? claudeHome.command.command : undefined).toBe('claude-home-cli');
    expect(claudeHome?.source).toEqual({
      kind: 'import',
      path: path.join(homeDir, '.claude', 'settings.json'),
      importKind: 'claude-code',
    });

    const opencodeOnly = servers.find((server) => server.name === 'opencode-only');
    expect(opencodeOnly?.command.kind).toBe('stdio');
    expect(opencodeOnly?.command.kind === 'stdio' ? opencodeOnly.command.command : undefined).toBe('opencode-cli');
    expect(opencodeOnly?.source).toEqual({
      kind: 'import',
      path: path.join(FIXTURE_ROOT, 'opencode.jsonc'),
      importKind: 'opencode',
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

  it('falls back to user-level Claude settings when the project lacks .claude files', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcporter-claude-home-'));
    try {
      const tempConfigDir = path.join(tempRoot, 'config');
      fs.mkdirSync(tempConfigDir, { recursive: true });
      fs.copyFileSync(path.join(FIXTURE_ROOT, 'config', 'mcporter.json'), path.join(tempConfigDir, 'mcporter.json'));

      const servers = await loadServerDefinitions({
        configPath: path.join(tempConfigDir, 'mcporter.json'),
        rootDir: tempRoot,
      });
      const claudeHome = servers.find((server) => server.name === 'claude-home');
      expect(claudeHome?.source).toEqual({
        kind: 'import',
        path: path.join(ensureFakeHomeDir(), '.claude', 'settings.json'),
        importKind: 'claude-code',
      });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('loads Claude project-scoped servers without treating metadata as servers', async () => {
    const homeDir = ensureFakeHomeDir();
    const claudeDir = path.join(homeDir, '.claude');
    fs.rmSync(claudeDir, { recursive: true, force: true });
    const claudeJsonPath = path.join(homeDir, '.claude.json');
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcporter-claude-project-'));
    const projectConfigDir = path.join(projectRoot, 'config');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'mcporter.json'),
      JSON.stringify({
        mcpServers: {},
        imports: ['claude-code'],
      })
    );
    fs.writeFileSync(
      claudeJsonPath,
      JSON.stringify(
        {
          tipsHistory: { foo: 1 },
          cachedStatsigGates: { example: false },
          projects: {
            [projectRoot]: {
              mcpServers: {
                'project-only': {
                  baseUrl: 'https://project.local/mcp',
                },
              },
            },
            '/other/project': {
              mcpServers: {
                ignored: { command: 'echo' },
              },
            },
          },
        },
        null,
        2
      )
    );

    try {
      const servers = await loadServerDefinitions({ rootDir: projectRoot });
      const projectServer = servers.find((server) => server.name === 'project-only');
      expect(projectServer).toBeDefined();
      expect(projectServer?.command.kind).toBe('http');
      expect(projectServer?.command.kind === 'http' ? projectServer.command.url.toString() : undefined).toBe(
        'https://project.local/mcp'
      );
      expect(projectServer?.source).toEqual({
        kind: 'import',
        path: claudeJsonPath,
        importKind: 'claude-code',
      });
      const serverNames = servers.map((server) => server.name);
      expect(serverNames).not.toContain('tipsHistory');
      expect(serverNames).not.toContain('cachedStatsigGates');
      expect(serverNames).not.toContain('ignored');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
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
        importKind: 'codex',
      });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('uses default imports even when config/mcporter.json is missing', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcporter-no-config-'));
    try {
      const servers = await loadServerDefinitions({ rootDir: tempRoot });
      const codexOnly = servers.find((server) => server.name === 'codex-only');
      expect(codexOnly).toBeDefined();
      expect(codexOnly?.source).toEqual({
        kind: 'import',
        path: path.join(ensureFakeHomeDir(), '.codex', 'config.toml'),
        importKind: 'codex',
      });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('falls back to the user OpenCode config when no project file is present', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcporter-opencode-home-'));
    try {
      const configDir = path.join(tempRoot, 'config');
      fs.mkdirSync(configDir, { recursive: true });
      fs.copyFileSync(path.join(FIXTURE_ROOT, 'config', 'mcporter.json'), path.join(configDir, 'mcporter.json'));
      const servers = await loadServerDefinitions({
        configPath: path.join(configDir, 'mcporter.json'),
        rootDir: tempRoot,
      });
      const opencodeHomeOnly = servers.find((server) => server.name === 'opencode-user-only');
      expect(opencodeHomeOnly).toBeDefined();
      const homeDir = ensureFakeHomeDir();
      const expectedPath = path.join(homeDir, '.config', 'opencode', 'opencode.jsonc');
      expect(opencodeHomeOnly?.source).toEqual({
        kind: 'import',
        path: expectedPath,
        importKind: 'opencode',
      });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('honors the OPENCODE_CONFIG override', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcporter-opencode-env-'));
    const tempConfig = path.join(tempRoot, 'custom-opencode.jsonc');
    fs.mkdirSync(tempRoot, { recursive: true });
    fs.writeFileSync(
      tempConfig,
      JSON.stringify(
        {
          mcp: {
            'opencode-env-only': {
              command: 'env-cli',
              args: ['--stdio'],
            },
          },
        },
        null,
        2
      )
    );
    process.env.OPENCODE_CONFIG = tempConfig;
    try {
      const servers = await loadServerDefinitions({ rootDir: FIXTURE_ROOT });
      const envServer = servers.find((server) => server.name === 'opencode-env-only');
      expect(envServer).toBeDefined();
      expect(envServer?.source).toEqual({
        kind: 'import',
        path: tempConfig,
        importKind: 'opencode',
      });
    } finally {
      process.env.OPENCODE_CONFIG = undefined;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('honors the OPENCODE_CONFIG_DIR override', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcporter-opencode-dir-'));
    const dirConfigPath = path.join(tempDir, 'opencode.jsonc');
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(
      dirConfigPath,
      JSON.stringify(
        {
          mcp: {
            'opencode-dir-only': {
              command: 'dir-cli',
              args: ['--stdio'],
            },
          },
        },
        null,
        2
      )
    );
    process.env.OPENCODE_CONFIG_DIR = tempDir;
    try {
      const servers = await loadServerDefinitions({ rootDir: FIXTURE_ROOT });
      const dirServer = servers.find((server) => server.name === 'opencode-dir-only');
      expect(dirServer).toBeDefined();
      expect(dirServer?.source).toEqual({
        kind: 'import',
        path: dirConfigPath,
        importKind: 'opencode',
      });
    } finally {
      process.env.OPENCODE_CONFIG_DIR = undefined;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

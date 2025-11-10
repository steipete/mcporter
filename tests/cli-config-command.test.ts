import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleConfigCli } from '../src/cli/config-command.js';
import type { LoadConfigOptions } from '../src/config.js';
import { MCPORTER_VERSION } from '../src/runtime.js';

describe('mcporter config CLI', () => {
  let tempDir: string;
  let configPath: string;
  let originalXdg: string | undefined;

  beforeEach(async () => {
    originalXdg = process.env.XDG_CONFIG_HOME;
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-config-'));
    configPath = path.join(tempDir, 'config', 'mcporter.json');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    process.env.XDG_CONFIG_HOME = originalXdg;
    vi.restoreAllMocks();
  });

  it('adds an HTTP server via positional target', async () => {
    await handleConfigCli(buildOptions({ configPath }), ['add', 'linear', 'https://linear.app/mcp']);
    const buffer = await fs.readFile(configPath, 'utf8');
    const parsed = JSON.parse(buffer) as { mcpServers: Record<string, { baseUrl: string }> };
    const linear = parsed.mcpServers.linear;
    expect(linear).toBeDefined();
    expect(linear?.baseUrl).toBe('https://linear.app/mcp');
  });

  it('lists servers in JSON format', async () => {
    await handleConfigCli(buildOptions({ configPath }), ['add', 'linear', 'https://linear.app/mcp']);
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation(captureLog(logs));
    await handleConfigCli(buildOptions({ configPath }), ['list', '--json']);
    spy.mockRestore();
    const jsonLine = logs.find((entry) => entry.trimStart().startsWith('{')) ?? '{}';
    const payload = JSON.parse(jsonLine.trim()) as { servers: Array<{ name: string }> };
    expect(payload.servers).toHaveLength(1);
    expect(payload.servers[0]?.name).toBe('linear');
  });

  it('prints config summary for text list output', async () => {
    await handleConfigCli(buildOptions({ configPath }), ['add', 'linear', 'https://linear.app/mcp']);
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation(captureLog(logs));
    await handleConfigCli(buildOptions({ configPath }), ['list']);
    spy.mockRestore();
    expect(logs.some((entry) => entry.includes('Project config:'))).toBe(true);
    expect(logs.some((entry) => entry.includes('System config:'))).toBe(true);
  });

  it('removes an existing server', async () => {
    await handleConfigCli(buildOptions({ configPath }), ['add', 'linear', 'https://linear.app/mcp']);
    await handleConfigCli(buildOptions({ configPath }), ['remove', 'linear']);
    const buffer = await fs.readFile(configPath, 'utf8');
    const parsed = JSON.parse(buffer) as { mcpServers: Record<string, unknown> };
    expect(parsed.mcpServers.linear).toBeUndefined();
  });

  it('copies imported entries when requested', async () => {
    const cursorDir = path.join(tempDir, '.cursor');
    await fs.mkdir(cursorDir, { recursive: true });
    const importPath = path.join(cursorDir, 'mcp.json');
    await fs.writeFile(
      importPath,
      JSON.stringify({
        mcpServers: {
          'cursor-only': {
            description: 'from cursor',
            baseUrl: 'https://cursor.example/mcp',
          },
        },
      }),
      'utf8'
    );

    await handleConfigCli(buildOptions({ configPath, rootDir: tempDir }), [
      'import',
      'cursor',
      '--copy',
      '--filter',
      'cursor-only',
    ]);
    const buffer = await fs.readFile(configPath, 'utf8');
    const parsed = JSON.parse(buffer) as { mcpServers: Record<string, { baseUrl: string }> };
    const cursorOnly = parsed.mcpServers['cursor-only'];
    expect(cursorOnly).toBeDefined();
    expect(cursorOnly?.baseUrl).toBe('https://cursor.example/mcp');
  });
  it('rejects stdio args without a command target', async () => {
    await expect(handleConfigCli(buildOptions({ configPath }), ['add', 'broken', '--arg', 'foo'])).rejects.toThrow(
      '--arg requires a stdio command'
    );
  });

  it('keeps project-scoped imports ahead of user-scoped ones when copying', async () => {
    const cursorProjectDir = path.join(tempDir, '.cursor');
    await fs.mkdir(cursorProjectDir, { recursive: true });
    const projectConfigPath = path.join(cursorProjectDir, 'mcp.json');
    await fs.writeFile(
      projectConfigPath,
      JSON.stringify({
        mcpServers: {
          shared: { baseUrl: 'https://project.example/mcp' },
        },
      }),
      'utf8'
    );

    const xdgRoot = path.join(tempDir, 'xdg');
    process.env.XDG_CONFIG_HOME = xdgRoot;
    const cursorUserPath = path.join(xdgRoot, 'Cursor');
    await fs.mkdir(cursorUserPath, { recursive: true });
    const userConfigPath = path.join(cursorUserPath, 'mcp.json');
    await fs.writeFile(
      userConfigPath,
      JSON.stringify({
        mcpServers: {
          shared: { baseUrl: 'https://user.example/mcp' },
        },
      }),
      'utf8'
    );

    await handleConfigCli(buildOptions({ configPath, rootDir: tempDir }), [
      'import',
      'cursor',
      '--copy',
      '--filter',
      'shared',
    ]);

    const buffer = await fs.readFile(configPath, 'utf8');
    const parsed = JSON.parse(buffer) as { mcpServers: Record<string, { baseUrl: string }> };
    const shared = parsed.mcpServers.shared;
    expect(shared).toBeDefined();
    expect(shared?.baseUrl).toBe('https://project.example/mcp');
  });

  it('delegates login to the auth handler', async () => {
    const invokeAuth = vi.fn().mockResolvedValue(undefined);
    await handleConfigCli(buildOptions({ configPath }, { invokeAuth }), ['login', 'linear']);
    expect(invokeAuth).toHaveBeenCalledWith(['linear']);
  });

  it('clears cached credentials on logout', async () => {
    const tokenDir = path.join(tempDir, 'token-cache');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          linear: {
            baseUrl: 'https://linear.app/mcp',
            auth: 'oauth',
            tokenCacheDir: tokenDir,
          },
        },
      }),
      'utf8'
    );
    await fs.mkdir(tokenDir, { recursive: true });
    await fs.writeFile(path.join(tokenDir, 'token.json'), '{}', 'utf8');
    await handleConfigCli(buildOptions({ configPath }), ['logout', 'linear']);
    await expect(fs.access(tokenDir)).rejects.toThrow();
  });

  it('reports a clean config via doctor', async () => {
    await handleConfigCli(buildOptions({ configPath }), ['add', 'linear', 'https://linear.app/mcp']);
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation(captureLog(logs));
    await handleConfigCli(buildOptions({ configPath }), ['doctor']);
    spy.mockRestore();
    expect(logs[0]).toBe(`MCPorter ${MCPORTER_VERSION}`);
    expect(logs.join('\n')).toContain('Config looks good.');
  });

  it('lists only local entries by default and summarizes imports', async () => {
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'xdg-home');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: {}, imports: ['cursor'] }), 'utf8');
    const cursorDir = path.join(tempDir, '.cursor');
    await fs.mkdir(cursorDir, { recursive: true });
    const importPath = path.join(cursorDir, 'mcp.json');
    await fs.writeFile(
      importPath,
      JSON.stringify({
        mcpServers: {
          'cursor-only': { baseUrl: 'https://cursor.example/mcp' },
        },
      }),
      'utf8'
    );
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation(captureLog(logs));
    await handleConfigCli(buildOptions({ configPath, rootDir: tempDir }), ['list']);
    spy.mockRestore();
    const output = logs.join('\n');
    expect(output).toContain('No local servers match');
    expect(output).toContain('Other sources available via --source import');
    const cursorPathPattern = /\.cursor[\\/]mcp\.json/;
    expect(output).toMatch(cursorPathPattern);
    expect(output).toContain('cursor-only');
  });

  it('lists import entries when --source import is provided', async () => {
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'xdg-home');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: {}, imports: ['cursor'] }), 'utf8');
    const cursorDir = path.join(tempDir, '.cursor');
    await fs.mkdir(cursorDir, { recursive: true });
    const importPath = path.join(cursorDir, 'mcp.json');
    await fs.writeFile(
      importPath,
      JSON.stringify({
        mcpServers: {
          'cursor-only': { baseUrl: 'https://cursor.example/mcp' },
        },
      }),
      'utf8'
    );
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation(captureLog(logs));
    await handleConfigCli(buildOptions({ configPath, rootDir: tempDir }), ['list', '--json', '--source', 'import']);
    spy.mockRestore();
    const jsonLine = logs.find((entry) => entry.trimStart().startsWith('{')) ?? '{}';
    const payload = JSON.parse(jsonLine.trim()) as { servers: Array<{ name: string }> };
    expect(payload.servers.some((server) => server.name === 'cursor-only')).toBe(true);
  });

  it('filters list output by source', async () => {
    await handleConfigCli(buildOptions({ configPath }), ['add', 'linear', 'https://linear.app/mcp']);
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation(captureLog(logs));
    await handleConfigCli(buildOptions({ configPath }), ['list', '--json', '--source', 'local']);
    spy.mockRestore();
    const jsonLine = logs.find((entry) => entry.trimStart().startsWith('{')) ?? '{}';
    const payload = JSON.parse(jsonLine.trim()) as { servers: Array<{ name: string }> };
    expect(payload.servers).toHaveLength(1);
    expect(payload.servers[0]?.name).toBe('linear');
  });

  it('prints server details via get --json', async () => {
    await handleConfigCli(buildOptions({ configPath }), ['add', 'linear', 'https://linear.app/mcp']);
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation(captureLog(logs));
    await handleConfigCli(buildOptions({ configPath }), ['get', 'linear', '--json']);
    spy.mockRestore();
    const payload = JSON.parse(logs.join('\n')) as { name: string; baseUrl: string };
    expect(payload.name).toBe('linear');
    expect(payload.baseUrl).toBe('https://linear.app/mcp');
  });

  it('auto-corrects server names when using get', async () => {
    await handleConfigCli(buildOptions({ configPath }), ['add', 'shadcn', 'https://shadcn.io/api/mcp']);
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation(captureLog(logs));
    await handleConfigCli(buildOptions({ configPath }), ['get', 'sshadcn', '--json']);
    spy.mockRestore();
    const output = logs.join('\n');
    expect(output).toContain('Auto-corrected server name to shadcn');
  });

  it('suggests close matches when get cannot auto-correct', async () => {
    await handleConfigCli(buildOptions({ configPath }), ['add', 'shadcn', 'https://shadcn.io/api/mcp']);
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation(captureLog(logs));
    await expect(handleConfigCli(buildOptions({ configPath }), ['get', 'shadowverse'])).rejects.toThrow(
      "[mcporter] Unknown server 'shadowverse'."
    );
    spy.mockRestore();
    expect(logs.join('\n')).toContain('Did you mean shadcn');
  });
});

function captureLog(target: string[]): (message?: unknown) => void {
  return (message?: unknown) => {
    if (typeof message === 'string') {
      target.push(message);
      return;
    }
    if (message == null) {
      target.push('');
      return;
    }
    if (typeof message === 'object') {
      try {
        target.push(JSON.stringify(message));
        return;
      } catch {
        target.push('[object]');
        return;
      }
    }
    if (typeof message === 'number' || typeof message === 'boolean' || typeof message === 'bigint') {
      target.push(String(message));
      return;
    }
    if (typeof message === 'symbol') {
      target.push(String(message));
      return;
    }
    if (typeof message === 'function') {
      target.push('[function]');
      return;
    }
    target.push('');
  };
}

function buildOptions(
  loadOptions: LoadConfigOptions,
  overrides?: Partial<{ invokeAuth: (args: string[]) => Promise<void> }>
): { loadOptions: LoadConfigOptions; invokeAuth: (args: string[]) => Promise<void> } {
  return {
    loadOptions,
    invokeAuth: overrides?.invokeAuth ?? (async () => {}),
  };
}

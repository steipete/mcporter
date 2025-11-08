import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathsForImport, readExternalEntries } from '../src/config-imports.js';

const TEMP_DIR = path.join(os.tmpdir(), 'mcporter-config-imports-unit');

describe('config import helpers', () => {
  let homedirSpy: { mockRestore(): void } | undefined;
  let previousAppData: string | undefined;
  let previousXdg: string | undefined;

  afterEach(async () => {
    homedirSpy?.mockRestore();
    homedirSpy = undefined;
    if (previousAppData === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = previousAppData;
    }
    if (previousXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previousXdg;
    }
    await fs.rm(TEMP_DIR, { recursive: true, force: true });
  });

  it('parses JSON files that use the mcpServers container', async () => {
    await fs.mkdir(TEMP_DIR, { recursive: true });
    const jsonPath = path.join(TEMP_DIR, 'cursor.json');
    await fs.writeFile(
      jsonPath,
      JSON.stringify({
        mcpServers: {
          cursor: {
            baseUrl: 'https://cursor.local/mcp',
            headers: { Authorization: 'Bearer dev' },
          },
        },
      }),
      'utf8'
    );
    const entries = await readExternalEntries(jsonPath);
    expect(entries).not.toBeNull();
    const cursor = entries?.get('cursor');
    expect(cursor?.baseUrl).toBe('https://cursor.local/mcp');
    expect(cursor?.headers?.Authorization).toBe('Bearer dev');
  });

  it('parses Codex-style TOML configs', async () => {
    await fs.mkdir(TEMP_DIR, { recursive: true });
    const tomlPath = path.join(TEMP_DIR, 'codex.toml');
    await fs.writeFile(
      tomlPath,
      `
        [mcp_servers.test]
        description = "Codex"
        baseUrl = "https://codex.local/mcp"
        bearerToken = "abc"
      `,
      'utf8'
    );
    const entries = await readExternalEntries(tomlPath);
    const testEntry = entries?.get('test');
    expect(testEntry).toBeDefined();
    expect(testEntry?.baseUrl).toBe('https://codex.local/mcp');
    expect(testEntry?.headers?.Authorization).toBe('Bearer abc');
  });

  it('prefers config.toml when resolving Codex imports', () => {
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue('/fake/home');
    const rootDir = '/repo/project';
    const imports = pathsForImport('codex', rootDir);
    expect(imports).toEqual([
      path.resolve(rootDir, '.codex', 'config.toml'),
      path.join('/fake/home', '.codex', 'config.toml'),
    ]);
  });

  it('generates cursor import paths relative to project root and user config dir', () => {
    previousAppData = process.env.APPDATA;
    previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = path.join(os.tmpdir(), 'xdg-home');
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue('/fake/home');
    const rootDir = '/repo/project';
    const [projectPath, userPath] = pathsForImport('cursor', rootDir);
    expect(projectPath).toBe(path.resolve(rootDir, '.cursor', 'mcp.json'));
    expect(userPath).toBeDefined();
    expect(userPath?.includes('Cursor')).toBe(true);
    expect(userPath?.endsWith(path.join('Cursor', 'mcp.json'))).toBe(true);
  });
});

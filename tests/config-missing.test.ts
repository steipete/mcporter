import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadServerDefinitions } from '../src/config.js';

describe('loadServerDefinitions when config is optional', () => {
  let tempHomeDir: string | undefined;
  let homedirSpy: { mockRestore(): void } | undefined;
  let previousEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-config-missing-home-'));
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tempHomeDir);
    previousEnv = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      APPDATA: process.env.APPDATA,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    };
    process.env.HOME = tempHomeDir;
    process.env.USERPROFILE = tempHomeDir;
    process.env.APPDATA = path.join(tempHomeDir, 'AppData', 'Roaming');
    process.env.XDG_CONFIG_HOME = path.join(tempHomeDir, '.config');
  });

  afterEach(async () => {
    homedirSpy?.mockRestore();
    homedirSpy = undefined;
    process.env.HOME = previousEnv.HOME;
    process.env.USERPROFILE = previousEnv.USERPROFILE;
    process.env.APPDATA = previousEnv.APPDATA;
    process.env.XDG_CONFIG_HOME = previousEnv.XDG_CONFIG_HOME;
    if (tempHomeDir) {
      await fs.rm(tempHomeDir, { recursive: true, force: true }).catch(() => {});
      tempHomeDir = undefined;
    }
  });

  it('returns an empty list when the default config is missing', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-config-missing-'));
    try {
      const servers = await loadServerDefinitions({ rootDir: tempDir });
      expect(servers).toEqual([]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('returns an empty list when the config directory exists but the file is missing', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-config-folder-'));
    try {
      await fs.mkdir(path.join(tempDir, 'config'), { recursive: true });
      const servers = await loadServerDefinitions({ rootDir: tempDir });
      expect(servers).toEqual([]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('returns an empty list and logs when the config file is invalid JSON', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-config-invalid-'));
    const configDir = path.join(tempDir, 'config');
    await fs.mkdir(configDir, { recursive: true });
    const configPath = path.join(configDir, 'mcporter.json');
    await fs.writeFile(configPath, '{ this is not valid JSON', 'utf8');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const servers = await loadServerDefinitions({ rootDir: tempDir });
      expect(servers).toEqual([]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toContain('Ignoring config');
      expect(warnSpy.mock.calls[0]?.[0]).toContain(configPath);
    } finally {
      warnSpy.mockRestore();
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('still throws when an explicit config path is missing', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-config-explicit-'));
    const explicitPath = path.join(tempDir, 'does-not-exist.json');
    await expect(loadServerDefinitions({ configPath: explicitPath })).rejects.toThrow();
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });
});

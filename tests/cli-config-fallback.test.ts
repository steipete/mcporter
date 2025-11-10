import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MCPORTER_VERSION } from '../src/runtime.js';

process.env.MCPORTER_DISABLE_AUTORUN = '1';
const cliModulePromise = import('../src/cli.js');

describe('mcporter CLI config fallback', () => {
  let tempDir: string;
  let originalCwd: string;
  let previousNoForceExit: string | undefined;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-cli-config-'));
    process.chdir(tempDir);
    previousNoForceExit = process.env.MCPORTER_NO_FORCE_EXIT;
    process.env.MCPORTER_NO_FORCE_EXIT = '1';
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    process.exitCode = undefined;
    if (previousNoForceExit === undefined) {
      delete process.env.MCPORTER_NO_FORCE_EXIT;
    } else {
      process.env.MCPORTER_NO_FORCE_EXIT = previousNoForceExit;
    }
  });

  it('lists servers even when the config directory is missing', async () => {
    const { runCli } = await cliModulePromise;
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      if (typeof value === 'string') {
        logs.push(value);
      }
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(runCli(['config', 'list'])).resolves.not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('warns once and continues when the default config is corrupt', async () => {
    const { runCli } = await cliModulePromise;
    await fs.mkdir(path.join(tempDir, 'config'), { recursive: true });
    const configPath = path.join(tempDir, 'config', 'mcporter.json');
    await fs.writeFile(configPath, '{ invalid : json', 'utf8');
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      if (typeof value === 'string') {
        logs.push(value);
      }
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(runCli(['config', 'list'])).resolves.not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0]?.[0]?.toString() ?? '';
    expect(message).toContain('Ignoring config');
    expect(message).toContain(configPath);
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('prints the doctor banner even when config is missing', async () => {
    const { runCli } = await cliModulePromise;
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      if (typeof value === 'string') {
        logs.push(value);
      }
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(runCli(['config', 'doctor'])).resolves.not.toThrow();
    expect(logs[0]).toBe(`MCPorter ${MCPORTER_VERSION}`);
    expect(warnSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('doctor warns once and keeps running when the config is corrupt', async () => {
    const { runCli } = await cliModulePromise;
    await fs.mkdir(path.join(tempDir, 'config'), { recursive: true });
    const configPath = path.join(tempDir, 'config', 'mcporter.json');
    await fs.writeFile(configPath, '{ not valid }', 'utf8');
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      if (typeof value === 'string') {
        logs.push(value);
      }
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(runCli(['config', 'doctor'])).resolves.not.toThrow();
    expect(logs[0]).toBe(`MCPorter ${MCPORTER_VERSION}`);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain(configPath);
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

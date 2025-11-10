import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.MCPORTER_DISABLE_AUTORUN = '1';
const cliModulePromise = import('../src/cli.js');

describe('mcporter CLI config fallback', () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-cli-config-'));
    process.chdir(tempDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('lists servers even when the config directory is missing', async () => {
    const { runCli } = await cliModulePromise;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(runCli(['list'])).resolves.not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('warns once and continues when the default config is corrupt', async () => {
    const { runCli } = await cliModulePromise;
    await fs.mkdir(path.join(tempDir, 'config'), { recursive: true });
    const configPath = path.join(tempDir, 'config', 'mcporter.json');
    await fs.writeFile(configPath, '{ invalid : json', 'utf8');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(runCli(['list'])).resolves.not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0]?.[0]?.toString() ?? '';
    expect(message).toContain('Ignoring config');
    expect(message).toContain(configPath);
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

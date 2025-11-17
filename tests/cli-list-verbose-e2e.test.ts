import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.MCPORTER_DISABLE_AUTORUN = '1';
const cliModulePromise = import('../src/cli.js');

describe('mcporter list --verbose end-to-end', () => {
  let tempDir: string;
  let originalCwd: string;
  let restoreHomedir: (() => void) | undefined;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-cli-verbose-'));
    process.chdir(tempDir);
    const spy = vi.spyOn(os, 'homedir');
    spy.mockReturnValue(tempDir);
    restoreHomedir = () => spy.mockRestore();
    process.env.MCPORTER_NO_FORCE_EXIT = '1';
  });

  afterEach(async () => {
    restoreHomedir?.();
    delete process.env.MCPORTER_NO_FORCE_EXIT;
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    process.exitCode = undefined;
  });

  it('prints verbose source markers in text output and includes sources in JSON', async () => {
    const projectConfigPath = path.join(tempDir, 'config', 'mcporter.json');
    await fs.mkdir(path.dirname(projectConfigPath), { recursive: true });
    await fs.writeFile(
      projectConfigPath,
      JSON.stringify(
        { imports: ['cursor'], mcpServers: { alpha: { baseUrl: 'https://primary.example.com/mcp' } } },
        null,
        2
      ),
      'utf8'
    );

    const cursorConfigPath = path.join(tempDir, '.cursor', 'mcp.json');
    await fs.mkdir(path.dirname(cursorConfigPath), { recursive: true });
    await fs.writeFile(
      cursorConfigPath,
      JSON.stringify({ mcpServers: { alpha: { baseUrl: 'https://shadow.example.com/mcp' } } }, null, 2),
      'utf8'
    );

    const { runCli } = await cliModulePromise;

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Text mode verbose should render primary + shadowed paths.
    await runCli(['list', '--verbose']);
    const textOutput = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(textOutput).toContain('alpha');
    expect(textOutput).toContain('(primary)');
    expect(textOutput).toContain('(shadowed by local)');

    logSpy.mockClear();

    // JSON mode with --sources should include the sources array even without --verbose.
    await runCli(['list', '--json', '--sources']);
    const jsonPayload = JSON.parse(logSpy.mock.calls.at(-1)?.[0] ?? '{}');
    const server = jsonPayload.servers?.find((entry: { name: string }) => entry.name === 'alpha');
    const sources = (server?.sources ?? []).map((entry: { path: string }) => entry.path.replace('/private', ''));
    const expected = [projectConfigPath.replace('/private', ''), cursorConfigPath.replace('/private', '')];
    expect(sources).toEqual(expected);

    logSpy.mockRestore();
  });
});

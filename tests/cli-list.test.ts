import { describe, expect, it, vi } from 'vitest';
import type { ServerDefinition } from '../src/config.js';

process.env.MCPORTER_DISABLE_AUTORUN = '1';
const cliModulePromise = import('../src/cli.js');

describe('CLI list timeout handling', () => {
  it('parses --timeout flag into list flags', async () => {
    const { extractListFlags } = await cliModulePromise;
    const args = ['--timeout', '7500', '--schema', 'server'];
    const flags = extractListFlags(args);
    expect(flags).toEqual({ schema: true, timeoutMs: 7500 });
    expect(args).toEqual(['server']);
  });

  it('honors --timeout when listing a single server', async () => {
    const { handleList } = await cliModulePromise;
    const definition: ServerDefinition = {
      name: 'slow-server',
      command: { kind: 'stdio', command: 'noop', args: [], cwd: process.cwd() },
      source: { kind: 'local', path: '/tmp/config.json' },
    };

    const runtime = {
      getDefinitions: () => [definition],
      getDefinition: () => definition,
      listTools: () =>
        new Promise((resolve) => {
          setTimeout(() => resolve([{ name: 'ok' }]), 50);
        }),
    } as unknown as Awaited<ReturnType<typeof import('../src/runtime.js')['createRuntime']>>;

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await handleList(runtime, ['--timeout', '10', 'slow-server']);

    const warningLines = warnSpy.mock.calls.map((call) => call[0]);
    expect(warningLines).toContain('  Tools: <timed out after 10ms>');
    expect(warningLines).toContain('  Reason: Timeout');

    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

describe('CLI list classification', () => {
  it('identifies auth and offline failures and suggests remediation', async () => {
    const originalCI = process.env.CI;
    process.env.CI = '1';

    const { handleList } = await cliModulePromise;
    const definitions: ServerDefinition[] = [
      {
        name: 'healthy',
        command: { kind: 'stdio', command: 'noop', args: [], cwd: process.cwd() },
        source: { kind: 'local', path: '/tmp/config.json' },
      },
      {
        name: 'vercel',
        description: 'Vercel MCP',
        command: { kind: 'http', url: new URL('https://example.com') },
      },
      {
        name: 'github',
        command: { kind: 'http', url: new URL('https://example.com') },
        source: { kind: 'import', path: '/tmp/import.json' },
      },
      {
        name: 'next-devtools',
        command: { kind: 'http', url: new URL('https://localhost') },
      },
      {
        name: 'obsidian',
        command: { kind: 'http', url: new URL('https://localhost') },
      },
    ];

    const runtime = {
      getDefinitions: () => definitions,
      listTools: (name: string) => {
        switch (name) {
          case 'healthy':
            return Promise.resolve([{ name: 'ok' }]);
          case 'vercel':
            return Promise.reject(new Error('SSE error: Non-200 status code (401)'));
          case 'github':
            return Promise.reject(new Error('SSE error: Non-200 status code (405)'));
          case 'next-devtools':
            return Promise.reject(new Error('SSE error: fetch failed: connect ECONNREFUSED 127.0.0.1:3000'));
          case 'obsidian':
            // Regression guard: raw "connection closed" errors should map to offline for friendlier messaging.
            return Promise.reject(new Error('MCP error -32000: Connection closed'));
          default:
            return Promise.resolve([]);
        }
      },
    } as unknown as Awaited<ReturnType<typeof import('../src/runtime.js')['createRuntime']>>;

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await handleList(runtime, []);

    const logLines = logSpy.mock.calls.map((call) => call.join(' '));
    expect(
      logLines.some((line) => line.includes("vercel — Vercel MCP (auth required — run 'mcporter auth vercel'"))
    ).toBe(true);
    expect(logLines.some((line) => line.includes("github (auth required — run 'mcporter auth github'"))).toBe(true);
    const nextDevtoolsLineFound = logLines.some(
      (line) => line.startsWith('- next-devtools') && line.includes('offline — unable to reach server')
    );
    expect(nextDevtoolsLineFound).toBe(true);
    expect(
      logLines.some((line) => line.includes('obsidian') && line.includes('offline — unable to reach server'))
    ).toBe(true);

    const summaryLine = logLines.find((line) => line.startsWith('✔ Listed'));
    expect(summaryLine).toBeDefined();
    expect(summaryLine).toContain('auth required');
    expect(summaryLine).toContain('offline');

    expect(logLines).toContain('Next steps:');
    expect(logLines).toContain("  • vercel — run 'mcporter auth vercel'");
    expect(logLines).toContain("  • github — run 'mcporter auth github'");

    logSpy.mockRestore();
    warnSpy.mockRestore();
    process.env.CI = originalCI;
  });
});

import { describe, expect, it, vi } from 'vitest';

process.env.MCPORTER_DISABLE_AUTORUN = '1';
const cliModulePromise = import('../src/cli.js');

describe('CLI call error reporting', () => {
  it('reports connection issues and emits JSON payloads when requested', async () => {
    const { handleCall } = await cliModulePromise;
    const callTool = vi.fn().mockRejectedValue(new Error('SSE error: Non-200 status code (401)'));
    const runtime = {
      callTool,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Awaited<ReturnType<typeof import('../src/runtime.js')['createRuntime']>>;

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await handleCall(runtime, ['github.list_repos', '--output', 'json']);

    const payload = JSON.parse(logSpy.mock.calls.at(-1)?.[0] ?? '{}');
    expect(payload.issue?.kind).toBe('auth');
    expect(errorSpy.mock.calls.some((call) => call.join(' ').includes('Authorization required'))).toBe(true);

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

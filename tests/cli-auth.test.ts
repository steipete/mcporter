import { describe, expect, it, vi } from 'vitest';
import type { ServerDefinition } from '../src/config.js';

process.env.MCPORTER_DISABLE_AUTORUN = '1';
const cliModulePromise = import('../src/cli.js');

const createRuntimeDouble = () => {
  const definitions = new Map<string, Record<string, unknown>>();
  const registerDefinition = vi.fn((definition: Record<string, unknown>) => {
    definitions.set(definition.name as string, { ...definition });
  });
  const getDefinition = vi.fn((name: string) => {
    const definition = definitions.get(name);
    if (!definition) {
      throw new Error(`Unknown MCP server '${name}'.`);
    }
    return definition;
  });
  const listTools = vi.fn().mockResolvedValue([{ name: 'ok' }]);
  const runtime = {
    registerDefinition,
    getDefinition,
    getDefinitions: () => Array.from(definitions.values()),
    listTools,
  } as unknown as Awaited<ReturnType<typeof import('../src/runtime.js')['createRuntime']>>;
  return { runtime, listTools };
};

describe('mcporter auth ad-hoc support', () => {
  it('registers ad-hoc HTTP servers via --http-url', async () => {
    const { handleAuth } = await cliModulePromise;
    const { runtime, listTools } = createRuntimeDouble();

    await handleAuth(runtime, ['--http-url', 'https://mcp.deepwiki.com/sse']);

    expect(listTools).toHaveBeenCalledWith('mcp-deepwiki-com-sse', { autoAuthorize: true });
  });

  it('accepts bare URLs as the auth target', async () => {
    const { handleAuth } = await cliModulePromise;
    const { runtime, listTools } = createRuntimeDouble();

    await handleAuth(runtime, ['https://mcp.supabase.com/mcp']);

    expect(listTools).toHaveBeenCalledWith('mcp-supabase-com-mcp', { autoAuthorize: true });
  });

  it('reuses configured servers when auth target is a URL', async () => {
    const { handleAuth } = await cliModulePromise;
    const definition = {
      name: 'vercel',
      command: { kind: 'http', url: new URL('https://mcp.vercel.com') },
      tokenCacheDir: '/tmp/cache',
    } as ServerDefinition;
    const registerDefinition = vi.fn();
    const listTools = vi.fn().mockResolvedValue([{ name: 'ok' }]);
    const runtime = {
      getDefinitions: () => [definition],
      registerDefinition,
      listTools,
      getDefinition: () => definition,
    } as unknown as Awaited<ReturnType<typeof import('../src/runtime.js')['createRuntime']>>;

    await handleAuth(runtime, ['https://mcp.vercel.com']);

    expect(listTools).toHaveBeenCalledWith('vercel', { autoAuthorize: true });
    expect(registerDefinition).not.toHaveBeenCalled();
  });

  it('emits JSON envelopes when auth fails and --json is provided', async () => {
    const { handleAuth } = await cliModulePromise;
    const definition = {
      name: 'linear',
      command: { kind: 'http', url: new URL('https://mcp.linear.app/mcp') },
    } as ServerDefinition;
    const runtime = {
      getDefinitions: () => [definition],
      registerDefinition: vi.fn(),
      listTools: vi.fn().mockRejectedValue(new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:9000')),
      getDefinition: () => definition,
    } as unknown as Awaited<ReturnType<typeof import('../src/runtime.js')['createRuntime']>>;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(handleAuth(runtime, ['linear', '--json'])).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    const payload = JSON.parse(logSpy.mock.calls.at(-1)?.[0] ?? '{}');
    expect(payload.server).toBe('linear');
    expect(payload.issue.kind).toBe('offline');

    logSpy.mockRestore();
    errorSpy.mockRestore();
    process.exitCode = undefined;
  });
});

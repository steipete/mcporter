import { describe, expect, it, vi } from 'vitest';
import { resolveEphemeralServer } from '../src/cli/adhoc-server.js';
import type { ServerDefinition } from '../src/config.js';

process.env.MCPORTER_DISABLE_AUTORUN = '1';
const cliModulePromise = import('../src/cli.js');

describe('CLI call execution behavior', () => {
  it('auto-selects the sole tool when omitted', async () => {
    const toolName = 'list_issues';
    const { handleCall } = await cliModulePromise;
    const { runtime, callTool } = createRuntimeStub(
      {
        linear: [
          {
            name: toolName,
            description: 'List issues',
            inputSchema: {
              type: 'object',
              properties: {
                limit: { type: 'number' },
              },
              required: [],
            },
          },
        ],
      },
      {
        definitions: [
          {
            name: 'linear',
            command: { kind: 'stdio', command: 'linear', args: [], cwd: process.cwd() },
            source: { kind: 'local', path: '<test>' },
          },
        ],
      }
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handleCall(runtime, ['linear', 'limit=5']);
    expect(callTool).toHaveBeenCalledWith('linear', toolName, expect.objectContaining({ args: { limit: 5 } }));
    logSpy.mockRestore();
  });

  it('still requires an explicit tool when multiple are available', async () => {
    const { handleCall } = await cliModulePromise;
    const { runtime, callTool } = createRuntimeStub(
      {
        linear: [
          { name: 'list_issues', inputSchema: {} },
          { name: 'create_issue', inputSchema: {} },
        ],
      },
      {
        definitions: [
          {
            name: 'linear',
            command: { kind: 'stdio', command: 'linear', args: [], cwd: process.cwd() },
            source: { kind: 'local', path: '<test>' },
          },
        ],
      }
    );
    await expect(handleCall(runtime, ['linear'])).rejects.toThrow(
      'Missing tool name. Provide it via <server>.<tool> or --tool.'
    );
    expect(callTool).not.toHaveBeenCalled();
  });

  it('runs quoted stdio commands without --stdio and infers the tool automatically', async () => {
    const command = 'npx -y vercel-domains-mcp';
    const { name: adhocName } = resolveEphemeralServer({ stdioCommand: command });
    const { handleCall } = await cliModulePromise;
    const { runtime, callTool } = createRuntimeStub({
      [adhocName]: [
        {
          name: 'getDomainAvailability',
          inputSchema: {
            type: 'object',
            properties: { domain: { type: 'string' } },
            required: ['domain'],
          },
        },
      ],
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handleCall(runtime, [command, 'domain=answeroverflow.com']);
    expect(callTool).toHaveBeenCalledWith(
      adhocName,
      'getDomainAvailability',
      expect.objectContaining({
        args: { domain: 'answeroverflow.com' },
      })
    );
    logSpy.mockRestore();
  });

  it('aborts long-running tools when the timeout elapses', async () => {
    vi.useFakeTimers();
    try {
      const { handleCall } = await cliModulePromise;
      const close = vi.fn().mockResolvedValue(undefined);
      const runtime = {
        callTool: () =>
          new Promise((resolve) => {
            setTimeout(() => resolve('done'), 1000);
          }),
        close,
      };
      const promise = handleCall(runtime as never, ['chrome-devtools.list_pages', '--timeout', '10']);
      const expectation = expect(promise).rejects.toThrow('Call to chrome-devtools.list_pages timed out after 10ms.');
      await vi.runOnlyPendingTimersAsync();
      await expectation;
      expect(close).toHaveBeenCalledWith('chrome-devtools');
    } finally {
      vi.useRealTimers();
    }
  });

  it('auto-corrects near-miss tool names', async () => {
    const { handleCall } = await cliModulePromise;
    const callTool = vi
      .fn()
      .mockRejectedValueOnce(new Error('MCP error -32602: Tool listIssues not found'))
      .mockResolvedValueOnce({ ok: true });
    const listTools = vi.fn().mockResolvedValue([{ name: 'list_issues' }]);
    const runtime = {
      callTool,
      listTools,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Awaited<ReturnType<typeof import('../src/runtime.js')['createRuntime']>>;

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleCall(runtime, ['linear.listIssues']);

    const notes = logSpy.mock.calls.map((call) => call.join(' '));
    expect(notes.some((line) => line.includes('Auto-corrected tool call to linear.list_issues'))).toBe(true);
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(callTool).toHaveBeenNthCalledWith(1, 'linear', 'listIssues', expect.objectContaining({ args: {} }));
    expect(callTool).toHaveBeenNthCalledWith(2, 'linear', 'list_issues', expect.objectContaining({ args: {} }));
    expect(listTools).toHaveBeenCalledWith('linear', { autoAuthorize: true, includeSchema: false });

    logSpy.mockRestore();
  });

  it('suggests similar tool names when the match is uncertain', async () => {
    const { handleCall } = await cliModulePromise;
    const callTool = vi.fn().mockRejectedValue(new Error('MCP error -32602: Tool listIssues not found'));
    const listTools = vi.fn().mockResolvedValue([{ name: 'list_issue_statuses' }]);
    const runtime = {
      callTool,
      listTools,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Awaited<ReturnType<typeof import('../src/runtime.js')['createRuntime']>>;

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(handleCall(runtime, ['linear.listIssues'])).rejects.toThrow('listIssues not found');

    const messages = errorSpy.mock.calls.map((call) => call.join(' '));
    expect(messages.some((line) => line.includes('Did you mean linear.list_issue_statuses'))).toBe(true);

    errorSpy.mockRestore();
  });
});

function createRuntimeStub(
  toolCatalog: Record<
    string,
    Array<{
      name: string;
      description?: string;
      inputSchema?: unknown;
    }>
  >,
  options: { definitions?: ServerDefinition[] } = {}
): {
  runtime: Awaited<ReturnType<typeof import('../src/runtime.js')['createRuntime']>>;
  callTool: ReturnType<typeof vi.fn>;
  listTools: ReturnType<typeof vi.fn>;
} {
  const definitions = new Map<string, ServerDefinition>();
  for (const entry of options.definitions ?? []) {
    definitions.set(entry.name, entry);
  }
  const callTool = vi.fn().mockResolvedValue({ ok: true });
  const listTools = vi.fn().mockImplementation(async (server: string) => {
    const tools = toolCatalog[server];
    if (!tools) {
      throw new Error(`Unknown MCP server '${server}'.`);
    }
    return tools;
  });
  const close = vi.fn().mockResolvedValue(undefined);
  const runtime = {
    getDefinitions: () => [...definitions.values()],
    registerDefinition: vi.fn().mockImplementation((definition: ServerDefinition) => {
      definitions.set(definition.name, definition);
    }),
    listTools,
    callTool,
    close,
  } as unknown as Awaited<ReturnType<typeof import('../src/runtime.js')['createRuntime']>>;
  return { runtime, callTool, listTools };
}

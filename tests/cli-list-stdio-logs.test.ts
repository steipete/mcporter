import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleList } from '../src/cli/list-command.js';
import type { ServerDefinition } from '../src/config.js';
import type { Runtime, ServerToolInfo } from '../src/runtime.js';
import * as sdkPatches from '../src/sdk-patches.js';

function buildServerDefinition(name: string): ServerDefinition {
  return {
    name,
    description: `${name} server`,
    command: { kind: 'stdio', command: name, args: [], cwd: '/tmp' },
    source: { kind: 'local', path: '/tmp/mcporter.json' },
  };
}

function createRuntime(definitions: ServerDefinition[]) {
  const listTools = vi.fn(
    async (_name: string, _options?: unknown): Promise<ServerToolInfo[]> => [
      {
        name: 'doctor',
        description: 'Runs diagnostics',
        inputSchema: undefined,
        outputSchema: undefined,
      },
    ]
  );
  const runtime: Runtime = {
    listServers: () => definitions.map((entry) => entry.name),
    getDefinitions: () => definitions,
    getDefinition: (name: string): ServerDefinition => {
      const found = definitions.find((entry) => entry.name === name);
      if (!found) {
        throw new Error(`Unknown MCP server '${name}'.`);
      }
      return found;
    },
    registerDefinition: vi.fn(),
    listTools,
    callTool: vi.fn(async () => undefined),
    listResources: vi.fn(async () => undefined),
    connect: vi.fn(async () => {
      throw new Error('connect not implemented');
    }),
    close: vi.fn(async () => undefined),
  };
  return { runtime, listTools };
}

const originalCI = process.env.CI;

describe('handleList STDIO log policy', () => {
  beforeEach(() => {
    process.env.CI = '1';
    sdkPatches.setStdioLogMode('auto');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.CI = originalCI;
    sdkPatches.setStdioLogMode('auto');
  });

  it('silences STDIO stderr when listing all servers', async () => {
    const definitions = [buildServerDefinition('alpha'), buildServerDefinition('beta')];
    const { runtime, listTools } = createRuntime(definitions);
    const setModeSpy = vi.spyOn(sdkPatches, 'setStdioLogMode');
    const observedModes: sdkPatches.StdioLogMode[] = [];
    listTools.mockImplementation(async (_name: string, _options?: unknown) => {
      observedModes.push(sdkPatches.getStdioLogMode());
      return [
        {
          name: 'doctor',
          description: 'Runs diagnostics',
          inputSchema: undefined,
          outputSchema: undefined,
        },
      ];
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await handleList(runtime, []);
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
    expect(setModeSpy).toHaveBeenCalledWith('silent');
    const lastCall = setModeSpy.mock.calls.at(-1);
    expect(lastCall?.[0]).toBe('auto');
    expect(observedModes.length).toBeGreaterThan(0);
    expect(observedModes.every((mode) => mode === 'silent')).toBe(true);
  });

  it('leaves STDIO stderr in auto mode for targeted listings', async () => {
    const definitions = [buildServerDefinition('alpha')];
    const { runtime } = createRuntime(definitions);
    const setModeSpy = vi.spyOn(sdkPatches, 'setStdioLogMode');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await handleList(runtime, ['alpha']);
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
    expect(setModeSpy).not.toHaveBeenCalled();
  });
});

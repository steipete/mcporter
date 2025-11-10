import { describe, expect, it, vi } from 'vitest';
import type { ServerDefinition } from '../src/config.js';
import { createKeepAliveRuntime } from '../src/daemon/runtime-wrapper.js';
import type { CallOptions, ListToolsOptions, Runtime } from '../src/runtime.js';

class FakeRuntime implements Runtime {
  private readonly definitions: ServerDefinition[];
  public readonly callToolMock = vi.fn().mockResolvedValue('local-call');
  public readonly listToolsMock = vi.fn().mockResolvedValue([{ name: 'local-tool' }]);
  public readonly listResourcesMock = vi.fn().mockResolvedValue([]);
  public readonly closeMock = vi.fn().mockResolvedValue(undefined);

  constructor(definitions: ServerDefinition[]) {
    this.definitions = definitions;
  }

  listServers(): string[] {
    return this.definitions.map((definition) => definition.name);
  }

  getDefinitions(): ServerDefinition[] {
    return this.definitions;
  }

  getDefinition(server: string): ServerDefinition {
    const definition = this.definitions.find((entry) => entry.name === server);
    if (!definition) {
      throw new Error(`Unknown server ${server}`);
    }
    return definition;
  }

  registerDefinition(): void {
    // no-op for tests
  }

  async listTools(server: string, options?: ListToolsOptions): Promise<Awaited<ReturnType<Runtime['listTools']>>> {
    return await this.listToolsMock(server, options);
  }

  async callTool(server: string, toolName: string, options?: CallOptions): Promise<unknown> {
    return await this.callToolMock(server, toolName, options);
  }

  async listResources(server: string, options?: unknown): Promise<unknown> {
    return await this.listResourcesMock(server, options);
  }

  async connect(): Promise<never> {
    throw new Error('not implemented');
  }

  async close(server?: string): Promise<void> {
    await this.closeMock(server);
  }
}

describe('createKeepAliveRuntime', () => {
  const definitions: ServerDefinition[] = [
    {
      name: 'alpha',
      description: 'keep alive server',
      command: { kind: 'http', url: new URL('https://alpha.example.com') },
      lifecycle: { mode: 'keep-alive' },
      source: { kind: 'local', path: '/tmp' },
    },
    {
      name: 'beta',
      description: 'ephemeral server',
      command: { kind: 'http', url: new URL('https://beta.example.com') },
      source: { kind: 'local', path: '/tmp' },
    },
  ];

  it('routes keep-alive servers through the daemon client', async () => {
    const runtime = new FakeRuntime(definitions);
    const daemon = {
      callTool: vi.fn().mockResolvedValue('daemon-call'),
      listTools: vi.fn().mockResolvedValue([{ name: 'remote-tool' }]),
      listResources: vi.fn().mockResolvedValue(['resource']),
      closeServer: vi.fn().mockResolvedValue(undefined),
    };
    const keepAliveRuntime = createKeepAliveRuntime(runtime as unknown as Runtime, {
      daemonClient: daemon as never,
      keepAliveServers: new Set(['alpha']),
    });

    await keepAliveRuntime.callTool('alpha', 'ping', { args: { value: 1 }, timeoutMs: 4_200 });
    expect(daemon.callTool).toHaveBeenCalledWith({
      server: 'alpha',
      tool: 'ping',
      args: { value: 1 },
      timeoutMs: 4_200,
    });

    await keepAliveRuntime.listTools('alpha', { includeSchema: true });
    expect(daemon.listTools).toHaveBeenCalledWith({ server: 'alpha', includeSchema: true, autoAuthorize: undefined });

    await keepAliveRuntime.listResources('alpha', { cursor: '1' });
    expect(daemon.listResources).toHaveBeenCalledWith({ server: 'alpha', params: { cursor: '1' } });

    await keepAliveRuntime.close('alpha');
    expect(daemon.closeServer).toHaveBeenCalledWith({ server: 'alpha' });

    await keepAliveRuntime.callTool('beta', 'pong', {});
    expect(runtime.callToolMock).toHaveBeenCalledWith('beta', 'pong', {});

    await keepAliveRuntime.close();
    expect(runtime.closeMock).toHaveBeenCalledWith(undefined);
  });
});

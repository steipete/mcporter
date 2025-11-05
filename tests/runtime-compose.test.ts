import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const connectMock = vi.fn();
  const listToolsMock = vi.fn();
  const callToolMock = vi.fn();
  const listResourcesMock = vi.fn();
  const clientInstances: unknown[] = [];
  const streamableInstances: unknown[] = [];
  const stdioInstances: unknown[] = [];

  class MockClient {
    constructor() {
      clientInstances.push(this);
    }

    async connect(transport: { start?: () => Promise<void> }) {
      connectMock(transport);
      if (typeof transport.start === 'function') {
        await transport.start();
      }
    }

    async listTools(params: unknown) {
      return listToolsMock(params);
    }

    async callTool(params: unknown) {
      return callToolMock(params);
    }

    async listResources(params: unknown) {
      return listResourcesMock(params);
    }
  }

  class MockStreamableHTTPClientTransport {
    public start = vi.fn(async () => {});
    public close = vi.fn(async () => {});
    constructor(
      public url: URL,
      public options?: unknown
    ) {
      streamableInstances.push(this);
    }
  }

  class MockSSEClientTransport {
    public start = vi.fn(async () => {});
    public close = vi.fn(async () => {});
    constructor(
      public url: URL,
      public options?: unknown
    ) {}
  }

  class MockStdioClientTransport {
    public close = vi.fn(async () => {});
    constructor(public options: unknown) {
      stdioInstances.push(this);
    }
  }

  class MockUnauthorizedError extends Error {}

  return {
    connectMock,
    listToolsMock,
    callToolMock,
    listResourcesMock,
    clientInstances,
    streamableInstances,
    stdioInstances,
    MockClient,
    MockStreamableHTTPClientTransport,
    MockSSEClientTransport,
    MockStdioClientTransport,
    MockUnauthorizedError,
  };
});

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: mocks.MockClient,
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: mocks.MockStreamableHTTPClientTransport,
}));

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: mocks.MockSSEClientTransport,
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: mocks.MockStdioClientTransport,
}));

vi.mock('@modelcontextprotocol/sdk/client/auth.js', () => ({
  UnauthorizedError: mocks.MockUnauthorizedError,
}));

import { createRuntime } from '../src/runtime.js';

describe('mcporter composability', () => {
  beforeEach(() => {
    mocks.connectMock.mockClear();
    mocks.listToolsMock.mockReset();
    mocks.callToolMock.mockReset();
    mocks.listResourcesMock.mockReset();
    mocks.clientInstances.length = 0;
    mocks.streamableInstances.length = 0;
    mocks.stdioInstances.length = 0;

    mocks.listToolsMock.mockResolvedValue({ tools: [] });
    mocks.callToolMock.mockResolvedValue({ ok: true });
    mocks.listResourcesMock.mockResolvedValue({ resources: [] });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('reuses a single client connection for sequential calls', async () => {
    mocks.listToolsMock.mockResolvedValueOnce({
      tools: [{ name: 'echo', description: 'Echo tool' }],
    });
    mocks.callToolMock.mockResolvedValueOnce({ ok: 'first' }).mockResolvedValueOnce({ ok: 'second' });

    const previousToken = process.env.INLINE_TOKEN;
    process.env.INLINE_TOKEN = 'inline-test';

    const runtime = await createRuntime({
      servers: [
        {
          name: 'fake',
          description: 'Inline fake server',
          command: {
            kind: 'http' as const,
            url: new URL('https://example.com'),
            headers: { Authorization: `Bearer \${INLINE_TOKEN}` },
          },
        },
      ],
    });

    try {
      const tools = await runtime.listTools('fake');
      expect(tools).toEqual([
        {
          name: 'echo',
          description: 'Echo tool',
          inputSchema: undefined,
          outputSchema: undefined,
        },
      ]);
      expect(mocks.connectMock).toHaveBeenCalledTimes(1);
      expect(mocks.clientInstances).toHaveLength(1);
      const streamableTransport = mocks.streamableInstances[0] as {
        options?: {
          requestInit?: { headers?: Record<string, string> };
          authProvider?: unknown;
        };
        close: ReturnType<typeof vi.fn>;
      };
      expect(streamableTransport.options?.requestInit?.headers).toEqual({
        Authorization: 'Bearer inline-test',
      });

      const first = await runtime.callTool('fake', 'echo', {
        args: { text: 'hi' },
      });
      const second = await runtime.callTool('fake', 'echoSecond', {
        args: { count: 2 },
      });

      expect(first).toEqual({ ok: 'first' });
      expect(second).toEqual({ ok: 'second' });
      expect(mocks.callToolMock).toHaveBeenNthCalledWith(1, {
        name: 'echo',
        arguments: { text: 'hi' },
      });
      expect(mocks.callToolMock).toHaveBeenNthCalledWith(2, {
        name: 'echoSecond',
        arguments: { count: 2 },
      });
      expect(mocks.connectMock).toHaveBeenCalledTimes(1);
      expect(mocks.clientInstances).toHaveLength(1);
    } finally {
      await runtime.close();
      const streamableTransport = mocks.streamableInstances[0] as {
        close: ReturnType<typeof vi.fn>;
      };
      expect(mocks.streamableInstances).toHaveLength(1);
      expect(streamableTransport.close).toHaveBeenCalledTimes(1);
      if (previousToken === undefined) {
        delete process.env.INLINE_TOKEN;
      } else {
        process.env.INLINE_TOKEN = previousToken;
      }
    }
  });
});

describe('stdio transport environment', () => {
  const previousEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...previousEnv };
    mocks.listToolsMock.mockReset();
    mocks.listToolsMock.mockResolvedValue({ tools: [] });
    mocks.clientInstances.length = 0;
    mocks.stdioInstances.length = 0;
  });

  afterEach(() => {
    process.env = { ...previousEnv };
    vi.clearAllMocks();
  });

  it('resolves env overrides before spawning stdio transport', async () => {
    process.env.OBSIDIAN_API_KEY = 'secret';
    delete process.env.OBSIDIAN_BASE_URL;

    const runtime = await createRuntime({
      servers: [
        {
          name: 'obsidian',
          description: 'Local Obsidian bridge',
          command: {
            kind: 'stdio' as const,
            command: 'node',
            args: ['--version'],
            cwd: '/repo',
          },
          env: {
            OBSIDIAN_API_KEY: '${OBSIDIAN_API_KEY}',
            OBSIDIAN_BASE_URL: '${OBSIDIAN_BASE_URL:-https://127.0.0.1:27124}',
            EMPTY_VAR: '',
          },
        },
      ],
    });

    try {
      await runtime.listTools('obsidian');
      expect(mocks.stdioInstances).toHaveLength(1);
      const transport = mocks.stdioInstances[0] as { options: { env?: Record<string, string> } };
      expect(transport.options.env).toEqual({
        OBSIDIAN_API_KEY: 'secret',
        OBSIDIAN_BASE_URL: 'https://127.0.0.1:27124',
      });
    } finally {
      await runtime.close().catch(() => {});
    }
  });
});

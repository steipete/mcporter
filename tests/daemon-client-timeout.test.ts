import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const timeoutRecords: Array<{ method: string; timeout: number }> = [];

class MockSocket extends EventEmitter {
  currentTimeout = 0;

  setTimeout(ms: number): this {
    this.currentTimeout = ms;
    return this;
  }

  write(data: string, cb?: (err?: Error | null) => void): boolean {
    const payload = JSON.parse(data.toString());
    timeoutRecords.push({ method: payload.method, timeout: this.currentTimeout });
    const response = buildResponse(payload.method, payload.id);
    setTimeout(() => {
      this.emit('data', JSON.stringify(response));
      this.emit('end');
    }, responseDelayMs);
    cb?.();
    return true;
  }

  end(cb?: () => void): this {
    cb?.();
    return this;
  }

  destroy(): this {
    return this;
  }
}

let responseDelayMs = 5;
const createConnection = vi.fn(() => {
  const socket = new MockSocket();
  setTimeout(() => socket.emit('connect'), 0);
  return socket;
});

let previousDaemonTimeout: string | undefined;

vi.mock('node:net', () => ({
  createConnection,
  default: { createConnection },
}));

vi.mock('../src/daemon/launch.js', () => ({
  launchDaemonDetached: vi.fn(),
}));

const { DaemonClient } = await import('../src/daemon/client.js');

function buildResponse(method: string, id: string) {
  if (method === 'status') {
    return {
      id,
      ok: true,
      result: {
        pid: 123,
        startedAt: Date.now(),
        configPath: 'test',
        socketPath: '/tmp/socket',
        servers: [],
      },
    };
  }
  return {
    id,
    ok: true,
    result: { ok: true },
  };
}

describe('DaemonClient timeouts', () => {
  beforeEach(() => {
    timeoutRecords.length = 0;
    responseDelayMs = 5;
    previousDaemonTimeout = process.env.MCPORTER_DAEMON_TIMEOUT_MS;
    delete process.env.MCPORTER_DAEMON_TIMEOUT_MS;
  });

  afterEach(() => {
    if (previousDaemonTimeout === undefined) {
      delete process.env.MCPORTER_DAEMON_TIMEOUT_MS;
    } else {
      process.env.MCPORTER_DAEMON_TIMEOUT_MS = previousDaemonTimeout;
    }
  });

  it('defaults to 30s per request', async () => {
    const client = new DaemonClient({ configPath: 'mcporter.config.json' });
    await client.callTool({ server: 'foo', tool: 'bar' });
    const callRecord = timeoutRecords.find((entry) => entry.method === 'callTool');
    expect(callRecord?.timeout).toBe(30_000);
  });

  it('honors MCPORTER_DAEMON_TIMEOUT_MS override', async () => {
    process.env.MCPORTER_DAEMON_TIMEOUT_MS = '4500';
    const client = new DaemonClient({ configPath: 'mcporter.config.json' });
    await client.callTool({ server: 'foo', tool: 'bar' });
    const callRecord = timeoutRecords.find((entry) => entry.method === 'callTool');
    expect(callRecord?.timeout).toBe(4_500);
  });

  it('honors per-call timeout overrides', async () => {
    const client = new DaemonClient({ configPath: 'mcporter.config.json' });
    await client.callTool({ server: 'foo', tool: 'bar', timeoutMs: 12_345 });
    const callRecord = timeoutRecords.find((entry) => entry.method === 'callTool');
    expect(callRecord?.timeout).toBe(12_345);
  });
});

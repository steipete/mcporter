import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DaemonClient, resolveDaemonPaths } from '../src/daemon/client.js';
import { makeShortTempDir } from './fixtures/test-helpers.js';

describe('daemon client', () => {
  it('keeps stdio sockets open until the daemon responds', async () => {
    const tmpDir = await makeShortTempDir('mcpd');
    const originalDir = process.env.MCPORTER_DAEMON_DIR;
    process.env.MCPORTER_DAEMON_DIR = tmpDir;
    const configPath = path.join(tmpDir, 'config.json');
    const { socketPath } = resolveDaemonPaths(configPath);
    await fs.mkdir(path.dirname(socketPath), { recursive: true });
    try {
      await fs.unlink(socketPath).catch(() => {});
      let clientClosedBeforeResponse = false;
      const server = net.createServer((socket) => {
        let responded = false;
        socket.on('data', () => {
          setTimeout(() => {
            responded = true;
            socket.write(JSON.stringify({ id: 'status', ok: true, result: { pong: true } }), () => {
              socket.end();
            });
          }, 20);
        });
        socket.on('end', () => {
          if (!responded) {
            clientClosedBeforeResponse = true;
          }
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => {
          server.off('error', reject);
          resolve();
        });
      });
      try {
        const client = new DaemonClient({ configPath });
        const result = await (
          client as unknown as { sendRequest: (method: 'status', params: object) => Promise<unknown> }
        ).sendRequest('status', {});
        expect(result).toEqual({ pong: true });
        expect(clientClosedBeforeResponse).toBe(false);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await fs.unlink(socketPath).catch(() => {});
      }
    } finally {
      if (originalDir) {
        process.env.MCPORTER_DAEMON_DIR = originalDir;
      } else {
        delete process.env.MCPORTER_DAEMON_DIR;
      }
    }
  });
});

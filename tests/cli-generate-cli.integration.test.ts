import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

const CLI_ENTRY = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

async function ensureDistBuilt(): Promise<void> {
  try {
    await fs.access(CLI_ENTRY);
  } catch {
    await new Promise<void>((resolve, reject) => {
      execFile('pnpm', ['build'], { cwd: process.cwd(), env: process.env }, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

async function hasBun(): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    execFile('bun', ['--version'], { cwd: process.cwd(), env: process.env }, (error) => {
      resolve(!error);
    });
  });
}

describe('mcporter CLI integration', () => {
  let baseUrl: URL;
  let shutdown: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    await ensureDistBuilt();
    const app = express();
    app.use(express.json());
    const server = new McpServer({ name: 'context7', version: '1.0.0' });
    server.registerTool(
      'ping',
      {
        title: 'Ping',
        description: 'Simple health check',
        inputSchema: { echo: z.string().optional() },
        outputSchema: { ok: z.boolean(), echo: z.string().optional() },
      },
      async ({ echo }) => ({
        content: [{ type: 'text', text: JSON.stringify({ ok: true, echo: echo ?? 'hi' }) }],
        structuredContent: { ok: true, echo: echo ?? 'hi' },
      })
    );

    app.post('/mcp', async (req, res) => {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        transport.close().catch(() => {});
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });

    const httpServer = createServer(app);
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to start integration server');
    }
    baseUrl = new URL(`http://127.0.0.1:${address.port}/mcp`);
    shutdown = async () =>
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
  });

  afterAll(async () => {
    if (shutdown) {
      await shutdown();
    }
  });

  it('runs "node dist/cli.js generate-cli" from a dependency-less directory', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-cli-e2e-'));
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'mcporter-e2e', version: '0.0.0' }, null, 2),
      'utf8'
    );
    const bundlePath = path.join(tempDir, 'context7.cli.js');

    await new Promise<void>((resolve, reject) => {
      execFile(
        process.execPath,
        [CLI_ENTRY, 'generate-cli', '--command', baseUrl.toString(), '--bundle', bundlePath],
        {
          cwd: tempDir,
          env: { ...process.env, MCPORTER_NO_FORCE_EXIT: '1' },
        },
        (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        }
      );
    });

    const stats = await fs.stat(bundlePath);
    expect(stats.isFile()).toBe(true);
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('runs "node dist/cli.js generate-cli --compile" when bun is available', async () => {
    if (!(await hasBun())) {
      console.warn('bun not available on this runner; skipping compile integration test.');
      return;
    }
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-cli-compile-'));
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'mcporter-compile-e2e', version: '0.0.0' }, null, 2),
      'utf8'
    );
    const binaryPath = path.join(tempDir, 'context7-cli');

    await new Promise<void>((resolve, reject) => {
      execFile(
        process.execPath,
        [CLI_ENTRY, 'generate-cli', '--command', baseUrl.toString(), '--compile', binaryPath, '--runtime', 'bun'],
        {
          cwd: tempDir,
          env: { ...process.env, MCPORTER_NO_FORCE_EXIT: '1' },
        },
        (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        }
      );
    });

    const stats = await fs.stat(binaryPath);
    expect(stats.isFile()).toBe(true);

    const { stdout } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(binaryPath, ['list-tools'], { env: process.env }, (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
    });
    expect(stdout).toContain('ping - Simple health check');

    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });
});

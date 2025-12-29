import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

const CLI_ENTRY = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const testRequire = createRequire(import.meta.url);
const MCP_SERVER_MODULE = pathToFileURL(testRequire.resolve('@modelcontextprotocol/sdk/server/mcp.js')).href;
const STDIO_SERVER_MODULE = pathToFileURL(testRequire.resolve('@modelcontextprotocol/sdk/server/stdio.js')).href;
const ZOD_MODULE = pathToFileURL(path.join(process.cwd(), 'node_modules', 'zod', 'index.js')).href;

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

async function ensureBunSupport(reason: string): Promise<boolean> {
  if (process.platform === 'win32') {
    console.warn(`bun not supported on Windows; skipping ${reason}.`);
    return false;
  }
  if (!(await hasBun())) {
    console.warn(`bun not available on this runner; skipping ${reason}.`);
    return false;
  }
  return true;
}

describe('mcporter CLI integration', () => {
  let baseUrl: URL;
  let shutdown: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    await ensureDistBuilt();
    const app = express();
    app.use(express.json());
    const server = new McpServer({ name: 'context7', title: 'Context7 integration harness', version: '1.0.0' });
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
        [CLI_ENTRY, 'generate-cli', '--command', baseUrl.toString(), '--bundle', bundlePath, '--runtime', 'node'],
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
    const helpOutput = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(process.execPath, [bundlePath], { env: process.env }, (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
    });
    expect(helpOutput.stdout).toMatch(/Usage: .+ <command> \[options]/);
    expect(helpOutput.stdout).toContain('Context7 integration harness');
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('bundles with Bun automatically when runtime resolves to Bun', async () => {
    if (!(await ensureBunSupport('Bun bundler integration test'))) {
      return;
    }
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-bun-bundle-'));
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'mcporter-bun-bundle', version: '0.0.0' }, null, 2),
      'utf8'
    );
    const bundlePath = path.join(tempDir, 'context7-bun.js');

    await new Promise<void>((resolve, reject) => {
      execFile(
        process.execPath,
        [CLI_ENTRY, 'generate-cli', '--command', baseUrl.toString(), '--runtime', 'bun', '--bundle', bundlePath],
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
    const helpOutput = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(bundlePath, [], { env: process.env }, (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
    });
    expect(helpOutput.stdout).toMatch(/Usage: .+ <command> \[options]/);
    expect(helpOutput.stdout).toContain('Context7 integration harness');
    expect(helpOutput.stdout).toContain('ping - Simple health check');
    expect(helpOutput.stdout).toContain('--echo <echo>');
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }, 20000);

  it('generates a Bun CLI that can call a tool', async () => {
    if (!(await ensureBunSupport('Bun CLI execution test'))) {
      return;
    }
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-bun-cli-'));
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'mcporter-bun-cli', version: '0.0.0' }, null, 2),
      'utf8'
    );
    const bundlePath = path.join(tempDir, 'context7-bun-cli.js');

    await new Promise<void>((resolve, reject) => {
      execFile(
        process.execPath,
        [CLI_ENTRY, 'generate-cli', '--command', baseUrl.toString(), '--runtime', 'bun', '--bundle', bundlePath],
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

    const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(
        bundlePath,
        ['ping', '--echo', 'ban', '--output', 'json'],
        { env: process.env },
        (error, stdout, stderr) => {
          if (error) {
            reject(error);
            return;
          }
          resolve({ stdout, stderr });
        }
      );
    });
    const parsed = JSON.parse(result.stdout.trim()) as { ok: boolean; echo?: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.echo).toBe('ban');
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }, 20000);

  it('runs "node dist/cli.js generate-cli --compile" when bun is available', async () => {
    if (!(await ensureBunSupport('compile integration test'))) {
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

    const helpOutput = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(binaryPath, [], { env: process.env }, (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
    });
    expect(helpOutput.stdout).toMatch(/Usage: .+ <command> \[options]/);
    expect(helpOutput.stdout).toContain('Context7 integration harness');
    expect(helpOutput.stdout).toContain('ping - Simple health check');
    expect(helpOutput.stdout).toContain('--echo <echo>');

    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }, 20000);

  it('runs "node dist/cli.js generate-cli --compile" using the Bun bundler by default', async () => {
    if (!(await ensureBunSupport('Bun bundler compile integration test'))) {
      return;
    }
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-cli-compile-bun-'));
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'mcporter-compile-bun', version: '0.0.0' }, null, 2),
      'utf8'
    );
    const binaryPath = path.join(tempDir, 'context7-cli-bun');

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

    const helpOutput = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(binaryPath, [], { env: process.env }, (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
    });
    expect(helpOutput.stdout).toMatch(/Usage: .+ <command> \[options]/);
    expect(helpOutput.stdout).toContain('ping - Simple health check');
    expect(helpOutput.stdout).toContain('--echo <echo>');

    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }, 20000);

  it('accepts inline stdio commands (e.g., "npx -y chrome-devtools-mcp@latest") when compiling', async () => {
    if (!(await ensureBunSupport('inline stdio compile integration test'))) {
      return;
    }
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-inline-stdio-'));
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'mcporter-inline-stdio', version: '0.0.0' }, null, 2),
      'utf8'
    );
    const scriptPath = path.join(tempDir, 'mock-stdio.mjs');
    const scriptSource = `import { McpServer } from '${MCP_SERVER_MODULE}';
import { StdioServerTransport } from '${STDIO_SERVER_MODULE}';
import { z } from '${ZOD_MODULE}';

const server = new McpServer({ name: 'inline-cli', version: '1.0.0' });
server.registerTool('echo', {
  title: 'Echo',
  description: 'Return the provided text',
  // Use Zod schemas to keep SDK 1.22.x happy when converting to JSON Schema.
  inputSchema: z.object({ text: z.string() }),
  outputSchema: z.object({ text: z.string() }),
}, async ({ text }) => ({
  content: [{ type: 'text', text }],
  structuredContent: { text },
}));

const transport = new StdioServerTransport();
await server.connect(transport);
await new Promise((resolve) => {
  transport.onclose = resolve;
});
`;
    await fs.writeFile(scriptPath, scriptSource, 'utf8');

    const binaryPath = path.join(tempDir, 'inline-cli');
    await new Promise<void>((resolve, reject) => {
      execFile(
        process.execPath,
        [CLI_ENTRY, 'generate-cli', `node ${scriptPath}`, '--compile', binaryPath, '--runtime', 'bun'],
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
      execFile(binaryPath, [], { env: process.env }, (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
    });
    expect(stdout).toContain('echo - Return the provided text');
    expect(stdout).toContain('[--raw <json>]');

    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }, 40_000);
});

import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { __test as generateCliInternals, generateCli } from '../src/generate-cli.js';

let baseUrl: URL;
const tmpDir = path.join(process.cwd(), 'tmp', 'mcporter-cli-tests');

beforeAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.mkdir(tmpDir, { recursive: true });
  const app = express();
  app.use(express.json());

  const server = new McpServer({ name: 'integration', version: '1.0.0' });
  server.registerTool(
    'add',
    {
      title: 'Add',
      description: 'Add two numbers',
      inputSchema: { a: z.number(), b: z.number() },
      outputSchema: { result: z.number() },
    },
    async ({ a, b }) => {
      const result = { result: Number(a) + Number(b) };
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      };
    }
  );
  server.registerResource(
    'greeting',
    new ResourceTemplate('greeting://{name}', { list: undefined }),
    { title: 'Greeting', description: 'Simple greeting' },
    async (uri, { name }) => ({
      contents: [
        {
          uri: uri.href,
          text: `Hello, ${typeof name === 'string' ? name : 'friend'}!`,
        },
      ],
    })
  );

  app.post('/mcp', async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
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
    throw new Error('Failed to obtain test server address');
  }
  baseUrl = new URL(`http://127.0.0.1:${address.port}/mcp`);

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });
});

describe('generateCli', () => {
  it('creates a standalone CLI and bundled executable', async () => {
    const inline = JSON.stringify({
      name: 'integration',
      description: 'Test integration server',
      command: baseUrl.toString(),
      tokenCacheDir: path.join(tmpDir, 'schema-cache'),
    });
    await fs.mkdir(path.join(tmpDir, 'schema-cache'), { recursive: true });
    const exec = await import('node:child_process');
    const bunAvailable = await hasBun(exec);
    if (!bunAvailable) {
      console.warn('bun is not available on this runner; skipping compilation checks.');
      return;
    }
    await new Promise<void>((resolve, reject) => {
      exec.exec('pnpm build', execOptions(), (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    const expectedBinaryPath = path.join(tmpDir, 'integration');
    const {
      outputPath: generated,
      bundlePath: bundled,
      compilePath,
    } = await generateCli({
      serverRef: inline,
      runtime: 'bun',
      timeoutMs: 5_000,
      minify: true,
      compile: expectedBinaryPath,
    });
    expect(bundled).toBeUndefined();
    if (!compilePath) {
      throw new Error('Expected compile output when --compile is provided');
    }
    expect(compilePath).toBe(expectedBinaryPath);

    // Template is only persisted when the caller supplies --output explicitly.
    const templateExists = await exists(generated);
    expect(templateExists).toBe(false);

    expect(await exists(compilePath)).toBe(true);

    const { stdout } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      exec.execFile(
        compilePath,
        ['list-tools'],
        execOptions(),
        (error: import('node:child_process').ExecFileException | null, stdout: string, stderr: string) => {
          if (error) {
            reject(error);
            return;
          }
          resolve({ stdout, stderr });
        }
      );
    });
    expect(stdout).toContain('Available tools');

    const packageJson = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      name?: string;
      version?: string;
    };
    const generatorLabel = `${packageJson.name ?? 'mcporter'}@${packageJson.version ?? 'unknown'}`;

    const { stdout: helpStdout } = await new Promise<{
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      exec.execFile(
        compilePath,
        ['--help'],
        execOptions(),
        (error: import('node:child_process').ExecFileException | null, stdout: string, stderr: string) => {
          if (error) {
            reject(error);
            return;
          }
          resolve({ stdout, stderr });
        }
      );
    });
    expect(helpStdout).toContain(`Generated by ${generatorLabel}`);
    expect(helpStdout).toContain('Tools:');
    expect(helpStdout).toContain('add - Add two numbers');

    const { stdout: callStdout } = await new Promise<{
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      exec.execFile(
        compilePath,
        ['add', '--a', '2', '--b', '3', '--output', 'json'],
        execOptions(),
        (error: import('node:child_process').ExecFileException | null, stdout: string, stderr: string) => {
          if (error) {
            reject(error);
            return;
          }
          resolve({ stdout, stderr });
        }
      );
    });
    expect(callStdout).toContain('result');

    const cachePath = path.join(tmpDir, 'schema-cache', 'schema.json');
    const cacheRaw = await fs.readFile(cachePath, 'utf8');
    const cacheData = JSON.parse(cacheRaw) as {
      tools: Record<string, unknown>;
    };
    expect(Object.keys(cacheData.tools)).toContain('add');

    const derivedUrl = new URL(baseUrl.toString());
    derivedUrl.hostname = 'integration.localhost';
    const altOutput = path.join(tmpDir, 'integration-alt.ts');
    await new Promise<void>((resolve, reject) => {
      exec.execFile(
        'node',
        ['dist/cli.js', 'generate-cli', '--command', derivedUrl.toString(), '--output', altOutput],
        execOptions(),
        (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        }
      );
    });
    const altContent = await fs.readFile(altOutput, 'utf8');
    expect(altContent).toContain('const embeddedName = "integration"');

    // --raw path exercised implicitly by runtime when needed; end-to-end call
    // verification is covered in runtime integration tests.
  }, 20_000);
});

describe('generateCli helpers', () => {
  const { getEnumValues, getDescriptorDefault, buildPlaceholder, buildExampleValue } = generateCliInternals;

  it('extracts enum candidates from descriptors', () => {
    expect(getEnumValues({ type: 'string', enum: ['a', 'b', 1] })).toEqual(['a', 'b']);
    expect(
      getEnumValues({
        type: 'array',
        items: { type: 'string', enum: ['x', 'y'] },
      })
    ).toEqual(['x', 'y']);
    expect(getEnumValues({ type: 'number' })).toBeUndefined();
  });

  it('derives defaults, placeholders, and examples', () => {
    expect(getDescriptorDefault({ type: 'string', default: 'inline' })).toBe('inline');
    expect(
      getDescriptorDefault({
        type: 'array',
        items: { type: 'string' },
        default: ['first'],
      })
    ).toEqual(['first']);

    expect(buildPlaceholder('mode', 'string', ['read', 'write'])).toBe('<mode:read|write>');
    expect(buildExampleValue('mode', 'string', ['read', 'write'], undefined)).toBe('read');
    expect(buildPlaceholder('count', 'number')).toBe('<count:number>');
    expect(buildExampleValue('count', 'number', undefined, 3)).toBe('3');
    expect(buildExampleValue('path', 'string', undefined, undefined)).toBe('/path/to/file.md');
  });
});

async function exists(file: string | undefined): Promise<boolean> {
  if (!file) {
    return false;
  }
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function execOptions() {
  return {
    cwd: process.cwd(),
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
    encoding: 'utf8' as const,
  };
}

async function hasBun(exec: typeof import('node:child_process')) {
  return await new Promise<boolean>((resolve) => {
    exec.execFile(process.env.BUN_BIN ?? 'bun', ['--version'], execOptions(), (error) => {
      resolve(!error);
    });
  });
}

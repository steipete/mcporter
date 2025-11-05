import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadServerDefinitions } from '../src/config.js';

const TMP_PREFIX = path.join(os.tmpdir(), 'mcporter-command-');

let tmpDir: string | undefined;

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe('command string parsing', () => {
  it('splits whitespace-delimited command strings into executable + args', async () => {
    tmpDir = await fs.mkdtemp(TMP_PREFIX);
    const configDir = path.join(tmpDir, 'config');
    await fs.mkdir(configDir, { recursive: true });
    const configPath = path.join(configDir, 'mcporter.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          xcodebuild: {
            description: 'test server',
            command: 'npx -y xcodebuildmcp@latest',
          },
        },
        imports: [],
      })
    );

    const servers = await loadServerDefinitions({
      configPath,
      rootDir: tmpDir,
    });

    expect(servers).toHaveLength(1);
    const server = servers[0];
    expect(server.command.kind).toBe('stdio');
    if (server.command.kind !== 'stdio') {
      throw new Error('expected stdio command');
    }
    expect(server.command.command).toBe('npx');
    expect(server.command.args).toEqual(['-y', 'xcodebuildmcp@latest']);
  });

  it('respects quoted segments inside command strings', async () => {
    tmpDir = await fs.mkdtemp(TMP_PREFIX);
    const configDir = path.join(tmpDir, 'config');
    await fs.mkdir(configDir, { recursive: true });
    const configPath = path.join(configDir, 'mcporter.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          bash: {
            command: 'bash -lc "echo \'hello world\'"',
          },
        },
        imports: [],
      })
    );

    const [server] = await loadServerDefinitions({
      configPath,
      rootDir: tmpDir,
    });

    expect(server.command.kind).toBe('stdio');
    if (server.command.kind !== 'stdio') {
      throw new Error('expected stdio command');
    }
    expect(server.command.command).toBe('bash');
    expect(server.command.args).toEqual(['-lc', "echo 'hello world'"]);
  });
});

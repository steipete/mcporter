import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import type { ServerDefinition, ServerSource } from './config.js';

export type CliArtifactKind = 'template' | 'bundle' | 'binary';

export interface SerializedServerDefinition {
  readonly name: string;
  readonly description?: string;
  readonly command:
    | {
        kind: 'http';
        url: string;
        headers?: Record<string, string>;
      }
    | {
        kind: 'stdio';
        command: string;
        args: string[];
        cwd: string;
      };
  readonly env?: Record<string, string>;
  readonly auth?: string;
  readonly tokenCacheDir?: string;
  readonly clientName?: string;
  readonly oauthRedirectUrl?: string;
}

export interface CliArtifactMetadata {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly generator: {
    readonly name: string;
    readonly version: string;
  };
  readonly server: {
    readonly name: string;
    readonly source?: ServerSource;
    readonly definition: SerializedServerDefinition;
  };
  readonly artifact: {
    readonly path: string;
    readonly kind: CliArtifactKind;
  };
  readonly invocation: {
    serverRef?: string;
    configPath?: string;
    rootDir?: string;
    runtime: 'node' | 'bun';
    bundler?: 'rolldown' | 'bun';
    outputPath?: string;
    bundle?: boolean | string;
    compile?: boolean | string;
    timeoutMs: number;
    minify: boolean;
    includeTools?: string[];
    excludeTools?: string[];
  };
}

// metadataPathForArtifact derives the metadata file path for a given artifact output path.
export function metadataPathForArtifact(artifactPath: string): string {
  return `${artifactPath}.metadata.json`;
}

// readCliMetadata loads metadata for a generated CLI artifact, preferring the embedded
// inspect command and falling back to legacy sidecar files.
export async function readCliMetadata(artifactPath: string): Promise<CliArtifactMetadata> {
  const legacyPath = metadataPathForArtifact(artifactPath);
  try {
    const buffer = await fs.readFile(legacyPath, 'utf8');
    return JSON.parse(buffer) as CliArtifactMetadata;
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) {
      throw error;
    }
  }
  return await readMetadataFromCli(artifactPath);
}

async function readMetadataFromCli(artifactPath: string): Promise<CliArtifactMetadata> {
  return await new Promise<CliArtifactMetadata>((resolve, reject) => {
    const child = spawn(artifactPath, ['__mcporter_inspect'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data) => {
      stdout += String(data);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (data) => {
      stderr += String(data);
    });
    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `Failed to inspect CLI artifact at ${artifactPath}${
              stderr ? `: ${stderr.trim()}` : ''
            } (exit code ${code ?? -1})`
          )
        );
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as CliArtifactMetadata;
        resolve(parsed);
      } catch (error) {
        reject(
          new Error(
            `Unable to parse embedded metadata from ${artifactPath}: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        );
      }
    });
  });
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === code);
}

// serializeDefinition converts an in-memory server definition into the metadata-friendly JSON form.
export function serializeDefinition(definition: ServerDefinition): SerializedServerDefinition {
  if (definition.command.kind === 'http') {
    return {
      name: definition.name,
      description: definition.description,
      command: {
        kind: 'http',
        url: definition.command.url.toString(),
        headers: definition.command.headers,
      },
      env: definition.env,
      auth: definition.auth,
      tokenCacheDir: definition.tokenCacheDir,
      clientName: definition.clientName,
      oauthRedirectUrl: definition.oauthRedirectUrl,
    };
  }
  return {
    name: definition.name,
    description: definition.description,
    command: {
      kind: 'stdio',
      command: definition.command.command,
      args: [...definition.command.args],
      cwd: definition.command.cwd,
    },
    env: definition.env,
    auth: definition.auth,
    tokenCacheDir: definition.tokenCacheDir,
    clientName: definition.clientName,
    oauthRedirectUrl: definition.oauthRedirectUrl,
  };
}

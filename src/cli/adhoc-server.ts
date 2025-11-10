import fs from 'node:fs/promises';
import path from 'node:path';
import type { CommandSpec, ServerDefinition } from '../config.js';
import { __configInternals } from '../config.js';
import { expandHome } from '../env.js';
import { canonicalKeepAliveName, resolveLifecycle } from '../lifecycle.js';

export interface EphemeralServerSpec {
  name?: string;
  httpUrl?: string;
  allowInsecureHttp?: boolean;
  stdioCommand?: string;
  stdioArgs?: string[];
  cwd?: string;
  env?: Record<string, string>;
  description?: string;
  persistPath?: string;
}

export interface EphemeralServerResolution {
  definition: ServerDefinition;
  name: string;
  persistedEntry: Record<string, unknown>;
}

const TEMP_SOURCE = { kind: 'local', path: '<adhoc>' } as const;

export function resolveEphemeralServer(spec: EphemeralServerSpec): EphemeralServerResolution {
  if (!spec.httpUrl && !spec.stdioCommand) {
    throw new Error('Ad-hoc servers require either --http-url or --stdio.');
  }
  if (spec.httpUrl && spec.stdioCommand) {
    throw new Error('Cannot combine --http-url and --stdio in the same ad-hoc server.');
  }

  if (spec.httpUrl) {
    const url = new URL(spec.httpUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error(`Unsupported protocol '${url.protocol}' for --http-url.`);
    }
    if (url.protocol === 'http:' && !spec.allowInsecureHttp) {
      throw new Error('HTTP endpoints require --allow-http to confirm insecure usage.');
    }
    const command: CommandSpec = {
      kind: 'http',
      url,
      headers: __configInternals.ensureHttpAcceptHeader(undefined),
    };
    const canonical = spec.name ? undefined : canonicalKeepAliveName(command);
    const name = slugify(spec.name ?? canonical ?? inferNameFromUrl(url));
    const lifecycle = resolveLifecycle(name, undefined, command);
    const definition: ServerDefinition = {
      name,
      description: spec.description,
      command,
      env: spec.env && Object.keys(spec.env).length > 0 ? spec.env : undefined,
      source: TEMP_SOURCE,
      lifecycle,
    };
    const persistedEntry: Record<string, unknown> = {
      baseUrl: url.href,
      ...(spec.description ? { description: spec.description } : {}),
      ...(spec.env && Object.keys(spec.env).length > 0 ? { env: spec.env } : {}),
      ...(lifecycle ? { lifecycle: serializeLifecycle(lifecycle) } : {}),
    };
    return { definition, name, persistedEntry };
  }

  const stdioCommand = spec.stdioCommand as string;
  const parts = splitCommandLine(stdioCommand);
  if (parts.length === 0) {
    throw new Error('--stdio requires a non-empty command.');
  }
  const [commandBinary, ...commandRest] = parts as [string, ...string[]];
  const commandArgs = commandRest.concat(spec.stdioArgs ?? []);
  const cwd = spec.cwd ? path.resolve(spec.cwd) : process.cwd();
  const command: CommandSpec = {
    kind: 'stdio',
    command: commandBinary,
    args: commandArgs,
    cwd,
  };
  const canonical = spec.name ? undefined : canonicalKeepAliveName(command);
  const name = slugify(spec.name ?? canonical ?? inferNameFromCommand(parts));
  const lifecycle = resolveLifecycle(name, undefined, command);
  const definition: ServerDefinition = {
    name,
    description: spec.description,
    command,
    env: spec.env && Object.keys(spec.env).length > 0 ? spec.env : undefined,
    source: TEMP_SOURCE,
    lifecycle,
  };
  const persistedEntry: Record<string, unknown> = {
    command: commandBinary,
    ...(commandArgs.length > 0 ? { args: commandArgs } : {}),
    ...(spec.description ? { description: spec.description } : {}),
    ...(spec.env && Object.keys(spec.env).length > 0 ? { env: spec.env } : {}),
    ...(lifecycle ? { lifecycle: serializeLifecycle(lifecycle) } : {}),
  };
  if (spec.cwd) {
    persistedEntry.cwd = spec.cwd;
  }
  return { definition, name, persistedEntry };
}

export async function persistEphemeralServer(resolution: EphemeralServerResolution, rawPath: string): Promise<void> {
  const resolvedPath = path.resolve(expandHome(rawPath));
  let existing: Record<string, unknown>;
  try {
    const buffer = await fs.readFile(resolvedPath, 'utf8');
    existing = JSON.parse(buffer) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    existing = { mcpServers: {} };
  }

  if (typeof existing.mcpServers !== 'object' || existing.mcpServers === null) {
    existing.mcpServers = {};
  }
  const servers = existing.mcpServers as Record<string, unknown>;
  servers[resolution.name] = resolution.persistedEntry;

  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  const serialized = `${JSON.stringify(existing, null, 2)}\n`;
  await fs.writeFile(resolvedPath, serialized, 'utf8');
}

function inferNameFromUrl(url: URL): string {
  const host = url.hostname.replace(/^www\./, '');
  const pathSegments = url.pathname.split('/').filter(Boolean);
  if (pathSegments.length === 0) {
    return host;
  }
  return `${host}-${pathSegments[pathSegments.length - 1]}`;
}

function inferNameFromCommand(parts: string[]): string {
  const executable = path.basename(parts[0] ?? 'command');
  if (parts.length === 1) {
    return executable;
  }
  const script = parts.find((segment) => segment.endsWith('.ts') || segment.endsWith('.js'));
  if (script) {
    return `${executable}-${path.basename(script, path.extname(script))}`;
  }
  const fallback = parts[1] ?? 'tool';
  return `${executable}-${fallback}`;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

export function splitCommandLine(input: string): string[] {
  const result: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input.charAt(i);
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && /\s/.test(char)) {
      if (current !== '') {
        result.push(current);
        current = '';
      }
      continue;
    }
    if (char === '\\' && !inSingle && i + 1 < input.length) {
      const next = input.charAt(i + 1);
      if (inDouble && next !== '"' && next !== '\\' && next !== '$') {
        current += char;
        continue;
      }
      current += next;
      i += 1;
      continue;
    }
    current += char;
  }

  if (inSingle || inDouble) {
    throw new Error('Unterminated quote in --stdio command.');
  }
  if (current !== '') {
    result.push(current);
  }
  return result;
}

function serializeLifecycle(
  lifecycle: ReturnType<typeof resolveLifecycle>
): string | { mode: 'keep-alive'; idleTimeoutMs?: number } | undefined {
  if (!lifecycle) {
    return undefined;
  }
  if (lifecycle.mode === 'keep-alive' && lifecycle.idleTimeoutMs === undefined) {
    return 'keep-alive';
  }
  if (lifecycle.mode === 'keep-alive') {
    return { mode: 'keep-alive', idleTimeoutMs: lifecycle.idleTimeoutMs };
  }
  return 'ephemeral';
}

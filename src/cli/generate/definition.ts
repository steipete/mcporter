import fs from 'node:fs/promises';
import path from 'node:path';
import type { CliArtifactMetadata } from '../../cli-metadata.js';
import { type HttpCommand, loadServerDefinitions, type ServerDefinition, type StdioCommand } from '../../config.js';
import type { ServerToolInfo } from '../../runtime.js';
import { createRuntime } from '../../runtime.js';

export interface ResolvedServer {
  definition: ServerDefinition;
  name: string;
}

type DefinitionInput =
  | ServerDefinition
  | (Record<string, unknown> & {
      name: string;
      command?: unknown;
      args?: unknown;
    });

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function ensureInvocationDefaults(
  invocation: CliArtifactMetadata['invocation'],
  definition: ServerDefinition
): CliArtifactMetadata['invocation'] {
  const serverRef = invocation.serverRef ?? definition.name;
  const configPath =
    invocation.configPath ??
    (definition.source && definition.source.kind === 'local' ? definition.source.path : undefined);
  return {
    ...invocation,
    serverRef,
    configPath,
  };
}

export async function resolveServerDefinition(
  serverRef: string,
  configPath?: string,
  rootDir?: string
): Promise<ResolvedServer> {
  const trimmed = serverRef.trim();

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const parsed = JSON.parse(trimmed) as ServerDefinition & { name: string };
    if (!parsed.name) {
      throw new Error("Inline server definition must include a 'name' field.");
    }
    return { definition: normalizeDefinition(parsed), name: parsed.name };
  }

  const possiblePath = path.resolve(trimmed);
  try {
    const buffer = await fs.readFile(possiblePath, 'utf8');
    const parsed = JSON.parse(buffer) as {
      mcpServers?: Record<string, unknown>;
    };
    if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object') {
      throw new Error(`Config file ${possiblePath} does not contain mcpServers.`);
    }
    const entries = Object.entries(parsed.mcpServers);
    if (entries.length === 0) {
      throw new Error(`Config file ${possiblePath} does not define any servers.`);
    }
    const first = entries[0];
    if (!first) {
      throw new Error(`Config file ${possiblePath} does not define any servers.`);
    }
    const [name, value] = first;
    return {
      definition: normalizeDefinition({
        name,
        ...(value as Record<string, unknown>),
      }),
      name,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  const definitions = await loadServerDefinitions({
    configPath,
    rootDir,
  });
  const match = definitions.find((def) => def.name === trimmed);
  if (!match) {
    throw new Error(`Unknown MCP server '${trimmed}'. Provide a name from config, a JSON file, or inline JSON.`);
  }
  return { definition: match, name: match.name };
}

export async function fetchTools(
  definition: ServerDefinition,
  serverName: string,
  configPath?: string,
  rootDir?: string
): Promise<ServerToolInfo[]> {
  const runtime = await createRuntime({
    configPath,
    rootDir,
    servers: configPath ? undefined : [definition],
  });
  try {
    return await runtime.listTools(serverName, { includeSchema: true });
  } finally {
    await runtime.close(serverName).catch(() => {});
  }
}

export function normalizeDefinition(def: DefinitionInput): ServerDefinition {
  if (isServerDefinition(def)) {
    return def;
  }

  const name = def.name;
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('Server definition must include a name.');
  }

  const description = typeof def.description === 'string' ? def.description : undefined;
  const env = toStringRecord(def.env);
  const auth = typeof def.auth === 'string' ? def.auth : undefined;
  const tokenCacheDir = typeof def.tokenCacheDir === 'string' ? def.tokenCacheDir : undefined;
  const clientName = typeof def.clientName === 'string' ? def.clientName : undefined;
  const headers = toStringRecord((def as Record<string, unknown>).headers);

  const commandValue = def.command;
  if (isCommandSpec(commandValue)) {
    return {
      name,
      description,
      command: normalizeCommand(commandValue, headers),
      env,
      auth,
      tokenCacheDir,
      clientName,
    };
  }
  if (typeof commandValue === 'string' && commandValue.trim().length > 0) {
    return {
      name,
      description,
      command: toCommandSpec(commandValue, getStringArray(def.args), headers ? { headers } : undefined),
      env,
      auth,
      tokenCacheDir,
      clientName,
    };
  }
  if (Array.isArray(commandValue) && commandValue.length > 0) {
    const [first, ...rest] = commandValue;
    if (typeof first !== 'string' || !rest.every((entry) => typeof entry === 'string')) {
      throw new Error('Command array must contain only strings.');
    }
    return {
      name,
      description,
      command: toCommandSpec(first, rest as string[], headers ? { headers } : undefined),
      env,
      auth,
      tokenCacheDir,
      clientName,
    };
  }
  throw new Error('Server definition must include command information.');
}

function isServerDefinition(value: unknown): value is ServerDefinition {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.name !== 'string') {
    return false;
  }
  return isCommandSpec(record.command);
}

function isCommandSpec(value: unknown): value is ServerDefinition['command'] {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { kind?: unknown };
  if (candidate.kind === 'http') {
    return 'url' in candidate;
  }
  if (candidate.kind === 'stdio') {
    return 'command' in candidate;
  }
  return false;
}

function normalizeCommand(
  command: ServerDefinition['command'],
  headers?: Record<string, string>
): ServerDefinition['command'] {
  if (command.kind === 'http') {
    const urlValue = command.url;
    const url = urlValue instanceof URL ? urlValue : new URL(String(urlValue));
    const mergedHeaders = command.headers ? (headers ? { ...command.headers, ...headers } : command.headers) : headers;
    const normalized: HttpCommand = {
      kind: 'http',
      url,
      ...(mergedHeaders ? { headers: mergedHeaders } : {}),
    };
    return normalized;
  }
  return {
    kind: 'stdio',
    command: command.command,
    args: [...command.args],
    cwd: command.cwd ?? process.cwd(),
  };
}

function toCommandSpec(
  command: string,
  args?: string[],
  extra?: { headers?: Record<string, string> }
): ServerDefinition['command'] {
  if (command.startsWith('http://') || command.startsWith('https://')) {
    const httpCommand: HttpCommand = {
      kind: 'http',
      url: new URL(command),
      ...(extra?.headers ? { headers: extra.headers } : {}),
    };
    return httpCommand;
  }
  const stdio: StdioCommand = {
    kind: 'stdio',
    command,
    args: args ?? [],
    cwd: process.cwd(),
  };
  return stdio;
}

function getStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries = value.filter((item): item is string => typeof item === 'string');
  return entries.length > 0 ? entries : undefined;
}

function toStringRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      result[key] = entry;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

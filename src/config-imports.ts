import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseToml } from '@iarna/toml';
import type { ImportKind, RawEntry } from './config-schema.js';
import { RawEntrySchema } from './config-schema.js';

export function pathsForImport(kind: ImportKind, rootDir: string): string[] {
  switch (kind) {
    case 'cursor':
      return [path.resolve(rootDir, '.cursor', 'mcp.json'), defaultCursorUserConfigPath()];
    case 'claude-code':
      return [
        path.resolve(rootDir, '.claude', 'mcp.json'),
        path.join(os.homedir(), '.claude', 'mcp.json'),
        path.join(os.homedir(), '.claude.json'),
      ];
    case 'claude-desktop':
      return [defaultClaudeDesktopConfigPath()];
    case 'codex':
      return [path.resolve(rootDir, '.codex', 'config.toml'), path.join(os.homedir(), '.codex', 'config.toml')];
    case 'windsurf':
      return [defaultWindsurfConfigPath()];
    case 'vscode':
      return defaultVscodeConfigPaths();
    default:
      return [];
  }
}

export async function readExternalEntries(filePath: string): Promise<Map<string, RawEntry> | null> {
  if (!(await fileExists(filePath))) {
    return null;
  }

  if (filePath.endsWith('.toml')) {
    const buffer = await fs.readFile(filePath, 'utf8');
    const parsed = parseToml(buffer) as Record<string, unknown>;
    return extractFromCodexConfig(parsed);
  }

  const buffer = await fs.readFile(filePath, 'utf8');
  const parsed = JSON.parse(buffer) as unknown;
  return extractFromMcpJson(parsed);
}

export function toFileUrl(filePath: string): URL {
  return pathToFileURL(filePath);
}

function extractFromMcpJson(raw: unknown): Map<string, RawEntry> {
  const map = new Map<string, RawEntry>();
  if (!raw || typeof raw !== 'object') {
    return map;
  }

  const container = (() => {
    if ('mcpServers' in raw && raw.mcpServers && typeof raw.mcpServers === 'object') {
      return raw.mcpServers as Record<string, unknown>;
    }
    if ('servers' in raw && raw.servers && typeof raw.servers === 'object') {
      return raw.servers as Record<string, unknown>;
    }
    return raw as Record<string, unknown>;
  })();

  for (const [name, value] of Object.entries(container)) {
    if (!value || typeof value !== 'object') {
      continue;
    }
    const entry = convertExternalEntry(value as Record<string, unknown>);
    if (entry) {
      map.set(name, entry);
    }
  }

  return map;
}

function extractFromCodexConfig(raw: Record<string, unknown>): Map<string, RawEntry> {
  const map = new Map<string, RawEntry>();
  const serversRaw = raw.mcp_servers;
  if (!serversRaw || typeof serversRaw !== 'object') {
    return map;
  }

  for (const [name, value] of Object.entries(serversRaw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') {
      continue;
    }
    const entry = convertExternalEntry(value as Record<string, unknown>);
    if (entry) {
      map.set(name, entry);
    }
  }

  return map;
}

function convertExternalEntry(value: Record<string, unknown>): RawEntry | null {
  const result: Record<string, unknown> = {};

  if (typeof value.description === 'string') {
    result.description = value.description;
  }

  const env = asStringRecord(value.env);
  if (env) {
    result.env = env;
  }

  const headers = buildExternalHeaders(value);
  if (headers) {
    result.headers = headers;
  }

  const auth = asString(value.auth);
  if (auth) {
    result.auth = auth;
  }

  const tokenCacheDir = asString(value.tokenCacheDir ?? value.token_cache_dir ?? value.token_cacheDir);
  if (tokenCacheDir) {
    result.tokenCacheDir = tokenCacheDir;
  }

  const clientName = asString(value.clientName ?? value.client_name);
  if (clientName) {
    result.clientName = clientName;
  }

  const url = asString(value.baseUrl ?? value.base_url ?? value.url ?? value.serverUrl ?? value.server_url);
  if (url) {
    result.baseUrl = url;
  }

  const commandValue = value.command ?? value.executable;
  if (Array.isArray(commandValue) && commandValue.every((item) => typeof item === 'string')) {
    result.command = commandValue;
  } else if (typeof commandValue === 'string') {
    result.command = commandValue;
  }

  if (Array.isArray(value.args) && value.args.every((item) => typeof item === 'string')) {
    result.args = value.args;
  }

  const parsed = RawEntrySchema.safeParse(result);
  return parsed.success ? parsed.data : null;
}

function buildExternalHeaders(record: Record<string, unknown>): Record<string, string> | undefined {
  const headers: Record<string, string> = {};

  const literalHeaders = asStringRecord(record.headers);
  if (literalHeaders) {
    Object.assign(headers, literalHeaders);
  }

  const bearerToken = asString(record.bearerToken ?? record.bearer_token);
  if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }

  const bearerTokenEnv = asString(record.bearerTokenEnv ?? record.bearer_token_env);
  if (bearerTokenEnv) {
    headers.Authorization = `$env:${bearerTokenEnv}`;
  }

  return Object.keys(headers).length > 0 ? headers : undefined;
}

function defaultCursorUserConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) {
    return path.join(xdg, 'Cursor', 'mcp.json');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Cursor', 'User', 'mcp.json');
  }
  return path.join(os.homedir(), '.config', 'Cursor', 'User', 'mcp.json');
}

function defaultClaudeDesktopConfigPath(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Claude', 'claude_desktop_config.json');
  }
  return path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}

function defaultWindsurfConfigPath(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Codeium', 'windsurf', 'mcp_config.json');
  }
  return path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json');
}

function defaultVscodeConfigPaths(): string[] {
  if (process.platform === 'darwin') {
    return [
      path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'mcp.json'),
      path.join(os.homedir(), 'Library', 'Application Support', 'Code - Insiders', 'User', 'mcp.json'),
    ];
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return [path.join(appData, 'Code', 'User', 'mcp.json'), path.join(appData, 'Code - Insiders', 'User', 'mcp.json')];
  }
  return [
    path.join(os.homedir(), '.config', 'Code', 'User', 'mcp.json'),
    path.join(os.homedir(), '.config', 'Code - Insiders', 'User', 'mcp.json'),
  ];
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asStringRecord(input: unknown): Record<string, string> | undefined {
  if (!input || typeof input !== 'object') {
    return undefined;
  }
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === 'string') {
      record[key] = value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      record[key] = String(value);
    }
  }
  return Object.keys(record).length > 0 ? record : undefined;
}

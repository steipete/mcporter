import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseToml } from '@iarna/toml';
import { z } from 'zod';
import { expandHome } from './env.js';

const ImportKindSchema = z.enum(['cursor', 'claude-code', 'claude-desktop', 'codex', 'windsurf', 'vscode']);

const DEFAULT_IMPORTS: ImportKind[] = ['cursor', 'claude-code', 'claude-desktop', 'codex', 'windsurf', 'vscode'];

const RawEntrySchema = z.object({
  description: z.string().optional(),
  baseUrl: z.string().optional(),
  base_url: z.string().optional(),
  url: z.string().optional(),
  serverUrl: z.string().optional(),
  server_url: z.string().optional(),
  command: z.union([z.string(), z.array(z.string())]).optional(),
  executable: z.string().optional(),
  args: z.array(z.string()).optional(),
  headers: z.record(z.string()).optional(),
  env: z.record(z.string()).optional(),
  auth: z.string().optional(),
  tokenCacheDir: z.string().optional(),
  token_cache_dir: z.string().optional(),
  clientName: z.string().optional(),
  client_name: z.string().optional(),
  oauthRedirectUrl: z.string().optional(),
  oauth_redirect_url: z.string().optional(),
  bearerToken: z.string().optional(),
  bearer_token: z.string().optional(),
  bearerTokenEnv: z.string().optional(),
  bearer_token_env: z.string().optional(),
});

const RawConfigSchema = z.object({
  mcpServers: z.record(RawEntrySchema),
  imports: z.array(ImportKindSchema).optional(),
});

export interface HttpCommand {
  readonly kind: 'http';
  readonly url: URL;
  readonly headers?: Record<string, string>;
}

export interface StdioCommand {
  readonly kind: 'stdio';
  readonly command: string;
  readonly args: string[];
  readonly cwd: string;
}

export type CommandSpec = HttpCommand | StdioCommand;

export interface ServerSource {
  readonly kind: 'local' | 'import';
  readonly path: string;
}

export interface ServerDefinition {
  readonly name: string;
  readonly description?: string;
  readonly command: CommandSpec;
  readonly env?: Record<string, string>;
  readonly auth?: string;
  readonly tokenCacheDir?: string;
  readonly clientName?: string;
  readonly oauthRedirectUrl?: string;
  readonly source?: ServerSource;
}

export interface LoadConfigOptions {
  readonly configPath?: string;
  readonly rootDir?: string;
}

// loadServerDefinitions reads mcporter configs (and imports) into normalized server definitions.
export async function loadServerDefinitions(options: LoadConfigOptions = {}): Promise<ServerDefinition[]> {
  const rootDir = options.rootDir ?? process.cwd();
  const configPath = resolveConfigPath(options.configPath, rootDir);
  const config = await readConfigFile(configPath);

  const merged = new Map<string, { raw: RawEntry; baseDir: string; source: ServerSource }>();

  const configuredImports = config.imports;
  const imports = configuredImports
    ? configuredImports.length === 0
      ? configuredImports
      : [...configuredImports, ...DEFAULT_IMPORTS.filter((kind) => !configuredImports.includes(kind))]
    : DEFAULT_IMPORTS;
  for (const importKind of imports) {
    const candidates = pathsForImport(importKind, rootDir);
    for (const candidate of candidates) {
      const resolved = expandHome(candidate);
      const entries = await readExternalEntries(resolved);
      if (!entries) {
        continue;
      }
      for (const [name, rawEntry] of entries) {
        if (merged.has(name)) {
          continue;
        }
        merged.set(name, {
          raw: rawEntry,
          baseDir: path.dirname(resolved),
          source: { kind: 'import', path: resolved },
        });
      }
    }
  }

  for (const [name, entryRaw] of Object.entries(config.mcpServers)) {
    const parsed = RawEntrySchema.parse(entryRaw);
    merged.set(name, {
      raw: parsed,
      baseDir: rootDir,
      source: { kind: 'local', path: configPath },
    });
  }

  const servers: ServerDefinition[] = [];
  for (const [name, { raw, baseDir: entryBaseDir, source }] of merged) {
    servers.push(normalizeServerEntry(name, raw, entryBaseDir, source));
  }

  return servers;
}

type ImportKind = z.infer<typeof ImportKindSchema>;
type RawEntry = z.infer<typeof RawEntrySchema>;
type RawConfig = z.infer<typeof RawConfigSchema>;

type RawEntryMap = Map<string, RawEntry>;

// resolveConfigPath determines the effective config file path based on overrides and root directory.
function resolveConfigPath(configPath: string | undefined, rootDir: string): string {
  if (configPath) {
    return path.resolve(configPath);
  }
  return path.resolve(rootDir, 'config', 'mcporter.json');
}

// readConfigFile loads and validates the primary mcporter.json contents.
async function readConfigFile(configPath: string): Promise<RawConfig> {
  const buffer = await fs.readFile(configPath, 'utf8');
  return RawConfigSchema.parse(JSON.parse(buffer));
}

// normalizeServerEntry merges a raw config entry into a runtime-ready server definition.
function normalizeServerEntry(name: string, raw: RawEntry, baseDir: string, source: ServerSource): ServerDefinition {
  const description = raw.description;
  const env = raw.env ? { ...raw.env } : undefined;
  const auth = normalizeAuth(raw.auth);
  const tokenCacheDir = normalizePath(raw.tokenCacheDir ?? raw.token_cache_dir);
  const clientName = raw.clientName ?? raw.client_name;
  const oauthRedirectUrl = raw.oauthRedirectUrl ?? raw.oauth_redirect_url ?? undefined;
  const headers = buildHeaders(raw);

  const httpUrl = getUrl(raw);
  const stdio = getCommand(raw);

  let command: CommandSpec;

  if (httpUrl) {
    command = {
      kind: 'http',
      url: new URL(httpUrl),
      headers,
    };
  } else if (stdio) {
    command = {
      kind: 'stdio',
      command: stdio.command,
      args: stdio.args,
      cwd: baseDir,
    };
  } else {
    throw new Error(`Server '${name}' is missing a baseUrl/url or command definition in mcporter.json`);
  }

  const resolvedTokenCacheDir =
    auth === 'oauth' ? (tokenCacheDir ?? path.join(os.homedir(), '.mcporter', name)) : (tokenCacheDir ?? undefined);

  return {
    name,
    description,
    command,
    env,
    auth,
    tokenCacheDir: resolvedTokenCacheDir,
    clientName,
    oauthRedirectUrl,
    source,
  };
}

// normalizeAuth filters auth values down to the supported keywords.
function normalizeAuth(auth: string | undefined): string | undefined {
  if (!auth) {
    return undefined;
  }
  if (auth.toLowerCase() === 'oauth') {
    return 'oauth';
  }
  return undefined;
}

// normalizePath expands home-dir tokens for filesystem paths when present.
function normalizePath(input: string | undefined): string | undefined {
  if (!input) {
    return undefined;
  }
  return expandHome(input);
}

// getUrl chooses the HTTP endpoint value from the various accepted config keys.
function getUrl(raw: RawEntry): string | undefined {
  return raw.baseUrl ?? raw.base_url ?? raw.url ?? raw.serverUrl ?? raw.server_url ?? undefined;
}

// getCommand resolves stdio command invocations from string or array shapes.
function getCommand(raw: RawEntry): { command: string; args: string[] } | undefined {
  const commandValue = raw.command ?? raw.executable;
  if (Array.isArray(commandValue)) {
    if (commandValue.length === 0 || typeof commandValue[0] !== 'string') {
      return undefined;
    }
    return { command: commandValue[0], args: commandValue.slice(1) };
  }
  if (typeof commandValue === 'string' && commandValue.length > 0) {
    const args = Array.isArray(raw.args) ? raw.args : [];
    if (args.length > 0) {
      return { command: commandValue, args };
    }
    const tokens = parseCommandString(commandValue);
    if (tokens.length === 0) {
      return undefined;
    }
    const [commandToken, ...rest] = tokens;
    if (!commandToken) {
      return undefined;
    }
    return { command: commandToken, args: rest };
  }
  return undefined;
}

// buildHeaders materializes header values (including bearer tokens) for a raw entry.
function buildHeaders(raw: RawEntry): Record<string, string> | undefined {
  const headers: Record<string, string> = {};

  if (raw.headers) {
    Object.assign(headers, raw.headers);
  }

  const bearerToken = raw.bearerToken ?? raw.bearer_token;
  if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }

  const bearerTokenEnv = raw.bearerTokenEnv ?? raw.bearer_token_env;
  if (bearerTokenEnv) {
    headers.Authorization = `$env:${bearerTokenEnv}`;
  }

  return Object.keys(headers).length > 0 ? headers : undefined;
}

// readExternalEntries parses imported config files (JSON or TOML) into raw entry maps.
async function readExternalEntries(filePath: string): Promise<RawEntryMap | null> {
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

// extractFromMcpJson pulls cursor-style MCP entries into a normalized map.
function extractFromMcpJson(raw: unknown): RawEntryMap {
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

// extractFromCodexConfig converts Codex TOML structures into the shared raw entry shape.
function extractFromCodexConfig(raw: Record<string, unknown>): RawEntryMap {
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

// convertExternalEntry rewrites external config objects into the internal RawEntry representation.
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

// buildExternalHeaders collects literal or bearer headers from imported config definitions.
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

// pathsForImport returns the set of candidate files to read for a given import kind.
function pathsForImport(kind: ImportKind, rootDir: string): string[] {
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
      return [path.join(os.homedir(), '.codex', 'config.toml')];
    case 'windsurf':
      return [defaultWindsurfConfigPath()];
    case 'vscode':
      return [path.resolve(rootDir, '.vscode', 'mcp.json'), ...defaultVscodeConfigPaths()];
    default:
      return [];
  }
}

// defaultCursorUserConfigPath provides the OS-specific Cursor config location.
function defaultCursorUserConfigPath(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), '.cursor', 'mcp.json');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Cursor', 'mcp.json');
  }
  return path.join(os.homedir(), '.config', 'Cursor', 'mcp.json');
}

// defaultClaudeDesktopConfigPath returns the platform-specific Claude desktop config path.
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

// defaultWindsurfConfigPath returns the platform-specific Windsurf MCP config path.
function defaultWindsurfConfigPath(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Codeium', 'windsurf', 'mcp_config.json');
  }
  return path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json');
}

// defaultVscodeConfigPaths returns potential VS Code MCP config paths across platforms.
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

// fileExists checks for file presence with graceful failure handling.
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// asString extracts a non-empty string value from an arbitrary input.
function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// asStringRecord coerces object entries into a string-to-string record.
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

// toFileUrl converts a filesystem path into a file:// URL.
export function toFileUrl(filePath: string): URL {
  return pathToFileURL(filePath);
}

// parseCommandString tokenizes a shell-style command string into argv entries.
function parseCommandString(value: string): string[] {
  const result: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escapeNext = false;

  for (const char of value.trim()) {
    if (escapeNext) {
      current += char;
      escapeNext = false;
      continue;
    }

    if (char === '\\') {
      escapeNext = true;
      continue;
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (char === ' ' && !inSingleQuote && !inDoubleQuote) {
      if (current.length > 0) {
        result.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (escapeNext) {
    current += '\\';
  }

  if (current.length > 0) {
    result.push(current);
  }

  return result;
}

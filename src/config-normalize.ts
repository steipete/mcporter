import os from 'node:os';
import path from 'node:path';
import type { CommandSpec, RawEntry, ServerDefinition, ServerLoggingOptions, ServerSource } from './config-schema.js';
import { expandHome } from './env.js';
import { resolveLifecycle } from './lifecycle.js';

export function normalizeServerEntry(
  name: string,
  raw: RawEntry,
  baseDir: string,
  source: ServerSource,
  sources: readonly ServerSource[]
): ServerDefinition {
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
      headers: ensureHttpAcceptHeader(headers),
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

  const lifecycle = resolveLifecycle(name, raw.lifecycle, command);
  const logging = normalizeLogging(raw.logging);
  const resultMapping = raw.resultMapping;

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
    sources,
    lifecycle,
    logging,
    resultMapping,
  };
}

export const __configInternals = {
  ensureHttpAcceptHeader,
};

function normalizeAuth(auth: string | undefined): string | undefined {
  if (!auth) {
    return undefined;
  }
  if (auth.toLowerCase() === 'oauth') {
    return 'oauth';
  }
  return undefined;
}

function normalizePath(input: string | undefined): string | undefined {
  if (!input) {
    return undefined;
  }
  return expandHome(input);
}

function getUrl(raw: RawEntry): string | undefined {
  return raw.baseUrl ?? raw.base_url ?? raw.url ?? raw.serverUrl ?? raw.server_url ?? undefined;
}

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

function ensureHttpAcceptHeader(headers?: Record<string, string>): Record<string, string> | undefined {
  const requiredAccept = 'application/json, text/event-stream';
  const normalized = headers ? { ...headers } : {};
  const acceptKey = Object.keys(normalized).find((key) => key.toLowerCase() === 'accept');
  const currentValue = acceptKey ? normalized[acceptKey] : undefined;
  if (!currentValue || !hasRequiredAcceptTokens(currentValue)) {
    normalized[acceptKey ?? 'accept'] = requiredAccept;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function hasRequiredAcceptTokens(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.includes('application/json') && lower.includes('text/event-stream');
}

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

export { ensureHttpAcceptHeader };

function normalizeLogging(raw?: { daemon?: { enabled?: boolean } }): ServerLoggingOptions | undefined {
  if (!raw) {
    return undefined;
  }
  if (raw.daemon) {
    const logging: ServerLoggingOptions = { daemon: { enabled: raw.daemon.enabled } };
    return logging;
  }
  return undefined;
}

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolRequest, ListResourcesRequest } from '@modelcontextprotocol/sdk/types.js';
import { loadServerDefinitions, type ServerDefinition } from './config.js';
import { resolveEnvValue, withEnvOverrides } from './env.js';
import { createPrefixedConsoleLogger, type Logger, type LogLevel, resolveLogLevelFromEnv } from './logging.js';
import { createOAuthSession, type OAuthSession } from './oauth.js';
import { materializeHeaders } from './runtime-header-utils.js';
import { isUnauthorizedError, maybeEnableOAuth } from './runtime-oauth-support.js';
import { closeTransportAndWait } from './runtime-process-utils.js';
import './sdk-patches.js';

const PACKAGE_NAME = 'mcporter';
const CLIENT_VERSION = '0.5.4';
const DEFAULT_OAUTH_CODE_TIMEOUT_MS = 60_000;
const OAUTH_CODE_TIMEOUT_MS = parseOAuthTimeout(
  process.env.MCPORTER_OAUTH_TIMEOUT_MS ?? process.env.MCPORTER_OAUTH_TIMEOUT
);
export const MCPORTER_VERSION = CLIENT_VERSION;

function parseOAuthTimeout(raw: string | undefined): number {
  if (!raw) {
    return DEFAULT_OAUTH_CODE_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_OAUTH_CODE_TIMEOUT_MS;
  }
  return parsed;
}

export interface RuntimeOptions {
  readonly configPath?: string;
  readonly servers?: ServerDefinition[];
  readonly rootDir?: string;
  readonly clientInfo?: {
    name: string;
    version: string;
  };
  readonly logger?: RuntimeLogger;
  readonly oauthTimeoutMs?: number;
}

export type RuntimeLogger = Logger;

export interface CallOptions {
  readonly args?: CallToolRequest['params']['arguments'];
  readonly timeoutMs?: number;
}

export interface ListToolsOptions {
  readonly includeSchema?: boolean;
  readonly autoAuthorize?: boolean;
}

interface ConnectOptions {
  readonly maxOAuthAttempts?: number;
  readonly skipCache?: boolean;
}

export interface Runtime {
  listServers(): string[];
  getDefinitions(): ServerDefinition[];
  getDefinition(server: string): ServerDefinition;
  registerDefinition(definition: ServerDefinition, options?: { overwrite?: boolean }): void;
  listTools(server: string, options?: ListToolsOptions): Promise<ServerToolInfo[]>;
  callTool(server: string, toolName: string, options?: CallOptions): Promise<unknown>;
  listResources(server: string, options?: Partial<ListResourcesRequest['params']>): Promise<unknown>;
  connect(server: string): Promise<ClientContext>;
  close(server?: string): Promise<void>;
}

export interface ServerToolInfo {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
}

interface ClientContext {
  readonly client: Client;
  readonly transport: Transport & { close(): Promise<void> };
  readonly definition: ServerDefinition;
  readonly oauthSession?: OAuthSession;
}

// createRuntime spins up a pooled MCP runtime from config JSON or provided definitions.
export async function createRuntime(options: RuntimeOptions = {}): Promise<Runtime> {
  // Build the runtime with either the provided server list or the config file contents.
  const servers =
    options.servers ??
    (await loadServerDefinitions({
      configPath: options.configPath,
      rootDir: options.rootDir,
    }));

  const runtime = new McpRuntime(servers, options);
  return runtime;
}

// callOnce connects to a server, invokes a single tool, and disposes the connection immediately.
export async function callOnce(params: {
  server: string;
  toolName: string;
  args?: Record<string, unknown>;
  configPath?: string;
}): Promise<unknown> {
  const runtime = await createRuntime({ configPath: params.configPath });
  try {
    return await runtime.callTool(params.server, params.toolName, {
      args: params.args,
    });
  } finally {
    await runtime.close(params.server);
  }
}

class McpRuntime implements Runtime {
  private readonly definitions: Map<string, ServerDefinition>;
  private readonly clients = new Map<string, Promise<ClientContext>>();
  private readonly logger: RuntimeLogger;
  private readonly clientInfo: { name: string; version: string };
  private readonly oauthTimeoutMs?: number;

  constructor(servers: ServerDefinition[], options: RuntimeOptions = {}) {
    this.definitions = new Map(servers.map((entry) => [entry.name, entry]));
    this.logger = options.logger ?? createConsoleLogger();
    this.clientInfo = options.clientInfo ?? {
      name: PACKAGE_NAME,
      version: CLIENT_VERSION,
    };
    this.oauthTimeoutMs = options.oauthTimeoutMs;
  }

  // listServers returns configured names sorted alphabetically for stable CLI output.
  listServers(): string[] {
    return [...this.definitions.keys()].sort((a, b) => a.localeCompare(b));
  }

  // getDefinitions exposes raw server metadata to consumers such as the CLI.
  getDefinitions(): ServerDefinition[] {
    return [...this.definitions.values()];
  }

  // getDefinition throws when the caller requests an unknown server name.
  getDefinition(server: string): ServerDefinition {
    const definition = this.definitions.get(server);
    if (!definition) {
      throw new Error(`Unknown MCP server '${server}'.`);
    }
    return definition;
  }

  registerDefinition(definition: ServerDefinition, options: { overwrite?: boolean } = {}): void {
    if (!options.overwrite && this.definitions.has(definition.name)) {
      throw new Error(`MCP server '${definition.name}' already exists.`);
    }
    this.definitions.set(definition.name, definition);
    this.clients.delete(definition.name);
  }

  // listTools queries tool metadata and optionally includes schemas when requested.
  async listTools(server: string, options: ListToolsOptions = {}): Promise<ServerToolInfo[]> {
    // Toggle auto authorization so list can run without forcing OAuth flows.
    const autoAuthorize = options.autoAuthorize !== false;
    const context = await this.connect(server, {
      maxOAuthAttempts: autoAuthorize ? undefined : 0,
      skipCache: !autoAuthorize,
    });
    try {
      const response = await context.client.listTools({ server: {} });
      return (response.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description ?? undefined,
        inputSchema: options.includeSchema ? tool.inputSchema : undefined,
        outputSchema: options.includeSchema ? tool.outputSchema : undefined,
      }));
    } finally {
      if (!autoAuthorize) {
        await context.client.close().catch(() => {});
        await closeTransportAndWait(this.logger, context.transport).catch(() => {});
        await context.oauthSession?.close().catch(() => {});
      }
    }
  }

  // callTool executes a tool using the args provided by the caller.
  async callTool(server: string, toolName: string, options: CallOptions = {}): Promise<unknown> {
    const { client } = await this.connect(server);
    const params: CallToolRequest['params'] = {
      name: toolName,
      arguments: options.args ?? {},
    };
    const resultPromise = client.callTool(params);
    const timeoutMs = normalizeTimeout(options.timeoutMs);
    if (!timeoutMs) {
      return resultPromise;
    }
    return raceWithTimeout(resultPromise, timeoutMs, () => {
      void this.close(server).catch(() => {});
    });
  }

  // listResources delegates to the MCP resources/list method with passthrough params.
  async listResources(server: string, options: Partial<ListResourcesRequest['params']> = {}): Promise<unknown> {
    const { client } = await this.connect(server);
    return client.listResources(options as ListResourcesRequest['params']);
  }

  // connect lazily instantiates a client context per server and memoizes it.
  async connect(server: string, options: ConnectOptions = {}): Promise<ClientContext> {
    // Reuse cached connections unless the caller explicitly opted out.
    const normalized = server.trim();

    const useCache = options.skipCache !== true && options.maxOAuthAttempts === undefined;

    if (useCache) {
      const existing = this.clients.get(normalized);
      if (existing) {
        return existing;
      }
    }

    const definition = this.definitions.get(normalized);
    if (!definition) {
      throw new Error(`Unknown MCP server '${normalized}'.`);
    }

    const connection = this.createClient(definition, options);

    if (useCache) {
      this.clients.set(normalized, connection);
      try {
        return await connection;
      } catch (error) {
        this.clients.delete(normalized);
        throw error;
      }
    }

    return connection;
  }

  // close tears down transports (and OAuth sessions) for a single server or all servers.
  async close(server?: string): Promise<void> {
    if (server) {
      const normalized = server.trim();
      const context = await this.clients.get(normalized);
      if (!context) {
        return;
      }
      await context.client.close().catch(() => {});
      await closeTransportAndWait(this.logger, context.transport).catch(() => {});
      await context.oauthSession?.close().catch(() => {});
      this.clients.delete(normalized);
      return;
    }

    for (const [name, promise] of this.clients.entries()) {
      try {
        const context = await promise;
        await context.client.close().catch(() => {});
        await closeTransportAndWait(this.logger, context.transport).catch(() => {});
        await context.oauthSession?.close().catch(() => {});
      } finally {
        this.clients.delete(name);
      }
    }
  }

  // createClient wires up transports, optional OAuth sessions, and connects the MCP client.
  private async createClient(definition: ServerDefinition, options: ConnectOptions = {}): Promise<ClientContext> {
    // Create a fresh MCP client context for the target server.
    const client = new Client(this.clientInfo);
    let activeDefinition = definition;

    return withEnvOverrides(activeDefinition.env, async () => {
      if (activeDefinition.command.kind === 'stdio') {
        // Resolve any ${VAR:-fallback} placeholders first so overrides remain deterministic even after
        // we merge the caller's environment below.
        const resolvedEnvOverrides =
          activeDefinition.env && Object.keys(activeDefinition.env).length > 0
            ? Object.fromEntries(
                Object.entries(activeDefinition.env)
                  .map(([key, raw]) => [key, resolveEnvValue(raw)])
                  .filter(([, value]) => value !== '')
              )
            : undefined;
        // Clone process.env so ad-hoc STDIO commands inherit the same environment as the invoking shell,
        // then layer config/env overrides on top (without mutating the parent process.env).
        const mergedEnv =
          resolvedEnvOverrides && Object.keys(resolvedEnvOverrides).length > 0
            ? { ...process.env, ...resolvedEnvOverrides }
            : { ...process.env };
        const transport = new StdioClientTransport({
          command: activeDefinition.command.command,
          args: activeDefinition.command.args,
          cwd: activeDefinition.command.cwd,
          env: mergedEnv,
        });
        await client.connect(transport);
        return { client, transport, definition: activeDefinition, oauthSession: undefined };
      }

      // HTTP transports may need to retry once OAuth is auto-enabled.
      while (true) {
        const command = activeDefinition.command;
        if (command.kind !== 'http') {
          throw new Error(`Server '${activeDefinition.name}' is not configured for HTTP transport.`);
        }
        let oauthSession: OAuthSession | undefined;
        const shouldEstablishOAuth = activeDefinition.auth === 'oauth' && options.maxOAuthAttempts !== 0;
        if (shouldEstablishOAuth) {
          oauthSession = await createOAuthSession(activeDefinition, this.logger);
        }

        const resolvedHeaders = materializeHeaders(command.headers, activeDefinition.name);

        const requestInit: RequestInit | undefined = resolvedHeaders
          ? { headers: resolvedHeaders as HeadersInit }
          : undefined;

        const baseOptions = {
          requestInit,
          authProvider: oauthSession?.provider,
        };

        const attemptConnect = async () => {
          const streamableTransport = new StreamableHTTPClientTransport(command.url, baseOptions);
          try {
            await this.connectWithAuth(
              client,
              streamableTransport,
              oauthSession,
              activeDefinition.name,
              options.maxOAuthAttempts
            );
            return {
              client,
              transport: streamableTransport,
              definition: activeDefinition,
              oauthSession,
            } as ClientContext;
          } catch (error) {
            await closeTransportAndWait(this.logger, streamableTransport).catch(() => {});
            throw error;
          }
        };

        try {
          return await attemptConnect();
        } catch (primaryError) {
          if (isUnauthorizedError(primaryError)) {
            await oauthSession?.close().catch(() => {});
            oauthSession = undefined;
            const promoted = maybeEnableOAuth(activeDefinition, this.logger);
            if (promoted && options.maxOAuthAttempts !== 0) {
              activeDefinition = promoted;
              this.definitions.set(promoted.name, promoted);
              continue;
            }
          }
          if (primaryError instanceof OAuthTimeoutError) {
            await oauthSession?.close().catch(() => {});
            throw primaryError;
          }
          if (primaryError instanceof Error) {
            this.logger.info(`Falling back to SSE transport for '${activeDefinition.name}': ${primaryError.message}`);
          }
          const sseTransport = new SSEClientTransport(command.url, {
            ...baseOptions,
          });
          try {
            await this.connectWithAuth(
              client,
              sseTransport,
              oauthSession,
              activeDefinition.name,
              options.maxOAuthAttempts
            );
            return { client, transport: sseTransport, definition: activeDefinition, oauthSession };
          } catch (sseError) {
            await closeTransportAndWait(this.logger, sseTransport).catch(() => {});
            await oauthSession?.close().catch(() => {});
            if (sseError instanceof OAuthTimeoutError) {
              throw sseError;
            }
            if (isUnauthorizedError(sseError) && options.maxOAuthAttempts !== 0) {
              const promoted = maybeEnableOAuth(activeDefinition, this.logger);
              if (promoted) {
                activeDefinition = promoted;
                this.definitions.set(promoted.name, promoted);
                continue;
              }
            }
            throw sseError;
          }
        }
      }
    });
  }

  // connectWithAuth retries MCP connect calls while the OAuth flow progresses.
  private async connectWithAuth(
    client: Client,
    transport: Transport & {
      close(): Promise<void>;
      finishAuth?: (authorizationCode: string) => Promise<void>;
    },
    session?: OAuthSession,
    serverName?: string,
    maxAttempts = 3
  ): Promise<void> {
    let attempt = 0;
    while (true) {
      try {
        await client.connect(transport);
        return;
      } catch (error) {
        if (!isUnauthorizedError(error) || !session) {
          throw error;
        }
        attempt += 1;
        if (attempt > maxAttempts) {
          throw error;
        }
        this.logger.warn(
          `OAuth authorization required for '${serverName ?? 'unknown'}'. Waiting for browser approval...`
        );
        try {
          const code = await waitForAuthorizationCodeWithTimeout(
            session,
            this.logger,
            serverName,
            this.oauthTimeoutMs ?? OAUTH_CODE_TIMEOUT_MS
          );
          if (typeof transport.finishAuth === 'function') {
            await transport.finishAuth(code);
            this.logger.info('Authorization code accepted. Retrying connection...');
          } else {
            this.logger.warn('Transport does not support finishAuth; cannot complete OAuth flow automatically.');
            throw error;
          }
        } catch (authError) {
          this.logger.error('OAuth authorization failed while waiting for callback.', authError);
          throw authError;
        }
      }
    }
  }
}

class OAuthTimeoutError extends Error {
  public readonly timeoutMs: number;
  public readonly serverName: string;

  constructor(serverName: string, timeoutMs: number) {
    const seconds = Math.round(timeoutMs / 1000);
    super(`OAuth authorization for '${serverName}' timed out after ${seconds}s; aborting.`);
    this.name = 'OAuthTimeoutError';
    this.timeoutMs = timeoutMs;
    this.serverName = serverName;
  }
}

export const __test = {
  maybeEnableOAuth,
  isUnauthorizedError,
  waitForAuthorizationCodeWithTimeout,
  OAuthTimeoutError,
};

// Race the pending OAuth browser handshake so the runtime can't sit on an unresolved promise forever.
function waitForAuthorizationCodeWithTimeout(
  session: OAuthSession,
  logger: RuntimeLogger,
  serverName?: string,
  timeoutMs = OAUTH_CODE_TIMEOUT_MS
): Promise<string> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return session.waitForAuthorizationCode();
  }
  const displayName = serverName ?? 'unknown';
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new OAuthTimeoutError(displayName, timeoutMs);
      logger.warn(error.message);
      reject(error);
    }, timeoutMs);
    session.waitForAuthorizationCode().then(
      (code) => {
        clearTimeout(timer);
        resolve(code);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function normalizeTimeout(raw?: number): number | undefined {
  if (raw == null) {
    return undefined;
  }
  if (!Number.isFinite(raw)) {
    return undefined;
  }
  const coerced = Math.trunc(raw);
  return coerced > 0 ? coerced : undefined;
}

function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error('Timeout'));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

// createConsoleLogger produces the default runtime logger honoring MCPORTER_LOG_LEVEL.
function createConsoleLogger(level: LogLevel = resolveLogLevelFromEnv()): RuntimeLogger {
  return createPrefixedConsoleLogger('mcporter', level);
}

export { readJsonFile, writeJsonFile } from './fs-json.js';

import fs from 'node:fs/promises';
import path from 'node:path';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolRequest, ListResourcesRequest } from '@modelcontextprotocol/sdk/types.js';
import { loadServerDefinitions, type ServerDefinition } from './config.js';
import { resolveEnvPlaceholders, withEnvOverrides } from './env.js';
import { createOAuthSession, type OAuthSession } from './oauth.js';

const PACKAGE_NAME = 'mcporter';
const CLIENT_VERSION = '0.1.0';

export interface RuntimeOptions {
  readonly configPath?: string;
  readonly servers?: ServerDefinition[];
  readonly rootDir?: string;
  readonly clientInfo?: {
    name: string;
    version: string;
  };
  readonly logger?: RuntimeLogger;
}

export interface RuntimeLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

export interface CallOptions {
  readonly args?: CallToolRequest['params']['arguments'];
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

  constructor(servers: ServerDefinition[], options: RuntimeOptions = {}) {
    this.definitions = new Map(servers.map((entry) => [entry.name, entry]));
    this.logger = options.logger ?? createConsoleLogger();
    this.clientInfo = options.clientInfo ?? {
      name: PACKAGE_NAME,
      version: CLIENT_VERSION,
    };
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
        await context.transport.close().catch(() => {});
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
    return client.callTool(params);
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
      await context.transport.close().catch(() => {});
      await context.oauthSession?.close().catch(() => {});
      this.clients.delete(normalized);
      return;
    }

    for (const [name, promise] of this.clients.entries()) {
      try {
        const context = await promise;
        await context.transport.close().catch(() => {});
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

    return withEnvOverrides(definition.env, async () => {
      let oauthSession: OAuthSession | undefined;
      const shouldEstablishOAuth = definition.auth === 'oauth' && options.maxOAuthAttempts !== 0;
      if (shouldEstablishOAuth) {
        oauthSession = await createOAuthSession(definition, this.logger);
      }

      if (definition.command.kind === 'stdio') {
        const transport = new StdioClientTransport({
          command: definition.command.command,
          args: definition.command.args,
          cwd: definition.command.cwd,
        });
        await client.connect(transport);
        return { client, transport, definition, oauthSession };
      }

      const resolvedHeaders = materializeHeaders(definition.command.headers, definition.name);

      const requestInit: RequestInit | undefined = resolvedHeaders
        ? { headers: resolvedHeaders as HeadersInit }
        : undefined;

      const baseOptions = {
        requestInit,
        authProvider: oauthSession?.provider,
      };

      const streamableTransport = new StreamableHTTPClientTransport(definition.command.url, baseOptions);

      try {
        try {
          await this.connectWithAuth(
            client,
            streamableTransport,
            oauthSession,
            definition.name,
            options.maxOAuthAttempts
          );
          return {
            client,
            transport: streamableTransport,
            definition,
            oauthSession,
          };
        } catch (error) {
          await streamableTransport.close().catch(() => {});
          this.logger.info(`Falling back to SSE transport for '${definition.name}': ${(error as Error).message}`);
          const sseTransport = new SSEClientTransport(definition.command.url, {
            ...baseOptions,
          });
          await this.connectWithAuth(client, sseTransport, oauthSession, definition.name, options.maxOAuthAttempts);
          return { client, transport: sseTransport, definition, oauthSession };
        }
      } catch (error) {
        await oauthSession?.close().catch(() => {});
        throw error;
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
        if (!(error instanceof UnauthorizedError) || !session) {
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
          const code = await session.waitForAuthorizationCode();
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

function createConsoleLogger(): RuntimeLogger {
  return {
    info: (message) => {
      console.log(`[mcporter] ${message}`);
    },
    warn: (message) => {
      console.warn(`[mcporter] ${message}`);
    },
    error: (message, error) => {
      console.error(`[mcporter] ${message}`);
      if (error) {
        console.error(error);
      }
    },
  };
}

function materializeHeaders(
  headers: Record<string, string> | undefined,
  serverName: string
): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    try {
      resolved[key] = resolveEnvPlaceholders(value);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to resolve header '${key}' for server '${serverName}': ${message}`);
    }
  }
  return resolved;
}

export async function readJsonFile<T = unknown>(filePath: string): Promise<T | undefined> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

export async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

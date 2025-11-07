import type { ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolRequest, ListResourcesRequest } from '@modelcontextprotocol/sdk/types.js';
import { loadServerDefinitions, type ServerDefinition } from './config.js';
import { resolveEnvPlaceholders, resolveEnvValue, withEnvOverrides } from './env.js';
import { createPrefixedConsoleLogger, type Logger, type LogLevel, resolveLogLevelFromEnv } from './logging.js';
import { createOAuthSession, type OAuthSession } from './oauth.js';
import './sdk-patches.js';

const PACKAGE_NAME = 'mcporter';
const CLIENT_VERSION = '0.3.0';

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

export type RuntimeLogger = Logger;

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
        const resolvedEnv =
          activeDefinition.env && Object.keys(activeDefinition.env).length > 0
            ? Object.fromEntries(
                Object.entries(activeDefinition.env)
                  .map(([key, raw]) => [key, resolveEnvValue(raw)])
                  .filter(([, value]) => value !== '')
              )
            : undefined;
        const transport = new StdioClientTransport({
          command: activeDefinition.command.command,
          args: activeDefinition.command.args,
          cwd: activeDefinition.command.cwd,
          env: resolvedEnv,
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
            const promoted = maybeEnableOAuth(activeDefinition, this.logger);
            if (promoted && options.maxOAuthAttempts !== 0) {
              activeDefinition = promoted;
              this.definitions.set(promoted.name, promoted);
              continue;
            }
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

function maybeEnableOAuth(definition: ServerDefinition, logger: RuntimeLogger): ServerDefinition | undefined {
  if (definition.auth === 'oauth') {
    return undefined;
  }
  if (definition.command.kind !== 'http') {
    return undefined;
  }
  const isAdHocSource = definition.source && definition.source.kind === 'local' && definition.source.path === '<adhoc>';
  if (!isAdHocSource) {
    return undefined;
  }
  const tokenCacheDir = definition.tokenCacheDir ?? path.join(os.homedir(), '.mcporter', definition.name);
  logger.info(`Detected OAuth requirement for '${definition.name}'. Launching browser flow...`);
  return {
    ...definition,
    auth: 'oauth',
    tokenCacheDir,
  };
}

export const __test = {
  maybeEnableOAuth,
  isUnauthorizedError,
};

function isUnauthorizedError(error: unknown): boolean {
  if (error instanceof UnauthorizedError) {
    return true;
  }
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : error ? JSON.stringify(error) : '';
  if (!message) {
    return false;
  }
  return /\b(401|403)\b/i.test(message) || /unauthorized|invalid[_-]?token|forbidden/i.test(message);
}

// closeTransportAndWait closes the transport and ensures its backing process exits.
async function closeTransportAndWait(
  logger: RuntimeLogger,
  transport: Transport & { close(): Promise<void> }
): Promise<void> {
  const pidBeforeClose = getTransportPid(transport);
  const childProcess =
    transport instanceof StdioClientTransport
      ? ((transport as unknown as { _process?: ChildProcess | null })._process ?? null)
      : null;
  try {
    await transport.close();
  } catch (error) {
    logger.warn(`Failed to close transport cleanly: ${(error as Error).message}`);
  }

  if (childProcess) {
    await waitForChildClose(childProcess, 1_000).catch(() => {});
  }

  if (!pidBeforeClose) {
    return;
  }

  await ensureProcessTerminated(logger, pidBeforeClose);
}

// getTransportPid attempts to extract a PID from various transport implementations.
function getTransportPid(transport: Transport & { pid?: number | null }): number | null {
  if (transport instanceof StdioClientTransport) {
    const pid = transport.pid;
    return typeof pid === 'number' && pid > 0 ? pid : null;
  }
  if ('pid' in transport) {
    const candidate = transport.pid;
    if (typeof candidate === 'number' && candidate > 0) {
      return candidate;
    }
  }
  const rawPid = (transport as unknown as { _process?: { pid?: number } | null | undefined })._process?.pid;
  return typeof rawPid === 'number' && rawPid > 0 ? rawPid : null;
}

// ensureProcessTerminated tears down any remaining processes for a given PID.
async function ensureProcessTerminated(logger: RuntimeLogger, pid: number): Promise<void> {
  await ensureProcessTreeTerminated(logger, pid);
}

// waitForChildClose resolves once the child process emits close/error or the timeout elapses.
async function waitForChildClose(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (
    (child as { exitCode?: number | null }).exitCode !== null &&
    (child as { exitCode?: number | null }).exitCode !== undefined
  ) {
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };
    const cleanup = () => {
      child.removeListener('close', finish);
      child.removeListener('exit', finish);
      child.removeListener('error', finish);
      if (timer) {
        clearTimeout(timer);
      }
    };
    child.once('close', finish);
    child.once('exit', finish);
    child.once('error', finish);
    let timer: NodeJS.Timeout | undefined;
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(finish, timeoutMs);
      timer.unref?.();
    }
  });

  try {
    child.stdin?.end?.();
  } catch {
    // ignore
  }
  try {
    child.stdout?.destroy?.();
    child.stdout?.removeAllListeners?.();
    (child.stdout as unknown as { unref?: () => void })?.unref?.();
  } catch {
    // ignore
  }
  try {
    child.stderr?.destroy?.();
    child.stderr?.removeAllListeners?.();
    (child.stderr as unknown as { unref?: () => void })?.unref?.();
  } catch {
    // ignore
  }
  try {
    const stdio = (child as { stdio?: unknown[] }).stdio;
    if (Array.isArray(stdio)) {
      for (const stream of stdio) {
        if (!stream || typeof stream !== 'object') {
          continue;
        }
        try {
          (stream as { removeAllListeners?: () => void }).removeAllListeners?.();
          (stream as { destroy?: () => void }).destroy?.();
          (stream as { end?: () => void }).end?.();
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }
  try {
    child.removeAllListeners();
  } catch {
    // ignore
  }
  try {
    child.unref?.();
  } catch {
    // ignore
  }
}

// isProcessAlive returns true when the target PID still exists.
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// createConsoleLogger produces the default runtime logger honoring MCPORTER_LOG_LEVEL.
function createConsoleLogger(level: LogLevel = resolveLogLevelFromEnv()): RuntimeLogger {
  return createPrefixedConsoleLogger('mcporter', level);
}

// ensureProcessTreeTerminated gracefully escalates signals until the process tree exits.
async function ensureProcessTreeTerminated(logger: RuntimeLogger, rootPid: number): Promise<void> {
  if (!isProcessAlive(rootPid)) {
    return;
  }

  let targets = await collectProcessTreePids(rootPid);
  if (await waitForTreeExit(targets, 300)) {
    return;
  }

  await sendSignalToTargets(targets, 'SIGTERM');
  targets = await collectProcessTreePids(rootPid);
  if (await waitForTreeExit(targets, 700)) {
    return;
  }

  targets = await collectProcessTreePids(rootPid);
  await sendSignalToTargets(targets, 'SIGKILL');
  if (await waitForTreeExit(targets, 500)) {
    return;
  }

  logger.warn(`Process tree rooted at pid=${rootPid} did not exit after SIGKILL.`);
}

// sendSignalToTargets deduplicates PIDs and delivers the requested signal.
async function sendSignalToTargets(pids: number[], signal: NodeJS.Signals): Promise<void> {
  const seen = new Set<number>();
  for (const pid of pids) {
    if (seen.has(pid)) {
      continue;
    }
    seen.add(pid);
    sendSignal(pid, signal);
  }
}

// sendSignal safely sends a signal while tolerating already-exited processes.
function sendSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (typeof error === 'object' && error && 'code' in error && (error as { code?: string }).code === 'ESRCH') {
      return;
    }
    throw error;
  }
}

// listDescendantPids enumerates child processes for the provided root PID.
async function listDescendantPids(rootPid: number): Promise<number[]> {
  if (!isProcessAlive(rootPid)) {
    return [];
  }
  if (process.platform === 'win32') {
    // TODO: implement Windows process tree enumeration if/when needed.
    return [];
  }

  try {
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid=']);
    const children = new Map<number, number[]>();
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const [pidText, ppidText] = trimmed.split(/\s+/, 2);
      const pid = Number.parseInt(pidText ?? '', 10);
      const ppid = Number.parseInt(ppidText ?? '', 10);
      if (!Number.isFinite(pid) || !Number.isFinite(ppid)) {
        continue;
      }
      const bucket = children.get(ppid) ?? [];
      bucket.push(pid);
      children.set(ppid, bucket);
    }

    const result: number[] = [];
    const queue = [...(children.get(rootPid) ?? [])];
    const seen = new Set<number>(queue);
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) {
        continue;
      }
      result.push(current);
      for (const child of children.get(current) ?? []) {
        if (!seen.has(child)) {
          seen.add(child);
          queue.push(child);
        }
      }
    }
    return result;
  } catch {
    return [];
  }
}

// execFileAsync wraps execFile in a promise for simpler async/await usage.
function execFileAsync(command: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

// collectProcessTreePids returns the root PID and all discovered descendants.
async function collectProcessTreePids(rootPid: number): Promise<number[]> {
  const descendants = await listDescendantPids(rootPid);
  return [...descendants, rootPid];
}

// waitForTreeExit polls until every PID exits or the timeout expires.
async function waitForTreeExit(pids: number[], durationMs: number): Promise<boolean> {
  const deadline = Date.now() + durationMs;
  while (true) {
    if (pids.every((pid) => !isProcessAlive(pid))) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    const remaining = Math.max(10, Math.min(100, deadline - Date.now()));
    await delay(remaining);
  }
}

// delay resolves after the specified milliseconds, allowing unref to avoid holding the event loop.
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref?: () => void }).unref?.();
    }
  });
}

// materializeHeaders resolves environment placeholders in header definitions for a server.
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

// readJsonFile reads JSON from disk, returning undefined when the file does not exist.
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

// writeJsonFile writes pretty-printed JSON to disk, creating parent directories automatically.
export async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

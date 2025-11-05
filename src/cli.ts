#!/usr/bin/env node
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { generateCli } from './generate-cli.js';
import { createRuntime } from './runtime.js';

type FlagMap = Partial<Record<string, string>>;

function logInfo(message: string) {
  // Log an info-level message with the standard prefix.
  console.log(`[mcporter] ${message}`);
}

function logWarn(message: string) {
  // Emit a warning with the standard prefix.
  console.warn(`[mcporter] ${message}`);
}

function logError(message: string, error?: unknown) {
  // Output an error message and optional error object.
  console.error(`[mcporter] ${message}`);
  if (error) {
    console.error(error);
  }
}

// main parses CLI flags and dispatches to list/call commands.
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    printHelp();
    process.exit(1);
  }

  const globalFlags = extractFlags(argv, ['--config', '--root']);
  const command = argv.shift();

  if (!command) {
    printHelp();
    process.exit(1);
  }

  if (command === 'generate-cli') {
    await handleGenerateCli(argv, globalFlags);
    return;
  }

  const runtime = await createRuntime({
    configPath: globalFlags['--config'],
    rootDir: globalFlags['--root'],
  });

  try {
    if (command === 'list') {
      await handleList(runtime, argv);
      return;
    }

    if (command === 'call') {
      await handleCall(runtime, argv);
      return;
    }

    if (command === 'auth') {
      await handleAuth(runtime, argv);
      return;
    }
  } finally {
    await runtime.close().catch(() => {});
  }

  printHelp(`Unknown command '${command}'.`);
  process.exit(1);
}

// extractFlags snacks out targeted flags (and their values) from argv in place.
function extractFlags(args: string[], keys: string[]): FlagMap {
  const flags: FlagMap = {};
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (token === undefined || !keys.includes(token)) {
      index += 1;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined) {
      throw new Error(`Flag '${token}' requires a value.`);
    }
    flags[token] = value;
    args.splice(index, 2);
  }
  return flags;
}

interface GenerateFlags {
  server?: string;
  name?: string;
  command?: string;
  description?: string;
  output?: string;
  bundle?: boolean | string;
  compile?: boolean | string;
  runtime?: 'node' | 'bun';
  timeout: number;
  minify: boolean;
}

function parseGenerateFlags(args: string[]): GenerateFlags {
  let server: string | undefined;
  let name: string | undefined;
  let command: string | undefined;
  let description: string | undefined;
  let output: string | undefined;
  let bundle: boolean | string | undefined;
  let compile: boolean | string | undefined;
  let runtime: 'node' | 'bun' | undefined;
  let timeout = 30_000;
  let minify = false;

  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (!token) {
      index += 1;
      continue;
    }
    if (token === '--server') {
      server = expectValue(token, args[index + 1]);
      args.splice(index, 2);
      continue;
    }
    if (token === '--name') {
      name = expectValue(token, args[index + 1]);
      args.splice(index, 2);
      continue;
    }
    if (token === '--command') {
      command = expectValue(token, args[index + 1]);
      args.splice(index, 2);
      continue;
    }
    if (token === '--description') {
      description = expectValue(token, args[index + 1]);
      args.splice(index, 2);
      continue;
    }
    if (token === '--output') {
      output = expectValue(token, args[index + 1]);
      args.splice(index, 2);
      continue;
    }
    if (token === '--runtime') {
      const value = expectValue(token, args[index + 1]);
      if (value !== 'node' && value !== 'bun') {
        throw new Error("--runtime must be 'node' or 'bun'.");
      }
      runtime = value;
      args.splice(index, 2);
      continue;
    }
    if (token === '--timeout') {
      const value = Number.parseInt(expectValue(token, args[index + 1]), 10);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error('--timeout must be a positive integer.');
      }
      timeout = value;
      args.splice(index, 2);
      continue;
    }
    if (token === '--bundle') {
      const next = args[index + 1];
      if (!next || next.startsWith('--')) {
        bundle = true;
        args.splice(index, 1);
      } else {
        bundle = next;
        args.splice(index, 2);
      }
      continue;
    }
    if (token === '--compile') {
      const next = args[index + 1];
      if (!next || next.startsWith('--')) {
        compile = true;
        args.splice(index, 1);
      } else {
        compile = next;
        args.splice(index, 2);
      }
      continue;
    }
    if (token === '--minify') {
      minify = true;
      args.splice(index, 1);
      continue;
    }
    throw new Error(`Unknown flag '${token}' for generate-cli.`);
  }

  return {
    server,
    name,
    command,
    description,
    output,
    bundle,
    compile,
    runtime,
    timeout,
    minify,
  };
}

function expectValue(flag: string, value: string | undefined): string {
  if (value === undefined) {
    throw new Error(`Flag '${flag}' requires a value.`);
  }
  return value;
}

const LIST_TIMEOUT_MS = Number.parseInt(process.env.MCPORTER_LIST_TIMEOUT ?? '30000', 10);

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  // Race the original promise with a timeout to keep CLI responsive.
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error('Timeout')), timeoutMs);
    }),
  ]) as Promise<T>;
}

async function handleGenerateCli(args: string[], globalFlags: FlagMap): Promise<void> {
  const parsed = parseGenerateFlags(args);
  const inferredName = parsed.name ?? (parsed.command ? inferNameFromCommand(parsed.command) : undefined);
  const serverRef =
    parsed.server ??
    (parsed.command && inferredName
      ? JSON.stringify({
          name: inferredName,
          command: parsed.command,
          ...(parsed.description ? { description: parsed.description } : {}),
        })
      : undefined);
  if (!serverRef) {
    throw new Error(
      'Provide --server with a definition or a command we can infer a name from (use --name to override).'
    );
  }
  const { outputPath, bundlePath, compilePath } = await generateCli({
    serverRef,
    configPath: globalFlags['--config'],
    rootDir: globalFlags['--root'],
    outputPath: parsed.output,
    runtime: parsed.runtime,
    bundle: parsed.bundle,
    timeoutMs: parsed.timeout,
    compile: parsed.compile,
    minify: parsed.minify,
  });
  console.log(`Generated CLI at ${outputPath}`);
  if (bundlePath) {
    console.log(`Bundled executable created at ${bundlePath}`);
  }
  if (compilePath) {
    console.log(`Compiled executable created at ${compilePath}`);
  }
}

// handleList prints configured servers and optional tool metadata.
function inferNameFromCommand(command: string): string | undefined {
  const trimmed = command.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const url = new URL(trimmed);
    const genericHosts = new Set(['www', 'api', 'mcp', 'service', 'services', 'app', 'localhost']);
    const knownTlds = new Set(['com', 'net', 'org', 'io', 'ai', 'app', 'dev', 'co', 'cloud']);
    const parts = url.hostname.split('.').filter(Boolean);
    const filtered = parts.filter((part) => {
      const lower = part.toLowerCase();
      if (genericHosts.has(lower)) {
        return false;
      }
      if (knownTlds.has(lower)) {
        return false;
      }
      if (/^\d+$/.test(part)) {
        return false;
      }
      return true;
    });
    if (filtered.length > 0) {
      const last = filtered[filtered.length - 1];
      if (last) {
        return last;
      }
    }
    const segments = url.pathname.split('/').filter(Boolean);
    const firstSegment = segments[0];
    if (firstSegment) {
      return firstSegment.replace(/[^a-zA-Z0-9-_]/g, '-');
    }
  } catch {
    // not a URL; fall through to filesystem heuristics
  }
  const firstToken = trimmed.split(/\s+/)[0] ?? trimmed;
  const candidate = firstToken.split(/[\\/]/).pop() ?? firstToken;
  return candidate.replace(/\.[a-z0-9]+$/i, '');
}

async function handleList(runtime: Awaited<ReturnType<typeof createRuntime>>, args: string[]): Promise<void> {
  const flags = extractListFlags(args);
  const target = args.shift();

  if (!target) {
    const servers = runtime.getDefinitions();
    const perServerTimeoutMs = LIST_TIMEOUT_MS;
    const perServerTimeoutSeconds = Math.round(perServerTimeoutMs / 1000);

    if (servers.length === 0) {
      console.log('No MCP servers configured.');
      return;
    }

    console.log(`Listing ${servers.length} server(s) (per-server timeout: ${perServerTimeoutSeconds}s)`);

    const results = await Promise.all(
      servers.map(async (server) => {
        const startedAt = Date.now();
        try {
          const tools = await withTimeout(runtime.listTools(server.name, { autoAuthorize: false }), perServerTimeoutMs);
          const durationMs = Date.now() - startedAt;
          return {
            server,
            status: 'ok' as const,
            tools,
            durationMs,
          };
        } catch (error) {
          const durationMs = Date.now() - startedAt;
          return {
            server,
            status: 'error' as const,
            error,
            durationMs,
          };
        }
      })
    );

    for (const result of results) {
      const description = result.server.description ? ` — ${result.server.description}` : '';
      const durationSeconds = (result.durationMs / 1000).toFixed(1);
      if (result.status === 'ok') {
        const toolSuffix =
          result.tools.length === 0
            ? 'no tools reported'
            : `${result.tools.length === 1 ? '1 tool' : `${result.tools.length} tools`}`;
        console.log(`- ${result.server.name}${description} (${toolSuffix}, ${durationSeconds}s)`);
        continue;
      }

      const { error } = result;
      let note: string;
      if (error instanceof UnauthorizedError) {
        note = `auth required — run 'mcporter auth ${result.server.name}' to complete the OAuth flow`;
      } else if (error instanceof Error && error.message === 'Timeout') {
        note = `timed out after ${perServerTimeoutSeconds}s`;
      } else if (error instanceof Error) {
        note = error.message;
      } else {
        note = String(error);
      }
      console.log(`- ${result.server.name}${description} (${note}, ${durationSeconds}s)`);
    }
    return;
  }

  try {
    const tools = await withTimeout(
      runtime.listTools(target, {
        includeSchema: flags.schema,
      }),
      LIST_TIMEOUT_MS
    );
    if (tools.length === 0) {
      console.log('  Tools: <none>');
      return;
    }
    console.log(`- ${target}`);
    console.log('  Tools:');
    for (const tool of tools) {
      const doc = tool.description ? `: ${tool.description}` : '';
      console.log(`    - ${tool.name}${doc}`);
      if (flags.schema && tool.inputSchema) {
        console.log(indent(JSON.stringify(tool.inputSchema, null, 2), '      '));
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load tool list.';
    console.warn(`  Tools: <timed out after ${LIST_TIMEOUT_MS}ms>`);
    console.warn(`  Reason: ${message}`);
  }
}

// handleCall invokes a tool, prints JSON, and optionally tails logs.
async function handleCall(runtime: Awaited<ReturnType<typeof createRuntime>>, args: string[]): Promise<void> {
  const parsed = parseCallArguments(args);
  const selector = parsed.selector;
  let server = parsed.server;
  let tool = parsed.tool;

  if (selector && !server && selector.includes('.')) {
    const [left, right] = selector.split('.', 2);
    server = left;
    tool = right;
  } else if (selector && !server) {
    server = selector;
  } else if (selector && !tool) {
    tool = selector;
  }

  if (!server) {
    throw new Error('Missing server name. Provide it via <server>.<tool> or --server.');
  }
  if (!tool) {
    throw new Error('Missing tool name. Provide it via <server>.<tool> or --tool.');
  }

  const result = await runtime.callTool(server, tool, { args: parsed.args });

  if (typeof result === 'string') {
    try {
      const decoded = JSON.parse(result);
      console.log(JSON.stringify(decoded, null, 2));
      tailLogIfRequested(decoded, parsed.tailLog ?? false);
    } catch {
      console.log(result);
      tailLogIfRequested(result, parsed.tailLog ?? false);
    }
    return;
  }

  console.log(JSON.stringify(result, null, 2));
  tailLogIfRequested(result, parsed.tailLog ?? false);
}

// extractListFlags captures list-specific options such as --schema.
function extractListFlags(args: string[]): { schema: boolean } {
  let schema = false;
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (token === '--schema') {
      schema = true;
      args.splice(index, 1);
      continue;
    }
    index += 1;
  }
  return { schema };
}

interface CallArgsParseResult {
  selector?: string;
  server?: string;
  tool?: string;
  args: Record<string, unknown>;
  tailLog?: boolean;
}

// parseCallArguments supports selectors, JSON payloads, and key=value args.
function parseCallArguments(args: string[]): CallArgsParseResult {
  const result: CallArgsParseResult = { args: {}, tailLog: false };
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (token === '--server' || token === '--mcp') {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`Flag '${token}' requires a value.`);
      }
      result.server = value;
      args.splice(index, 2);
      continue;
    }
    if (token === '--tool') {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`Flag '${token}' requires a value.`);
      }
      result.tool = value;
      args.splice(index, 2);
      continue;
    }
    if (token === '--args') {
      const value = args[index + 1];
      if (!value) {
        throw new Error('--args requires JSON payload.');
      }
      try {
        const decoded = JSON.parse(value);
        if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
          throw new Error('--args must be a JSON object.');
        }
        Object.assign(result.args, decoded);
      } catch (error) {
        throw new Error(`Unable to parse --args: ${(error as Error).message}`);
      }
      args.splice(index, 2);
      continue;
    }
    if (token === '--tail-log') {
      result.tailLog = true;
      args.splice(index, 1);
      continue;
    }
    index += 1;
  }

  if (args.length > 0) {
    result.selector = args.shift();
  }
  for (const token of args) {
    const [key, raw] = token.split('=', 2);
    if (!key || raw === undefined) {
      throw new Error(`Argument '${token}' must be key=value format.`);
    }
    result.args[key] = coerceValue(raw);
  }
  return result;
}

// coerceValue tries to cast string tokens into JS primitives or JSON.
function coerceValue(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === '') {
    return '';
  }
  if (trimmed === 'true' || trimmed === 'false') {
    return trimmed === 'true';
  }
  if (trimmed === 'null' || trimmed === 'none') {
    return null;
  }
  if (!Number.isNaN(Number(trimmed)) && trimmed === `${Number(trimmed)}`) {
    return Number(trimmed);
  }
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

// indent adds consistent left padding when printing nested JSON.
function indent(text: string, pad: string): string {
  return text
    .split('\n')
    .map((line) => pad + line)
    .join('\n');
}

// tailLogIfRequested prints the final lines of any referenced log files.
function tailLogIfRequested(result: unknown, enabled: boolean): void {
  // Bail out immediately when tailing is disabled.
  if (!enabled) {
    return;
  }
  const candidates: string[] = [];
  if (typeof result === 'string') {
    const idx = result.indexOf(':');
    if (idx !== -1) {
      const candidate = result.slice(idx + 1).trim();
      if (candidate) {
        candidates.push(candidate);
      }
    }
  }
  if (result && typeof result === 'object') {
    const possibleKeys = ['logPath', 'logFile', 'logfile', 'path'];
    for (const key of possibleKeys) {
      const value = (result as Record<string, unknown>)[key];
      if (typeof value === 'string') {
        candidates.push(value);
      }
    }
  }

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      logWarn(`Log path not found: ${candidate}`);
      continue;
    }
    try {
      const content = fs.readFileSync(candidate, 'utf8');
      const lines = content.trimEnd().split(/\r?\n/);
      const tail = lines.slice(-20);
      console.log(`--- tail ${candidate} ---`);
      for (const line of tail) {
        console.log(line);
      }
    } catch (error) {
      logWarn(`Failed to read log file ${candidate}: ${(error as Error).message}`);
    }
  }
}

// printHelp explains available commands and global flags.
function printHelp(message?: string): void {
  if (message) {
    console.error(message);
    console.error('');
  }
  console.error(`Usage: mcporter <command> [options]

Commands:
  list [name] [--schema]             List configured MCP servers (and tools for a server)
  call [selector] [flags]            Call a tool (selector like server.tool)
    --tail-log                       Tail log output when the tool returns a log file path
  auth <name>                        Complete the OAuth flow for a server without listing tools
  generate-cli --server <ref>        Generate a standalone CLI
    --name <name>                    Supply a friendly name (otherwise inferred)
    --command <ref>                  MCP command or URL (required without --server)
    --output <path>                  Override output file path
    --bundle [path]                  Create a bundled JS file (auto-named when omitted)
    --compile [path]                 Compile with Bun (implies --bundle); requires Bun
    --minify                         Minify bundled output
    --runtime node|bun               Force runtime selection (auto-detected otherwise)
    --timeout <ms>                   Override introspection timeout (default 30000)

Global flags:
  --config <path>                    Path to mcporter.json (defaults to ./config/mcporter.json)
  --root <path>                      Root directory for stdio command cwd
`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  logError(message, error instanceof Error ? error : undefined);
  process.exit(1);
});
async function handleAuth(runtime: Awaited<ReturnType<typeof createRuntime>>, args: string[]): Promise<void> {
  // Peel off optional flags before we consume positional args.
  const resetIndex = args.indexOf('--reset');
  const shouldReset = resetIndex !== -1;
  if (shouldReset) {
    args.splice(resetIndex, 1);
  }
  const target = args.shift();
  if (!target) {
    throw new Error('Usage: mcporter auth <server>');
  }

  const definition = runtime.getDefinition(target);
  if (shouldReset) {
    const tokenDir = definition.tokenCacheDir;
    if (tokenDir) {
      // Drop the cached credentials so the next auth run starts cleanly.
      await fsPromises.rm(tokenDir, { recursive: true, force: true });
      logInfo(`Cleared cached credentials for '${target}' at ${tokenDir}`);
    } else {
      logWarn(`Server '${target}' does not expose a token cache path.`);
    }
  }

  try {
    // Kick off the interactive OAuth flow without blocking list output.
    logInfo(`Initiating OAuth flow for '${target}'...`);
    const tools = await runtime.listTools(target, { autoAuthorize: true });
    logInfo(`Authorization complete. ${tools.length} tool${tools.length === 1 ? '' : 's'} available.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to authorize '${target}': ${message}`);
  }
}

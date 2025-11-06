#!/usr/bin/env node
import fsPromises from 'node:fs/promises';
import { handleCall as runHandleCall } from './cli/call-command.js';
import { handleList } from './cli/list-command.js';
import { formatSourceSuffix } from './cli/list-format.js';
import { getActiveLogger, getActiveLogLevel, logError, logInfo, logWarn, setLogLevel } from './cli/logger-context.js';
import { formatPathForDisplay } from './cli/path-utils.js';
import { DEBUG_HANG, dumpActiveHandles, terminateChildProcesses } from './cli/runtime-debug.js';
import type { CliArtifactMetadata, SerializedServerDefinition } from './cli-metadata.js';
import { readCliMetadata } from './cli-metadata.js';
import { generateCli } from './generate-cli.js';
import { parseLogLevel } from './logging.js';
import { createRuntime } from './runtime.js';

export { handleCall, parseCallArguments } from './cli/call-command.js';
export { extractListFlags, handleList } from './cli/list-command.js';
export { resolveCallTimeout } from './cli/timeouts.js';

type FlagMap = Partial<Record<string, string>>;
// main parses CLI flags and dispatches to list/call commands.
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    printHelp();
    process.exit(1);
  }

  const globalFlags = extractFlags(argv, ['--config', '--root', '--log-level']);
  if (globalFlags['--log-level']) {
    try {
      const parsedLevel = parseLogLevel(globalFlags['--log-level'], getActiveLogLevel());
      setLogLevel(parsedLevel);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError(message, error instanceof Error ? error : undefined);
      process.exit(1);
    }
  }
  const command = argv.shift();

  if (!command) {
    printHelp();
    process.exit(1);
  }

  if (command === 'generate-cli') {
    await handleGenerateCli(argv, globalFlags);
    return;
  }

  if (command === 'inspect-cli') {
    await handleInspectCli(argv);
    return;
  }

  if (command === 'regenerate-cli') {
    await handleRegenerateCli(argv, globalFlags);
    return;
  }

  const runtime = await createRuntime({
    configPath: globalFlags['--config'],
    rootDir: globalFlags['--root'],
    logger: getActiveLogger(),
  });

  try {
    if (command === 'list') {
      await handleList(runtime, argv);
      return;
    }

    if (command === 'call') {
      await runHandleCall(runtime, argv);
      return;
    }

    if (command === 'auth') {
      await handleAuth(runtime, argv);
      return;
    }
  } finally {
    const closeStart = Date.now();
    if (DEBUG_HANG) {
      logInfo('[debug] beginning runtime.close()');
      dumpActiveHandles('before runtime.close');
    }
    try {
      await runtime.close();
      if (DEBUG_HANG) {
        const duration = Date.now() - closeStart;
        logInfo(`[debug] runtime.close() completed in ${duration}ms`);
        dumpActiveHandles('after runtime.close');
      }
    } catch (error) {
      if (DEBUG_HANG) {
        logError('[debug] runtime.close() failed', error);
      }
    } finally {
      terminateChildProcesses('runtime.finally');
      // By default we force an exit after cleanup so Node doesn't hang on lingering stdio handles
      // (see typescript-sdk#579/#780/#1049). Opt out by exporting MCPORTER_NO_FORCE_EXIT=1.
      const disableForceExit = process.env.MCPORTER_NO_FORCE_EXIT === '1';
      if (DEBUG_HANG) {
        dumpActiveHandles('after terminateChildProcesses');
        if (!disableForceExit || process.env.MCPORTER_FORCE_EXIT === '1') {
          process.exit(0);
        }
      } else {
        const scheduleExit = () => {
          if (!disableForceExit || process.env.MCPORTER_FORCE_EXIT === '1') {
            process.exit(0);
          }
        };
        setImmediate(scheduleExit);
      }
    }
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

// parseGenerateFlags extracts generate-cli specific flags from argv.
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

// expectValue asserts that a flag is followed by a value.
function expectValue(flag: string, value: string | undefined): string {
  if (value === undefined) {
    throw new Error(`Flag '${flag}' requires a value.`);
  }
  return value;
}

// handleGenerateCli parses flags and generates the requested standalone CLI.
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

interface InspectFlags {
  artifactPath: string;
  format: 'text' | 'json';
}

// parseInspectFlags pulls inspect-cli options from argv.
function parseInspectFlags(args: string[]): InspectFlags {
  let format: 'text' | 'json' = 'text';
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (!token) {
      index += 1;
      continue;
    }
    if (token === '--json') {
      format = 'json';
      args.splice(index, 1);
      continue;
    }
    if (token === '--format') {
      const value = expectValue(token, args[index + 1]);
      if (value !== 'json' && value !== 'text') {
        throw new Error("--format must be 'json' or 'text'.");
      }
      format = value;
      args.splice(index, 2);
      continue;
    }
    if (token.startsWith('--')) {
      throw new Error(`Unknown flag '${token}' for inspect-cli.`);
    }
    index += 1;
  }
  const artifactPath = args.shift();
  if (!artifactPath) {
    throw new Error('Usage: mcporter inspect-cli <artifact> [--json]');
  }
  return { artifactPath, format };
}

interface RegenerateOverrides {
  server?: string;
  config?: string;
  runtime?: 'node' | 'bun';
  timeoutMs?: number;
  minify?: boolean;
  outputPath?: string;
  bundle?: boolean | string;
  compile?: boolean | string;
}

interface RegenerateParseResult {
  artifactPath: string;
  overrides: RegenerateOverrides;
  dryRun: boolean;
}

// parseRegenerateFlags collects regenerate-cli overrides and metadata.
function parseRegenerateFlags(args: string[]): RegenerateParseResult {
  const overrides: RegenerateOverrides = {};
  let dryRun = false;
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (!token) {
      index += 1;
      continue;
    }
    if (token === '--dry-run') {
      dryRun = true;
      args.splice(index, 1);
      continue;
    }
    if (token === '--server') {
      overrides.server = expectValue(token, args[index + 1]);
      args.splice(index, 2);
      continue;
    }
    if (token === '--config') {
      overrides.config = expectValue(token, args[index + 1]);
      args.splice(index, 2);
      continue;
    }
    if (token === '--runtime') {
      const value = expectValue(token, args[index + 1]);
      if (value !== 'node' && value !== 'bun') {
        throw new Error("--runtime must be 'node' or 'bun'.");
      }
      overrides.runtime = value;
      args.splice(index, 2);
      continue;
    }
    if (token === '--timeout') {
      const value = Number.parseInt(expectValue(token, args[index + 1]), 10);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error('--timeout must be a positive integer.');
      }
      overrides.timeoutMs = value;
      args.splice(index, 2);
      continue;
    }
    if (token === '--minify') {
      overrides.minify = true;
      args.splice(index, 1);
      continue;
    }
    if (token === '--no-minify') {
      overrides.minify = false;
      args.splice(index, 1);
      continue;
    }
    if (token === '--output') {
      overrides.outputPath = expectValue(token, args[index + 1]);
      args.splice(index, 2);
      continue;
    }
    if (token === '--bundle') {
      const next = args[index + 1];
      if (!next || next.startsWith('--')) {
        overrides.bundle = true;
        args.splice(index, 1);
      } else {
        overrides.bundle = next;
        args.splice(index, 2);
      }
      continue;
    }
    if (token === '--compile') {
      const next = args[index + 1];
      if (!next || next.startsWith('--')) {
        overrides.compile = true;
        args.splice(index, 1);
      } else {
        overrides.compile = next;
        args.splice(index, 2);
      }
      continue;
    }
    if (token.startsWith('--')) {
      throw new Error(`Unknown flag '${token}' for regenerate-cli.`);
    }
    index += 1;
  }
  const artifactPath = args.shift();
  if (!artifactPath) {
    throw new Error('Usage: mcporter regenerate-cli <artifact> [options]');
  }
  return { artifactPath, overrides, dryRun };
}

// handleInspectCli loads and prints metadata about a generated CLI artifact.
export async function handleInspectCli(args: string[]): Promise<void> {
  const parsed = parseInspectFlags(args);
  const metadata = await readCliMetadata(parsed.artifactPath);
  if (parsed.format === 'json') {
    console.log(JSON.stringify(metadata, null, 2));
    return;
  }
  console.log(`Artifact: ${formatPathForDisplay(metadata.artifact.path)} (${metadata.artifact.kind})`);
  console.log(`Server: ${metadata.server.name}`);
  if (metadata.server.source) {
    const suffix = formatSourceSuffix(metadata.server.source, true);
    if (suffix) {
      console.log(`Source: ${suffix}`);
    }
  }
  console.log(
    `Generated: ${new Date(metadata.generatedAt).toISOString()} via ${metadata.generator.name}@${
      metadata.generator.version
    }`
  );
  if (metadata.invocation.runtime) {
    console.log(`Runtime: ${metadata.invocation.runtime}`);
  }
  console.log('Invocation flags:');
  for (const [key, value] of Object.entries(metadata.invocation)) {
    if (value === undefined || value === null || key === 'runtime') {
      continue;
    }
    console.log(`  ${key}: ${Array.isArray(value) ? JSON.stringify(value) : String(value)}`);
  }
  const dryRunCommand = buildGenerateCliCommand(metadata.invocation, metadata.server.definition);
  console.log('Regenerate with:');
  console.log(`  mcporter regenerate-cli ${shellQuote(parsed.artifactPath)}`);
  if (dryRunCommand) {
    console.log('Underlying generate-cli command:');
    console.log(`  ${dryRunCommand}`);
  }
}

// handleRegenerateCli replays stored metadata to regenerate a CLI artifact.
export async function handleRegenerateCli(args: string[], globalFlags: FlagMap): Promise<void> {
  const parsed = parseRegenerateFlags(args);
  const metadata = await readCliMetadata(parsed.artifactPath);
  const invocation = { ...metadata.invocation };
  if (parsed.overrides.server) {
    invocation.serverRef = parsed.overrides.server;
  }
  if (!invocation.serverRef) {
    invocation.serverRef = metadata.server.name ?? JSON.stringify(metadata.server.definition);
  }
  if (parsed.overrides.config) {
    invocation.configPath = parsed.overrides.config;
  } else if (globalFlags['--config']) {
    invocation.configPath = globalFlags['--config'];
  }
  if (globalFlags['--root']) {
    invocation.rootDir = globalFlags['--root'];
  }
  if (parsed.overrides.runtime) {
    invocation.runtime = parsed.overrides.runtime;
  }
  if (parsed.overrides.timeoutMs !== undefined) {
    invocation.timeoutMs = parsed.overrides.timeoutMs;
  }
  if (parsed.overrides.minify !== undefined) {
    invocation.minify = parsed.overrides.minify;
  }
  if (parsed.overrides.outputPath !== undefined) {
    invocation.outputPath = parsed.overrides.outputPath;
  }
  if (parsed.overrides.bundle !== undefined) {
    invocation.bundle = parsed.overrides.bundle;
  }
  if (parsed.overrides.compile !== undefined) {
    invocation.compile = parsed.overrides.compile;
  }

  if (!invocation.serverRef) {
    invocation.serverRef = JSON.stringify(metadata.server.definition);
  }
  if (!invocation.runtime) {
    invocation.runtime = 'node';
  }
  if (parsed.dryRun) {
    const command = buildGenerateCliCommand(invocation, metadata.server.definition, globalFlags);
    console.log('Dry run — would execute:');
    console.log(`  ${command}`);
    return;
  }

  const result = await generateCli({
    serverRef: invocation.serverRef,
    configPath: invocation.configPath,
    rootDir: invocation.rootDir,
    outputPath: invocation.outputPath,
    runtime: invocation.runtime,
    bundle: invocation.bundle,
    timeoutMs: invocation.timeoutMs,
    minify: invocation.minify,
    compile: invocation.compile,
  });

  if (metadata.artifact.kind === 'binary' && result.compilePath) {
    console.log(`Regenerated compiled CLI at ${result.compilePath}`);
  } else if (metadata.artifact.kind === 'bundle' && result.bundlePath) {
    console.log(`Regenerated bundled CLI at ${result.bundlePath}`);
  } else if (metadata.artifact.kind === 'template') {
    console.log(`Regenerated template at ${result.outputPath}`);
  } else {
    console.log('Regeneration completed.');
  }
}

// inferNameFromCommand derives a friendly CLI name from a command or URL.
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

// buildGenerateCliCommand reconstructs the generate-cli invocation for logging/dry runs.
function buildGenerateCliCommand(
  invocation: CliArtifactMetadata['invocation'],
  definition: SerializedServerDefinition,
  globalFlags: FlagMap = {}
): string {
  const tokens: string[] = ['mcporter'];
  const configPath = invocation.configPath ?? globalFlags['--config'];
  const rootDir = invocation.rootDir ?? globalFlags['--root'];
  if (configPath) {
    tokens.push('--config', configPath);
  }
  if (rootDir) {
    tokens.push('--root', rootDir);
  }
  tokens.push('generate-cli');

  const serverRef = invocation.serverRef ?? definition.name ?? JSON.stringify(definition);
  tokens.push('--server', serverRef);

  if (invocation.outputPath) {
    tokens.push('--output', invocation.outputPath);
  }
  if (typeof invocation.bundle === 'string') {
    tokens.push('--bundle', invocation.bundle);
  } else if (invocation.bundle) {
    tokens.push('--bundle');
  }
  if (typeof invocation.compile === 'string') {
    tokens.push('--compile', invocation.compile);
  } else if (invocation.compile) {
    tokens.push('--compile');
  }
  if (invocation.runtime) {
    tokens.push('--runtime', invocation.runtime);
  }
  if (invocation.timeoutMs && invocation.timeoutMs !== 30_000) {
    tokens.push('--timeout', String(invocation.timeoutMs));
  }
  if (invocation.minify) {
    tokens.push('--minify');
  }
  return tokens.map(shellQuote).join(' ');
}

// shellQuote safely quotes CLI tokens when reconstructing commands.
function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./@%-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
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
    --output <format>                Output format: auto|text|markdown|json|raw (default auto)
    --raw                            Shortcut for --output raw
  auth <name>                        Complete the OAuth flow for a server without listing tools
  inspect-cli <path> [--json]        Show metadata and regeneration info for a generated CLI artifact
  regenerate-cli <path> [options]    Re-run generate-cli using stored metadata to refresh an artifact
    --dry-run                         Print the generate-cli command without executing
    --server <ref>                    Override the stored server reference
    --config <path>                   Override config path from metadata
    --runtime node|bun                Force runtime selection when regenerating
    --timeout <ms>                    Override schema introspection timeout
    --minify/--no-minify              Toggle bundle minification
    --output <path>                   Override template output path
    --bundle [path]                   Override bundle path (omit value to auto-name)
    --compile [path]                  Override compiled binary path (omit value to auto-name)
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
  --log-level <debug|info|warn|error>  Adjust CLI log verbosity (defaults to warn)
`);
}

if (process.env.MCPORTER_DISABLE_AUTORUN !== '1') {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    logError(message, error instanceof Error ? error : undefined);
    process.exit(1);
  });
}
// handleAuth clears cached tokens and executes standalone OAuth flows.
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

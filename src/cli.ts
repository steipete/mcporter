#!/usr/bin/env node
import fsPromises from 'node:fs/promises';
import type { EphemeralServerSpec } from './cli/adhoc-server.js';
import { handleCall as runHandleCall } from './cli/call-command.js';
import { inferCommandRouting } from './cli/command-inference.js';
import { handleEmitTs } from './cli/emit-ts-command.js';
import { extractEphemeralServerFlags } from './cli/ephemeral-flags.js';
import { prepareEphemeralServerTarget } from './cli/ephemeral-target.js';
import { CliUsageError } from './cli/errors.js';
import { extractFlags } from './cli/flag-utils.js';
import { handleGenerateCli } from './cli/generate-cli-runner.js';
import { looksLikeHttpUrl } from './cli/http-utils.js';
import { handleInspectCli } from './cli/inspect-cli-command.js';
import { buildConnectionIssueEnvelope } from './cli/json-output.js';
import { handleList } from './cli/list-command.js';
import { getActiveLogger, getActiveLogLevel, logError, logInfo, logWarn, setLogLevel } from './cli/logger-context.js';
import { consumeOutputFormat } from './cli/output-format.js';
import { DEBUG_HANG, dumpActiveHandles, terminateChildProcesses } from './cli/runtime-debug.js';
import { analyzeConnectionError } from './error-classifier.js';
import { parseLogLevel } from './logging.js';
import { createRuntime } from './runtime.js';

export { handleCall, parseCallArguments } from './cli/call-command.js';
export { handleGenerateCli } from './cli/generate-cli-runner.js';
export { handleInspectCli } from './cli/inspect-cli-command.js';
export { extractListFlags, handleList } from './cli/list-command.js';
export { resolveCallTimeout } from './cli/timeouts.js';

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

  if (command === 'emit-ts') {
    const runtime = await createRuntime({
      configPath: globalFlags['--config'],
      rootDir: globalFlags['--root'],
      logger: getActiveLogger(),
    });
    try {
      await handleEmitTs(runtime, argv);
    } finally {
      await runtime.close().catch(() => {});
    }
    return;
  }

  const runtime = await createRuntime({
    configPath: globalFlags['--config'],
    rootDir: globalFlags['--root'],
    logger: getActiveLogger(),
  });

  const inference = inferCommandRouting(command, argv, runtime.getDefinitions());
  if (inference.kind === 'abort') {
    process.exitCode = inference.exitCode;
    return;
  }
  const resolvedCommand = inference.command;
  const resolvedArgs = inference.args;

  try {
    if (resolvedCommand === 'list') {
      await handleList(runtime, resolvedArgs);
      return;
    }

    if (resolvedCommand === 'call') {
      await runHandleCall(runtime, resolvedArgs);
      return;
    }

    if (resolvedCommand === 'auth') {
      await handleAuth(runtime, resolvedArgs);
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

  printHelp(`Unknown command '${resolvedCommand}'.`);
  process.exit(1);
}

// printHelp explains available commands and global flags.
function printHelp(message?: string): void {
  if (message) {
    console.error(message);
    console.error('');
  }
  console.error(`Usage: mcporter <command> [options]

Commands:
  list [name] [--schema] [--json]    List configured MCP servers (and tools for a server)
    --json                          Emit machine-readable JSON instead of text output
  call [selector] [flags]            Call a tool (selector like server.tool)
    --tail-log                       Tail log output when the tool returns a log file path
    --output <format>                Output format: auto|text|markdown|json|raw (default auto)
    --raw                            Shortcut for --output raw
  auth <name>                        Complete the OAuth flow for a server without listing tools
  inspect-cli <path> [--json]        Show metadata and regeneration info for a generated CLI artifact
  generate-cli --server <ref>        Generate a standalone CLI
    --name <name>                    Supply a friendly name (otherwise inferred)
    --command <ref>                  MCP command or URL (required without --server)
    --output <path>                  Override output file path
    --bundle [path]                  Create a bundled JS file (auto-named when omitted)
    --compile [path]                 Compile with Bun (implies --bundle); requires Bun
    --minify                         Minify bundled output
    --no-minify                      Disable minification when it's enabled by defaults
    --runtime node|bun               Force runtime selection (auto-detected otherwise)
    --timeout <ms>                   Override introspection timeout (default 30000)
    --from <artifact>                Reuse metadata from an existing CLI artifact
    --dry-run                        Print the resolved generate-cli command without executing (requires --from)

Global flags:
  --config <path>                    Path to mcporter.json (defaults to ./config/mcporter.json)
  --root <path>                      Root directory for stdio command cwd
  --log-level <debug|info|warn|error>  Adjust CLI log verbosity (defaults to warn)

mcporter automatically loads servers from ./config/mcporter.json plus any imports it finds from Cursor,
Claude Code/Desktop, Codex, and other compatible editors—so everything you've already configured is
ready to use.

Examples:
  npx mcporter list
  npx mcporter linear.list_issues limit:5 orderBy:updatedAt
  npx mcporter 'https://www.shadcn.io/api/mcp.getComponents()'
  npx mcporter generate-cli --from dist/context7.js
`);
}

if (process.env.MCPORTER_DISABLE_AUTORUN !== '1') {
  main().catch((error) => {
    if (error instanceof CliUsageError) {
      logError(error.message);
      process.exit(1);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    logError(message, error instanceof Error ? error : undefined);
    process.exit(1);
  });
}
// handleAuth clears cached tokens and executes standalone OAuth flows.
export async function handleAuth(runtime: Awaited<ReturnType<typeof createRuntime>>, args: string[]): Promise<void> {
  // Peel off optional flags before we consume positional args.
  const resetIndex = args.indexOf('--reset');
  const shouldReset = resetIndex !== -1;
  if (shouldReset) {
    args.splice(resetIndex, 1);
  }
  const format = consumeOutputFormat(args, {
    defaultFormat: 'text',
    allowed: ['text', 'json'],
    enableRawShortcut: false,
    jsonShortcutFlag: '--json',
  }) as 'text' | 'json';
  const ephemeralSpec: EphemeralServerSpec | undefined = extractEphemeralServerFlags(args);
  let target = args.shift();
  const nameHints: string[] = [];
  if (ephemeralSpec && target && !looksLikeHttpUrl(target)) {
    nameHints.push(target);
  }

  const prepared = await prepareEphemeralServerTarget({
    runtime,
    target,
    ephemeral: ephemeralSpec,
    nameHints,
    reuseFromSpec: true,
  });
  target = prepared.target;

  if (!target) {
    throw new Error('Usage: mcporter auth <server | url> [--http-url <url> | --stdio <command>]');
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

  // Kick off the interactive OAuth flow without blocking list output. We retry once if the
  // server gets auto-promoted to OAuth mid-flight.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      logInfo(`Initiating OAuth flow for '${target}'...`);
      const tools = await runtime.listTools(target, { autoAuthorize: true });
      logInfo(`Authorization complete. ${tools.length} tool${tools.length === 1 ? '' : 's'} available.`);
      return;
    } catch (error) {
      if (attempt === 0 && shouldRetryAuthError(error)) {
        logWarn('Server signaled OAuth after the initial attempt. Retrying with browser flow...');
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (format === 'json') {
        const payload = buildConnectionIssueEnvelope({
          server: target,
          error,
          issue: analyzeConnectionError(error),
        });
        console.log(JSON.stringify(payload, null, 2));
        process.exitCode = 1;
        return;
      }
      throw new Error(`Failed to authorize '${target}': ${message}`);
    }
  }
}

function shouldRetryAuthError(error: unknown): boolean {
  return analyzeConnectionError(error).kind === 'auth';
}

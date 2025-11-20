#!/usr/bin/env node
import fsPromises from 'node:fs/promises';

import type { EphemeralServerSpec } from './cli/adhoc-server.js';
import { handleCall as runHandleCall, printCallHelp } from './cli/call-command.js';
import { buildGlobalContext } from './cli/cli-factory.js';
import { inferCommandRouting } from './cli/command-inference.js';
import { handleConfigCli } from './cli/config-command.js';
import { handleDaemonCli } from './cli/daemon-command.js';
import { handleEmitTs } from './cli/emit-ts-command.js';
import { extractEphemeralServerFlags } from './cli/ephemeral-flags.js';
import { prepareEphemeralServerTarget } from './cli/ephemeral-target.js';
import { CliUsageError } from './cli/errors.js';
import { handleGenerateCli } from './cli/generate-cli-runner.js';
import { looksLikeHttpUrl } from './cli/http-utils.js';
import { handleInspectCli } from './cli/inspect-cli-command.js';
import { buildConnectionIssueEnvelope } from './cli/json-output.js';
import { handleList, printListHelp } from './cli/list-command.js';
import { logError, logInfo, logWarn } from './cli/logger-context.js';
import { consumeOutputFormat } from './cli/output-format.js';
import { DEBUG_HANG, dumpActiveHandles, terminateChildProcesses } from './cli/runtime-debug.js';
import { boldText, dimText, extraDimText, supportsAnsiColor } from './cli/terminal.js';
import { resolveConfigPath } from './config.js';
import { DaemonClient } from './daemon/client.js';
import { createKeepAliveRuntime } from './daemon/runtime-wrapper.js';
import { analyzeConnectionError } from './error-classifier.js';
import { isKeepAliveServer } from './lifecycle.js';
import { createRuntime, MCPORTER_VERSION } from './runtime.js';

export { parseCallArguments } from './cli/call-arguments.js';
export { handleCall } from './cli/call-command.js';
export { handleGenerateCli } from './cli/generate-cli-runner.js';
export { handleInspectCli } from './cli/inspect-cli-command.js';
export { extractListFlags, handleList } from './cli/list-command.js';
export { resolveCallTimeout } from './cli/timeouts.js';

export async function runCli(argv: string[]): Promise<void> {
  const args = [...argv];
  if (args.length === 0) {
    printHelp();
    process.exit(1);
    return;
  }

  const context = buildGlobalContext(args);
  if ('exit' in context) {
    process.exit(context.code);
    return;
  }
  const { globalFlags, runtimeOptions } = context;
  const command = args.shift();

  if (!command) {
    printHelp();
    process.exit(1);
    return;
  }

  if (isHelpToken(command)) {
    printHelp();
    process.exitCode = 0;
    return;
  }

  if (isVersionToken(command)) {
    await printVersion();
    return;
  }

  // Early-exit command handlers that don't require runtime inference.
  if (command === 'generate-cli') {
    await handleGenerateCli(args, globalFlags);
    return;
  }
  if (command === 'inspect-cli') {
    await handleInspectCli(args);
    return;
  }
  const rootOverride = globalFlags['--root'];
  const configPath = runtimeOptions.configPath ?? globalFlags['--config'];
  const configResolution = resolveConfigPath(globalFlags['--config'], rootOverride ?? process.cwd());
  const configPathResolved = configPath ?? configResolution.path;
  const runtimeOptionsWithPath = {
    ...runtimeOptions,
    configPath: runtimeOptions.configPath ?? configPathResolved,
  };

  if (command === 'daemon') {
    await handleDaemonCli(args, {
      configPath: configPathResolved,
      rootDir: rootOverride,
    });
    return;
  }

  if (command === 'config') {
    await handleConfigCli(
      {
        loadOptions: { configPath, rootDir: rootOverride },
        invokeAuth: (authArgs) => invokeAuthCommand(runtimeOptionsWithPath, authArgs),
      },
      args
    );
    return;
  }

  if (command === 'emit-ts') {
    const runtime = await createRuntime(runtimeOptionsWithPath);
    try {
      await handleEmitTs(runtime, args);
    } finally {
      await runtime.close().catch(() => {});
    }
    return;
  }

  const baseRuntime = await createRuntime(runtimeOptionsWithPath);
  const keepAliveServers = new Set(
    baseRuntime
      .getDefinitions()
      .filter(isKeepAliveServer)
      .map((entry) => entry.name)
  );
  const daemonClient =
    keepAliveServers.size > 0 ? new DaemonClient({ configPath: configResolution.path, rootDir: rootOverride }) : null;
  const runtime = createKeepAliveRuntime(baseRuntime, { daemonClient, keepAliveServers });

  const inference = inferCommandRouting(command, args, runtime.getDefinitions());
  if (inference.kind === 'abort') {
    process.exitCode = inference.exitCode;
    return;
  }
  const resolvedCommand = inference.command;
  const resolvedArgs = inference.args;

  try {
    if (resolvedCommand === 'list') {
      if (consumeHelpTokens(resolvedArgs)) {
        printListHelp();
        process.exitCode = 0;
        return;
      }
      await handleList(runtime, resolvedArgs);
      return;
    }

    if (resolvedCommand === 'call') {
      if (consumeHelpTokens(resolvedArgs)) {
        printCallHelp();
        process.exitCode = 0;
        return;
      }
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

// main parses CLI flags and dispatches to list/call commands.
async function main(): Promise<void> {
  await runCli(process.argv.slice(2));
}

// printHelp explains available commands and global flags.
function printHelp(message?: string): void {
  if (message) {
    console.error(message);
    console.error('');
  }
  const colorize = supportsAnsiColor;
  const sections = buildCommandSections(colorize);
  const globalFlags = formatGlobalFlags(colorize);
  const quickStart = formatQuickStart(colorize);
  const footer = formatHelpFooter(colorize);
  const title = colorize
    ? `${boldText('mcporter')} ${dimText('— Model Context Protocol CLI & generator')}`
    : 'mcporter — Model Context Protocol CLI & generator';
  const lines = [
    title,
    '',
    'Usage: mcporter <command> [options]',
    '',
    ...sections,
    '',
    globalFlags,
    '',
    quickStart,
    '',
    footer,
  ];
  console.error(lines.join('\n'));
}

type HelpEntry = {
  name: string;
  summary: string;
  usage: string;
};

type HelpSection = {
  title: string;
  entries: HelpEntry[];
};

function buildCommandSections(colorize: boolean): string[] {
  const sections: HelpSection[] = [
    {
      title: 'Core commands',
      entries: [
        {
          name: 'list',
          summary: 'List configured servers (add --schema for tool docs)',
          usage: 'mcporter list [name] [--schema] [--json]',
        },
        {
          name: 'call',
          summary: 'Call a tool by selector (server.tool) or HTTP URL; key=value flags supported',
          usage: 'mcporter call <selector> [key=value ...]',
        },
        {
          name: 'auth',
          summary: 'Complete OAuth for a server without listing tools',
          usage: 'mcporter auth <server | url> [--reset]',
        },
      ],
    },
    {
      title: 'Generator & tooling',
      entries: [
        {
          name: 'generate-cli',
          summary: 'Emit a standalone CLI (supports HTTP, stdio, and inline commands)',
          usage: 'mcporter generate-cli --server <name> | --command <ref> [options]',
        },
        {
          name: 'inspect-cli',
          summary: 'Show metadata and regen instructions for a generated CLI',
          usage: 'mcporter inspect-cli <path> [--json]',
        },
        {
          name: 'emit-ts',
          summary: 'Generate TypeScript client/types for a server',
          usage: 'mcporter emit-ts <server> --mode client|types [options]',
        },
      ],
    },
    {
      title: 'Configuration',
      entries: [
        {
          name: 'config',
          summary: 'Inspect or edit config files (list, get, add, remove, import, login, logout)',
          usage: 'mcporter config <command> [options]',
        },
      ],
    },
    {
      title: 'Daemon',
      entries: [
        {
          name: 'daemon',
          summary: 'Manage the keep-alive daemon (start | status | stop | restart)',
          usage: 'mcporter daemon <subcommand>',
        },
      ],
    },
  ];
  return sections.flatMap((section) => formatCommandSection(section, colorize));
}

function formatCommandSection(section: HelpSection, colorize: boolean): string[] {
  const maxNameLength = Math.max(...section.entries.map((entry) => entry.name.length));
  const header = colorize ? boldText(section.title) : section.title;
  const lines = [header];
  section.entries.forEach((entry) => {
    const paddedName = entry.name.padEnd(maxNameLength);
    const renderedName = colorize ? boldText(paddedName) : paddedName;
    const summary = colorize ? dimText(entry.summary) : entry.summary;
    lines.push(`  ${renderedName}  ${summary}`);
    lines.push(`    ${extraDimText('usage:')} ${entry.usage}`);
  });
  return [...lines, ''];
}

function formatGlobalFlags(colorize: boolean): string {
  const title = colorize ? boldText('Global flags') : 'Global flags';
  const entries = [
    {
      flag: '--config <path>',
      summary: 'Path to mcporter.json (defaults to ./config/mcporter.json)',
    },
    {
      flag: '--root <path>',
      summary: 'Working directory for stdio servers',
    },
    {
      flag: '--log-level <debug|info|warn|error>',
      summary: 'Adjust CLI logging (defaults to warn)',
    },
    {
      flag: '--oauth-timeout <ms>',
      summary: 'Time to wait for browser-based OAuth before giving up (default 60000)',
    },
  ];
  const formatted = entries.map((entry) => `  ${entry.flag.padEnd(34)}${entry.summary}`);
  return [title, ...formatted].join('\n');
}

function formatQuickStart(colorize: boolean): string {
  const title = colorize ? boldText('Quick start') : 'Quick start';
  const entries = [
    ['mcporter list', 'show configured servers'],
    ['mcporter list linear --schema', 'view Linear tool docs'],
    ['mcporter call linear.list_issues limit:5', 'invoke a tool with key=value arguments'],
    ['mcporter generate-cli --command https://host/mcp --compile ./my-cli', 'build a standalone CLI/binary'],
  ];
  const formatted = entries.map(([cmd, note]) => {
    const comment = colorize ? dimText(`# ${note}`) : `# ${note}`;
    return `  ${cmd}\n    ${comment}`;
  });
  return [title, ...formatted].join('\n');
}

function formatHelpFooter(colorize: boolean): string {
  const pointer = 'Run `mcporter <command> --help` for detailed flags.';
  const autoLoad =
    'mcporter auto-loads servers from ./config/mcporter.json and editor imports (Cursor, Claude, Codex, etc.).';
  if (!colorize) {
    return `${pointer}\n${autoLoad}`;
  }
  return `${dimText(pointer)}\n${extraDimText(autoLoad)}`;
}

async function printVersion(): Promise<void> {
  console.log(await resolveCliVersion());
}

function isHelpToken(token: string): boolean {
  return token === '--help' || token === '-h' || token === 'help';
}

function consumeHelpTokens(args: string[]): boolean {
  let found = false;
  for (let index = args.length - 1; index >= 0; index -= 1) {
    const token = args[index];
    if (token && isHelpToken(token)) {
      args.splice(index, 1);
      found = true;
    }
  }
  return found;
}

function isVersionToken(token: string): boolean {
  return token === '--version' || token === '-v' || token === '-V';
}

async function resolveCliVersion(): Promise<string> {
  try {
    const packageJsonPath = new URL('../package.json', import.meta.url);
    const buffer = await fsPromises.readFile(packageJsonPath, 'utf8');
    const pkg = JSON.parse(buffer) as { version?: string };
    return pkg.version ?? MCPORTER_VERSION;
  } catch {
    return MCPORTER_VERSION;
  }
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

async function invokeAuthCommand(runtimeOptions: Parameters<typeof createRuntime>[0], args: string[]): Promise<void> {
  const runtime = await createRuntime(runtimeOptions);
  try {
    await handleAuth(runtime, args);
  } finally {
    await runtime.close().catch(() => {});
  }
}

function shouldRetryAuthError(error: unknown): boolean {
  return analyzeConnectionError(error).kind === 'auth';
}

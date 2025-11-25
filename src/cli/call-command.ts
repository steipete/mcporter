import { analyzeConnectionError, type ConnectionIssue } from '../error-classifier.js';
import { wrapCallResult } from '../result-utils.js';
import { type CallArgsParseResult, parseCallArguments } from './call-arguments.js';
import { prepareEphemeralServerTarget } from './ephemeral-target.js';
import { looksLikeHttpUrl, normalizeHttpUrlCandidate } from './http-utils.js';
import type { IdentifierResolution } from './identifier-helpers.js';
import {
  chooseClosestIdentifier,
  normalizeIdentifier,
  renderIdentifierResolutionMessages,
} from './identifier-helpers.js';
import { buildConnectionIssueEnvelope } from './json-output.js';
import { handleList } from './list-command.js';
import type { OutputFormat } from './output-utils.js';
import { printCallOutput, tailLogIfRequested } from './output-utils.js';
import { dumpActiveHandles } from './runtime-debug.js';
import { dimText, redText, yellowText } from './terminal.js';
import { resolveCallTimeout, withTimeout } from './timeouts.js';
import { loadToolMetadata } from './tool-cache.js';

export async function handleCall(
  runtime: Awaited<ReturnType<typeof import('../runtime.js')['createRuntime']>>,
  args: string[]
): Promise<void> {
  const parsed = parseCallArguments(args);
  let ephemeralSpec = parsed.ephemeral ? { ...parsed.ephemeral } : undefined;

  const nameHints: string[] = [];
  const absorbUrlCandidate = (value: string | undefined): string | undefined => {
    if (!value) {
      return value;
    }
    const normalized = normalizeHttpUrlCandidate(value);
    if (!normalized) {
      return value;
    }
    if (!ephemeralSpec) {
      ephemeralSpec = { httpUrl: normalized };
    } else if (!ephemeralSpec.httpUrl) {
      ephemeralSpec = { ...ephemeralSpec, httpUrl: normalized };
    }
    return undefined;
  };

  parsed.server = absorbUrlCandidate(parsed.server);
  parsed.selector = absorbUrlCandidate(parsed.selector);

  if (ephemeralSpec && parsed.server && !looksLikeHttpUrl(parsed.server)) {
    nameHints.push(parsed.server);
    parsed.server = undefined;
  }

  if (ephemeralSpec?.httpUrl && !ephemeralSpec.name && parsed.tool) {
    const candidate = parsed.selector && !looksLikeHttpUrl(parsed.selector) ? parsed.selector : undefined;
    if (candidate) {
      nameHints.push(candidate);
      parsed.selector = undefined;
    }
  }

  const prepared = await prepareEphemeralServerTarget({
    runtime,
    target: parsed.server,
    ephemeral: ephemeralSpec,
    nameHints,
    reuseFromSpec: true,
  });

  parsed.server = prepared.target;
  if (!parsed.selector) {
    parsed.selector = prepared.target;
  }

  const target = resolveCallTarget(parsed, { allowMissingTool: true });
  const server = target.server;
  let tool = target.tool;
  if (!server) {
    throw new Error('Missing server name. Provide it via <server>.<tool> or --server.');
  }
  if (!tool) {
    tool = await inferSingleToolName(runtime, server);
    if (!tool) {
      throw new Error('Missing tool name. Provide it via <server>.<tool> or --tool.');
    }
  }

  if (await maybeDescribeServer(runtime, server, tool, parsed.output)) {
    return;
  }

  const timeoutMs = resolveCallTimeout(parsed.timeoutMs);
  const hydratedArgs = await hydratePositionalArguments(runtime, server, tool, parsed.args, parsed.positionalArgs);
  let invocation: { result: unknown; resolvedTool: string };
  try {
    invocation = await invokeWithAutoCorrection(runtime, server, tool, hydratedArgs, timeoutMs);
  } catch (error) {
    const issue = maybeReportConnectionIssue(server, tool, error);
    if (parsed.output === 'json' || parsed.output === 'raw') {
      const payload = buildConnectionIssueEnvelope({ server, tool, error, issue });
      console.log(JSON.stringify(payload, null, 2));
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  const { result } = invocation;

  const { callResult: wrapped } = wrapCallResult(result);
  printCallOutput(wrapped, result, parsed.output);
  tailLogIfRequested(result, parsed.tailLog);
  dumpActiveHandles('after call (formatted result)');
}

export function printCallHelp(): void {
  const lines = [
    'Usage: mcporter call <server.tool | url> [arguments] [flags]',
    '',
    'Selectors:',
    '  server.tool            Use a configured server and tool (e.g., linear.list_issues).',
    '  https://host/mcp.tool  Call a tool by full HTTP URL (auto-registers ad-hoc).',
    '  --server <name>        Override the server name.',
    '  --tool <name>          Override the tool name.',
    '',
    'Arguments:',
    '  key=value / key:value  Flag-style named arguments.',
    "  function-call syntax   'server.tool(arg: \"value\", other: 1)'.",
    '  --args <json>          Provide a JSON object payload.',
    '  positional values      Accepted when schema order is known.',
    '',
    'Runtime flags:',
    '  --timeout <ms>         Override the call timeout.',
    '  --output text|markdown|json|raw  Control formatting.',
    '  --tail-log             Stream returned log handles.',
    '',
    'Ad-hoc servers:',
    '  --http-url <url>       Register an HTTP server for this run.',
    '  --allow-http           Permit plain http:// URLs with --http-url.',
    '  --stdio <command>      Run a stdio MCP server (repeat --stdio-arg for args).',
    '  --stdio-arg <value>    Append args to the stdio command (repeatable).',
    '  --env KEY=value        Inject env vars for stdio servers (repeatable).',
    '  --cwd <path>           Working directory for stdio servers.',
    '  --name <value>         Override the display name for ad-hoc servers.',
    '  --description <text>   Override the description for ad-hoc servers.',
    '  --persist <path>       Write the ad-hoc definition to config/mcporter.json.',
    '  --yes                  Skip confirmation prompts when persisting.',
    '',
    'Examples:',
    '  mcporter call linear.list_issues team=ENG limit:5',
    '  mcporter call "linear.create_issue(title: \\"Bug\\", team: \\"ENG\\")"',
    '  mcporter call https://api.example.com/mcp.fetch url:https://example.com',
    '  mcporter call --stdio "bun run ./server.ts" scrape url=https://example.com',
  ];
  console.error(lines.join('\n'));
}

async function maybeDescribeServer(
  runtime: Awaited<ReturnType<typeof import('../runtime.js')['createRuntime']>>,
  server: string,
  tool: string,
  outputFormat: OutputFormat
): Promise<boolean> {
  if (tool === 'list_tools') {
    console.log(dimText(`[mcporter] ${server}.list_tools is a shortcut for 'mcporter list ${server}'.`));
    const listArgs = [server];
    if (outputFormat === 'json') {
      listArgs.push('--json');
    }
    await handleList(runtime, listArgs);
    return true;
  }
  if (tool !== 'help') {
    return false;
  }
  const tools = await runtime.listTools(server, { includeSchema: false, autoAuthorize: false }).catch(() => undefined);
  if (!tools) {
    return false;
  }
  const hasHelpTool = tools.some((entry) => entry.name === 'help');
  if (hasHelpTool) {
    return false;
  }
  console.log(dimText(`[mcporter] ${server} does not expose a 'help' tool; showing mcporter list output instead.`));
  const listArgs = [server];
  if (outputFormat === 'json') {
    listArgs.push('--json');
  }
  await handleList(runtime, listArgs);
  return true;
}

interface ResolveCallTargetOptions {
  allowMissingTool?: boolean;
}

function resolveCallTarget(
  parsed: CallArgsParseResult,
  options: ResolveCallTargetOptions = {}
): { server?: string; tool?: string } {
  const selector = parsed.selector;
  let server = parsed.server;
  let tool = parsed.tool;

  if (selector && !server && selector.includes('.')) {
    const [left, right] = selector.split('.', 2);
    server = left;
    tool = right;
  } else if (selector && !server) {
    server = selector;
  } else if (selector && !tool && selector !== server) {
    tool = selector;
  }

  if (!server) {
    throw new Error('Missing server name. Provide it via <server>.<tool> or --server.');
  }
  if (!tool && !options.allowMissingTool) {
    throw new Error('Missing tool name. Provide it via <server>.<tool> or --tool.');
  }

  return { server, tool };
}

async function hydratePositionalArguments(
  runtime: Awaited<ReturnType<typeof import('../runtime.js')['createRuntime']>>,
  server: string,
  tool: string,
  namedArgs: Record<string, unknown>,
  positionalArgs: unknown[] | undefined
): Promise<Record<string, unknown>> {
  if (!positionalArgs || positionalArgs.length === 0) {
    return namedArgs;
  }
  // We need the schema order to know which field each positional argument maps to; pull the
  // tool list with schemas instead of guessing locally so optional/required order stays correct.
  const tools = await loadToolMetadata(runtime, server, { includeSchema: true }).catch(() => undefined);
  if (!tools) {
    throw new Error('Unable to load tool metadata; name positional arguments explicitly.');
  }
  const toolInfo = tools.find((entry) => entry.tool.name === tool);
  if (!toolInfo) {
    throw new Error(
      `Unknown tool '${tool}' on server '${server}'. Double-check the name or run mcporter list ${server}.`
    );
  }
  if (!toolInfo.tool.inputSchema) {
    throw new Error(`Tool '${tool}' does not expose an input schema; name positional arguments explicitly.`);
  }
  const options = toolInfo.options;
  if (options.length === 0) {
    throw new Error(`Tool '${tool}' has no declared parameters; remove positional arguments.`);
  }
  // Respect whichever parameters the user already supplied by name so positional values only
  // populate the fields that are still unset.
  const remaining = options.filter((option) => !(option.property in namedArgs));
  if (positionalArgs.length > remaining.length) {
    throw new Error(
      `Too many positional arguments (${positionalArgs.length}) supplied; only ${remaining.length} parameter${remaining.length === 1 ? '' : 's'} remain on ${tool}.`
    );
  }
  const hydrated: Record<string, unknown> = { ...namedArgs };
  positionalArgs.forEach((value, index) => {
    const target = remaining[index];
    if (!target) {
      return;
    }
    hydrated[target.property] = value;
  });
  return hydrated;
}

type ToolResolution = IdentifierResolution;

async function inferSingleToolName(
  runtime: Awaited<ReturnType<typeof import('../runtime.js')['createRuntime']>>,
  server: string
): Promise<string | undefined> {
  const tools = await loadToolMetadata(runtime, server, { includeSchema: false });
  if (tools.length !== 1) {
    return undefined;
  }
  const name = tools[0]?.tool.name;
  if (!name) {
    return undefined;
  }
  console.log(dimText(`[auto] ${server} exposes a single tool (${name}); using it.`));
  return name;
}

async function invokeWithAutoCorrection(
  runtime: Awaited<ReturnType<typeof import('../runtime.js')['createRuntime']>>,
  server: string,
  tool: string,
  args: Record<string, unknown>,
  timeoutMs: number
): Promise<{ result: unknown; resolvedTool: string }> {
  // Attempt the original request first; if it fails with a "tool not found" we opportunistically retry once with a better match.
  return attemptCall(runtime, server, tool, args, timeoutMs, true);
}

async function attemptCall(
  runtime: Awaited<ReturnType<typeof import('../runtime.js')['createRuntime']>>,
  server: string,
  tool: string,
  args: Record<string, unknown>,
  timeoutMs: number,
  allowCorrection: boolean
): Promise<{ result: unknown; resolvedTool: string }> {
  try {
    const result = await withTimeout(runtime.callTool(server, tool, { args, timeoutMs }), timeoutMs);
    return { result, resolvedTool: tool };
  } catch (error) {
    if (error instanceof Error && error.message === 'Timeout') {
      const timeoutDisplay = `${timeoutMs}ms`;
      await runtime.close(server).catch(() => {});
      throw new Error(
        `Call to ${server}.${tool} timed out after ${timeoutDisplay}. Override MCPORTER_CALL_TIMEOUT or pass --timeout to adjust.`
      );
    }

    if (!allowCorrection) {
      throw error;
    }

    const resolution = await maybeResolveToolName(runtime, server, tool, error);
    if (!resolution) {
      maybeReportConnectionIssue(server, tool, error);
      throw error;
    }

    const messages = renderIdentifierResolutionMessages({
      entity: 'tool',
      attempted: tool,
      resolution,
      scope: server,
    });
    if (resolution.kind === 'suggest') {
      if (messages.suggest) {
        console.error(dimText(messages.suggest));
      }
      throw error;
    }
    if (messages.auto) {
      console.log(dimText(messages.auto));
    }
    return attemptCall(runtime, server, resolution.value, args, timeoutMs, false);
  }
}

async function maybeResolveToolName(
  runtime: Awaited<ReturnType<typeof import('../runtime.js')['createRuntime']>>,
  server: string,
  attemptedTool: string,
  error: unknown
): Promise<ToolResolution | undefined> {
  const missingName = extractMissingToolFromError(error);
  if (!missingName) {
    return undefined;
  }

  // Only attempt a suggestion if the server explicitly rejected the tool we tried.
  if (normalizeIdentifier(missingName) !== normalizeIdentifier(attemptedTool)) {
    return undefined;
  }

  const tools = await loadToolMetadata(runtime, server, { includeSchema: false }).catch(() => undefined);
  if (!tools) {
    return undefined;
  }

  const resolution = chooseClosestIdentifier(
    attemptedTool,
    tools.map((entry) => entry.tool.name)
  );
  if (!resolution) {
    return undefined;
  }
  return resolution;
}

function extractMissingToolFromError(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : undefined;
  if (!message) {
    return undefined;
  }
  const match = message.match(/Tool\s+([A-Za-z0-9._-]+)\s+not found/i);
  return match?.[1];
}

function maybeReportConnectionIssue(server: string, tool: string, error: unknown): ConnectionIssue | undefined {
  const issue = analyzeConnectionError(error);
  const detail = summarizeIssueMessage(issue.rawMessage);
  if (issue.kind === 'auth') {
    const authCommand = `mcporter auth ${server}`;
    const hint = `[mcporter] Authorization required for ${server}. Run '${authCommand}'.${detail ? ` (${detail})` : ''}`;
    console.error(yellowText(hint));
    return issue;
  }
  if (issue.kind === 'offline') {
    const hint = `[mcporter] ${server} appears offline${detail ? ` (${detail})` : ''}.`;
    console.error(redText(hint));
    return issue;
  }
  if (issue.kind === 'http') {
    const status = issue.statusCode ? `HTTP ${issue.statusCode}` : 'an HTTP error';
    const hint = `[mcporter] ${server}.${tool} responded with ${status}${detail ? ` (${detail})` : ''}.`;
    console.error(dimText(hint));
    return issue;
  }
  if (issue.kind === 'stdio-exit') {
    const exit = typeof issue.stdioExitCode === 'number' ? `code ${issue.stdioExitCode}` : 'an unknown status';
    const signal = issue.stdioSignal ? ` (signal ${issue.stdioSignal})` : '';
    const hint = `[mcporter] STDIO server for ${server} exited with ${exit}${signal}.`;
    console.error(redText(hint));
  }
  return issue;
}

function summarizeIssueMessage(message: string): string {
  if (!message) {
    return '';
  }
  const trimmed = message.trim();
  if (trimmed.length <= 120) {
    return trimmed;
  }
  return `${trimmed.slice(0, 117)}…`;
}

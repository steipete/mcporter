import ora from 'ora';
import type { ServerDefinition } from '../config.js';
import type { EphemeralServerSpec } from './adhoc-server.js';
import { extractEphemeralServerFlags } from './ephemeral-flags.js';
import { prepareEphemeralServerTarget } from './ephemeral-target.js';
import type { ToolMetadata } from './generate/tools.js';
import { splitHttpToolSelector } from './http-utils.js';
import { chooseClosestIdentifier, renderIdentifierResolutionMessages } from './identifier-helpers.js';
import type { SerializedConnectionIssue } from './json-output.js';
import { formatErrorMessage, serializeConnectionIssue } from './json-output.js';
import { buildToolDoc, formatExampleBlock } from './list-detail-helpers.js';
import type { ListSummaryResult, StatusCategory } from './list-format.js';
import { classifyListError, formatSourceSuffix, renderServerListRow } from './list-format.js';
import { consumeOutputFormat } from './output-format.js';
import { boldText, dimText, extraDimText, supportsSpinner, yellowText } from './terminal.js';
import { consumeTimeoutFlag, LIST_TIMEOUT_MS, withTimeout } from './timeouts.js';
import { loadToolMetadata } from './tool-cache.js';
import { formatTransportSummary } from './transport-utils.js';

export function extractListFlags(args: string[]): {
  schema: boolean;
  timeoutMs?: number;
  requiredOnly: boolean;
  ephemeral?: EphemeralServerSpec;
  format: ListOutputFormat;
} {
  let schema = false;
  let timeoutMs: number | undefined;
  let requiredOnly = true;
  const format = consumeOutputFormat(args, {
    defaultFormat: 'text',
    allowed: ['text', 'json'],
    enableRawShortcut: false,
    jsonShortcutFlag: '--json',
  }) as ListOutputFormat;
  const ephemeral = extractEphemeralServerFlags(args);
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (token === '--schema') {
      schema = true;
      args.splice(index, 1);
      continue;
    }
    if (token === '--yes') {
      args.splice(index, 1);
      continue;
    }
    if (token === '--all-parameters') {
      requiredOnly = false;
      args.splice(index, 1);
      continue;
    }
    if (token === '--timeout') {
      timeoutMs = consumeTimeoutFlag(args, index, { flagName: '--timeout' });
      continue;
    }
    index += 1;
  }
  return { schema, timeoutMs, requiredOnly, ephemeral, format };
}

type ListOutputFormat = 'text' | 'json';

export async function handleList(
  runtime: Awaited<ReturnType<typeof import('../runtime.js')['createRuntime']>>,
  args: string[]
): Promise<void> {
  const flags = extractListFlags(args);
  let target = args.shift();

  if (target) {
    const split = splitHttpToolSelector(target);
    if (split) {
      target = split.baseUrl;
    }
  }

  const prepared = await prepareEphemeralServerTarget({
    runtime,
    target,
    ephemeral: flags.ephemeral,
  });
  target = prepared.target;

  if (!target) {
    const servers = runtime.getDefinitions();
    const perServerTimeoutMs = flags.timeoutMs ?? LIST_TIMEOUT_MS;
    const perServerTimeoutSeconds = Math.round(perServerTimeoutMs / 1000);

    if (servers.length === 0) {
      if (flags.format === 'json') {
        const payload = {
          mode: 'list',
          counts: createEmptyStatusCounts(),
          servers: [] as ListJsonServerEntry[],
        };
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log('No MCP servers configured.');
      }
      return;
    }

    if (flags.format === 'text') {
      console.log(`Listing ${servers.length} server(s) (per-server timeout: ${perServerTimeoutSeconds}s)`);
    }
    const spinner =
      flags.format === 'text' && supportsSpinner ? ora(`Discovering ${servers.length} server(s)…`).start() : undefined;
    const renderedResults =
      flags.format === 'text'
        ? (Array.from({ length: servers.length }, () => undefined) as Array<
            ReturnType<typeof renderServerListRow> | undefined
          >)
        : undefined;
    const summaryResults: Array<ListSummaryResult | undefined> = Array.from(
      { length: servers.length },
      () => undefined
    );
    let completedCount = 0;

    const tasks = servers.map((server, index) =>
      (async (): Promise<ListSummaryResult> => {
        const startedAt = Date.now();
        try {
          const tools = await withTimeout(runtime.listTools(server.name, { autoAuthorize: false }), perServerTimeoutMs);
          return {
            server,
            status: 'ok' as const,
            tools,
            durationMs: Date.now() - startedAt,
          };
        } catch (error) {
          return {
            server,
            status: 'error' as const,
            error,
            durationMs: Date.now() - startedAt,
          };
        }
      })().then((result) => {
        summaryResults[index] = result;
        if (renderedResults) {
          const rendered = renderServerListRow(result, perServerTimeoutMs);
          renderedResults[index] = rendered;
          completedCount += 1;
          if (spinner) {
            spinner.stop();
            console.log(rendered.line);
            const remaining = servers.length - completedCount;
            if (remaining > 0) {
              spinner.text = `Listing servers… ${completedCount}/${servers.length}`;
              spinner.start();
            }
          } else {
            console.log(rendered.line);
          }
        }
        return result;
      })
    );

    await Promise.all(tasks);

    if (flags.format === 'json') {
      const jsonEntries = summaryResults.map((entry, index) => {
        const serverDefinition = servers[index] ?? entry?.server ?? servers[0];
        if (!serverDefinition) {
          throw new Error('Unable to resolve server definition for JSON output.');
        }
        const normalizedEntry = entry ?? createUnknownResult(serverDefinition);
        return buildJsonListEntry(normalizedEntry, perServerTimeoutSeconds, {
          includeSchemas: Boolean(flags.schema),
        });
      });
      const counts = summarizeStatusCounts(jsonEntries);
      console.log(JSON.stringify({ mode: 'list', counts, servers: jsonEntries }, null, 2));
      return;
    }

    if (spinner) {
      spinner.stop();
    }
    const errorCounts = createEmptyStatusCounts();
    renderedResults?.forEach((entry) => {
      if (!entry) {
        return;
      }
      const category = entry.category ?? 'error';
      errorCounts[category] = (errorCounts[category] ?? 0) + 1;
    });
    const okSummary = `${errorCounts.ok} healthy`;
    const parts = [
      okSummary,
      ...(errorCounts.auth > 0 ? [`${errorCounts.auth} auth required`] : []),
      ...(errorCounts.offline > 0 ? [`${errorCounts.offline} offline`] : []),
      ...(errorCounts.http > 0 ? [`${errorCounts.http} http errors`] : []),
      ...(errorCounts.error > 0 ? [`${errorCounts.error} errors`] : []),
    ];
    console.log(`✔ Listed ${servers.length} server${servers.length === 1 ? '' : 's'} (${parts.join('; ')}).`);
    return;
  }

  const resolved = resolveServerDefinition(runtime, target);
  if (!resolved) {
    return;
  }
  target = resolved.name;
  const definition = resolved.definition;
  const timeoutMs = flags.timeoutMs ?? LIST_TIMEOUT_MS;
  const sourcePath =
    definition.source?.kind === 'import' || definition.source?.kind === 'local'
      ? formatSourceSuffix(definition.source, true)
      : undefined;
  const transportSummary = formatTransportSummary(definition);
  const startedAt = Date.now();
  if (flags.format === 'json') {
    try {
      const metadataEntries = await withTimeout(loadToolMetadata(runtime, target, { includeSchema: true }), timeoutMs);
      const durationMs = Date.now() - startedAt;
      const payload = {
        mode: 'server',
        name: definition.name,
        status: 'ok' as StatusCategory,
        durationMs,
        description: definition.description,
        transport: transportSummary,
        source: definition.source,
        tools: metadataEntries.map((entry) => ({
          name: entry.tool.name,
          description: entry.tool.description,
          inputSchema: entry.tool.inputSchema,
          outputSchema: entry.tool.outputSchema,
          options: entry.options,
        })),
      };
      console.log(JSON.stringify(payload, null, 2));
      return;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const authCommand = buildAuthCommandHint(definition);
      const advice = classifyListError(error, definition.name, timeoutMs, { authCommand });
      const payload = {
        mode: 'server',
        name: definition.name,
        status: advice.category,
        durationMs,
        description: definition.description,
        transport: transportSummary,
        source: definition.source,
        issue: advice.issue,
        authCommand: advice.authCommand,
        error: advice.summary,
      };
      console.log(JSON.stringify(payload, null, 2));
      process.exitCode = 1;
      return;
    }
  }
  try {
    // Always request schemas so we can render CLI-style parameter hints without re-querying per tool.
    const metadataEntries = await withTimeout(loadToolMetadata(runtime, target, { includeSchema: true }), timeoutMs);
    const durationMs = Date.now() - startedAt;
    const summaryLine = printSingleServerHeader(
      definition,
      metadataEntries.length,
      durationMs,
      transportSummary,
      sourcePath,
      {
        printSummaryNow: false,
      }
    );
    if (metadataEntries.length === 0) {
      console.log('  Tools: <none>');
      console.log(summaryLine);
      console.log('');
      return;
    }
    const examples: string[] = [];
    let optionalOmitted = false;
    for (const entry of metadataEntries) {
      const detail = printToolDetail(target, entry, Boolean(flags.schema), flags.requiredOnly);
      examples.push(...detail.examples);
      optionalOmitted ||= detail.optionalOmitted;
    }
    const uniqueExamples = formatExampleBlock(examples);
    if (uniqueExamples.length > 0) {
      console.log(`  ${dimText('Examples:')}`);
      for (const example of uniqueExamples) {
        console.log(`    ${example}`);
      }
      console.log('');
    }
    if (flags.requiredOnly && optionalOmitted) {
      console.log(`  ${extraDimText('Optional parameters hidden; run with --all-parameters to view all fields.')}`);
      console.log('');
    }
    console.log(summaryLine);
    console.log('');
    return;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    printSingleServerHeader(definition, undefined, durationMs, transportSummary, sourcePath);
    const message = error instanceof Error ? error.message : 'Failed to load tool list.';
    const timeoutMs = flags.timeoutMs ?? LIST_TIMEOUT_MS;
    const authCommand = buildAuthCommandHint(definition);
    const advice = classifyListError(error, definition.name, timeoutMs, { authCommand });
    console.warn(`  Tools: <timed out after ${timeoutMs}ms>`);
    console.warn(`  Reason: ${message}`);
    if (advice.category === 'auth' && advice.authCommand) {
      console.warn(`  Next: run '${advice.authCommand}' to finish authentication.`);
    }
  }
}

function indent(text: string, pad: string): string {
  return text
    .split('\n')
    .map((line) => pad + line)
    .join('\n');
}

interface ToolDetailResult {
  examples: string[];
  optionalOmitted: boolean;
}

function printSingleServerHeader(
  definition: ReturnType<Awaited<ReturnType<typeof import('../runtime.js')['createRuntime']>>['getDefinition']>,
  toolCount: number | undefined,
  durationMs: number | undefined,
  transportSummary: string,
  sourcePath: string | undefined,
  options?: { printSummaryNow?: boolean }
): string {
  const prefix = boldText(definition.name);
  if (definition.description) {
    console.log(`${prefix} - ${extraDimText(definition.description)}`);
  } else {
    console.log(prefix);
  }
  const summaryParts: string[] = [];
  summaryParts.push(
    extraDimText(typeof toolCount === 'number' ? `${toolCount} tool${toolCount === 1 ? '' : 's'}` : 'tools unavailable')
  );
  if (typeof durationMs === 'number') {
    summaryParts.push(extraDimText(`${durationMs}ms`));
  }
  if (transportSummary) {
    summaryParts.push(extraDimText(transportSummary));
  }
  if (sourcePath) {
    summaryParts.push(sourcePath);
  }
  const summaryLine = `  ${summaryParts.join(extraDimText(' · '))}`;
  if (options?.printSummaryNow === false) {
    console.log('');
  } else {
    console.log(summaryLine);
    console.log('');
  }
  return summaryLine;
}

function printToolDetail(
  serverName: string,
  metadata: ToolMetadata,
  includeSchema: boolean,
  requiredOnly: boolean
): ToolDetailResult {
  const doc = buildToolDoc({
    serverName,
    toolName: metadata.tool.name,
    description: metadata.tool.description,
    outputSchema: metadata.tool.outputSchema,
    options: metadata.options,
    requiredOnly,
    colorize: true,
  });
  if (doc.docLines) {
    for (const line of doc.docLines) {
      console.log(`  ${line}`);
    }
  }
  console.log(`  ${doc.signature}`);
  if (doc.optionalSummary && requiredOnly) {
    console.log(`  ${doc.optionalSummary}`);
  }
  if (includeSchema && metadata.tool.inputSchema) {
    // Schemas can be large — indenting keeps multi-line JSON legible without disrupting surrounding output.
    console.log(indent(JSON.stringify(metadata.tool.inputSchema, null, 2), '      '));
  }
  console.log('');
  return {
    examples: doc.examples,
    optionalOmitted: doc.hiddenOptions.length > 0,
  };
}

interface ListJsonServerEntry {
  name: string;
  status: StatusCategory;
  durationMs: number;
  description?: string;
  transport?: string;
  source?: ServerDefinition['source'];
  tools?: Array<{
    name: string;
    description?: string;
    inputSchema?: unknown;
    outputSchema?: unknown;
  }>;
  issue?: SerializedConnectionIssue;
  authCommand?: string;
  error?: string;
}

function createEmptyStatusCounts(): Record<StatusCategory, number> {
  return {
    ok: 0,
    auth: 0,
    offline: 0,
    http: 0,
    error: 0,
  };
}

function summarizeStatusCounts(entries: ListJsonServerEntry[]): Record<StatusCategory, number> {
  const counts = createEmptyStatusCounts();
  entries.forEach((entry) => {
    counts[entry.status] = (counts[entry.status] ?? 0) + 1;
  });
  return counts;
}

function buildJsonListEntry(
  result: ListSummaryResult,
  timeoutSeconds: number,
  options: { includeSchemas: boolean }
): ListJsonServerEntry {
  if (result.status === 'ok') {
    return {
      name: result.server.name,
      status: 'ok',
      durationMs: result.durationMs,
      description: result.server.description,
      transport: formatTransportSummary(
        result.server as ReturnType<
          Awaited<ReturnType<typeof import('../runtime.js')['createRuntime']>>['getDefinition']
        >
      ),
      source: result.server.source,
      tools: result.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: options.includeSchemas ? tool.inputSchema : undefined,
        outputSchema: options.includeSchemas ? tool.outputSchema : undefined,
      })),
    };
  }
  const authCommand = buildAuthCommandHint(
    result.server as ReturnType<Awaited<ReturnType<typeof import('../runtime.js')['createRuntime']>>['getDefinition']>
  );
  const advice = classifyListError(result.error, result.server.name, timeoutSeconds, { authCommand });
  return {
    name: result.server.name,
    status: advice.category,
    durationMs: result.durationMs,
    description: result.server.description,
    transport: formatTransportSummary(
      result.server as ReturnType<Awaited<ReturnType<typeof import('../runtime.js')['createRuntime']>>['getDefinition']>
    ),
    source: result.server.source,
    issue: serializeConnectionIssue(advice.issue),
    authCommand: advice.authCommand,
    error: formatErrorMessage(result.error),
  };
}

function createUnknownResult(server: ServerDefinition): ListSummaryResult {
  return {
    status: 'error',
    server,
    error: new Error('Unknown server result'),
    durationMs: 0,
  };
}

function buildAuthCommandHint(
  definition: ReturnType<Awaited<ReturnType<typeof import('../runtime.js')['createRuntime']>>['getDefinition']>
): string {
  if (definition.source?.kind === 'local' && definition.source.path === '<adhoc>') {
    if (definition.command.kind === 'http') {
      const url = definition.command.url instanceof URL ? definition.command.url.href : String(definition.command.url);
      return `mcporter auth ${url}`;
    }
    if (definition.command.kind === 'stdio') {
      const parts = [definition.command.command, ...(definition.command.args ?? [])];
      const rendered = parts.map(quoteCommandSegment).join(' ').trim();
      return rendered.length > 0 ? `mcporter auth --stdio ${rendered}` : 'mcporter auth --stdio';
    }
  }
  return `mcporter auth ${definition.name}`;
}

function quoteCommandSegment(segment: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(segment)) {
    return segment;
  }
  return JSON.stringify(segment);
}

function resolveServerDefinition(
  runtime: Awaited<ReturnType<typeof import('../runtime.js')['createRuntime']>>,
  name: string
): { definition: ServerDefinition; name: string } | undefined {
  try {
    const definition = runtime.getDefinition(name);
    return { definition, name };
  } catch (error) {
    if (!(error instanceof Error) || !/Unknown MCP server/i.test(error.message)) {
      throw error;
    }
    const suggestion = suggestServerName(runtime, name);
    if (!suggestion) {
      console.error(error.message);
      return undefined;
    }
    const messages = renderIdentifierResolutionMessages({
      entity: 'server',
      attempted: name,
      resolution: suggestion,
    });
    if (suggestion.kind === 'auto' && messages.auto) {
      console.log(dimText(messages.auto));
      return resolveServerDefinition(runtime, suggestion.value);
    }
    if (messages.suggest) {
      console.error(yellowText(messages.suggest));
    }
    console.error(error.message);
    return undefined;
  }
}

function suggestServerName(
  runtime: Awaited<ReturnType<typeof import('../runtime.js')['createRuntime']>>,
  attempted: string
) {
  const definitions = runtime.getDefinitions();
  const names = definitions.map((entry) => entry.name);
  return chooseClosestIdentifier(attempted, names);
}

import ora from 'ora';
import type { ServerToolInfo } from '../runtime.js';
import type { GeneratedOption } from './generate/tools.js';
import { extractOptions } from './generate/tools.js';
import type { ListSummaryResult, StatusCategory } from './list-format.js';
import { formatSourceSuffix, renderServerListRow } from './list-format.js';
import { boldText, cyanText, dimText, supportsSpinner } from './terminal.js';
import { LIST_TIMEOUT_MS, withTimeout } from './timeouts.js';

export function extractListFlags(args: string[]): { schema: boolean; timeoutMs?: number } {
  let schema = false;
  let timeoutMs: number | undefined;
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (token === '--schema') {
      schema = true;
      args.splice(index, 1);
      continue;
    }
    if (token === '--timeout') {
      const value = args[index + 1];
      if (!value) {
        throw new Error("Flag '--timeout' requires a value.");
      }
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error('--timeout must be a positive integer (milliseconds).');
      }
      timeoutMs = parsed;
      args.splice(index, 2);
      continue;
    }
    index += 1;
  }
  return { schema, timeoutMs };
}

export async function handleList(
  runtime: Awaited<ReturnType<typeof import('../runtime.js')['createRuntime']>>,
  args: string[]
): Promise<void> {
  const flags = extractListFlags(args);
  const target = args.shift();

  if (!target) {
    const servers = runtime.getDefinitions();
    const perServerTimeoutMs = flags.timeoutMs ?? LIST_TIMEOUT_MS;
    const perServerTimeoutSeconds = Math.round(perServerTimeoutMs / 1000);

    if (servers.length === 0) {
      console.log('No MCP servers configured.');
      return;
    }

    console.log(`Listing ${servers.length} server(s) (per-server timeout: ${perServerTimeoutSeconds}s)`);
    const spinner = supportsSpinner ? ora(`Discovering ${servers.length} server(s)…`).start() : undefined;
    const spinnerActive = Boolean(spinner);
    // Track rendered rows separately so we can show live progress yet still build an ordered footer summary afterward.
    const renderedResults: Array<ReturnType<typeof renderServerListRow> | undefined> = Array.from(
      { length: servers.length },
      () => undefined
    );
    let completedCount = 0;

    // Kick off every list request up-front so slow servers don't block faster ones.
    const tasks = servers.map((server, index) =>
      (async (): Promise<ListSummaryResult> => {
        const startedAt = Date.now();
        try {
          // autoAuthorize=false keeps the list command purely observational—no auth prompts mid-run.
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
        const rendered = renderServerListRow(result, perServerTimeoutMs);
        // Persist results in the original index so the final summary prints in config order, even though tasks resolve out of order.
        renderedResults[index] = rendered;
        completedCount += 1;

        if (spinnerActive && spinner) {
          spinner.stop();
          console.log(rendered.line);
          const remaining = servers.length - completedCount;
          if (remaining > 0) {
            // Switch the spinner to a count-only message so we avoid re-printing the last server name over and over.
            spinner.text = `Listing servers… ${completedCount}/${servers.length} · remaining: ${remaining}`;
            spinner.start();
          }
        } else {
          console.log(rendered.line);
        }

        return result;
      })
    );

    await Promise.all(tasks);

    const errorCounts: Record<StatusCategory, number> = {
      ok: 0,
      auth: 0,
      offline: 0,
      error: 0,
    };
    renderedResults.forEach((entry) => {
      if (!entry) {
        return;
      }
      // Default anything unexpected to the error bucket so the footer still surfaces that something went wrong.
      const category = (entry as { category?: StatusCategory }).category ?? 'error';
      errorCounts[category] = (errorCounts[category] ?? 0) + 1;
    });
    if (spinnerActive && spinner) {
      spinner.stop();
    }
    const okSummary = `${errorCounts.ok} healthy`;
    const parts = [
      okSummary,
      ...(errorCounts.auth > 0 ? [`${errorCounts.auth} auth required`] : []),
      ...(errorCounts.offline > 0 ? [`${errorCounts.offline} offline`] : []),
      ...(errorCounts.error > 0 ? [`${errorCounts.error} errors`] : []),
    ];
    console.log(`✔ Listed ${servers.length} server${servers.length === 1 ? '' : 's'} (${parts.join('; ')}).`);
    return;
  }

  const definition = runtime.getDefinition(target);
  const timeoutMs = flags.timeoutMs ?? LIST_TIMEOUT_MS;
  const sourcePath = formatSourceSuffix(definition.source, true);
  const transportSummary =
    definition.command.kind === 'http'
      ? `HTTP ${definition.command.url instanceof URL ? definition.command.url.href : String(definition.command.url)}`
      : `STDIO ${[definition.command.command, ...(definition.command.args ?? [])].join(' ')}`.trim();
  const serverSummary = `${definition.description ?? '<none>'}${transportSummary ? ` [${transportSummary}]` : ''}`;
  const headerLabel = boldText(target);
  console.log(`${headerLabel} - ${serverSummary}`);
  if (sourcePath) {
    console.log(`  Source: ${sourcePath}`);
  }
  try {
    // Always request schemas so we can render CLI-style parameter hints without re-querying per tool.
    const tools = await withTimeout(runtime.listTools(target, { includeSchema: true }), timeoutMs);
    if (tools.length === 0) {
      console.log('  Tools: <none>');
      return;
    }
    const examples: string[] = [];
    for (const tool of tools) {
      const example = printToolDetail(target, tool, Boolean(flags.schema));
      if (example) {
        examples.push(example);
      }
    }
    const uniqueExamples = Array.from(new Set(examples)).filter(Boolean).slice(0, 3);
    if (uniqueExamples.length > 0) {
      console.log(`  ${dimText('Examples:')}`);
      for (const example of uniqueExamples) {
        console.log(`    ${example}`);
      }
      console.log('');
    }
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load tool list.';
    const timeoutMs = flags.timeoutMs ?? LIST_TIMEOUT_MS;
    console.warn(`  Tools: <timed out after ${timeoutMs}ms>`);
    console.warn(`  Reason: ${message}`);
  }
}

function indent(text: string, pad: string): string {
  return text
    .split('\n')
    .map((line) => pad + line)
    .join('\n');
}

function printToolDetail(
  serverName: string,
  tool: { name: string; description?: string; inputSchema?: unknown },
  includeSchema: boolean
): string | undefined {
  const options = extractOptions(tool as ServerToolInfo);
  const lines = formatToolSignatureBlock(tool.name, tool.description ?? '', options);
  for (const line of lines) {
    console.log(`  ${line}`);
  }

  if (includeSchema && tool.inputSchema) {
    // Schemas can be large — indenting keeps multi-line JSON legible without disrupting surrounding output.
    console.log(indent(JSON.stringify(tool.inputSchema, null, 2), '      '));
  }
  console.log('');
  return formatCallExpressionExample(serverName, tool.name, options);
}

function formatToolSignatureBlock(name: string, description: string, options: GeneratedOption[]): string[] {
  const lines: string[] = [];
  if (description) {
    lines.push(dimText(`// ${description}`));
  }
  if (options.length === 0) {
    lines.push(`${cyanText(name)}()`);
    return lines;
  }
  lines.push(`${cyanText(name)}({`);
  for (const option of options) {
    lines.push(`  ${formatParameterSignature(option)}`);
  }
  lines.push('})');
  return lines;
}

function formatParameterSignature(option: GeneratedOption): string {
  const typeAnnotation = formatTypeAnnotation(option);
  const optionalSuffix = option.required ? '' : '?';
  const commentSuffix = option.description ? `  ${dimText(`// ${option.description}`)}` : '';
  return `${option.property}${optionalSuffix}: ${typeAnnotation}${commentSuffix}`;
}

function formatTypeAnnotation(option: GeneratedOption): string {
  let baseType: string;
  if (option.enumValues && option.enumValues.length > 0) {
    baseType = option.enumValues.map((value) => JSON.stringify(value)).join(' | ');
  } else {
    switch (option.type) {
      case 'number':
        baseType = 'number';
        break;
      case 'boolean':
        baseType = 'boolean';
        break;
      case 'array':
        baseType = 'string[]';
        break;
      case 'string':
        baseType = 'string';
        break;
      default:
        baseType = 'unknown';
        break;
    }
  }
  const dimmedType = dimText(baseType);
  if (option.formatHint && option.type === 'string' && (!option.enumValues || option.enumValues.length === 0)) {
    return `${dimmedType} ${dimText(`/* ${option.formatHint} */`)}`;
  }
  return dimmedType;
}

function formatCallExpressionExample(
  serverName: string,
  toolName: string,
  options: GeneratedOption[]
): string | undefined {
  const assignments = options
    .map((option) => ({ option, literal: buildExampleLiteral(option) }))
    .filter(({ option, literal }) => option.required || literal !== undefined)
    .map(({ option, literal }) => {
      const value = literal ?? buildFallbackLiteral(option);
      return `${option.property}: ${value}`;
    });

  const args = assignments.join(', ');
  const callSuffix = assignments.length > 0 ? `(${args})` : '()';
  return `mcporter call ${serverName}.${toolName}${callSuffix}`;
}

function buildExampleLiteral(option: GeneratedOption): string | undefined {
  if (option.enumValues && option.enumValues.length > 0) {
    return JSON.stringify(option.enumValues[0]);
  }
  if (!option.exampleValue) {
    return undefined;
  }
  if (option.type === 'array') {
    const values = option.exampleValue
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (values.length === 0) {
      return undefined;
    }
    return `[${values.map((entry) => JSON.stringify(entry)).join(', ')}]`;
  }
  if (option.type === 'number' || option.type === 'boolean') {
    return option.exampleValue;
  }
  try {
    const parsed = JSON.parse(option.exampleValue);
    if (typeof parsed === 'number' || typeof parsed === 'boolean') {
      return option.exampleValue;
    }
  } catch {
    // Ignore JSON parse errors; fall through to quote string values.
  }
  return JSON.stringify(option.exampleValue);
}

function buildFallbackLiteral(option: GeneratedOption): string {
  switch (option.type) {
    case 'number':
      return '1';
    case 'boolean':
      return 'true';
    case 'array':
      return '["value1"]';
    default: {
      if (option.property.toLowerCase().includes('id')) {
        return JSON.stringify('example-id');
      }
      if (option.property.toLowerCase().includes('url')) {
        return JSON.stringify('https://example.com');
      }
      return JSON.stringify('value');
    }
  }
}

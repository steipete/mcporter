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
    const renderedResults: Array<ReturnType<typeof renderServerListRow> | undefined> = Array.from(
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
        const rendered = renderServerListRow(result, perServerTimeoutMs);
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
  console.log(boldText(target));
  const transportSummary =
    definition.command.kind === 'http'
      ? `HTTP ${definition.command.url instanceof URL ? definition.command.url.href : String(definition.command.url)}`
      : `STDIO ${[definition.command.command, ...(definition.command.args ?? [])].join(' ')}`.trim();
  const serverSummary = `${definition.description ?? '<none>'}${transportSummary ? ` [${transportSummary}]` : ''}`;
  console.log(`  ${serverSummary}`);
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
    for (const tool of tools) {
      printToolDetail(target, tool, Boolean(flags.schema));
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
): void {
  const options = extractOptions(tool as ServerToolInfo);
  const header = formatToolSignature(tool.name, tool.description ?? '', options);
  console.log(`  ${header}`);

  const usageParts = [`mcporter call ${serverName}.${tool.name}`];
  for (const option of options.filter((entry) => entry.required)) {
    usageParts.push(`--${option.cliName} ${option.placeholder}`);
  }
  console.log(`    ${dimText('Usage:')} ${usageParts.join(' ')}`);

  if (includeSchema && tool.inputSchema) {
    // Schemas can be large — indenting keeps multi-line JSON legible without disrupting surrounding output.
    console.log(indent(JSON.stringify(tool.inputSchema, null, 2), '      '));
  }
  console.log('');
}

function formatToolSignature(name: string, description: string, options: GeneratedOption[]): string {
  const parameters = formatParameterList(options);
  const descriptionSuffix = description ? ` — ${description}` : '';
  return `${cyanText(name)}${parameters}${descriptionSuffix}`;
}

function formatParameterList(options: GeneratedOption[]): string {
  if (options.length === 0) {
    return '()';
  }
  const segments = options.map((option) => {
    const formatted = formatParameter(option);
    return option.required ? formatted : `[${formatted}]`;
  });
  return `(${segments.join(', ')})`;
}

function formatParameter(option: GeneratedOption): string {
  const raw =
    option.placeholder.startsWith('<') && option.placeholder.endsWith('>')
      ? option.placeholder.slice(1, -1)
      : option.placeholder;
  const detail = raw.includes(':') ? raw.split(':').slice(1).join(':') : raw;
  const trimmedDetail = detail ? dimText(detail) : '';
  return trimmedDetail ? `${option.property}:${trimmedDetail}` : option.property;
}

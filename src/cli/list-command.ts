import ora from 'ora';
import type { ListSummaryResult, StatusCategory } from './list-format.js';
import { formatSourceSuffix, renderServerListRow } from './list-format.js';
import { supportsSpinner } from './terminal.js';
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
            // Keep the spinner focused on progress instead of replaying the last completed server.
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
    const authRecommendations: Array<{ server: string; command: string }> = [];
    renderedResults.forEach((entry, index) => {
      if (!entry) {
        return;
      }
      const category = (entry as { category?: StatusCategory }).category ?? 'error';
      errorCounts[category] = (errorCounts[category] ?? 0) + 1;
      if (category === 'auth') {
        const authCommand = (entry as { authCommand?: string }).authCommand;
        if (!authCommand) {
          return;
        }
        const serverDefinition = servers[index];
        const serverLabel = serverDefinition?.name ?? 'unknown';
        authRecommendations.push({ server: serverLabel, command: authCommand });
      }
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

    if (authRecommendations.length > 0) {
      console.log('');
      console.log('Next steps:');
      const seen = new Set<string>();
      for (const recommendation of authRecommendations) {
        if (seen.has(recommendation.command)) {
          continue;
        }
        seen.add(recommendation.command);
        console.log(`  • ${recommendation.server ?? 'the server'} — run '${recommendation.command}'`);
      }
    }
    return;
  }

  const definition = runtime.getDefinition(target);
  const timeoutMs = flags.timeoutMs ?? LIST_TIMEOUT_MS;
  const sourcePath = formatSourceSuffix(definition.source, true);
  console.log(`- ${target}`);
  if (sourcePath) {
    console.log(`  Source: ${sourcePath}`);
  }
  try {
    const tools = await withTimeout(runtime.listTools(target, { includeSchema: flags.schema }), timeoutMs);
    if (tools.length === 0) {
      console.log('  Tools: <none>');
      return;
    }
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

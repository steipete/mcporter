import fs from 'node:fs';
import { inspect } from 'node:util';
import type { CallResult } from '../result-utils.js';
import { createCallResult } from '../result-utils.js';
import { logWarn } from './logger-context.js';
import { dumpActiveHandles } from './runtime-debug.js';
import { resolveCallTimeout, withTimeout } from './timeouts.js';

export type OutputFormat = 'auto' | 'text' | 'markdown' | 'json' | 'raw';

interface CallArgsParseResult {
  selector?: string;
  server?: string;
  tool?: string;
  args: Record<string, unknown>;
  tailLog: boolean;
  output: OutputFormat;
  timeoutMs?: number;
}

function isOutputFormat(value: string): value is OutputFormat {
  return value === 'auto' || value === 'text' || value === 'markdown' || value === 'json' || value === 'raw';
}

export function parseCallArguments(args: string[]): CallArgsParseResult {
  const result: CallArgsParseResult = { args: {}, tailLog: false, output: 'auto' };
  const positional: string[] = [];
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (!token) {
      index += 1;
      continue;
    }
    if (token === '--server' || token === '--mcp') {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`Flag '${token}' requires a value.`);
      }
      result.server = value;
      index += 2;
      continue;
    }
    if (token === '--tool') {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`Flag '${token}' requires a value.`);
      }
      result.tool = value;
      index += 2;
      continue;
    }
    if (token === '--timeout') {
      const value = args[index + 1];
      if (!value) {
        throw new Error('--timeout requires a value (milliseconds).');
      }
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error('--timeout must be a positive integer (milliseconds).');
      }
      result.timeoutMs = parsed;
      index += 2;
      continue;
    }
    if (token === '--tail-log') {
      result.tailLog = true;
      index += 1;
      continue;
    }
    if (token === '--args') {
      const value = args[index + 1];
      if (!value) {
        throw new Error('--args requires a JSON value.');
      }
      try {
        const decoded = JSON.parse(value);
        if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
          throw new Error('--args must be a JSON object.');
        }
        Object.assign(result.args, decoded);
      } catch (error) {
        throw new Error(`Unable to parse --args: ${(error as Error).message}`);
      }
      index += 2;
      continue;
    }
    if (token === '--output') {
      const value = args[index + 1];
      if (!value) {
        throw new Error('--output requires a format (auto|text|markdown|json|raw).');
      }
      if (!isOutputFormat(value)) {
        throw new Error('--output format must be one of: auto, text, markdown, json, raw.');
      }
      result.output = value;
      index += 2;
      continue;
    }
    positional.push(token);
    index += 1;
  }

  if (positional.length > 0) {
    result.selector = positional.shift();
  }

  const nextPositional = positional[0];
  if (!result.tool && nextPositional !== undefined && !nextPositional.includes('=')) {
    result.tool = positional.shift();
  }

  for (const token of positional) {
    const [key, raw] = token.split('=', 2);
    if (!key || raw === undefined) {
      throw new Error(`Argument '${token}' must be key=value format.`);
    }
    const value = coerceValue(raw);
    if ((key === 'tool' || key === 'command') && !result.tool) {
      if (typeof value !== 'string') {
        throw new Error("Argument 'tool' must be a string value.");
      }
      result.tool = value as string;
      continue;
    }
    if (key === 'server' && !result.server) {
      if (typeof value !== 'string') {
        throw new Error("Argument 'server' must be a string value.");
      }
      result.server = value as string;
      continue;
    }
    result.args[key] = value;
  }
  return result;
}

export async function handleCall(
  runtime: Awaited<ReturnType<typeof import('../runtime.js')['createRuntime']>>,
  args: string[]
): Promise<void> {
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

  const timeoutMs = resolveCallTimeout(parsed.timeoutMs);
  let result: unknown;
  try {
    result = await withTimeout(runtime.callTool(server, tool, { args: parsed.args }), timeoutMs);
  } catch (error) {
    if (error instanceof Error && error.message === 'Timeout') {
      const timeoutDisplay = `${timeoutMs}ms`;
      await runtime.close(server).catch(() => {});
      throw new Error(
        `Call to ${server}.${tool} timed out after ${timeoutDisplay}. Override MCPORTER_CALL_TIMEOUT or pass --timeout to adjust.`
      );
    }
    throw error;
  }

  const wrapped = createCallResult(result);
  printCallOutput(wrapped, result, parsed.output);
  tailLogIfRequested(result, parsed.tailLog);
  dumpActiveHandles('after call (formatted result)');
}

function printCallOutput<T>(wrapped: CallResult<T>, raw: T, format: OutputFormat): void {
  switch (format) {
    case 'raw': {
      printRaw(raw);
      return;
    }
    case 'json': {
      const jsonValue = wrapped.json();
      if (jsonValue !== null && attemptPrintJson(jsonValue)) {
        return;
      }
      printRaw(raw);
      return;
    }
    case 'markdown': {
      const markdown = wrapped.markdown();
      if (typeof markdown === 'string') {
        console.log(markdown);
        return;
      }
      const text = wrapped.text();
      if (typeof text === 'string') {
        console.log(text);
        return;
      }
      const jsonValue = wrapped.json();
      if (jsonValue !== null && attemptPrintJson(jsonValue)) {
        return;
      }
      printRaw(raw);
      return;
    }
    case 'text': {
      const text = wrapped.text();
      if (typeof text === 'string') {
        console.log(text);
        return;
      }
      const markdown = wrapped.markdown();
      if (typeof markdown === 'string') {
        console.log(markdown);
        return;
      }
      const jsonValue = wrapped.json();
      if (jsonValue !== null && attemptPrintJson(jsonValue)) {
        return;
      }
      printRaw(raw);
      return;
    }
    default: {
      const jsonValue = wrapped.json();
      if (jsonValue !== null && attemptPrintJson(jsonValue)) {
        return;
      }
      const markdown = wrapped.markdown();
      if (typeof markdown === 'string') {
        console.log(markdown);
        return;
      }
      const text = wrapped.text();
      if (typeof text === 'string') {
        console.log(text);
        return;
      }
      printRaw(raw);
    }
  }
}

function attemptPrintJson(value: unknown): boolean {
  if (value === undefined) {
    return false;
  }
  try {
    if (value === null) {
      console.log('null');
    } else {
      console.log(JSON.stringify(value, null, 2));
    }
    return true;
  } catch {
    return false;
  }
}

function printRaw(raw: unknown): void {
  if (typeof raw === 'string') {
    console.log(raw);
    return;
  }
  if (raw === null) {
    console.log('null');
    return;
  }
  if (raw === undefined) {
    console.log('undefined');
    return;
  }
  if (typeof raw === 'bigint') {
    console.log(raw.toString());
    return;
  }
  try {
    const serialized = JSON.stringify(raw, null, 2);
    if (serialized === undefined) {
      if (typeof raw === 'symbol' || typeof raw === 'function') {
        console.log(raw.toString());
        return;
      }
      console.log(inspect(raw, { depth: 2, breakLength: 80 }));
      return;
    }
    console.log(serialized);
  } catch {
    if (typeof raw === 'symbol' || typeof raw === 'function') {
      console.log(raw.toString());
      return;
    }
    console.log(inspect(raw, { depth: 2, breakLength: 80 }));
  }
}

function tailLogIfRequested(result: unknown, enabled: boolean): void {
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

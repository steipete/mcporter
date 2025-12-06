import { splitCommandLine } from '../adhoc-server.js';
import { expectValue } from '../flag-utils.js';
import {
  extractHttpServerTarget,
  looksLikeHttpUrl,
  normalizeHttpUrlCandidate,
  splitHttpToolSelector,
} from '../http-utils.js';
import { extractGeneratorFlags } from './flag-parser.js';
import type { CommandInput } from './types.js';

export interface GenerateFlags {
  server?: string;
  name?: string;
  command?: CommandInput;
  description?: string;
  output?: string;
  bundler?: 'rolldown' | 'bun';
  bundle?: boolean | string;
  compile?: boolean | string;
  runtime?: 'node' | 'bun';
  timeout: number;
  minify?: boolean;
  from?: string;
  dryRun: boolean;
  includeTools?: string[];
  excludeTools?: string[];
}

export function parseGenerateFlags(args: string[]): GenerateFlags {
  const common = extractGeneratorFlags(args);
  let server: string | undefined;
  let name: string | undefined;
  let command: CommandInput | undefined;
  let description: string | undefined;
  let output: string | undefined;
  let bundler: 'rolldown' | 'bun' | undefined;
  let bundle: boolean | string | undefined;
  let compile: boolean | string | undefined;
  const runtime: 'node' | 'bun' | undefined = common.runtime;
  const timeout = common.timeout ?? 30_000;
  let minify: boolean | undefined;
  let from: string | undefined;
  let dryRun = false;
  let includeTools: string[] | undefined;
  let excludeTools: string[] | undefined;

  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (!token) {
      index += 1;
      continue;
    }
    if (token === '--from') {
      from = expectValue(token, args[index + 1]);
      args.splice(index, 2);
      continue;
    }
    if (token === '--dry-run') {
      dryRun = true;
      args.splice(index, 1);
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
      const value = expectValue(token, args[index + 1]);
      command = normalizeCommandInput(value);
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
    if (token === '--bundler') {
      const value = expectValue(token, args[index + 1]);
      if (value !== 'rolldown' && value !== 'bun') {
        throw new Error("--bundler must be 'rolldown' or 'bun'.");
      }
      bundler = value;
      args.splice(index, 2);
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
    if (token === '--no-minify') {
      minify = false;
      args.splice(index, 1);
      continue;
    }
    if (token === '--include-tools') {
      const value = expectValue(token, args[index + 1]);
      includeTools = mergeCsvList(includeTools, value);
      args.splice(index, 2);
      continue;
    }
    if (token === '--exclude-tools') {
      const value = expectValue(token, args[index + 1]);
      excludeTools = mergeCsvList(excludeTools, value);
      args.splice(index, 2);
      continue;
    }
    if (token.startsWith('--')) {
      throw new Error(`Unknown flag '${token}' for generate-cli.`);
    }
    index += 1;
  }

  const positional = !server && !command && !from ? args.find((token) => token && !token.startsWith('--')) : undefined;
  if (positional) {
    const position = args.indexOf(positional);
    if (position !== -1) {
      args.splice(position, 1);
    }
    if (looksLikeInlineCommand(positional)) {
      command = normalizeCommandInput(positional);
    } else if (looksLikeHttpUrl(positional) || positional.includes('://')) {
      command = positional;
    } else {
      server = positional;
    }
  }

  // translate shorthand env:/URL into normalized http url
  if (!server && !command && common.runtime === 'node' && common.timeout && !from && args[0]) {
    const target = extractHttpServerTarget(args[0]);
    if (target) {
      server = target;
    }
  }

  return {
    server,
    name,
    command,
    description,
    output,
    bundler,
    bundle,
    compile,
    runtime,
    timeout,
    minify,
    from,
    dryRun,
    includeTools,
    excludeTools,
  };
}

function mergeCsvList(existing: string[] | undefined, value: string): string[] {
  const parts = value
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const base = existing ?? [];
  const merged = [...base, ...parts];
  // Dedupe while preserving order
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of merged) {
    if (!seen.has(name)) {
      seen.add(name);
      result.push(name);
    }
  }
  return result;
}

function normalizeCommandInput(value: string): CommandInput {
  const httpCandidate = normalizeHttpUrlCandidate(value);
  if (httpCandidate) {
    const selector = splitHttpToolSelector(httpCandidate);
    if (selector) {
      return selector.baseUrl;
    }
    return httpCandidate;
  }
  if (looksLikeInlineCommand(value)) {
    return parseInlineCommand(value);
  }
  return { command: value };
}

function looksLikeInlineCommand(value: string): boolean {
  if (!value) {
    return false;
  }
  if (!/\s/.test(value)) {
    return false;
  }
  try {
    const parts = splitCommandLine(value.trim());
    return parts.length > 0;
  } catch {
    return false;
  }
}

function parseInlineCommand(value: string): CommandInput {
  const parts = splitCommandLine(value.trim());
  if (parts.length === 0) {
    throw new Error('--command requires a non-empty value.');
  }
  const [command, ...rest] = parts as [string, ...string[]];
  return { command, args: rest };
}

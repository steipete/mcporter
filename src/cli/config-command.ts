import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RawEntry } from '../config.js';
import {
  type LoadConfigOptions,
  loadRawConfig,
  loadServerDefinitions,
  type RawConfig,
  resolveConfigPath,
  writeRawConfig,
} from '../config.js';
import { pathsForImport, readExternalEntries } from '../config-imports.js';
import type { ServerDefinition } from '../config-schema.js';
import { expandHome } from '../env.js';
import { MCPORTER_VERSION } from '../runtime.js';
import { CliUsageError } from './errors.js';
import { chooseClosestIdentifier, renderIdentifierResolutionMessages } from './identifier-helpers.js';
import { boldText, dimText, extraDimText, supportsAnsiColor } from './terminal.js';

interface ConfigCliOptions {
  readonly loadOptions: LoadConfigOptions;
  readonly invokeAuth: (args: string[]) => Promise<void>;
}

interface ListFlags {
  format: 'text' | 'json';
  source?: 'local' | 'import';
}

interface AddFlags {
  transport?: 'http' | 'sse' | 'stdio';
  url?: string;
  command?: string;
  stdio?: string;
  args: string[];
  description?: string;
  env: Record<string, string>;
  headers: Record<string, string>;
  tokenCacheDir?: string;
  clientName?: string;
  oauthRedirectUrl?: string;
  auth?: string;
  copyFrom?: string;
  persistPath?: string;
  dryRun?: boolean;
}

interface ImportFlags {
  path?: string;
  filter?: string;
  copy?: boolean;
  format: 'text' | 'json';
}

const COLOR_ENABLED = (): boolean => Boolean(supportsAnsiColor && process.stdout.isTTY);

type ConfigSubcommand = 'list' | 'get' | 'add' | 'remove' | 'import' | 'login' | 'logout' | 'doctor';

type ConfigHelpEntry = {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
  readonly description: string;
  readonly flags?: Array<{ flag: string; description: string }>;
  readonly examples?: string[];
};

const CONFIG_HELP_ENTRIES: Record<ConfigSubcommand, ConfigHelpEntry> = {
  list: {
    name: 'list [options] [filter]',
    summary: 'Show merged servers',
    usage: 'mcporter config list [options] [filter]',
    description: 'Lists configured servers. Defaults to local entries, but you can view imports and emit JSON.',
    flags: [
      { flag: '--json', description: 'Print JSON payloads instead of ANSI text.' },
      { flag: '--source <local|import>', description: 'Filter to local definitions or imported entries only.' },
      { flag: 'filter (positional)', description: 'Substring match applied to server names.' },
    ],
    examples: ['pnpm mcporter config list', 'pnpm mcporter config list --json --source import cursor'],
  },
  get: {
    name: 'get <name> [--json]',
    summary: 'Inspect a single server',
    usage: 'mcporter config get <name> [--json]',
    description: 'Shows one server definition, including transport, headers, and env overrides.',
    flags: [{ flag: '--json', description: 'Emit the server entry as JSON.' }],
    examples: ['pnpm mcporter config get linear', 'pnpm mcporter config get claude --json'],
  },
  add: {
    name: 'add [options] <name> [target]',
    summary: 'Persist a server definition',
    usage: 'mcporter config add [options] <name> [target]',
    description:
      'Adds HTTP or stdio servers to the local config. Accepts URLs, commands, env vars, and OAuth metadata.',
    flags: [
      { flag: '--url <https://host>', description: 'Set the HTTP/S base URL (implies http transport).' },
      { flag: '--command <binary>', description: 'Set the stdio executable (implies stdio transport).' },
      { flag: '--stdio <binary>', description: 'Alias for --command.' },
      { flag: '--transport <http|sse|stdio>', description: 'Force a specific transport (validates target).' },
      { flag: '--arg <value>', description: 'Pass through additional stdio arguments (repeatable).' },
      { flag: '--description <text>', description: 'Set a human-friendly summary.' },
      { flag: '--env KEY=value', description: 'Attach environment variables (repeatable).' },
      { flag: '--header KEY=value', description: 'Attach HTTP headers (repeatable).' },
      { flag: '--token-cache-dir <path>', description: 'Override where OAuth tokens are persisted.' },
      { flag: '--client-name <name>', description: 'Customize the OAuth client identifier.' },
      { flag: '--oauth-redirect-url <url>', description: 'Set a custom OAuth redirect URL.' },
      { flag: '--auth <strategy>', description: 'Force the auth type (e.g., oauth).' },
      { flag: '--copy-from <import:name>', description: 'Start with an imported definition by name.' },
      { flag: '--persist <config-path>', description: 'Write to an alternate mcporter.json path.' },
      { flag: '--dry-run', description: 'Print the would-be entry without writing to disk.' },
      { flag: '--', description: 'Forward every subsequent token as a stdio arg.' },
    ],
    examples: [
      'pnpm mcporter config add linear https://mcp.linear.app/mcp',
      'pnpm mcporter config add cursor --command "npx -y cursor" --arg --stdio',
    ],
  },
  remove: {
    name: 'remove <name>',
    summary: 'Delete a local entry',
    usage: 'mcporter config remove <name>',
    description: 'Removes a server definition from the active mcporter.json file.',
    examples: ['pnpm mcporter config remove linear'],
  },
  import: {
    name: 'import <kind> [options]',
    summary: 'Inspect or copy imported servers',
    usage: 'mcporter config import <kind> [options]',
    description:
      'Shows entries from Cursor, Claude, Codex, and other supported imports. Optionally copies them locally.',
    flags: [
      { flag: '--path <file>', description: 'Manually point at a config file path.' },
      { flag: '--filter <substring>', description: 'Match server names by substring before listing/copying.' },
      { flag: '--copy', description: 'Write the filtered entries into the local config.' },
      { flag: '--json', description: 'Emit JSON instead of plain text listings.' },
    ],
    examples: ['pnpm mcporter config import cursor --copy', 'pnpm mcporter config import claude --filter notion'],
  },
  login: {
    name: 'login <name|url> [options]',
    summary: 'Run the OAuth/auth flow',
    usage: 'mcporter config login <name|url> [options]',
    description: 'Delegates to `mcporter auth`, so you can pass ephemeral flags like --http-url/--stdio/--reset.',
    examples: ['pnpm mcporter config login linear', 'pnpm mcporter config login https://example.com/mcp --reset'],
  },
  logout: {
    name: 'logout <name>',
    summary: 'Clear cached credentials',
    usage: 'mcporter config logout <name>',
    description: 'Deletes the token cache directory for an OAuth-enabled server.',
    examples: ['pnpm mcporter config logout linear'],
  },
  doctor: {
    name: 'doctor',
    summary: 'Validate config files',
    usage: 'mcporter config doctor',
    description: 'Validates config files, warns about missing token caches, and prints config locations.',
    examples: ['pnpm mcporter config doctor'],
  },
};

const CONFIG_HELP_ORDER: ConfigSubcommand[] = ['list', 'get', 'add', 'remove', 'import', 'login', 'logout', 'doctor'];

export async function handleConfigCli(options: ConfigCliOptions, args: string[]): Promise<void> {
  const initialToken = args[0];
  if (args.length === 0 || (initialToken && isHelpToken(initialToken))) {
    printConfigHelp();
    return;
  }

  const subcommand = args.shift();
  if (!subcommand) {
    printConfigHelp();
    return;
  }

  if (subcommand === 'help') {
    const target = args[0];
    if (!target || isHelpToken(target)) {
      printConfigHelp();
    } else {
      printConfigHelp(target);
    }
    return;
  }

  if (consumeInlineHelpTokens(args)) {
    printConfigHelp(subcommand);
    return;
  }

  switch (subcommand) {
    case 'list':
      await handleListCommand(options, args);
      return;
    case 'get':
      await handleGetCommand(options, args);
      return;
    case 'add':
      await handleAddCommand(options, args);
      return;
    case 'remove':
      await handleRemoveCommand(options, args);
      return;
    case 'import':
      await handleImportCommand(options, args);
      return;
    case 'login':
      await handleLoginCommand(options, args);
      return;
    case 'logout':
      await handleLogoutCommand(options, args);
      return;
    case 'doctor':
      await handleDoctorCommand(options, args);
      return;
    default:
      throw new CliUsageError(`Unknown config subcommand '${subcommand}'. Run 'mcporter config --help'.`);
  }
}

function isHelpToken(token: string): boolean {
  return token === '--help' || token === '-h';
}

function printConfigHelp(subcommand?: string): void {
  const colorize = COLOR_ENABLED();
  if (!subcommand) {
    printConfigOverview(colorize);
    return;
  }
  const resolved = resolveHelpSubcommand(subcommand);
  if (!resolved) {
    console.log(`Unknown config subcommand '${subcommand}'. Available commands: ${CONFIG_HELP_ORDER.join(', ')}.`);
    return;
  }
  printSubcommandHelp(resolved, colorize);
}

function consumeInlineHelpTokens(args: string[]): boolean {
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

function resolveHelpSubcommand(token: string | undefined): ConfigSubcommand | undefined {
  if (!token) {
    return undefined;
  }
  const normalized = token.toLowerCase() as ConfigSubcommand;
  return normalized in CONFIG_HELP_ENTRIES ? normalized : undefined;
}

function printConfigOverview(colorize: boolean): void {
  const title = colorize ? boldText('mcporter config') : 'mcporter config';
  const subtitle = colorize
    ? dimText('Manage configured MCP servers, imports, and ad-hoc discoveries.')
    : 'Manage configured MCP servers, imports, and ad-hoc discoveries.';
  const commandsHeader = colorize ? boldText('Commands') : 'Commands';
  const examplesHeader = colorize ? boldText('Examples') : 'Examples';
  const lines: string[] = [title, subtitle, '', commandsHeader];
  const maxName = Math.max(...CONFIG_HELP_ORDER.map((key) => CONFIG_HELP_ENTRIES[key].name.length));
  for (const key of CONFIG_HELP_ORDER) {
    const entry = CONFIG_HELP_ENTRIES[key];
    const padded = entry.name.padEnd(maxName);
    const renderedName = colorize ? boldText(padded) : padded;
    const renderedDesc = colorize ? dimText(entry.summary) : entry.summary;
    lines.push(`  ${renderedName}  ${renderedDesc}`);
  }
  lines.push('', examplesHeader);
  const exampleList = [
    'pnpm mcporter config list --json',
    'pnpm mcporter config add linear https://mcp.linear.app/mcp',
    'pnpm mcporter config import cursor --copy',
  ];
  for (const entry of exampleList) {
    lines.push(`  ${colorize ? extraDimText(entry) : entry}`);
  }
  const pointer = "Run 'mcporter config <command> --help' for detailed flag info.";
  lines.push('', colorize ? extraDimText(pointer) : pointer);
  console.log(lines.join('\n'));
}

function printSubcommandHelp(subcommand: ConfigSubcommand, colorize: boolean): void {
  const entry = CONFIG_HELP_ENTRIES[subcommand];
  const title = colorize ? boldText(`mcporter config ${subcommand}`) : `mcporter config ${subcommand}`;
  const description = colorize ? dimText(entry.description) : entry.description;
  const usageHeader = colorize ? boldText('Usage') : 'Usage';
  const lines: string[] = [title, description, '', usageHeader, `  ${entry.usage}`];
  if (entry.flags && entry.flags.length > 0) {
    const flagsHeader = colorize ? boldText('Flags') : 'Flags';
    const maxFlag = Math.max(...entry.flags.map((flag) => flag.flag.length));
    lines.push('', flagsHeader);
    for (const flag of entry.flags) {
      const padded = flag.flag.padEnd(maxFlag);
      const renderedFlag = colorize ? boldText(padded) : padded;
      const renderedDesc = colorize ? dimText(flag.description) : flag.description;
      lines.push(`  ${renderedFlag}  ${renderedDesc}`);
    }
  }
  if (entry.examples && entry.examples.length > 0) {
    const examplesHeader = colorize ? boldText('Examples') : 'Examples';
    lines.push('', examplesHeader);
    for (const example of entry.examples) {
      lines.push(`  ${colorize ? extraDimText(example) : example}`);
    }
  }
  console.log(lines.join('\n'));
}

async function handleListCommand(options: ConfigCliOptions, args: string[]): Promise<void> {
  const flags = extractListFlags(args);
  const filter = args.shift();
  const servers = await loadServerDefinitions(options.loadOptions);
  let filtered = servers;
  if (flags.source) {
    filtered = filtered.filter((server) => (server.source?.kind ?? 'local') === flags.source);
  }
  if (filter) {
    filtered = filtered.filter((server) => filterMatches(filter, server));
  }
  if (flags.format === 'json') {
    const payload = filtered.map((server) => serializeDefinition(server));
    console.log(JSON.stringify({ servers: payload }, null, 2));
    return;
  }
  const colorize = COLOR_ENABLED();
  if (filtered.length === 0) {
    console.log(
      colorize
        ? dimText('No local servers match the provided filters.')
        : 'No local servers match the provided filters.'
    );
  } else {
    for (const server of filtered) {
      printServerSummary(server);
    }
  }
  if ((!flags.source || flags.source === 'local') && flags.format === 'text') {
    printImportSummary(servers.filter((server) => server.source?.kind === 'import'));
  }
  if (flags.format === 'text') {
    await printConfigFooter(options.loadOptions);
  }
}

function extractListFlags(args: string[]): ListFlags {
  const flags: ListFlags = { format: 'text', source: 'local' };
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (token === '--json') {
      flags.format = 'json';
      args.splice(index, 1);
      continue;
    }
    if (token === '--source') {
      const value = args[index + 1];
      if (value !== 'local' && value !== 'import') {
        throw new CliUsageError("--source must be either 'local' or 'import'.");
      }
      flags.source = value;
      args.splice(index, 2);
      continue;
    }
    index += 1;
  }
  return flags;
}

function filterMatches(filter: string, server: ServerDefinition): boolean {
  if (filter.startsWith('source:')) {
    const origin = server.source?.kind ?? 'local';
    return `source:${origin}` === filter;
  }
  return server.name.includes(filter);
}

function serializeDefinition(definition: ServerDefinition): Record<string, unknown> {
  const origin = definition.source ?? { kind: 'local', path: '' };
  const base: Record<string, unknown> = {
    name: definition.name,
    description: definition.description,
    source: origin,
    auth: definition.auth,
    tokenCacheDir: definition.tokenCacheDir,
    clientName: definition.clientName,
    oauthRedirectUrl: definition.oauthRedirectUrl,
    env: definition.env,
  };
  if (definition.command.kind === 'http') {
    base.transport = 'http';
    base.baseUrl = definition.command.url.href;
    base.headers = definition.command.headers;
  } else {
    base.transport = 'stdio';
    base.command = definition.command.command;
    base.args = definition.command.args;
    base.cwd = definition.command.cwd;
  }
  return base;
}

function printServerSummary(definition: ServerDefinition): void {
  const colorize = COLOR_ENABLED();
  const origin = definition.source;
  const header = colorize ? boldText(definition.name) : definition.name;
  const label = (text: string): string => (colorize ? dimText(text) : text);
  console.log(header);
  if (origin) {
    console.log(`  ${label('Source')}: ${origin.kind}${origin.path ? ` (${origin.path})` : ''}`);
  } else {
    console.log(`  ${label('Source')}: local`);
  }
  if (definition.command.kind === 'http') {
    console.log(`  ${label('Transport')}: http (${definition.command.url.href})`);
  } else {
    const renderedArgs = definition.command.args.length > 0 ? ` ${definition.command.args.join(' ')}` : '';
    console.log(`  ${label('Transport')}: stdio (${definition.command.command}${renderedArgs})`);
    console.log(`  ${label('CWD')}: ${definition.command.cwd}`);
  }
  if (definition.description) {
    console.log(`  ${label('Description')}: ${definition.description}`);
  }
  if (definition.auth === 'oauth') {
    console.log(`  ${label('Auth')}: oauth`);
  }
}

async function handleGetCommand(options: ConfigCliOptions, args: string[]): Promise<void> {
  const flags = extractGetFlags(args);
  const name = args.shift();
  if (!name) {
    throw new CliUsageError('Usage: mcporter config get <name>');
  }
  const servers = await loadServerDefinitions(options.loadOptions);
  const target = resolveServerDefinition(name, servers);
  if (flags.format === 'json') {
    console.log(JSON.stringify(serializeDefinition(target), null, 2));
    return;
  }
  printServerSummary(target);
  if (target.command.kind === 'http' && target.command.headers && Object.keys(target.command.headers).length > 0) {
    console.log('  Headers:');
    for (const [key, value] of Object.entries(target.command.headers)) {
      console.log(`    ${key}: ${value}`);
    }
  }
  if (target.env && Object.keys(target.env).length > 0) {
    console.log('  Env:');
    for (const [key, value] of Object.entries(target.env)) {
      console.log(`    ${key}=${value}`);
    }
  }
}

function extractGetFlags(args: string[]): { format: 'text' | 'json' } {
  let format: 'text' | 'json' = 'text';
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (token === '--json') {
      format = 'json';
      args.splice(index, 1);
      continue;
    }
    index += 1;
  }
  return { format };
}

async function handleAddCommand(options: ConfigCliOptions, args: string[]): Promise<void> {
  const name = args.shift();
  if (!name) {
    throw new CliUsageError('Usage: mcporter config add <name> [target]');
  }
  let positionalTarget: string | undefined;
  if (args[0] && !args[0].startsWith('--')) {
    positionalTarget = args.shift();
  }
  const flags = extractAddFlags(args);

  const effectiveLoadOptions = flags.persistPath
    ? { ...options.loadOptions, configPath: path.resolve(expandHome(flags.persistPath)) }
    : options.loadOptions;

  const { config, path: configPath } = await loadOrCreateConfig(effectiveLoadOptions);
  const nextConfig = cloneConfig(config);

  const baseEntry = await resolveBaseEntry(flags.copyFrom, options.loadOptions);
  const entry: RawEntry = baseEntry ? { ...baseEntry } : {};

  applyTargetToEntry(entry, positionalTarget, flags);
  applyFlagsToEntry(entry, flags);
  validateTransportChoice(entry, flags.transport);

  const hasHttpTarget =
    Boolean(entry.baseUrl) ||
    Boolean(entry.base_url) ||
    Boolean(entry.url) ||
    Boolean(entry.serverUrl) ||
    Boolean(entry.server_url);
  const hasCommandTarget = Boolean(entry.command ?? entry.executable);

  if (flags.args.length > 0 && !hasCommandTarget) {
    throw new CliUsageError('--arg requires a stdio command (use --command, --stdio, or provide a positional target).');
  }

  if (!hasHttpTarget && !hasCommandTarget) {
    throw new CliUsageError('Server definitions require either a --url/target or a stdio command.');
  }

  if (!nextConfig.mcpServers) {
    nextConfig.mcpServers = {};
  }
  nextConfig.mcpServers[name] = entry;

  if (flags.dryRun) {
    console.log(JSON.stringify({ [name]: entry }, null, 2));
    console.log('(dry-run) No changes were written.');
    return;
  }

  await writeRawConfig(configPath, nextConfig);
  console.log(`Added '${name}' to ${configPath}`);
}

function extractAddFlags(args: string[]): AddFlags {
  const flags: AddFlags = { args: [], env: {}, headers: {} };
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    switch (token) {
      case '--transport':
        flags.transport = parseTransport(requireValue(args, index, token));
        args.splice(index, 2);
        continue;
      case '--url':
        flags.url = requireValue(args, index, token);
        args.splice(index, 2);
        continue;
      case '--command':
        flags.command = requireValue(args, index, token);
        args.splice(index, 2);
        continue;
      case '--stdio':
        flags.stdio = requireValue(args, index, token);
        args.splice(index, 2);
        continue;
      case '--arg':
        flags.args.push(requireValue(args, index, token));
        args.splice(index, 2);
        continue;
      case '--description':
        flags.description = requireValue(args, index, token);
        args.splice(index, 2);
        continue;
      case '--env':
        parseKeyValue(requireValue(args, index, token), flags.env, '--env');
        args.splice(index, 2);
        continue;
      case '--header':
        parseKeyValue(requireValue(args, index, token), flags.headers, '--header');
        args.splice(index, 2);
        continue;
      case '--token-cache-dir':
        flags.tokenCacheDir = requireValue(args, index, token);
        args.splice(index, 2);
        continue;
      case '--client-name':
        flags.clientName = requireValue(args, index, token);
        args.splice(index, 2);
        continue;
      case '--oauth-redirect-url':
        flags.oauthRedirectUrl = requireValue(args, index, token);
        args.splice(index, 2);
        continue;
      case '--auth':
        flags.auth = requireValue(args, index, token);
        args.splice(index, 2);
        continue;
      case '--copy-from':
        flags.copyFrom = requireValue(args, index, token);
        args.splice(index, 2);
        continue;
      case '--persist':
        flags.persistPath = requireValue(args, index, token);
        args.splice(index, 2);
        continue;
      case '--dry-run':
        flags.dryRun = true;
        args.splice(index, 1);
        continue;
      case '--':
        args.splice(index, 1);
        while (index < args.length) {
          const value = args[index];
          if (value !== undefined) {
            flags.args.push(value);
          }
          args.splice(index, 1);
        }
        continue;
      default:
        index += 1;
        break;
    }
  }
  return flags;
}

function parseTransport(value: string | undefined): 'http' | 'sse' | 'stdio' {
  if (value !== 'http' && value !== 'sse' && value !== 'stdio') {
    throw new CliUsageError("--transport must be one of 'http', 'sse', or 'stdio'.");
  }
  return value;
}

function parseKeyValue(input: string | undefined, target: Record<string, string>, flagName: string): void {
  if (!input || !input.includes('=')) {
    throw new CliUsageError(`${flagName} requires KEY=value.`);
  }
  const [key, ...rest] = input.split('=');
  if (!key) {
    throw new CliUsageError(`${flagName} requires KEY=value.`);
  }
  target[key] = rest.join('=');
}

function requireValue(args: string[], index: number, flagName: string): string {
  const value = args[index + 1];
  if (!value) {
    throw new CliUsageError(`Flag '${flagName}' requires a value.`);
  }
  return value;
}

async function resolveBaseEntry(copyFrom: string | undefined, options: LoadConfigOptions): Promise<RawEntry | null> {
  if (!copyFrom) {
    return null;
  }
  const [kind, ...rest] = copyFrom.split(':');
  const name = rest.join(':');
  if (!kind || !name) {
    throw new CliUsageError("--copy-from requires the format '<import>:<name>'.");
  }
  const rootDir = options.rootDir ?? process.cwd();
  const paths = pathsForImport(kind as never, rootDir);
  for (const candidate of paths) {
    const resolved = expandHome(candidate);
    const entries = await readExternalEntries(resolved, { projectRoot: rootDir, importKind: kind as never });
    if (!entries) {
      continue;
    }
    const entry = entries.get(name);
    if (entry) {
      return structuredClone(entry);
    }
  }
  throw new CliUsageError(`Unable to find '${name}' in import '${kind}'.`);
}

function applyTargetToEntry(entry: RawEntry, positionalTarget: string | undefined, flags: AddFlags): void {
  if (flags.url) {
    entry.baseUrl = flags.url;
    return;
  }
  if (flags.command) {
    entry.command = flags.command;
  }
  if (flags.stdio) {
    entry.command = flags.stdio;
  }
  if (positionalTarget) {
    if (looksLikeHttp(positionalTarget)) {
      entry.baseUrl = positionalTarget;
    } else {
      entry.command = positionalTarget;
    }
  }
}

function applyFlagsToEntry(entry: RawEntry, flags: AddFlags): void {
  if (flags.args.length > 0) {
    entry.args = flags.args;
  }
  if (flags.description) {
    entry.description = flags.description;
  }
  if (Object.keys(flags.env).length > 0) {
    entry.env = entry.env ? { ...entry.env, ...flags.env } : { ...flags.env };
  }
  if (Object.keys(flags.headers).length > 0) {
    entry.headers = entry.headers ? { ...entry.headers, ...flags.headers } : { ...flags.headers };
  }
  if (flags.tokenCacheDir) {
    entry.tokenCacheDir = flags.tokenCacheDir;
  }
  if (flags.clientName) {
    entry.clientName = flags.clientName;
  }
  if (flags.oauthRedirectUrl) {
    entry.oauthRedirectUrl = flags.oauthRedirectUrl;
  }
  if (flags.auth) {
    entry.auth = flags.auth;
  }
}

function validateTransportChoice(entry: RawEntry, transport: AddFlags['transport']): void {
  if (!transport) {
    return;
  }
  const isHttp = Boolean(entry.baseUrl ?? entry.url ?? entry.serverUrl);
  const isStdio = Boolean(entry.command ?? entry.args);
  if (transport === 'stdio' && !isStdio) {
    throw new CliUsageError("Transport 'stdio' requires a stdio command.");
  }
  if ((transport === 'http' || transport === 'sse') && !isHttp) {
    throw new CliUsageError(`Transport '${transport}' requires a URL target.`);
  }
}

async function handleRemoveCommand(options: ConfigCliOptions, args: string[]): Promise<void> {
  const name = args.shift();
  if (!name) {
    throw new CliUsageError('Usage: mcporter config remove <name>');
  }
  const { config, path: configPath } = await loadOrCreateConfig(options.loadOptions);
  const targetName = findServerNameWithFuzzyMatch(name, Object.keys(config.mcpServers ?? {}));
  if (!targetName) {
    throw new CliUsageError(`Server '${name}' does not exist in ${configPath}.`);
  }
  const nextConfig = cloneConfig(config);
  delete nextConfig.mcpServers[targetName];
  await writeRawConfig(configPath, nextConfig);
  console.log(`Removed '${targetName}' from ${configPath}`);
}

async function handleImportCommand(options: ConfigCliOptions, args: string[]): Promise<void> {
  const kind = args.shift();
  if (!kind) {
    throw new CliUsageError('Usage: mcporter config import <kind>');
  }
  const flags = extractImportFlags(args);
  const rootDir = options.loadOptions.rootDir ?? process.cwd();
  const paths = flags.path ? [path.resolve(expandHome(flags.path))] : pathsForImport(kind as never, rootDir);
  const entries: Array<{ name: string; entry: RawEntry; source: string }> = [];
  const seenNames = new Set<string>();
  for (const candidate of paths) {
    const resolved = expandHome(candidate);
    const map = await readExternalEntries(resolved, { projectRoot: rootDir, importKind: kind as never });
    if (!map) {
      continue;
    }
    for (const [name, entry] of map) {
      if (flags.filter && !name.includes(flags.filter)) {
        continue;
      }
      if (seenNames.has(name)) {
        continue;
      }
      seenNames.add(name);
      entries.push({ name, entry, source: resolved });
    }
  }
  if (entries.length === 0) {
    console.log('No entries found.');
    return;
  }
  if (flags.format === 'json') {
    console.log(JSON.stringify({ entries }, null, 2));
  } else {
    for (const item of entries) {
      console.log(`${item.name} (${item.source})`);
    }
  }
  if (flags.copy) {
    const { config, path: configPath } = await loadOrCreateConfig(options.loadOptions);
    const nextConfig = cloneConfig(config);
    if (!nextConfig.mcpServers) {
      nextConfig.mcpServers = {};
    }
    for (const item of entries) {
      nextConfig.mcpServers[item.name] = structuredClone(item.entry);
    }
    await writeRawConfig(configPath, nextConfig);
    console.log(`Copied ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} to ${configPath}`);
  }
}

function extractImportFlags(args: string[]): ImportFlags {
  const flags: ImportFlags = { format: 'text' };
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    switch (token) {
      case '--path':
        flags.path = args[index + 1];
        args.splice(index, 2);
        continue;
      case '--filter':
        flags.filter = args[index + 1];
        args.splice(index, 2);
        continue;
      case '--copy':
        flags.copy = true;
        args.splice(index, 1);
        continue;
      case '--json':
        flags.format = 'json';
        args.splice(index, 1);
        continue;
      default:
        index += 1;
        break;
    }
  }
  return flags;
}

async function handleLoginCommand(options: ConfigCliOptions, args: string[]): Promise<void> {
  if (args.length === 0) {
    throw new CliUsageError('Usage: mcporter config login <name|url>');
  }
  await options.invokeAuth([...args]);
}

async function handleLogoutCommand(options: ConfigCliOptions, args: string[]): Promise<void> {
  const name = args.shift();
  if (!name) {
    throw new CliUsageError('Usage: mcporter config logout <name>');
  }
  const servers = await loadServerDefinitions(options.loadOptions);
  const target = resolveServerDefinition(name, servers);
  if (!target.tokenCacheDir) {
    console.log(`Server '${name}' does not expose a token cache directory.`);
    return;
  }
  await fs.rm(target.tokenCacheDir, { recursive: true, force: true });
  console.log(`Cleared cached credentials for '${target.name}' (${target.tokenCacheDir})`);
}

async function handleDoctorCommand(options: ConfigCliOptions, _args: string[]): Promise<void> {
  console.log(`MCPorter ${MCPORTER_VERSION}`);
  const configLocations = await resolveConfigLocations(options.loadOptions);
  logConfigLocations(configLocations, { leadingNewline: false });
  console.log('');
  const servers = await loadServerDefinitions(options.loadOptions);
  const issues: string[] = [];
  for (const server of servers) {
    if (server.command.kind === 'stdio' && !path.isAbsolute(server.command.cwd)) {
      issues.push(`Server '${server.name}' has a non-absolute working directory.`);
    }
    if (server.auth === 'oauth' && !server.tokenCacheDir) {
      issues.push(`Server '${server.name}' enables OAuth but lacks a token cache directory.`);
    }
  }
  if (issues.length === 0) {
    console.log('Config looks good.');
    return;
  }
  console.log('Config issues detected:');
  for (const issue of issues) {
    console.log(`  - ${issue}`);
  }
}

function looksLikeHttp(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://');
}

function cloneConfig(config: RawConfig): RawConfig {
  return {
    mcpServers: config.mcpServers ? { ...config.mcpServers } : {},
    imports: config.imports ? [...config.imports] : [],
  };
}

type ConfigLocationSummary = {
  projectPath: string;
  projectExists: boolean;
  systemPath: string;
  systemExists: boolean;
};

async function printConfigFooter(loadOptions: LoadConfigOptions): Promise<void> {
  const summary = await resolveConfigLocations(loadOptions);
  logConfigLocations(summary, { leadingNewline: true });
}

async function resolveConfigLocations(loadOptions: LoadConfigOptions): Promise<ConfigLocationSummary> {
  const rootDir = loadOptions.rootDir ?? process.cwd();
  const projectPath = path.resolve(rootDir, 'config', 'mcporter.json');
  const projectExists = await pathExists(projectPath);
  const systemCandidates = buildSystemConfigCandidates();
  const systemResolved = await resolveFirstExisting(systemCandidates);
  return {
    projectPath,
    projectExists,
    systemPath: systemResolved.path,
    systemExists: systemResolved.exists,
  };
}

function logConfigLocations(summary: ConfigLocationSummary, options?: { leadingNewline?: boolean }): void {
  const shouldAddNewline = options?.leadingNewline ?? true;
  if (shouldAddNewline) {
    console.log('');
  }
  console.log(`Project config: ${formatPath(summary.projectPath, summary.projectExists)}`);
  console.log(`System config: ${formatPath(summary.systemPath, summary.systemExists)}`);
}

function buildSystemConfigCandidates(): string[] {
  const homeDir = os.homedir();
  const base = path.join(homeDir, '.mcporter');
  return [path.join(base, 'mcporter.json'), path.join(base, 'mcporter.jsonc')];
}

async function resolveFirstExisting(pathsToCheck: string[]): Promise<{ path: string; exists: boolean }> {
  for (const candidate of pathsToCheck) {
    if (await pathExists(candidate)) {
      return { path: candidate, exists: true };
    }
  }
  return { path: pathsToCheck[0] ?? '', exists: false };
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function formatPath(targetPath: string, exists: boolean): string {
  return exists ? targetPath : `${targetPath} (missing)`;
}

async function loadOrCreateConfig(loadOptions: LoadConfigOptions): Promise<{ config: RawConfig; path: string }> {
  try {
    const { config, path } = await loadRawConfig(loadOptions);
    return { config, path };
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      const rootDir = loadOptions.rootDir ?? process.cwd();
      const resolved = resolveConfigPath(loadOptions.configPath, rootDir);
      return { config: { mcpServers: {}, imports: [] }, path: resolved.path };
    }
    throw error;
  }
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === code);
}

function printImportSummary(importServers: ServerDefinition[]): void {
  if (importServers.length === 0) {
    return;
  }
  const colorize = COLOR_ENABLED();
  const grouped = new Map<string, string[]>();
  for (const server of importServers) {
    const sourcePath = server.source?.path ?? '<unknown>';
    const list = grouped.get(sourcePath) ?? [];
    list.push(server.name);
    grouped.set(sourcePath, list);
  }
  console.log('');
  const header = colorize
    ? boldText('Other sources available via --source import')
    : 'Other sources available via --source import';
  console.log(header);
  for (const [path, names] of grouped) {
    names.sort();
    const sample = names.slice(0, 3).join(', ');
    const suffix = names.length > 3 ? ', …' : '';
    const countLabel = `${names.length} server${names.length === 1 ? '' : 's'}`;
    const pathLabel = colorize ? dimText(path) : path;
    console.log(`  ${pathLabel} — ${countLabel} (${sample}${suffix})`);
  }
  const guidance = 'Use `mcporter config import <kind>` to copy them locally.';
  console.log(colorize ? dimText(guidance) : guidance);
}

function resolveServerDefinition(name: string, servers: ServerDefinition[]): ServerDefinition {
  const direct = servers.find((server) => server.name === name);
  if (direct) {
    return direct;
  }
  const resolution = chooseClosestIdentifier(
    name,
    servers.map((server) => server.name)
  );
  if (!resolution) {
    throw new CliUsageError(`[mcporter] Unknown server '${name}'.`);
  }
  const messages = renderIdentifierResolutionMessages({
    entity: 'server',
    attempted: name,
    resolution,
  });
  if (messages.auto) {
    console.log(dimText(messages.auto));
  }
  if (resolution.kind === 'auto') {
    const match = servers.find((server) => server.name === resolution.value);
    if (match) {
      return match;
    }
  }
  if (messages.suggest) {
    console.log(dimText(messages.suggest));
  }
  throw new CliUsageError(`[mcporter] Unknown server '${name}'.`);
}

function findServerNameWithFuzzyMatch(name: string, candidates: string[]): string | null {
  if (candidates.includes(name)) {
    return name;
  }
  const resolution = chooseClosestIdentifier(name, candidates);
  if (!resolution) {
    return null;
  }
  const messages = renderIdentifierResolutionMessages({
    entity: 'server',
    attempted: name,
    resolution,
  });
  if (messages.auto) {
    console.log(dimText(messages.auto));
  }
  if (resolution.kind === 'auto') {
    return resolution.value;
  }
  if (messages.suggest) {
    console.log(dimText(messages.suggest));
  }
  return null;
}

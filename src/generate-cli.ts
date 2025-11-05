import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build as esbuild } from 'esbuild';
import { type HttpCommand, loadServerDefinitions, type ServerDefinition, type StdioCommand } from './config.js';
import type { ServerToolInfo } from './runtime.js';
import { createRuntime } from './runtime.js';

export interface GenerateCliOptions {
  readonly serverRef: string;
  readonly configPath?: string;
  readonly rootDir?: string;
  readonly outputPath?: string;
  readonly runtime?: 'node' | 'bun';
  readonly bundle?: boolean | string;
  readonly timeoutMs?: number;
  readonly minify?: boolean;
  readonly compile?: boolean | string;
}

interface ResolvedServer {
  definition: ServerDefinition;
  name: string;
}

interface ToolMetadata {
  tool: ServerToolInfo;
  methodName: string;
  options: GeneratedOption[];
}

interface GeneratedOption {
  property: string;
  cliName: string;
  description?: string;
  required: boolean;
  type: 'string' | 'number' | 'boolean' | 'array' | 'unknown';
}

export async function generateCli(
  options: GenerateCliOptions
): Promise<{ outputPath: string; bundlePath?: string; compilePath?: string }> {
  const runtimeKind = await resolveRuntimeKind(options.runtime, options.compile);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const { definition, name } = await resolveServerDefinition(options.serverRef, options.configPath, options.rootDir);
  const tools = await fetchTools(definition, name, options.configPath, options.rootDir);
  const toolMetadata = tools.map((tool) => buildToolMetadata(tool));
  const generator = await readPackageMetadata();
  const outputPath = await writeTemplate({
    outputPath: options.outputPath,
    runtimeKind,
    timeoutMs,
    definition,
    serverName: name,
    tools: toolMetadata,
    generator,
  });

  const shouldBundle = Boolean(options.bundle ?? options.compile);
  let bundlePath: string | undefined;
  let compilePath: string | undefined;
  if (shouldBundle) {
    const targetPath = resolveBundleTarget({
      bundle: options.bundle,
      compile: options.compile,
      outputPath,
      runtimeKind,
    });
    bundlePath = await bundleOutput({
      sourcePath: outputPath,
      runtimeKind,
      targetPath,
      minify: options.minify ?? false,
    });

    if (options.compile) {
      if (runtimeKind !== 'bun') {
        throw new Error('--compile is only supported when --runtime bun');
      }
      const compileTarget = computeCompileTarget(options.compile, bundlePath, name);
      await compileBundleWithBun(bundlePath, compileTarget);
      compilePath = compileTarget;
    }
  }

  return { outputPath, bundlePath, compilePath };
}

async function resolveServerDefinition(
  serverRef: string,
  configPath?: string,
  rootDir?: string
): Promise<ResolvedServer> {
  const trimmed = serverRef.trim();

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const parsed = JSON.parse(trimmed) as ServerDefinition & { name: string };
    if (!parsed.name) {
      throw new Error("Inline server definition must include a 'name' field.");
    }
    return { definition: normalizeDefinition(parsed), name: parsed.name };
  }

  const possiblePath = path.resolve(trimmed);
  try {
    const buffer = await fs.readFile(possiblePath, 'utf8');
    const parsed = JSON.parse(buffer) as {
      mcpServers?: Record<string, unknown>;
    };
    if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object') {
      throw new Error(`Config file ${possiblePath} does not contain mcpServers.`);
    }
    const entries = Object.entries(parsed.mcpServers);
    if (entries.length === 0) {
      throw new Error(`Config file ${possiblePath} does not define any servers.`);
    }
    const first = entries[0];
    if (!first) {
      throw new Error(`Config file ${possiblePath} does not define any servers.`);
    }
    const [name, value] = first;
    return {
      definition: normalizeDefinition({
        name,
        ...(value as Record<string, unknown>),
      }),
      name,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  const definitions = await loadServerDefinitions({
    configPath,
    rootDir,
  });
  const match = definitions.find((def) => def.name === trimmed);
  if (!match) {
    throw new Error(`Unknown MCP server '${trimmed}'. Provide a name from config, a JSON file, or inline JSON.`);
  }
  return { definition: match, name: match.name };
}

async function fetchTools(
  definition: ServerDefinition,
  serverName: string,
  configPath?: string,
  rootDir?: string
): Promise<ServerToolInfo[]> {
  const runtime = await createRuntime({
    configPath,
    rootDir,
    servers: configPath ? undefined : [definition],
  });
  try {
    return await runtime.listTools(serverName, { includeSchema: true });
  } finally {
    await runtime.close(serverName).catch(() => {});
  }
}

function buildToolMetadata(tool: ServerToolInfo): ToolMetadata {
  const methodName = toProxyMethodName(tool.name);
  const properties = extractOptions(tool);
  return {
    tool,
    methodName,
    options: properties,
  };
}

function buildEmbeddedSchemaMap(tools: ToolMetadata[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const entry of tools) {
    if (entry.tool.inputSchema && typeof entry.tool.inputSchema === 'object') {
      result[entry.tool.name] = entry.tool.inputSchema;
    }
  }
  return result;
}

function extractOptions(tool: ServerToolInfo): GeneratedOption[] {
  const schema = tool.inputSchema;
  if (!schema || typeof schema !== 'object') {
    return [];
  }
  const record = schema as Record<string, unknown>;
  if (record.type !== 'object' || typeof record.properties !== 'object') {
    return [];
  }
  const properties = record.properties as Record<string, unknown>;
  const requiredList = Array.isArray(record.required) ? (record.required as string[]) : [];
  return Object.entries(properties).map(([property, descriptor]) => {
    const type = inferType(descriptor);
    return {
      property,
      cliName: toCliOption(property),
      description: getDescriptorDescription(descriptor),
      required: requiredList.includes(property),
      type,
    };
  });
}

function inferType(descriptor: unknown): GeneratedOption['type'] {
  if (!descriptor || typeof descriptor !== 'object') {
    return 'unknown';
  }
  const type = (descriptor as Record<string, unknown>).type;
  if (type === 'string' || type === 'number' || type === 'boolean' || type === 'array') {
    return type;
  }
  return 'unknown';
}

function getDescriptorDescription(descriptor: unknown): string | undefined {
  if (typeof descriptor !== 'object' || descriptor === null) {
    return undefined;
  }
  const record = descriptor as Record<string, unknown>;
  return typeof record.description === 'string' ? (record.description as string) : undefined;
}

function toProxyMethodName(toolName: string): string {
  return toolName
    .replace(/[-_](\w)/g, (_, char: string) => char.toUpperCase())
    .replace(/^(\w)/, (match) => match.toLowerCase());
}

function toCliOption(property: string): string {
  return property.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`).replace(/_/g, '-');
}

type DefinitionInput =
  | ServerDefinition
  | (Record<string, unknown> & {
      name: string;
      command?: unknown;
      args?: unknown;
    });

function normalizeDefinition(def: DefinitionInput): ServerDefinition {
  if (isServerDefinition(def)) {
    return def;
  }

  const name = def.name;
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('Server definition must include a name.');
  }

  const description = typeof def.description === 'string' ? def.description : undefined;
  const env = toStringRecord(def.env);
  const auth = typeof def.auth === 'string' ? def.auth : undefined;
  const tokenCacheDir = typeof def.tokenCacheDir === 'string' ? def.tokenCacheDir : undefined;
  const clientName = typeof def.clientName === 'string' ? def.clientName : undefined;
  const headers = toStringRecord((def as Record<string, unknown>).headers);

  const commandValue = def.command;
  if (isCommandSpec(commandValue)) {
    return {
      name,
      description,
      command: normalizeCommand(commandValue, headers),
      env,
      auth,
      tokenCacheDir,
      clientName,
    };
  }
  if (typeof commandValue === 'string' && commandValue.trim().length > 0) {
    return {
      name,
      description,
      command: toCommandSpec(commandValue, getStringArray(def.args), headers ? { headers } : undefined),
      env,
      auth,
      tokenCacheDir,
      clientName,
    };
  }
  if (Array.isArray(commandValue) && commandValue.length > 0) {
    const [first, ...rest] = commandValue;
    if (typeof first !== 'string' || !rest.every((entry) => typeof entry === 'string')) {
      throw new Error('Command array must contain only strings.');
    }
    return {
      name,
      description,
      command: toCommandSpec(first, rest as string[], headers ? { headers } : undefined),
      env,
      auth,
      tokenCacheDir,
      clientName,
    };
  }
  throw new Error('Server definition must include command information.');
}

function isServerDefinition(value: unknown): value is ServerDefinition {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.name !== 'string') {
    return false;
  }
  return isCommandSpec(record.command);
}

function isCommandSpec(value: unknown): value is ServerDefinition['command'] {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { kind?: unknown };
  if (candidate.kind === 'http') {
    return 'url' in candidate;
  }
  if (candidate.kind === 'stdio') {
    return 'command' in candidate;
  }
  return false;
}

function normalizeCommand(
  command: ServerDefinition['command'],
  headers?: Record<string, string>
): ServerDefinition['command'] {
  if (command.kind === 'http') {
    const urlValue = command.url;
    const url = urlValue instanceof URL ? urlValue : new URL(String(urlValue));
    const mergedHeaders = command.headers ? (headers ? { ...command.headers, ...headers } : command.headers) : headers;
    const normalized: HttpCommand = {
      kind: 'http',
      url,
      ...(mergedHeaders ? { headers: mergedHeaders } : {}),
    };
    return normalized;
  }
  return {
    kind: 'stdio',
    command: command.command,
    args: [...command.args],
    cwd: command.cwd,
  };
}

function toCommandSpec(
  command: string,
  args?: string[],
  extra?: { headers?: Record<string, string> }
): ServerDefinition['command'] {
  if (command.startsWith('http://') || command.startsWith('https://')) {
    const httpCommand: HttpCommand = {
      kind: 'http',
      url: new URL(command),
      ...(extra?.headers ? { headers: extra.headers } : {}),
    };
    return httpCommand;
  }
  const stdio: StdioCommand = {
    kind: 'stdio',
    command,
    args: args ?? [],
    cwd: process.cwd(),
  };
  return stdio;
}

function getStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries = value.filter((item): item is string => typeof item === 'string');
  return entries.length > 0 ? entries : undefined;
}

function toStringRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      result[key] = entry;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

async function readPackageMetadata(): Promise<{
  name: string;
  version: string;
}> {
  try {
    const pkgPath = new URL('../package.json', import.meta.url);
    const raw = await fs.readFile(pkgPath, 'utf8');
    const parsed = JSON.parse(raw) as { name?: string; version?: string };
    return {
      name: typeof parsed.name === 'string' ? parsed.name : 'mcporter',
      version: typeof parsed.version === 'string' ? parsed.version : 'unknown',
    };
  } catch {
    return { name: 'mcporter', version: 'unknown' };
  }
}

interface TemplateInput {
  outputPath?: string;
  runtimeKind: 'node' | 'bun';
  timeoutMs: number;
  definition: ServerDefinition;
  serverName: string;
  tools: ToolMetadata[];
  generator: { name: string; version: string };
}

async function writeTemplate(input: TemplateInput): Promise<string> {
  const defaultName = `${input.serverName}.ts`;
  const output = input.outputPath ?? defaultName;
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, renderTemplate(input), 'utf8');
  return output;
}

function renderTemplate({ runtimeKind, timeoutMs, definition, serverName, tools, generator }: TemplateInput): string {
  const imports = [
    "import { Command } from 'commander';",
    "import { createRuntime, createServerProxy } from 'mcporter';",
    "import { createCallResult } from 'mcporter';",
  ].join('\n');
  const embedded = JSON.stringify(definition, (_key, value) => (value instanceof URL ? value.toString() : value), 2);
  const generatorHeader = `Generated by ${generator.name}@${generator.version} — https://github.com/steipete/mcporter`;
  const toolHelpLines = tools
    .map((tool) => `  ${tool.tool.name}${tool.tool.description ? ` - ${tool.tool.description}` : ''}`)
    .join('\n');
  const generatorHeaderLiteral = JSON.stringify(generatorHeader);
  const toolHelpLiteral = JSON.stringify(toolHelpLines);
  const embeddedSchemas = JSON.stringify(buildEmbeddedSchemaMap(tools), undefined, 2);
  const toolBlocks = tools.map((tool) => renderToolCommand(tool, timeoutMs)).join('\n\n');
  return `#!/usr/bin/env ${runtimeKind === 'bun' ? 'bun' : 'node'}
${imports}

const embeddedServer = ${embedded} as const;
const embeddedSchemas = ${embeddedSchemas} as const;
const embeddedName = ${JSON.stringify(serverName)};
const generatorInfo = ${generatorHeaderLiteral};
const generatorTools = ${toolHelpLiteral};
const program = new Command();
program.name(embeddedName);
program.description('Standalone CLI generated for the ' + embeddedName + ' MCP server.');
program.option('-c, --config <path>', 'Alternate mcporter.json path to load server definition.');
program.option('-s, --server <name>', 'Alternate server name when using --config.');
program.option('-t, --timeout <ms>', 'Call timeout in milliseconds', (value) => parseInt(value, 10), ${timeoutMs});
program.option('-o, --output <format>', 'Output format: text|markdown|json|raw', 'text');
program.addHelpText('after', () => {
	const sections: string[] = [];
	if (generatorTools) {
		sections.push('\\nTools:\\n' + generatorTools + '\\n');
	}
	if (generatorInfo) {
		sections.push('\\n' + generatorInfo + '\\n');
	}
	return sections.join('');
});

${toolBlocks}

program.command('list-tools')
	.description('List available tools for this CLI')
	.action(() => {
		console.log('Available tools:');
		${JSON.stringify(
      tools.map((tool) => ({
        name: tool.tool.name,
        description: tool.tool.description ?? '',
      })),
      null,
      2
    )}.forEach((entry) => {
			console.log(' - ' + entry.name + (entry.description ? ' - ' + entry.description : ''));
		});
	});

program.parseAsync(process.argv).catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});

async function ensureRuntime(globalOptions: { config?: string; server?: string; timeout: number }) {
	if (globalOptions.config) {
		const runtime = await createRuntime({ configPath: globalOptions.config });
		const name = globalOptions.server ?? embeddedName;
		return { runtime, serverName: name, usingEmbedded: false };
	}
	if (globalOptions.server && globalOptions.server !== embeddedName) {
		throw new Error('Server override not found in embedded definition. Provide --config pointing to a file that contains the server.');
	}
	const definition = normalizeEmbeddedServer(embeddedServer);
	const runtime = await createRuntime({ servers: [definition] });
	return { runtime, serverName: embeddedName, usingEmbedded: true };
}

async function invokeWithTimeout<T>(promise: Promise<T>, timeout: number): Promise<T> {
	return await Promise.race([
		promise,
		new Promise<T>((_, reject) => {
			setTimeout(() => reject(new Error('MCP call timed out after ' + timeout + 'ms')), timeout);
		}),
	]);
}

function printResult(result: unknown, format: string) {
	const wrapped = createCallResult(result);
	switch (format) {
		case 'json': {
			const json = wrapped.json();
			if (json) {
				console.log(JSON.stringify(json, null, 2));
				return;
			}
			break;
		}
		case 'markdown': {
			const markdown = wrapped.markdown();
			if (markdown) {
				console.log(markdown);
				return;
			}
			break;
		}
		case 'raw': {
			console.log(JSON.stringify(wrapped.raw, null, 2));
			return;
		}
	}
	const text = wrapped.text();
	if (text) {
		console.log(text);
	} else {
		console.log(JSON.stringify(wrapped.raw, null, 2));
	}
}

function normalizeEmbeddedServer(server: typeof embeddedServer) {
	const base = { ...server } as Record<string, unknown>;
	if ((server.command as any).kind === 'http') {
		const urlRaw = (server.command as any).url;
		const urlValue = typeof urlRaw === 'string' ? urlRaw : String(urlRaw);
		return {
			...base,
			command: {
				...(server.command as Record<string, unknown>),
				url: new URL(urlValue),
			},
		};
	}
	if ((server.command as any).kind === 'stdio') {
		return {
			...base,
			command: {
				...(server.command as Record<string, unknown>),
				args: [ ...((server.command as any).args ?? []) ],
			},
		};
	}
	return base;
}
`;
}

function renderToolCommand(tool: ToolMetadata, defaultTimeout: number): string {
  const commandName = tool.tool.name.replace(/[^a-zA-Z0-9-]/g, '-');
  const description = tool.tool.description ?? `Invoke the ${tool.tool.name} tool.`;
  const optionLines = tool.options.map((option) => renderOption(option)).join('\n');
  const usageParts = tool.options.map((option) =>
    option.required ? `--${option.cliName} <value>` : `[--${option.cliName} <value>]`
  );
  usageParts.push('[--raw <json>]');
  const usageLine = usageParts.length ? usageParts.join(' ') : '';
  const usageSnippet = usageLine ? `.usage(${JSON.stringify(usageLine)})\n` : '';
  const buildArgs = tool.options
    .map((option) => {
      const source = `cmdOpts.${option.property}`;
      return `if (${source} !== undefined) args.${option.property} = ${source};`;
    })
    .join('\n\t\t');
  return `program
	.command(${JSON.stringify(commandName)})
	.description(${JSON.stringify(description)})
${usageSnippet ? `\t${usageSnippet}` : ''}\t.option('--raw <json>', 'Provide raw JSON arguments to the tool, bypassing flag parsing.')
${optionLines ? `\n${optionLines}` : ''}
	.action(async (cmdOpts) => {
		const globalOptions = program.opts();
		const { runtime, serverName, usingEmbedded } = await ensureRuntime({
			config: globalOptions.config,
			server: globalOptions.server,
			timeout: globalOptions.timeout || ${defaultTimeout},
		});
		const proxy = createServerProxy(runtime, serverName, {
			initialSchemas: usingEmbedded ? embeddedSchemas : undefined,
		});
		try {
			const args = cmdOpts.raw ? JSON.parse(cmdOpts.raw) : ({} as Record<string, unknown>);
			${buildArgs}
			const call = (proxy.${tool.methodName} as any)(args);
			const result = await invokeWithTimeout(call, globalOptions.timeout || ${defaultTimeout});
			printResult(result, globalOptions.output ?? 'text');
		} finally {
			await runtime.close(serverName).catch(() => {});
		}
	});`;
}

function renderOption(option: GeneratedOption): string {
  const flag = `--${option.cliName} <value>`;
  const description = option.description ? option.description : `Set ${option.property}.`;
  const parser = optionParser(option);
  const base = option.required
    ? `.requiredOption(${JSON.stringify(flag)}, ${JSON.stringify(description)}${parser ? `, ${parser}` : ''})`
    : `.option(${JSON.stringify(flag)}, ${JSON.stringify(description)}${parser ? `, ${parser}` : ''})`;
  return `	${base}`;
}

function optionParser(option: GeneratedOption): string | undefined {
  switch (option.type) {
    case 'number':
      return '(value) => parseFloat(value)';
    case 'boolean':
      return "(value) => value !== 'false'";
    case 'array':
      return "(value) => value.split(',')";
    default:
      return undefined;
  }
}

async function bundleOutput({
  sourcePath,
  targetPath,
  runtimeKind,
  minify,
}: {
  sourcePath: string;
  targetPath: string;
  runtimeKind: 'node' | 'bun';
  minify: boolean;
}): Promise<string> {
  const absTarget = path.resolve(targetPath);
  await esbuild({
    absWorkingDir: process.cwd(),
    entryPoints: [sourcePath],
    outfile: absTarget,
    bundle: true,
    platform: 'node',
    format: runtimeKind === 'bun' ? 'esm' : 'cjs',
    target: 'node20',
    minify,
    logLevel: 'silent',
  });
  await fs.chmod(absTarget, 0o755);
  return absTarget;
}

function replaceExtension(file: string, extension: string): string {
  const dirname = path.dirname(file);
  const basename = path.basename(file, path.extname(file));
  return path.join(dirname, `${basename}.${extension}`);
}

async function compileBundleWithBun(bundlePath: string, outputPath: string): Promise<void> {
  const bunBin = await verifyBunAvailable();
  await new Promise<void>((resolve, reject) => {
    execFile(
      bunBin,
      ['build', bundlePath, '--compile', '--outfile', outputPath],
      { cwd: process.cwd(), env: process.env },
      (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      }
    );
  });

  await fs.chmod(outputPath, 0o755);
}

// resolveBundleTarget normalizes bundle path selection when --bundle/--compile are combined.
function resolveBundleTarget({
  bundle,
  compile,
  outputPath,
  runtimeKind,
}: {
  bundle?: boolean | string;
  compile?: boolean | string;
  outputPath: string;
  runtimeKind: 'node' | 'bun';
}): string {
  const defaultExt = runtimeKind === 'bun' ? '.js' : '.cjs';
  if (typeof bundle === 'string') {
    return bundle;
  }
  if (bundle) {
    return replaceExtension(outputPath, defaultExt.slice(1));
  }
  if (typeof compile === 'string') {
    const ext = path.extname(compile);
    const base = ext ? path.join(path.dirname(compile), path.basename(compile, ext)) : compile;
    return `${base}${defaultExt}`;
  }
  return replaceExtension(outputPath, defaultExt.slice(1));
}

// computeCompileTarget picks the final binary output location, defaulting to the bundle basename.

function computeCompileTarget(
  compileOption: GenerateCliOptions['compile'],
  bundlePath: string,
  serverName: string
): string {
  if (typeof compileOption === 'string') {
    return compileOption;
  }
  const bundleDir = path.dirname(bundlePath);
  if (serverName) {
    return path.join(bundleDir, serverName);
  }
  const parsed = path.parse(bundlePath);
  return path.join(parsed.dir, parsed.name);
}

async function resolveRuntimeKind(
  runtimeOption: GenerateCliOptions['runtime'],
  compileOption: GenerateCliOptions['compile']
): Promise<'node' | 'bun'> {
  if (runtimeOption) {
    return runtimeOption;
  }
  const bunAvailable = await isBunAvailable();
  if (compileOption && !bunAvailable) {
    throw new Error('--compile requires Bun. Install Bun or set BUN_BIN to the bun executable.');
  }
  return bunAvailable ? 'bun' : 'node';
}

async function isBunAvailable(): Promise<boolean> {
  try {
    await verifyBunAvailable();
    return true;
  } catch {
    return false;
  }
}

async function verifyBunAvailable(): Promise<string> {
  const bunBin = process.env.BUN_BIN ?? 'bun';
  await new Promise<void>((resolve, reject) => {
    execFile(bunBin, ['--version'], { cwd: process.cwd(), env: process.env }, (error) => {
      if (error) {
        reject(new Error('Unable to locate Bun runtime. Install Bun or set BUN_BIN to the bun executable.'));
        return;
      }
      resolve();
    });
  });
  return bunBin;
}

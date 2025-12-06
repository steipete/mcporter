import type { CliArtifactMetadata, SerializedServerDefinition } from '../../cli-metadata.js';
import type { GenerateCliOptions } from '../../generate-cli.js';

export type InspectableInvocation = CliArtifactMetadata['invocation'] & {
  serverRef?: string;
  includeTools?: string[];
  excludeTools?: string[];
};

export interface GenerateCliContext {
  invocation: InspectableInvocation;
  definition: SerializedServerDefinition;
}

export function buildGenerateCliCommand(
  invocation: InspectableInvocation,
  definition: SerializedServerDefinition,
  globalFlags: Record<string, string | undefined> = {}
): string {
  const tokens: string[] = ['mcporter'];
  const configPath = invocation.configPath ?? globalFlags['--config'];
  const rootDir = invocation.rootDir ?? globalFlags['--root'];
  if (configPath) {
    tokens.push('--config', configPath);
  }
  if (rootDir) {
    tokens.push('--root', rootDir);
  }
  tokens.push('generate-cli');

  const serverRef = invocation.serverRef ?? definition.name ?? JSON.stringify(definition);
  tokens.push('--server', serverRef);

  if (invocation.outputPath) {
    tokens.push('--output', invocation.outputPath);
  }
  if (invocation.bundler && invocation.bundler !== 'rolldown') {
    tokens.push('--bundler', invocation.bundler);
  }
  if (typeof invocation.bundle === 'string') {
    tokens.push('--bundle', invocation.bundle);
  } else if (invocation.bundle) {
    tokens.push('--bundle');
  }
  if (typeof invocation.compile === 'string') {
    tokens.push('--compile', invocation.compile);
  } else if (invocation.compile) {
    tokens.push('--compile');
  }
  if (invocation.runtime) {
    tokens.push('--runtime', invocation.runtime);
  }
  if (invocation.timeoutMs && invocation.timeoutMs !== 30_000) {
    tokens.push('--timeout', String(invocation.timeoutMs));
  }
  if (invocation.minify) {
    tokens.push('--minify');
  }
  if (invocation.includeTools && invocation.includeTools.length > 0) {
    tokens.push('--include-tools', invocation.includeTools.join(','));
  }
  if (invocation.excludeTools && invocation.excludeTools.length > 0) {
    tokens.push('--exclude-tools', invocation.excludeTools.join(','));
  }
  return tokens.map(shellQuote).join(' ');
}

export function resolveGenerateRequestFromArtifact(
  parsed: {
    from?: string;
    server?: string;
    output?: string;
    runtime?: GenerateCliOptions['runtime'];
    bundler?: GenerateCliOptions['bundler'];
    bundle?: GenerateCliOptions['bundle'];
    timeout: number;
    compile?: GenerateCliOptions['compile'];
    minify?: boolean;
    includeTools?: string[];
    excludeTools?: string[];
  },
  metadata: CliArtifactMetadata,
  globalFlags: Record<string, string | undefined>
): GenerateCliOptions {
  if (!parsed.from) {
    throw new Error('Missing --from artifact path.');
  }
  const invocation = { ...metadata.invocation };
  const serverRef =
    parsed.server ?? invocation.serverRef ?? metadata.server.name ?? JSON.stringify(metadata.server.definition);
  if (!serverRef) {
    throw new Error('Unable to determine server definition from artifact; pass --server with a target name.');
  }

  // Resolve include/exclude from CLI flags or metadata
  const includeTools = parsed.includeTools ?? invocation.includeTools;
  const excludeTools = parsed.excludeTools ?? invocation.excludeTools;

  // Validate mutual exclusivity across CLI flags + metadata
  if (includeTools && excludeTools) {
    throw new Error(
      'Cannot combine --include-tools and --exclude-tools; artifact metadata and CLI overrides both specify conflicting filters.'
    );
  }

  return {
    serverRef,
    configPath: globalFlags['--config'] ?? invocation.configPath,
    rootDir: globalFlags['--root'] ?? invocation.rootDir,
    outputPath: parsed.output ?? invocation.outputPath,
    runtime: parsed.runtime ?? invocation.runtime,
    bundler: parsed.bundler ?? invocation.bundler,
    bundle: parsed.bundle ?? invocation.bundle,
    timeoutMs: parsed.timeout ?? invocation.timeoutMs,
    compile: parsed.compile ?? invocation.compile,
    minify: parsed.minify ?? invocation.minify ?? false,
    includeTools,
    excludeTools,
  };
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./@%-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

import { readCliMetadata } from '../cli-metadata.js';
import type { FlagMap } from './flag-utils.js';
import { parseGenerateFlags } from './generate/flags.js';
import { inferNameFromCommand } from './generate/name-utils.js';
import { performGenerateFromArtifact, performGenerateFromRequest } from './generate/output.js';
import { buildInlineServerDefinition } from './generate/server-utils.js';
import { buildGenerateCliCommand, resolveGenerateRequestFromArtifact } from './generate/template-data.js';

// handleGenerateCli parses flags and generates the requested standalone CLI.
export async function handleGenerateCli(args: string[], globalFlags: FlagMap): Promise<void> {
  const parsed = parseGenerateFlags(args);
  if (parsed.includeTools && parsed.excludeTools) {
    throw new Error('--include-tools and --exclude-tools cannot be used together.');
  }
  if (parsed.from && (parsed.command || parsed.description || parsed.name)) {
    throw new Error('--from cannot be combined with --command/--description/--name.');
  }
  if (parsed.dryRun && !parsed.from) {
    throw new Error('--dry-run currently requires --from <artifact>.');
  }

  if (parsed.from) {
    const metadata = await readCliMetadata(parsed.from);
    const request = resolveGenerateRequestFromArtifact(parsed, metadata, globalFlags);
    if (parsed.dryRun) {
      const command = buildGenerateCliCommand(
        {
          serverRef: request.serverRef,
          configPath: request.configPath,
          rootDir: request.rootDir,
          outputPath: request.outputPath,
          bundle: request.bundle,
          compile: request.compile,
          runtime: request.runtime ?? 'node',
          timeoutMs: request.timeoutMs ?? 30_000,
          minify: request.minify ?? false,
          includeTools: request.includeTools,
          excludeTools: request.excludeTools,
        },
        metadata.server.definition,
        globalFlags
      );
      console.log('Dry run — would execute:');
      console.log(`  ${command}`);
      return;
    }
    await performGenerateFromArtifact(metadata, request);
    return;
  }

  const inferredName = parsed.name ?? (parsed.command ? inferNameFromCommand(parsed.command) : undefined);
  const serverRef =
    parsed.server ??
    (parsed.command && inferredName
      ? JSON.stringify(buildInlineServerDefinition(inferredName, parsed.command, parsed.description))
      : undefined);
  if (!serverRef) {
    throw new Error(
      'Provide --server with a definition or a command we can infer a name from (use --name to override).'
    );
  }
  await performGenerateFromRequest({
    serverRef,
    configPath: globalFlags['--config'],
    rootDir: globalFlags['--root'],
    outputPath: parsed.output,
    runtime: parsed.runtime,
    bundler: parsed.bundler,
    bundle: parsed.bundle,
    timeoutMs: parsed.timeout,
    compile: parsed.compile,
    minify: parsed.minify ?? false,
    includeTools: parsed.includeTools,
    excludeTools: parsed.excludeTools,
  });
}

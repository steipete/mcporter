import fs from 'node:fs/promises';
import path from 'node:path';
import {
  bundleOutput,
  compileBundleWithBun,
  computeCompileTarget,
  resolveBundleTarget,
} from './cli/generate/artifacts.js';
import {
  ensureInvocationDefaults,
  fetchTools,
  fileExists,
  resolveServerDefinition,
} from './cli/generate/definition.js';
import { resolveRuntimeKind } from './cli/generate/runtime.js';
import { readPackageMetadata, writeTemplate } from './cli/generate/template.js';
import type { ToolMetadata } from './cli/generate/tools.js';
import { buildToolMetadata, toolsTestHelpers } from './cli/generate/tools.js';
import { type CliArtifactKind, type CliArtifactMetadata, writeCliMetadata } from './cli-metadata.js';

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

// generateCli produces a standalone CLI (and optional bundle/binary) for a given MCP server.
export async function generateCli(
  options: GenerateCliOptions
): Promise<{ outputPath: string; bundlePath?: string; compilePath?: string }> {
  const runtimeKind = await resolveRuntimeKind(options.runtime, options.compile);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const { definition, name } = await resolveServerDefinition(options.serverRef, options.configPath, options.rootDir);
  const tools = await fetchTools(definition, name, options.configPath, options.rootDir);
  const toolMetadata: ToolMetadata[] = tools.map((tool) => buildToolMetadata(tool));
  const generator = await readPackageMetadata();

  let templateTmpDir: string | undefined;
  let templateOutputPath = options.outputPath;
  if (!templateOutputPath && options.compile) {
    const tmpPrefix = path.join(process.cwd(), 'tmp', 'mcporter-cli-');
    await fs.mkdir(path.dirname(tmpPrefix), { recursive: true });
    templateTmpDir = await fs.mkdtemp(tmpPrefix);
    templateOutputPath = path.join(templateTmpDir, `${name}.ts`);
  }

  const outputPath = await writeTemplate({
    outputPath: templateOutputPath,
    runtimeKind,
    timeoutMs,
    definition,
    serverName: name,
    tools: toolMetadata,
    generator,
  });

  let bundlePath: string | undefined;
  let compilePath: string | undefined;

  try {
    const shouldBundle = Boolean(options.bundle ?? options.compile);
    if (shouldBundle) {
      const targetPath = resolveBundleTarget({
        bundle: options.bundle,
        compile: options.compile,
        outputPath,
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
        if (!options.bundle) {
          await fs.rm(bundlePath).catch(() => {});
          bundlePath = undefined;
        }
      }
    }
  } finally {
    if (templateTmpDir) {
      await fs.rm(templateTmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  const metadataTargets: Array<{ path: string; kind: CliArtifactKind; invocation: CliArtifactMetadata['invocation'] }> =
    [];
  const baseInvocation: CliArtifactMetadata['invocation'] = {
    serverRef: options.serverRef,
    configPath: options.configPath,
    rootDir: options.rootDir,
    runtime: runtimeKind,
    outputPath: options.outputPath,
    bundle: options.bundle,
    compile: options.compile,
    timeoutMs,
    minify: options.minify ?? false,
  };

  const templatePersisted = !templateTmpDir || Boolean(options.outputPath);
  if (templatePersisted && (await fileExists(outputPath))) {
    metadataTargets.push({
      path: outputPath,
      kind: 'template',
      invocation: {
        ...baseInvocation,
        outputPath,
      },
    });
  }

  if (bundlePath) {
    metadataTargets.push({
      path: bundlePath,
      kind: 'bundle',
      invocation: {
        ...baseInvocation,
        bundle: bundlePath,
      },
    });
  }

  if (compilePath) {
    metadataTargets.push({
      path: compilePath,
      kind: 'binary',
      invocation: {
        ...baseInvocation,
        compile: compilePath,
      },
    });
  }

  if (metadataTargets.length > 0) {
    await Promise.all(
      metadataTargets.map((entry) =>
        writeCliMetadata({
          artifactPath: entry.path,
          kind: entry.kind,
          generator,
          server: { name, source: definition.source, definition },
          invocation: ensureInvocationDefaults(entry.invocation, definition),
        })
      )
    );
  }

  return { outputPath: options.outputPath ?? outputPath, bundlePath, compilePath };
}

export const __test = toolsTestHelpers;

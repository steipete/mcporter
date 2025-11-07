import { execFile } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild, type Plugin } from 'esbuild';
import { verifyBunAvailable } from './runtime.js';

const localRequire = createRequire(import.meta.url);
const packageRoot = fileURLToPath(new URL('../../..', import.meta.url));
// Generated CLIs import commander/mcporter, but end-users run mcporter from directories
// that often lack node_modules. Pre-resolve those deps to this package so bundling works
// even in empty temp dirs (fixes #1).
const dependencyAliasPlugin = createLocalDependencyAliasPlugin(['commander', 'mcporter']);

export async function bundleOutput({
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
  await fs.mkdir(path.dirname(absTarget), { recursive: true });
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
    plugins: dependencyAliasPlugin ? [dependencyAliasPlugin] : undefined,
  });
  await fs.chmod(absTarget, 0o755);
  return absTarget;
}

export async function compileBundleWithBun(bundlePath: string, outputPath: string): Promise<void> {
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

export function resolveBundleTarget({
  bundle,
  compile,
  outputPath,
}: {
  bundle?: boolean | string;
  compile?: boolean | string;
  outputPath: string;
}): string {
  if (typeof bundle === 'string') {
    return bundle;
  }
  if (bundle) {
    throw new Error('--bundle requires an explicit output path when used with --compile.');
  }
  if (typeof compile === 'string') {
    const ext = path.extname(compile);
    const base = ext ? path.join(path.dirname(compile), path.basename(compile, ext)) : compile;
    return `${base}.js`;
  }
  if (compile) {
    const tmpDir = path.join(process.cwd(), 'tmp', 'mcporter-cli-bundles');
    const baseName = path.basename(outputPath, path.extname(outputPath)) || 'bundle';
    return path.join(tmpDir, `${baseName}-${Date.now()}.bundle.js`);
  }
  throw new Error('--compile requires an explicit bundle target.');
}

export function computeCompileTarget(
  compileOption: boolean | string | undefined,
  bundlePath: string,
  serverName: string
): string {
  if (typeof compileOption === 'string') {
    return compileOption;
  }
  const parsed = path.parse(bundlePath);
  const base = parsed.name.replace(/\.bundle$/, '') || serverName || 'mcporter-cli';
  return path.join(parsed.dir, base);
}

function createLocalDependencyAliasPlugin(specifiers: string[]): Plugin | undefined {
  const resolvedEntries = specifiers
    .map((specifier) => ({ specifier, path: resolveLocalDependency(specifier) }))
    .filter((entry): entry is { specifier: string; path: string } => Boolean(entry.path));
  if (resolvedEntries.length === 0) {
    return undefined;
  }
  return {
    name: 'mcporter-local-deps',
    setup(build) {
      for (const { specifier, path: resolvedPath } of resolvedEntries) {
        const filter = new RegExp(`^${escapeForRegExp(specifier)}$`);
        build.onResolve({ filter }, () => ({ path: resolvedPath }));
      }
    },
  };
}

function resolveLocalDependency(specifier: string): string | undefined {
  try {
    return localRequire.resolve(specifier);
  } catch {
    if (specifier === 'mcporter') {
      // During development or unpublished builds there may not be an installed entry,
      // so fall back to the files inside the repo that represent the published surface.
      const fallbacks = [
        path.join(packageRoot, 'dist', 'index.js'),
        path.join(packageRoot, 'dist', 'index.mjs'),
        path.join(packageRoot, 'src', 'index.ts'),
        path.join(packageRoot, 'src', 'index.js'),
      ];
      for (const candidate of fallbacks) {
        if (fsSync.existsSync(candidate)) {
          return candidate;
        }
      }
    }
    return undefined;
  }
}

function escapeForRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

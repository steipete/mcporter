import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build as esbuild } from 'esbuild';
import { verifyBunAvailable } from './runtime.js';

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

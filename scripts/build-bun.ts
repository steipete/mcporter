#!/usr/bin/env bun
/**
 * Build a self-contained mcporter binary using Bun's --compile mode.
 * Mirrors the poltergeist release flow so we can dual-publish via npm + Homebrew.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

interface Options {
  readonly target?: string;
  readonly bytecode: boolean;
  readonly minify: boolean;
  readonly output?: string;
}

// parseArgs walks CLI flags and produces normalized build options.
function parseArgs(argv: string[]): Options {
  let target: string | undefined;
  let bytecode = false;
  let minify = true;
  let output: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) {
      continue;
    }
    if (token === '--target') {
      target = requireValue(token, argv[++index]);
      continue;
    }
    if (token === '--bytecode') {
      bytecode = true;
      continue;
    }
    if (token === '--no-minify') {
      minify = false;
      continue;
    }
    if (token === '--output') {
      output = requireValue(token, argv[++index]);
      continue;
    }
    throw new Error(`Unknown flag "${token}"`);
  }

  return { target, bytecode, minify, output };
}

// requireValue asserts that a flag includes a value.
function requireValue(flag: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

// main orchestrates the Bun compile flow for the mcporter binary.
async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const projectRoot = path.join(fs.realpathSync(path.dirname(new URL(import.meta.url).pathname)), '..');
  const distDir = path.join(projectRoot, 'dist-bun');
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  const outputPath = options.output
    ? path.resolve(options.output)
    : path.join(distDir, options.target ? `mcporter-${options.target}` : 'mcporter');

  const buildArgs = ['build', path.join(projectRoot, 'src/cli.ts'), '--compile', '--outfile', outputPath];

  if (options.minify) {
    buildArgs.push('--minify');
  }
  if (options.bytecode) {
    buildArgs.push('--bytecode');
  }
  if (options.target) {
    buildArgs.push('--target', options.target);
  }

  console.log(`Building mcporter binary → ${outputPath}`);
  const result = spawnSync('bun', buildArgs, { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`bun build exited with status ${result.status ?? 'unknown'}`);
  }

  if (process.platform !== 'win32') {
    fs.chmodSync(outputPath, 0o755);
  }

  try {
    const sizeBytes = fs.statSync(outputPath).size;
    const human = formatSize(sizeBytes);
    console.log(`✅ Built ${outputPath} (${human})`);
  } catch {
    console.log(`✅ Built ${outputPath}`);
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 ** 2) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 ** 3) {
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  }
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

main().catch((error) => {
  console.error('mcporter Bun build failed.');
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exit(1);
});

import { execFile } from 'node:child_process';

export async function resolveRuntimeKind(
  runtimeOption: 'node' | 'bun' | undefined,
  compileOption: boolean | string | undefined
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

export async function verifyBunAvailable(): Promise<string> {
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

async function isBunAvailable(): Promise<boolean> {
  try {
    await verifyBunAvailable();
    return true;
  } catch {
    return false;
  }
}

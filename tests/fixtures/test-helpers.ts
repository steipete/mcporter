import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Generates a short-lived temp directory with a stable, short base to avoid
// UNIX-domain socket length issues on macOS/Linux. On Windows we stick to the
// platform temp dir.
export async function makeShortTempDir(prefix: string): Promise<string> {
  const baseDir = process.platform === 'win32' ? os.tmpdir() : '/tmp';
  const dir = path.join(baseDir, `${prefix}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

// Safely restore cwd when running under Vitest workers (which disallow chdir).
export function restoreCwdSafely(originalCwd: string): void {
  try {
    process.chdir(originalCwd);
  } catch (error) {
    if (!(error instanceof Error) || !/chdir\(\) is not supported/.test(error.message)) {
      throw error;
    }
  }
}

import fs from 'node:fs/promises';

// Windows/WSL DrvFs mounts frequently reject chmod/copyfile when targeting NTFS-backed paths.
// Keep these helpers best-effort so CLI generation still works on those hosts.
export async function markExecutable(filePath: string): Promise<void> {
  try {
    await fs.chmod(filePath, 0o755);
  } catch (error) {
    if (!shouldIgnorePosixPermissionError(error)) {
      throw error;
    }
  }
}

export async function safeCopyFile(sourcePath: string, targetPath: string): Promise<void> {
  try {
    await fs.copyFile(sourcePath, targetPath);
    return;
  } catch (error) {
    if (!shouldIgnorePosixPermissionError(error)) {
      throw error;
    }
  }
  const data = await fs.readFile(sourcePath);
  await fs.writeFile(targetPath, data);
}

function shouldIgnorePosixPermissionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EPERM' || code === 'EINVAL' || code === 'ENOSYS' || code === 'EACCES';
}

import fs from 'node:fs/promises';
import path from 'node:path';

// readJsonFile reads a JSON file and returns undefined when the file does not exist.
export async function readJsonFile<T = unknown>(filePath: string): Promise<T | undefined> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

// writeJsonFile writes a JSON object to disk, ensuring parent directories are created first.
export async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

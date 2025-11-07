import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readJsonFile, writeJsonFile } from '../src/fs-json.js';

describe('fs-json helpers', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-fs-json-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('returns undefined when reading a missing file', async () => {
    const missingPath = path.join(tempDir, 'missing.json');
    const value = await readJsonFile<Record<string, string>>(missingPath);
    expect(value).toBeUndefined();
  });

  it('writes JSON and reads it back, ensuring parent directories are created', async () => {
    const nestedPath = path.join(tempDir, 'nested', 'config.json');
    const payload = { apiKey: 'secret', retries: 2 };
    await writeJsonFile(nestedPath, payload);

    const roundTripped = await readJsonFile<typeof payload>(nestedPath);
    expect(roundTripped).toEqual(payload);

    const raw = await fs.readFile(nestedPath, 'utf8');
    expect(raw).toContain('\n  "apiKey"');
  });
});

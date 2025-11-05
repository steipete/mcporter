import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ServerDefinition } from './config.js';

const SCHEMA_FILENAME = 'schema.json';

export interface SchemaCacheSnapshot {
  readonly updatedAt: string;
  readonly tools: Record<string, unknown>;
}

export function resolveSchemaCacheDir(definition: ServerDefinition): string {
  return definition.tokenCacheDir ?? path.join(os.homedir(), '.mcporter', definition.name);
}

export function resolveSchemaCachePath(definition: ServerDefinition): string {
  return path.join(resolveSchemaCacheDir(definition), SCHEMA_FILENAME);
}

export async function readSchemaCache(definition: ServerDefinition): Promise<SchemaCacheSnapshot | undefined> {
  const filePath = resolveSchemaCachePath(definition);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as SchemaCacheSnapshot;
    if (!parsed || typeof parsed !== 'object') {
      return undefined;
    }
    if (!parsed.tools || typeof parsed.tools !== 'object') {
      return undefined;
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

export async function writeSchemaCache(definition: ServerDefinition, snapshot: SchemaCacheSnapshot): Promise<void> {
  const filePath = resolveSchemaCachePath(definition);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf8');
}

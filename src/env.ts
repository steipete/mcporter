import os from 'node:os';

const ENV_DEFAULT_PATTERN = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-|:|-)?([^}]*)\}$/;
const ENV_INTERPOLATION_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const ENV_DIRECT_PREFIX = '$env:';

export function expandHome(input: string): string {
  if (!input.startsWith('~')) {
    return input;
  }
  const home = os.homedir();
  if (input === '~') {
    return home;
  }
  if (input.startsWith('~/')) {
    return `${home}/${input.slice(2)}`;
  }
  return input;
}

export function resolveEnvValue(raw: unknown): string {
  if (typeof raw !== 'string') {
    return String(raw);
  }

  const match = ENV_DEFAULT_PATTERN.exec(raw);
  if (match) {
    const envName = match[1];
    const defaultValue = match[2] ?? '';
    if (!envName) {
      return raw;
    }
    const existing = process.env[envName];
    if (existing && existing !== '') {
      return existing;
    }
    return defaultValue;
  }

  if (raw.startsWith('$')) {
    return resolveEnvPlaceholders(raw);
  }

  return raw;
}

export function resolveEnvPlaceholders(value: string): string {
  if (value.startsWith(ENV_DIRECT_PREFIX)) {
    const envName = value.slice(ENV_DIRECT_PREFIX.length);
    const envValue = process.env[envName];
    if (envValue === undefined) {
      throw new Error(`Environment variable '${envName}' is required for MCP header substitution.`);
    }
    return envValue;
  }

  const missing = new Set<string>();
  const replaced = value.replace(ENV_INTERPOLATION_PATTERN, (placeholder, envName: string) => {
    const envValue = process.env[envName];
    if (envValue === undefined) {
      missing.add(envName);
      return placeholder;
    }
    return envValue;
  });

  if (missing.size > 0) {
    const names = [...missing].sort().join(', ');
    throw new Error(`Environment variable(s) ${names} must be set for MCP header substitution.`);
  }

  return replaced;
}

export async function withEnvOverrides<T>(
  envOverrides: Record<string, string> | undefined,
  fn: () => Promise<T> | T
): Promise<T> {
  if (!envOverrides || Object.keys(envOverrides).length === 0) {
    return await fn();
  }

  const applied: string[] = [];
  for (const [key, rawValue] of Object.entries(envOverrides)) {
    if (process.env[key]) {
      continue;
    }
    const resolved = resolveEnvValue(rawValue);
    if (resolved === '') {
      continue;
    }
    process.env[key] = resolved;
    applied.push(key);
  }

  try {
    return await fn();
  } finally {
    for (const key of applied) {
      delete process.env[key];
    }
  }
}

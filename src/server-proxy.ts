import { createCallResult } from './result-utils.js';
import type { CallOptions, ListToolsOptions, Runtime, ServerToolInfo } from './runtime.js';
import { readSchemaCache, writeSchemaCache } from './schema-cache.js';

type ToolCallOptions = CallOptions & { args?: unknown };
type ToolArguments = CallOptions['args'];

type ServerProxy = {
  call(toolName: string, options?: ToolCallOptions): Promise<ReturnType<typeof createCallResult>>;
  listTools(options?: ListToolsOptions): Promise<ServerToolInfo[]>;
};

type ToolSchemaInfo = {
  schema: Record<string, unknown>;
  orderedKeys: string[];
  requiredKeys: string[];
  propertySet: Set<string>;
};

const KNOWN_OPTION_KEYS = new Set(['tailLog', 'timeout', 'stream', 'streamLog', 'mimeType', 'metadata', 'log']);

export interface ServerProxyOptions {
  readonly mapPropertyToTool?: (property: string | symbol) => string;
  readonly cacheSchemas?: boolean;
  readonly initialSchemas?: Record<string, unknown>;
}

function defaultToolNameMapper(propertyKey: string | symbol): string {
  if (typeof propertyKey !== 'string') {
    throw new TypeError('Tool name must be a string when using server proxy.');
  }
  return propertyKey.replace(/([a-z\d])([A-Z])/g, '$1-$2').toLowerCase();
}

function canonicalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createToolSchemaInfo(schemaRaw: unknown): ToolSchemaInfo | undefined {
  if (!schemaRaw || typeof schemaRaw !== 'object') {
    return undefined;
  }
  const schema = schemaRaw as Record<string, unknown>;
  const propertiesRaw = schema.properties;
  const propertyKeys =
    propertiesRaw && typeof propertiesRaw === 'object' ? Object.keys(propertiesRaw as Record<string, unknown>) : [];
  const requiredKeys = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  const orderedKeys: string[] = [];
  const seen = new Set<string>();

  for (const key of requiredKeys) {
    if (typeof key === 'string' && !seen.has(key)) {
      orderedKeys.push(key);
      seen.add(key);
    }
  }

  for (const key of propertyKeys) {
    if (!seen.has(key)) {
      orderedKeys.push(key);
      seen.add(key);
    }
  }

  return {
    schema,
    orderedKeys,
    requiredKeys,
    propertySet: new Set([...propertyKeys, ...requiredKeys]),
  };
}

function applyDefaults(meta: ToolSchemaInfo, args?: ToolArguments): ToolArguments {
  const propertiesRaw = meta.schema.properties;
  if (!propertiesRaw || typeof propertiesRaw !== 'object') {
    return args;
  }

  const result: Record<string, unknown> = isPlainObject(args) ? { ...(args as Record<string, unknown>) } : {};

  for (const [key, value] of Object.entries(propertiesRaw as Record<string, unknown>)) {
    if (
      value &&
      typeof value === 'object' &&
      'default' in (value as Record<string, unknown>) &&
      result[key] === undefined
    ) {
      result[key] = (value as Record<string, unknown>).default as unknown;
    }
  }

  if (Object.keys(result).length === 0 && !isPlainObject(args)) {
    return args;
  }

  return result as ToolArguments;
}

function validateRequired(meta: ToolSchemaInfo, args?: ToolArguments): void {
  if (meta.requiredKeys.length === 0) {
    return;
  }
  if (!isPlainObject(args)) {
    throw new Error(`Missing required arguments: ${meta.requiredKeys.join(', ')}`);
  }
  const missing = meta.requiredKeys.filter((key) => (args as Record<string, unknown>)[key] === undefined);
  if (missing.length > 0) {
    throw new Error(`Missing required arguments: ${missing.join(', ')}`);
  }
}

export function createServerProxy(
  runtime: Runtime,
  serverName: string,
  mapOrOptions?: ((property: string | symbol) => string) | ServerProxyOptions,
  maybeOptions?: ServerProxyOptions
): ServerProxy {
  let mapPropertyToTool = defaultToolNameMapper;
  let options: ServerProxyOptions | undefined;

  if (typeof mapOrOptions === 'function') {
    mapPropertyToTool = mapOrOptions;
    options = maybeOptions;
  } else if (mapOrOptions) {
    options = mapOrOptions;
    if (typeof mapOrOptions.mapPropertyToTool === 'function') {
      mapPropertyToTool = mapOrOptions.mapPropertyToTool;
    }
  }

  const cacheSchemas = options?.cacheSchemas ?? true;
  const initialSchemas = options?.initialSchemas ?? undefined;

  const toolSchemaCache = new Map<string, ToolSchemaInfo>();
  const persistedSchemas = new Map<string, Record<string, unknown>>();
  const toolAliasMap = new Map<string, string>();
  let schemaFetch: Promise<void> | null = null;
  let diskLoad: Promise<void> | null = null;
  let persistPromise: Promise<void> | null = null;
  let refreshPending = false;

  let definitionForCache: ReturnType<Runtime['getDefinition']> | undefined;
  if (cacheSchemas) {
    try {
      definitionForCache = runtime.getDefinition(serverName);
    } catch {
      definitionForCache = undefined;
    }
  }

  if (cacheSchemas && !initialSchemas && definitionForCache) {
    diskLoad = loadSchemasFromDisk(definitionForCache);
    refreshPending = true;
  }

  if (initialSchemas) {
    for (const [key, schemaRaw] of Object.entries(initialSchemas)) {
      storeSchema(key, schemaRaw);
    }
    persistPromise = persistSchemas();
  }

  async function consumePersist(): Promise<void> {
    if (!persistPromise) {
      return;
    }
    try {
      await persistPromise;
    } finally {
      persistPromise = null;
    }
  }

  async function ensureMetadata(toolName: string): Promise<ToolSchemaInfo | undefined> {
    await consumePersist();
    const cached = toolSchemaCache.get(toolName);
    if (cached && !refreshPending) {
      return cached;
    }

    if (diskLoad) {
      try {
        await diskLoad;
      } finally {
        diskLoad = null;
      }
      if (toolSchemaCache.has(toolName) && !refreshPending) {
        return toolSchemaCache.get(toolName);
      }
    }

    if (!schemaFetch) {
      schemaFetch = runtime
        .listTools(serverName, { includeSchema: true })
        .then((tools) => {
          for (const tool of tools) {
            if (!tool.inputSchema || typeof tool.inputSchema !== 'object') {
              continue;
            }
            storeSchema(tool.name, tool.inputSchema);
          }
          persistPromise = persistSchemas();
          refreshPending = false;
        })
        .catch((error) => {
          schemaFetch = null;
          throw error;
        });
    }

    await schemaFetch;
    await consumePersist();
    return toolSchemaCache.get(toolName);
  }

  function storeSchema(key: string, schemaRaw: unknown) {
    const info = createToolSchemaInfo(schemaRaw);
    if (!info) {
      return;
    }
    const canonical = mapPropertyToTool(key);
    toolSchemaCache.set(canonical, info);
    if (canonical !== key) {
      toolSchemaCache.set(key, info);
    }
    const canonicalAlias = canonicalizeToolName(key);
    if (!toolAliasMap.has(canonicalAlias)) {
      toolAliasMap.set(canonicalAlias, key);
    }
    const mapperAlias = canonicalizeToolName(canonical);
    if (!toolAliasMap.has(mapperAlias)) {
      toolAliasMap.set(mapperAlias, key);
    }
    if (cacheSchemas && definitionForCache && isPlainObject(schemaRaw)) {
      persistedSchemas.set(canonical, schemaRaw as Record<string, unknown>);
    }
  }

  async function loadSchemasFromDisk(definition: ReturnType<Runtime['getDefinition']>): Promise<void> {
    try {
      const snapshot = await readSchemaCache(definition);
      if (!snapshot) {
        return;
      }
      for (const [key, schemaRaw] of Object.entries(snapshot.tools)) {
        storeSchema(key, schemaRaw);
      }
    } catch {
      // ignore cache read failures
    }
  }

  function persistSchemas(): Promise<void> | null {
    if (!cacheSchemas || !definitionForCache || persistedSchemas.size === 0) {
      return null;
    }
    const definition = definitionForCache;
    const snapshot = {
      updatedAt: new Date().toISOString(),
      tools: Object.fromEntries(persistedSchemas.entries()),
    };
    return writeSchemaCache(definition, snapshot).catch(() => {
      // best-effort persistence
    });
  }

  const base: ServerProxy = {
    call: async (toolName: string, options?: ToolCallOptions) => {
      const result = await runtime.callTool(serverName, toolName, options ?? {});
      return createCallResult(result);
    },
    listTools: (options) => runtime.listTools(serverName, options),
  };

  return new Proxy(base as ServerProxy & Record<string | symbol, unknown>, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) {
        return Reflect.get(target, property, receiver);
      }
      const propertyKey = property;
      const canonicalKey = typeof propertyKey === 'string' ? canonicalizeToolName(propertyKey) : null;
      let resolvedToolName =
        typeof propertyKey === 'string' && canonicalKey
          ? (toolAliasMap.get(canonicalKey) ?? mapPropertyToTool(propertyKey))
          : mapPropertyToTool(propertyKey);

      return async (...callArgs: unknown[]) => {
        let schemaInfo: ToolSchemaInfo | undefined;
        try {
          schemaInfo = await ensureMetadata(resolvedToolName);
        } catch {
          schemaInfo = undefined;
        }
        if (typeof propertyKey === 'string' && canonicalKey) {
          const alias = toolAliasMap.get(canonicalKey);
          if (alias && alias !== resolvedToolName) {
            resolvedToolName = alias;
            try {
              schemaInfo = await ensureMetadata(resolvedToolName);
            } catch {
              // ignore and keep prior schema if available
            }
          }
        }

        const positional: unknown[] = [];
        const argsAccumulator: Record<string, unknown> = {};
        const optionsAccumulator: ToolCallOptions = {};

        for (const arg of callArgs) {
          if (isPlainObject(arg)) {
            const keys = Object.keys(arg);
            const treatAsArgs =
              schemaInfo !== undefined &&
              keys.length > 0 &&
              (keys.every((key) => schemaInfo.propertySet.has(key)) ||
                keys.every((key) => !KNOWN_OPTION_KEYS.has(key)));

            if (treatAsArgs) {
              Object.assign(argsAccumulator, arg as Record<string, unknown>);
            } else {
              Object.assign(optionsAccumulator, arg as ToolCallOptions);
            }
          } else {
            positional.push(arg);
          }
        }

        const explicitArgs = optionsAccumulator.args as ToolArguments | undefined;
        if (explicitArgs !== undefined) {
          delete (optionsAccumulator as Record<string, unknown>).args;
        }

        const finalOptions: ToolCallOptions = { ...optionsAccumulator };
        let combinedArgs: ToolArguments | undefined = explicitArgs;

        if (schemaInfo) {
          const schema = schemaInfo;

          if (positional.length > schema.orderedKeys.length) {
            throw new Error(`Too many positional arguments for tool "${resolvedToolName}"`);
          }

          if (positional.length > 0) {
            const baseArgs = isPlainObject(combinedArgs) ? { ...(combinedArgs as Record<string, unknown>) } : {};
            positional.forEach((value, idx) => {
              const key = schema.orderedKeys[idx];
              if (key) {
                baseArgs[key] = value;
              }
            });
            combinedArgs = baseArgs as ToolArguments;
          }

          if (Object.keys(argsAccumulator).length > 0) {
            const baseArgs = isPlainObject(combinedArgs) ? { ...(combinedArgs as Record<string, unknown>) } : {};
            Object.assign(baseArgs, argsAccumulator);
            combinedArgs = baseArgs as ToolArguments;
          }

          if (combinedArgs !== undefined) {
            combinedArgs = applyDefaults(schema, combinedArgs);
          } else {
            const defaults = applyDefaults(schema, undefined);
            if (defaults && typeof defaults === 'object') {
              combinedArgs = defaults as ToolArguments;
            }
          }

          validateRequired(schema, combinedArgs);
        } else {
          if (positional.length > 0) {
            combinedArgs = positional as unknown as ToolArguments;
          }
          if (Object.keys(argsAccumulator).length > 0) {
            const baseArgs = isPlainObject(combinedArgs) ? { ...(combinedArgs as Record<string, unknown>) } : {};
            Object.assign(baseArgs, argsAccumulator);
            combinedArgs = baseArgs as ToolArguments;
          }
        }

        if (combinedArgs !== undefined) {
          finalOptions.args = combinedArgs;
        }

        const result = await runtime.callTool(serverName, resolvedToolName, finalOptions);
        return createCallResult(result);
      };
    },
  });
}

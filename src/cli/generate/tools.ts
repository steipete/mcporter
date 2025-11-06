import type { ServerToolInfo } from '../../runtime.js';

export interface ToolMetadata {
  tool: ServerToolInfo;
  methodName: string;
  options: GeneratedOption[];
}

export interface GeneratedOption {
  property: string;
  cliName: string;
  description?: string;
  required: boolean;
  type: 'string' | 'number' | 'boolean' | 'array' | 'unknown';
  placeholder: string;
  exampleValue?: string;
  enumValues?: string[];
  defaultValue?: unknown;
}

export function buildToolMetadata(tool: ServerToolInfo): ToolMetadata {
  const methodName = toProxyMethodName(tool.name);
  const properties = extractOptions(tool);
  return {
    tool,
    methodName,
    options: properties,
  };
}

export function buildEmbeddedSchemaMap(tools: ToolMetadata[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const entry of tools) {
    if (entry.tool.inputSchema && typeof entry.tool.inputSchema === 'object') {
      result[entry.tool.name] = entry.tool.inputSchema;
    }
  }
  return result;
}

export function extractOptions(tool: ServerToolInfo): GeneratedOption[] {
  const schema = tool.inputSchema;
  if (!schema || typeof schema !== 'object') {
    return [];
  }
  const record = schema as Record<string, unknown>;
  if (record.type !== 'object' || typeof record.properties !== 'object') {
    return [];
  }
  const properties = record.properties as Record<string, unknown>;
  const requiredList = Array.isArray(record.required) ? (record.required as string[]) : [];
  return Object.entries(properties).map(([property, descriptor]) => {
    const type = inferType(descriptor);
    const enumValues = getEnumValues(descriptor);
    const defaultValue = getDescriptorDefault(descriptor);
    const placeholder = buildPlaceholder(property, type, enumValues);
    const exampleValue = buildExampleValue(property, type, enumValues, defaultValue);
    return {
      property,
      cliName: toCliOption(property),
      description: getDescriptorDescription(descriptor),
      required: requiredList.includes(property),
      type,
      placeholder,
      exampleValue,
      enumValues,
      defaultValue,
    };
  });
}

export function getEnumValues(descriptor: unknown): string[] | undefined {
  if (!descriptor || typeof descriptor !== 'object') {
    return undefined;
  }
  const record = descriptor as Record<string, unknown>;
  if (Array.isArray(record.enum)) {
    const values = record.enum.filter((entry): entry is string => typeof entry === 'string');
    return values.length > 0 ? values : undefined;
  }
  if (record.type === 'array' && typeof record.items === 'object' && record.items !== null) {
    const nested = record.items as Record<string, unknown>;
    if (Array.isArray(nested.enum)) {
      const values = nested.enum.filter((entry): entry is string => typeof entry === 'string');
      return values.length > 0 ? values : undefined;
    }
  }
  return undefined;
}

export function getDescriptorDefault(descriptor: unknown): unknown {
  if (!descriptor || typeof descriptor !== 'object') {
    return undefined;
  }
  const record = descriptor as Record<string, unknown>;
  if (record.default !== undefined) {
    return record.default;
  }
  if (record.type === 'array' && typeof record.items === 'object' && record.items !== null) {
    return Array.isArray(record.default) ? record.default : undefined;
  }
  return undefined;
}

export function buildPlaceholder(property: string, type: GeneratedOption['type'], enumValues?: string[]): string {
  const normalized = property.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`).replace(/_/g, '-');
  if (enumValues && enumValues.length > 0) {
    return `<${normalized}:${enumValues.join('|')}>`;
  }
  switch (type) {
    case 'number':
      return `<${normalized}:number>`;
    case 'boolean':
      return `<${normalized}:true|false>`;
    case 'array':
      return `<${normalized}:value1,value2>`;
    default:
      return `<${normalized ?? 'value'}>`;
  }
}

export function buildExampleValue(
  property: string,
  type: GeneratedOption['type'],
  enumValues: string[] | undefined,
  defaultValue: unknown
): string | undefined {
  if (enumValues && enumValues.length > 0) {
    return enumValues[0] as string;
  }
  if (defaultValue !== undefined) {
    try {
      return typeof defaultValue === 'string' ? defaultValue : JSON.stringify(defaultValue);
    } catch {
      return undefined;
    }
  }
  switch (type) {
    case 'number':
      return '1';
    case 'boolean':
      return 'true';
    case 'array':
      return 'value1,value2';
    default:
      if (property.toLowerCase().includes('path')) {
        return '/path/to/file.md';
      }
      if (property.toLowerCase().includes('id')) {
        return 'example-id';
      }
      return undefined;
  }
}

export function inferType(descriptor: unknown): GeneratedOption['type'] {
  if (!descriptor || typeof descriptor !== 'object') {
    return 'unknown';
  }
  const type = (descriptor as Record<string, unknown>).type;
  if (type === 'string' || type === 'number' || type === 'boolean' || type === 'array') {
    return type;
  }
  return 'unknown';
}

export function getDescriptorDescription(descriptor: unknown): string | undefined {
  if (typeof descriptor !== 'object' || descriptor === null) {
    return undefined;
  }
  const record = descriptor as Record<string, unknown>;
  return typeof record.description === 'string' ? (record.description as string) : undefined;
}

export function toProxyMethodName(toolName: string): string {
  return toolName
    .replace(/[-_](\w)/g, (_, char: string) => char.toUpperCase())
    .replace(/^(\w)/, (match) => match.toLowerCase());
}

export function toCliOption(property: string): string {
  return property.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`).replace(/_/g, '-');
}

export const toolsTestHelpers = {
  getEnumValues,
  getDescriptorDefault,
  buildPlaceholder,
  buildExampleValue,
};

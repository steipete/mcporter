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
  arrayItemType?: 'string' | 'number' | 'boolean' | 'unknown';
  placeholder: string;
  exampleValue?: string;
  enumValues?: string[];
  defaultValue?: unknown;
  formatHint?: string;
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
  // Flatten schema properties into Commander-friendly option descriptors.
  const properties = record.properties as Record<string, unknown>;
  const requiredList = Array.isArray(record.required) ? (record.required as string[]) : [];
  return Object.entries(properties).map(([property, descriptor]) => {
    const type = inferType(descriptor);
    const arrayItemType = type === 'array' ? inferArrayItemType(descriptor) : undefined;
    const enumValues = getEnumValues(descriptor);
    const defaultValue = getDescriptorDefault(descriptor);
    const formatInfo = getDescriptorFormatHint(descriptor);
    const placeholder = buildPlaceholder(property, type, enumValues, formatInfo?.slug);
    const exampleValue = buildExampleValue(property, type, enumValues, defaultValue);
    return {
      property,
      cliName: toCliOption(property),
      description: getDescriptorDescription(descriptor),
      required: requiredList.includes(property),
      type,
      arrayItemType,
      placeholder,
      exampleValue,
      enumValues,
      defaultValue,
      formatHint: formatInfo?.display,
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

export function buildPlaceholder(
  property: string,
  type: GeneratedOption['type'],
  enumValues?: string[],
  formatSlug?: string
): string {
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
      if (formatSlug) {
        return `<${normalized}:${formatSlug}>`;
      }
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

export function pickExampleLiteral(option: GeneratedOption): string | undefined {
  if (option.enumValues && option.enumValues.length > 0) {
    return JSON.stringify(option.enumValues[0]);
  }
  if (!option.exampleValue) {
    return undefined;
  }
  if (option.type === 'array') {
    const values = option.exampleValue
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (values.length === 0) {
      return undefined;
    }
    return `[${values.map((entry) => JSON.stringify(entry)).join(', ')}]`;
  }
  if (option.type === 'number' || option.type === 'boolean') {
    return option.exampleValue;
  }
  try {
    const parsed = JSON.parse(option.exampleValue);
    if (typeof parsed === 'number' || typeof parsed === 'boolean') {
      return option.exampleValue;
    }
  } catch {
    // fall through to quoted string literal
  }
  return JSON.stringify(option.exampleValue);
}

export function buildFallbackLiteral(option: GeneratedOption): string {
  switch (option.type) {
    case 'number':
      return '1';
    case 'boolean':
      return 'true';
    case 'array':
      return '["value1"]';
    default: {
      if (option.property.toLowerCase().includes('id')) {
        return JSON.stringify('example-id');
      }
      if (option.property.toLowerCase().includes('url')) {
        return JSON.stringify('https://example.com');
      }
      return JSON.stringify('value');
    }
  }
}

export function inferType(descriptor: unknown): GeneratedOption['type'] {
  if (!descriptor || typeof descriptor !== 'object') {
    return 'unknown';
  }
  const type = (descriptor as Record<string, unknown>).type;
  const resolveType = (value: unknown): GeneratedOption['type'] | undefined => {
    if (value === 'integer') {
      return 'number';
    }
    if (value === 'string' || value === 'number' || value === 'boolean' || value === 'array') {
      return value;
    }
    return undefined;
  };
  if (Array.isArray(type)) {
    for (const entry of type) {
      const resolved = resolveType(entry);
      if (resolved) {
        return resolved;
      }
    }
    return 'unknown';
  }
  const resolved = resolveType(type);
  if (resolved) {
    return resolved;
  }
  return 'unknown';
}

export function inferArrayItemType(descriptor: unknown): GeneratedOption['arrayItemType'] {
  if (!descriptor || typeof descriptor !== 'object') {
    return 'unknown';
  }
  const record = descriptor as Record<string, unknown>;
  if (record.type !== 'array' || !record.items || typeof record.items !== 'object') {
    return 'unknown';
  }
  const items = record.items as Record<string, unknown>;
  const itemType = items.type;
  const resolveItemType = (value: unknown): GeneratedOption['arrayItemType'] | undefined => {
    if (value === 'integer') {
      return 'number';
    }
    if (value === 'string' || value === 'number' || value === 'boolean') {
      return value;
    }
    return undefined;
  };
  if (Array.isArray(itemType)) {
    for (const entry of itemType) {
      const resolved = resolveItemType(entry);
      if (resolved) {
        return resolved;
      }
    }
    return 'unknown';
  }
  const resolved = resolveItemType(itemType);
  if (resolved) {
    return resolved;
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

export function getDescriptorFormatHint(descriptor: unknown): { display: string; slug: string } | undefined {
  if (typeof descriptor !== 'object' || descriptor === null) {
    return undefined;
  }
  const record = descriptor as Record<string, unknown>;
  const formatRaw = typeof record.format === 'string' ? record.format : undefined;
  const description = typeof record.description === 'string' ? record.description : undefined;

  const iso8601FromDescription =
    !formatRaw && description && /\biso[-\s]*8601\b/i.test(description) ? 'iso-8601' : undefined;
  const isoFormatFromDescription =
    !formatRaw && !iso8601FromDescription && description && /\biso\s+format\b/i.test(description)
      ? 'iso-8601'
      : undefined;

  const formatFromDescription = iso8601FromDescription ?? isoFormatFromDescription;

  const slug = formatRaw ?? formatFromDescription;
  if (!slug) {
    return undefined;
  }

  let display: string;
  switch (slug) {
    case 'date-time':
    case 'iso-8601':
      display = 'ISO 8601';
      break;
    case 'uuid':
      display = 'UUID';
      break;
    default:
      display = slug.replace(/[_-]/g, ' ');
      display = display.charAt(0).toUpperCase() + display.slice(1);
      break;
  }
  return {
    display: display.replace(/\b\w/g, (char) => char.toUpperCase()),
    slug,
  };
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
  pickExampleLiteral,
  buildFallbackLiteral,
};

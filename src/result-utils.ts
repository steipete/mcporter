export interface CallResult<T = unknown> {
  raw: T;
  text(joiner?: string): string | null;
  markdown(joiner?: string): string | null;
  json<J = unknown>(): J | null;
  content(): unknown[] | null;
  structuredContent(): unknown;
}

function extractContentArray(raw: unknown): unknown[] | null {
  if (
    raw &&
    typeof raw === 'object' &&
    'content' in (raw as Record<string, unknown>) &&
    Array.isArray((raw as Record<string, unknown>).content)
  ) {
    return (raw as { content: unknown[] }).content;
  }
  return null;
}

function extractStructuredContent(raw: unknown): unknown {
  if (raw && typeof raw === 'object' && 'structuredContent' in (raw as Record<string, unknown>)) {
    return (raw as Record<string, unknown>).structuredContent;
  }
  return null;
}

function asString(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (value && typeof value === 'object' && 'text' in value) {
    const text = (value as Record<string, unknown>).text;
    return typeof text === 'string' ? text : null;
  }
  return null;
}

function collectText(content: unknown[], joiner: string): string | null {
  const pieces: string[] = [];
  for (const entry of content) {
    if (entry && typeof entry === 'object' && 'type' in entry) {
      const type = (entry as Record<string, unknown>).type;
      if (type === 'text' || type === 'markdown') {
        const text = asString(entry);
        if (text) {
          pieces.push(text);
        }
      }
    }
  }
  if (pieces.length > 0) {
    return pieces.join(joiner);
  }
  return null;
}

function tryParseJson(value: unknown): unknown {
  if (!value) {
    return null;
  }
  if (typeof value === 'object') {
    if ('json' in (value as Record<string, unknown>)) {
      return (value as Record<string, unknown>).json ?? null;
    }
    if ('data' in (value as Record<string, unknown>)) {
      return (value as Record<string, unknown>).data ?? null;
    }
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return null;
}

export function createCallResult<T = unknown>(raw: T): CallResult<T> {
  return {
    raw,
    text(joiner = '\n') {
      if (raw == null) {
        return null;
      }
      if (typeof raw === 'string') {
        return raw;
      }

      const content = extractContentArray(raw);
      if (content) {
        const collected = collectText(content, joiner);
        if (collected) {
          return collected;
        }
      }

      const structured = extractStructuredContent(raw);
      const asStr = asString(structured);
      return asStr ?? null;
    },
    markdown(joiner = '\n') {
      const structured = extractStructuredContent(raw);
      if (structured && typeof structured === 'object') {
        const markdown = (structured as Record<string, unknown>).markdown;
        if (typeof markdown === 'string') {
          return markdown;
        }
      }

      const content = extractContentArray(raw);
      if (!content) {
        return null;
      }
      const markdownEntries = content.filter(
        (entry) => entry && typeof entry === 'object' && (entry as Record<string, unknown>).type === 'markdown'
      );
      if (markdownEntries.length === 0) {
        return null;
      }
      return markdownEntries
        .map((entry) => asString(entry) ?? '')
        .filter(Boolean)
        .join(joiner);
    },
    json<J = unknown>() {
      const structured = extractStructuredContent(raw);
      const parsedStructured = tryParseJson(structured);
      if (parsedStructured) {
        return parsedStructured as J;
      }

      const content = extractContentArray(raw);
      if (content) {
        for (const entry of content) {
          if (entry && typeof entry === 'object' && (entry as Record<string, unknown>).type === 'json') {
            const parsed = tryParseJson(entry);
            if (parsed) {
              return parsed as J;
            }
          }
        }
      }
      return null;
    },
    content() {
      return extractContentArray(raw);
    },
    structuredContent() {
      return extractStructuredContent(raw);
    },
  };
}

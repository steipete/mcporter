import { analyzeConnectionError, type ConnectionIssue } from './error-classifier.js';

export interface CallResult<T = unknown> {
  raw: T;
  text(joiner?: string): string | null;
  markdown(joiner?: string): string | null;
  json<J = unknown>(): J | null;
  content(): unknown[] | null;
  structuredContent(): unknown;
  pick<J = unknown>(paths: string | readonly string[]): J | null;
  withJsonOverride<J = unknown>(nextJson: J): CallResult<T>;
}

// extractContentArray pulls the `content` array from MCP response envelopes.
function extractContentArray(raw: unknown): unknown[] | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const obj = raw as Record<string, unknown>;

  // Check for content array at top level
  if ('content' in obj && Array.isArray(obj.content)) {
    return obj.content as unknown[];
  }

  // Check for content array nested inside 'raw' wrapper
  if ('raw' in obj && obj.raw && typeof obj.raw === 'object') {
    const nested = obj.raw as Record<string, unknown>;
    if ('content' in nested && Array.isArray(nested.content)) {
      return nested.content as unknown[];
    }
  }

  return null;
}

// extractStructuredContent returns the structuredContent field when present.
function extractStructuredContent(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const obj = raw as Record<string, unknown>;

  // Check for structuredContent at top level
  if ('structuredContent' in obj) {
    return obj.structuredContent;
  }

  // Check for structuredContent nested inside 'raw' wrapper
  if ('raw' in obj && obj.raw && typeof obj.raw === 'object') {
    const nested = obj.raw as Record<string, unknown>;
    if ('structuredContent' in nested) {
      return nested.structuredContent;
    }
  }

  return null;
}

// asString converts known content/value shapes into plain strings.
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

// collectText flattens all text/markdown entries into a joined string.
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

// tryParseJson pulls JSON payloads out of structured responses or raw strings.
function tryParseJson(value: unknown): unknown {
  if (value === undefined || value === null) {
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

// createCallResult wraps a tool response with helpers for common content types.
export function createCallResult<T = unknown>(raw: T, options?: { jsonOverride?: unknown }): CallResult<T> {
  const jsonOverride = options?.jsonOverride;

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
      if (jsonOverride !== undefined) {
        return jsonOverride as J;
      }

      const structured = extractStructuredContent(raw);
      const parsedStructured = tryParseJson(structured);
      if (parsedStructured !== null) {
        return parsedStructured as J;
      }

      const content = extractContentArray(raw);
      if (content) {
        for (const entry of content) {
          if (entry && typeof entry === 'object') {
            const typedEntry = entry as Record<string, unknown>;
            if (typedEntry.type === 'json') {
              const parsed = tryParseJson(entry);
              if (parsed !== null) {
                return parsed as J;
              }
              continue;
            }
            if (typedEntry.type === 'text' || typedEntry.type === 'markdown') {
              const text = asString(entry);
              if (typeof text === 'string') {
                const parsedText = tryParseJson(text);
                if (parsedText !== null) {
                  return parsedText as J;
                }
              }
              continue;
            }
          }
          if (typeof entry === 'string') {
            const parsed = tryParseJson(entry);
            if (parsed !== null) {
              return parsed as J;
            }
          }
        }
      }

      if (typeof raw === 'string') {
        const parsedRaw = tryParseJson(raw);
        if (parsedRaw !== null) {
          return parsedRaw as J;
        }
      }

      const textContent = this.text?.();
      if (typeof textContent === 'string') {
        const parsedText = tryParseJson(textContent);
        if (parsedText !== null) {
          return parsedText as J;
        }
      }

      const markdownContent = this.markdown?.();
      if (typeof markdownContent === 'string') {
        const parsedMarkdown = tryParseJson(markdownContent);
        if (parsedMarkdown !== null) {
          return parsedMarkdown as J;
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
    pick<J = unknown>(paths: string | readonly string[]): J | null {
      const data = this.json<any>();
      if (data === null) {
        return null;
      }

      const list = Array.isArray(paths) ? paths : [paths];

      const project = (value: any): any => {
        if (value == null || typeof value !== 'object') return value;

        const out: Record<string, unknown> = {};

        for (const path of list) {
          if (!path) continue;
          const segments = path.split('.');
          let cursor: any = value;

          // Navigate to the value
          for (const seg of segments) {
            if (cursor == null) break;
            cursor = cursor[seg];
          }

          if (cursor !== undefined) {
            // Preserve nested structure by rebuilding the path
            if (segments.length === 1) {
              // Simple case: top-level field
              out[segments[0]!] = cursor;
            } else {
              // Nested case: rebuild the object hierarchy
              let target = out;
              for (let i = 0; i < segments.length - 1; i++) {
                const seg = segments[i]!;
                if (!(seg in target)) {
                  target[seg] = {};
                }
                target = target[seg] as Record<string, unknown>;
              }
              const leafKey = segments[segments.length - 1]!;
              target[leafKey] = cursor;
            }
          }
        }

        return out;
      };

      if (Array.isArray(data)) {
        return data.map(project) as J;
      }

      return project(data) as J;
    },
    withJsonOverride<J = unknown>(nextJson: J): CallResult<T> {
      return createCallResult(raw, { jsonOverride: nextJson });
    },
  };
}

export type { ConnectionIssue } from './error-classifier.js';

export function describeConnectionIssue(error: unknown): ConnectionIssue {
  return analyzeConnectionError(error);
}

export function wrapCallResult<T = unknown>(raw: T): { raw: T; callResult: CallResult<T> } {
  return { raw, callResult: createCallResult(raw) };
}

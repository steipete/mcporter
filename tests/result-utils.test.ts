import { describe, expect, it } from 'vitest';
import { createCallResult, describeConnectionIssue } from '../src/result-utils.js';

describe('result-utils connection helpers', () => {
  it('describes connection issues for offline errors', () => {
    const issue = describeConnectionIssue(new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:9999'));
    expect(issue.kind).toBe('offline');
  });
});

describe('createCallResult text extraction', () => {
  it('extracts text from content array at top level', () => {
    const response = {
      content: [
        {
          type: 'text',
          text: 'Hello World',
        },
      ],
    };
    const result = createCallResult(response);
    expect(result.text()).toBe('Hello World');
  });

  it('extracts text from content array nested inside raw wrapper', () => {
    const response = {
      raw: {
        content: [
          {
            type: 'text',
            text: 'Available pages for stanfordnlp/dspy:\n\n- 1 Overview',
          },
        ],
      },
    };
    const result = createCallResult(response);
    expect(result.text()).toBe('Available pages for stanfordnlp/dspy:\n\n- 1 Overview');
  });

  it('extracts multiple text entries and joins them', () => {
    const response = {
      content: [
        {
          type: 'text',
          text: 'First part',
        },
        {
          type: 'text',
          text: 'Second part',
        },
      ],
    };
    const result = createCallResult(response);
    expect(result.text()).toBe('First part\nSecond part');
  });

  it('returns null when no text content is available', () => {
    const response = {
      content: [
        {
          type: 'image',
          data: 'base64...',
        },
      ],
    };
    const result = createCallResult(response);
    expect(result.text()).toBe(null);
  });

  it('returns string when raw is already a string', () => {
    const response = 'Simple string response';
    const result = createCallResult(response);
    expect(result.text()).toBe('Simple string response');
  });
});

describe('createCallResult markdown extraction', () => {
  it('extracts markdown from content array', () => {
    const response = {
      content: [
        {
          type: 'markdown',
          text: '# Header\n\nContent',
        },
      ],
    };
    const result = createCallResult(response);
    expect(result.markdown()).toBe('# Header\n\nContent');
  });

  it('extracts markdown from content array nested inside raw wrapper', () => {
    const response = {
      raw: {
        content: [
          {
            type: 'markdown',
            text: '## Subtitle',
          },
        ],
      },
    };
    const result = createCallResult(response);
    expect(result.markdown()).toBe('## Subtitle');
  });

  it('extracts markdown from structuredContent nested inside raw wrapper', () => {
    const response = {
      raw: {
        structuredContent: {
          markdown: '_italic_',
        },
      },
    };
    const result = createCallResult(response);
    expect(result.markdown()).toBe('_italic_');
  });
});

describe('createCallResult json extraction', () => {
  it('returns null for text-only content', () => {
    const response = {
      content: [
        {
          type: 'text',
          text: 'Plain text',
        },
      ],
    };
    const result = createCallResult(response);
    expect(result.json()).toBe(null);
  });

  it('extracts json from content array with json type', () => {
    const response = {
      content: [
        {
          type: 'json',
          json: { foo: 'bar' },
        },
      ],
    };
    const result = createCallResult(response);
    expect(result.json()).toEqual({ foo: 'bar' });
  });

  it('extracts json from structuredContent nested inside raw wrapper', () => {
    const response = {
      raw: {
        structuredContent: {
          json: { nested: true },
        },
      },
    };
    const result = createCallResult(response);
    expect(result.json()).toEqual({ nested: true });
  });
});

describe('createCallResult structured accessors', () => {
  it('content() returns nested raw content array', () => {
    const nested = [{ type: 'text', text: 'Hello' }];
    const response = {
      raw: {
        content: nested,
      },
    };
    const result = createCallResult(response);
    expect(result.content()).toBe(nested);
  });

  it('structuredContent() returns nested raw structuredContent', () => {
    const structured = { text: 'Inner text' };
    const response = {
      raw: {
        structuredContent: structured,
      },
    };
    const result = createCallResult(response);
    expect(result.structuredContent()).toBe(structured);
  });

  it('text() falls back to structuredContent.text when no content exists', () => {
    const response = {
      raw: {
        structuredContent: {
          text: 'Structured fallback',
        },
      },
    };
    const result = createCallResult(response);
    expect(result.text()).toBe('Structured fallback');
  });
});

describe('CallResult.pick()', () => {
  it('picks top-level fields from a single object', () => {
    const mockResponse = {
      content: [
        {
          type: 'json',
          json: {
            id: 'user-1',
            name: 'Alice',
            email: 'alice@example.com',
            age: 30,
            secret: 'should-not-appear',
          },
        },
      ],
    };

    const result = createCallResult(mockResponse);
    const picked = result.pick(['id', 'name', 'email']);

    expect(picked).toEqual({
      id: 'user-1',
      name: 'Alice',
      email: 'alice@example.com',
    });
  });

  it('picks top-level fields from an array of objects', () => {
    const mockResponse = {
      content: [
        {
          type: 'json',
          json: [
            { id: 'doc-1', title: 'First', content: 'Long content...' },
            { id: 'doc-2', title: 'Second', content: 'More content...' },
          ],
        },
      ],
    };

    const result = createCallResult(mockResponse);
    const picked = result.pick(['id', 'title']);

    expect(picked).toEqual([
      { id: 'doc-1', title: 'First' },
      { id: 'doc-2', title: 'Second' },
    ]);
  });

  it('picks nested fields and preserves structure', () => {
    const mockResponse = {
      content: [
        {
          type: 'json',
          json: {
            id: 'user-1',
            profile: {
              email: 'alice@example.com',
              location: {
                city: 'San Francisco',
                country: 'USA',
              },
            },
            settings: {
              theme: 'dark',
            },
          },
        },
      ],
    };

    const result = createCallResult(mockResponse);
    const picked = result.pick(['id', 'profile.email', 'profile.location.city']);

    expect(picked).toEqual({
      id: 'user-1',
      profile: {
        email: 'alice@example.com',
        location: {
          city: 'San Francisco',
        },
      },
    });
  });

  it('picks nested fields from array of objects', () => {
    const mockResponse = {
      content: [
        {
          type: 'json',
          json: [
            {
              id: 'doc-1',
              title: 'Getting Started',
              metadata: {
                author: 'Alice',
                stats: { views: 100, likes: 10 },
              },
            },
            {
              id: 'doc-2',
              title: 'Advanced',
              metadata: {
                author: 'Bob',
                stats: { views: 200, likes: 20 },
              },
            },
          ],
        },
      ],
    };

    const result = createCallResult(mockResponse);
    const picked = result.pick(['id', 'title', 'metadata.author', 'metadata.stats.views']);

    expect(picked).toEqual([
      {
        id: 'doc-1',
        title: 'Getting Started',
        metadata: {
          author: 'Alice',
          stats: { views: 100 },
        },
      },
      {
        id: 'doc-2',
        title: 'Advanced',
        metadata: {
          author: 'Bob',
          stats: { views: 200 },
        },
      },
    ]);
  });

  it('handles single string path (not array)', () => {
    const mockResponse = {
      content: [{ type: 'json', json: { id: '123', name: 'Test' } }],
    };

    const result = createCallResult(mockResponse);
    const picked = result.pick('id');

    expect(picked).toEqual({ id: '123' });
  });

  it('returns null when json() returns null', () => {
    const mockResponse = { content: [] };
    const result = createCallResult(mockResponse);
    const picked = result.pick(['id', 'name']);

    expect(picked).toBeNull();
  });

  it('handles missing nested fields gracefully', () => {
    const mockResponse = {
      content: [
        {
          type: 'json',
          json: {
            id: 'user-1',
            profile: { email: 'alice@example.com' },
          },
        },
      ],
    };

    const result = createCallResult(mockResponse);
    const picked = result.pick(['id', 'profile.email', 'profile.location.city', 'missing.field']);

    expect(picked).toEqual({
      id: 'user-1',
      profile: { email: 'alice@example.com' },
    });
  });

  it('handles empty pick array', () => {
    const mockResponse = {
      content: [{ type: 'json', json: { id: '123', name: 'Test' } }],
    };

    const result = createCallResult(mockResponse);
    const picked = result.pick([]);

    expect(picked).toEqual({});
  });
});

describe('CallResult.withJsonOverride()', () => {
  it('creates new CallResult with overridden json', () => {
    const mockResponse = {
      content: [{ type: 'json', json: { original: 'data' } }],
    };

    const result = createCallResult(mockResponse);
    const overridden = result.withJsonOverride({ custom: 'data' });

    expect(overridden.json()).toEqual({ custom: 'data' });
    expect(overridden.raw).toBe(mockResponse); // raw unchanged
  });

  it('preserves raw envelope while changing json', () => {
    const mockResponse = {
      content: [{ type: 'json', json: { id: '123' } }],
      isError: false,
    };

    const result = createCallResult(mockResponse);
    const picked = result.pick(['id']);
    const overridden = result.withJsonOverride(picked);

    expect(overridden.raw).toEqual(mockResponse);
    expect(overridden.json()).toEqual({ id: '123' });
  });
});

describe('CallResult.json() with override', () => {
  it('returns override when provided', () => {
    const mockResponse = {
      content: [{ type: 'json', json: { original: 'data' } }],
    };

    const result = createCallResult(mockResponse, { jsonOverride: { overridden: true } });

    expect(result.json()).toEqual({ overridden: true });
  });

  it('returns parsed json when no override', () => {
    const mockResponse = {
      content: [{ type: 'json', json: { original: 'data' } }],
    };

    const result = createCallResult(mockResponse);

    expect(result.json()).toEqual({ original: 'data' });
  });
});

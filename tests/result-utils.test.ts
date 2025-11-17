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
});

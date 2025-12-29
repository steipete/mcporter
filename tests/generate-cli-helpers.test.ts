import { describe, expect, it } from 'vitest';
import {
  buildExampleValue,
  buildFallbackLiteral,
  buildPlaceholder,
  buildToolMetadata,
  extractOptions,
  getDescriptorDefault,
  getDescriptorDescription,
  getDescriptorFormatHint,
  getEnumValues,
  inferArrayItemType,
  inferType,
  pickExampleLiteral,
  toCliOption,
  toProxyMethodName,
} from '../src/cli/generate/tools.js';
import type { ServerToolInfo } from '../src/runtime.js';

describe('generate helpers', () => {
  const sampleTool: ServerToolInfo = {
    name: 'add-numbers',
    description: 'Add two numbers',
    inputSchema: {
      type: 'object',
      properties: {
        firstValue: { type: 'number', description: 'First operand', default: 1 },
        mode: { type: 'string', enum: ['fast', 'accurate'] },
        extra_path: { type: 'string' },
        cursor: { type: 'string', format: 'date-time', description: 'ISO 8601 cursor' },
      },
      required: ['firstValue', 'mode'],
    },
    outputSchema: undefined,
  };

  it('builds tool metadata', () => {
    const metadata = buildToolMetadata(sampleTool);
    expect(metadata.methodName).toBe('addNumbers');
    expect(metadata.options).toHaveLength(4);
    const first = metadata.options.find((option) => option.property === 'firstValue');
    expect(first).toBeDefined();
    if (first) {
      expect(first.required).toBe(true);
    }
  });

  it('extracts detailed option information', () => {
    const options = extractOptions(sampleTool);
    const first = options.find((option) => option.property === 'firstValue');
    expect(first).toBeDefined();
    if (first) {
      expect(first.placeholder).toBe('<first-value:number>');
      expect(first.exampleValue).toBe('1');
    }

    const mode = options.find((option) => option.property === 'mode');
    expect(mode).toBeDefined();
    if (mode) {
      expect(mode.enumValues).toEqual(['fast', 'accurate']);
      expect(mode.exampleValue).toBe('fast');
    }

    const extra = options.find((option) => option.property === 'extra_path');
    expect(extra).toBeDefined();
    if (extra) {
      expect(extra.placeholder).toBe('<extra-path>');
      expect(extra.exampleValue).toBe('/path/to/file.md');
    }

    const cursor = options.find((option) => option.property === 'cursor');
    expect(cursor).toBeDefined();
    if (cursor) {
      expect(cursor.placeholder).toBe('<cursor:date-time>');
      expect(cursor.formatHint).toBe('ISO 8601');
    }
  });

  it('derives helper metadata', () => {
    expect(getEnumValues({ enum: ['a', 'b', 1] })).toEqual(['a', 'b']);
    expect(getEnumValues({ type: 'array', items: { enum: ['x', 'y'] } })).toEqual(['x', 'y']);
    expect(getEnumValues({ type: 'string' })).toBeUndefined();

    expect(getDescriptorDefault({ default: 'inline' })).toBe('inline');
    expect(getDescriptorDefault({ type: 'array', default: ['alpha'] })).toEqual(['alpha']);

    expect(buildPlaceholder('myPath', 'string', ['s1', 's2'])).toBe('<my-path:s1|s2>');
    expect(buildPlaceholder('createdAt', 'string', undefined, 'iso-8601')).toBe('<created-at:iso-8601>');
    expect(buildExampleValue('itemId', 'string', undefined, undefined)).toBe('example-id');
    expect(buildExampleValue('mode', 'string', ['fast'], undefined)).toBe('fast');

    expect(inferType({ type: 'boolean' })).toBe('boolean');
    expect(inferType({ type: 'integer' })).toBe('number');
    expect(inferType({ type: ['null', 'integer'] })).toBe('number');
    expect(inferType({ type: ['null', 'array'] })).toBe('array');
    expect(inferType({})).toBe('unknown');

    expect(inferArrayItemType({ type: 'array', items: { type: 'integer' } })).toBe('number');
    expect(inferArrayItemType({ type: 'array', items: { type: ['null', 'boolean'] } })).toBe('boolean');
    expect(inferArrayItemType({ type: 'array', items: { type: 'object' } })).toBe('unknown');

    expect(getDescriptorDescription({ description: 'hi' })).toBe('hi');
    expect(getDescriptorDescription({})).toBeUndefined();
    expect(getDescriptorFormatHint({ format: 'uuid' })).toEqual({ display: 'UUID', slug: 'uuid' });
    expect(getDescriptorFormatHint({ description: 'Provide an ISO format timestamp' })?.slug).toBe('iso-8601');
    expect(getDescriptorFormatHint({ description: 'plain string' })).toBeUndefined();

    expect(toProxyMethodName('some-tool_name')).toBe('someToolName');
    expect(toCliOption('inputValue')).toBe('input-value');
  });

  it('picks example literals and fallbacks consistently', () => {
    expect(
      pickExampleLiteral({
        type: 'number',
        exampleValue: '3',
        property: 'count',
        cliName: 'count',
        required: true,
        placeholder: '<count>',
      })
    ).toBe('3');
    expect(
      pickExampleLiteral({
        type: 'array',
        exampleValue: 'foo,bar',
        property: 'items',
        cliName: 'items',
        required: false,
        placeholder: '<items>',
      })
    ).toBe('["foo", "bar"]');
    expect(
      pickExampleLiteral({
        type: 'string',
        enumValues: ['alpha', 'beta'],
        property: 'mode',
        cliName: 'mode',
        required: true,
        placeholder: '<mode>',
      })
    ).toBe('"alpha"');
    expect(
      buildFallbackLiteral({
        type: 'string',
        property: 'issueId',
        cliName: 'issue-id',
        required: true,
        placeholder: '<issue-id>',
      })
    ).toBe('"example-id"');
    expect(
      buildFallbackLiteral({
        type: 'array',
        property: 'labels',
        cliName: 'labels',
        required: false,
        placeholder: '<labels>',
      })
    ).toBe('["value1"]');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createRuntime } from '../src/runtime.js';
import type { ServerDefinition } from '../src/config-schema.js';

describe('Runtime result mapping integration', () => {
  it('applies result mapping when configured', async () => {
    // Mock server definition with result mapping
    const serverDef: ServerDefinition = {
      name: 'test-server',
      command: {
        kind: 'http',
        url: new URL('https://example.com/mcp'),
      },
      resultMapping: {
        test_tool: {
          pick: ['id', 'title'],
        },
      },
    };

    const runtime = await createRuntime({
      servers: [serverDef],
    });

    // Mock the connect method to return a fake client
    const mockClient = {
      callTool: vi.fn().mockResolvedValue({
        content: [
          {
            type: 'json',
            json: {
              id: 'doc-1',
              title: 'Test Document',
              content: 'Long content that should be filtered out',
              metadata: {
                author: 'Alice',
                tags: ['test'],
              },
            },
          },
        ],
      }),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn(),
      listResources: vi.fn(),
    };

    // @ts-expect-error - accessing private method for testing
    runtime.connect = vi.fn().mockResolvedValue({
      client: mockClient,
      transport: { close: vi.fn() },
    });

    const result = await runtime.callTool('test-server', 'test_tool', {
      args: { query: 'test' },
    });

    // Verify the result has been projected
    expect(result).toHaveProperty('content');
    const content = (result as any).content;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toHaveProperty('type', 'json');
    expect(content[0].json).toEqual({
      id: 'doc-1',
      title: 'Test Document',
    });

    // Verify original fields are not present
    expect(content[0].json).not.toHaveProperty('content');
    expect(content[0].json).not.toHaveProperty('metadata');

    await runtime.close();
  });

  it('returns unprojected result when no mapping configured', async () => {
    const serverDef: ServerDefinition = {
      name: 'test-server',
      command: {
        kind: 'http',
        url: new URL('https://example.com/mcp'),
      },
      // No resultMapping
    };

    const runtime = await createRuntime({
      servers: [serverDef],
    });

    const fullResponse = {
      content: [
        {
          type: 'json',
          json: {
            id: 'doc-1',
            title: 'Test',
            content: 'Full content',
          },
        },
      ],
    };

    const mockClient = {
      callTool: vi.fn().mockResolvedValue(fullResponse),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn(),
      listResources: vi.fn(),
    };

    // @ts-expect-error - accessing private method for testing
    runtime.connect = vi.fn().mockResolvedValue({
      client: mockClient,
      transport: { close: vi.fn() },
    });

    const result = await runtime.callTool('test-server', 'test_tool', {
      args: {},
    });

    // Should return the full unprojected response
    expect(result).toEqual(fullResponse);

    await runtime.close();
  });

  it('applies mapping to array results', async () => {
    const serverDef: ServerDefinition = {
      name: 'test-server',
      command: {
        kind: 'http',
        url: new URL('https://example.com/mcp'),
      },
      resultMapping: {
        list_docs: {
          pick: ['id', 'title'],
        },
      },
    };

    const runtime = await createRuntime({
      servers: [serverDef],
    });

    const mockClient = {
      callTool: vi.fn().mockResolvedValue({
        content: [
          {
            type: 'json',
            json: [
              { id: '1', title: 'First', content: 'Long...' },
              { id: '2', title: 'Second', content: 'More...' },
            ],
          },
        ],
      }),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn(),
      listResources: vi.fn(),
    };

    // @ts-expect-error - accessing private method for testing
    runtime.connect = vi.fn().mockResolvedValue({
      client: mockClient,
      transport: { close: vi.fn() },
    });

    const result = await runtime.callTool('test-server', 'list_docs', {});

    const content = (result as any).content[0];
    expect(content.json).toEqual([
      { id: '1', title: 'First' },
      { id: '2', title: 'Second' },
    ]);

    await runtime.close();
  });

  it('preserves nested structure in projections', async () => {
    const serverDef: ServerDefinition = {
      name: 'test-server',
      command: {
        kind: 'http',
        url: new URL('https://example.com/mcp'),
      },
      resultMapping: {
        get_user: {
          pick: ['id', 'profile.email', 'profile.location.city'],
        },
      },
    };

    const runtime = await createRuntime({
      servers: [serverDef],
    });

    const mockClient = {
      callTool: vi.fn().mockResolvedValue({
        content: [
          {
            type: 'json',
            json: {
              id: 'user-1',
              name: 'Alice',
              profile: {
                email: 'alice@example.com',
                phone: '555-1234',
                location: {
                  city: 'San Francisco',
                  country: 'USA',
                  zipcode: '94102',
                },
              },
            },
          },
        ],
      }),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn(),
      listResources: vi.fn(),
    };

    // @ts-expect-error - accessing private method for testing
    runtime.connect = vi.fn().mockResolvedValue({
      client: mockClient,
      transport: { close: vi.fn() },
    });

    const result = await runtime.callTool('test-server', 'get_user', {});

    const content = (result as any).content[0];
    expect(content.json).toEqual({
      id: 'user-1',
      profile: {
        email: 'alice@example.com',
        location: {
          city: 'San Francisco',
        },
      },
    });

    // Verify fields not in pick list are excluded
    expect(content.json).not.toHaveProperty('name');
    expect(content.json.profile).not.toHaveProperty('phone');
    expect(content.json.profile.location).not.toHaveProperty('country');
    expect(content.json.profile.location).not.toHaveProperty('zipcode');

    await runtime.close();
  });
});

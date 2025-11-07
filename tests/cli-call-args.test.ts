import { describe, expect, it, vi } from 'vitest';
import { CliUsageError } from '../src/cli/errors.js';

process.env.MCPORTER_DISABLE_AUTORUN = '1';
const cliModulePromise = import('../src/cli.js');

describe('CLI call argument parsing', () => {
  it('falls back to default call timeout when env is empty', async () => {
    vi.stubEnv('MCPORTER_CALL_TIMEOUT', '');
    try {
      const { resolveCallTimeout } = await cliModulePromise;
      expect(resolveCallTimeout()).toBe(60_000);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('accepts server and tool as separate positional arguments', async () => {
    const { parseCallArguments } = await cliModulePromise;
    const parsed = parseCallArguments(['chrome-devtools', 'list_pages']);
    expect(parsed.selector).toBe('chrome-devtools');
    expect(parsed.tool).toBe('list_pages');
    expect(parsed.args).toEqual({});
  });

  it('captures timeout flag values', async () => {
    const { parseCallArguments } = await cliModulePromise;
    const parsed = parseCallArguments(['chrome-devtools', '--timeout', '2500', '--tool', 'list_pages']);
    expect(parsed.selector).toBe('chrome-devtools');
    expect(parsed.tool).toBe('list_pages');
    expect(parsed.timeoutMs).toBe(2500);
  });

  it('parses function-call syntax with named arguments', async () => {
    const { parseCallArguments } = await cliModulePromise;
    const parsed = parseCallArguments(['linear.create_comment(issueId: "ISSUE-123", notify: false)']);
    expect(parsed.server).toBe('linear');
    expect(parsed.tool).toBe('create_comment');
    expect(parsed.args).toEqual({ issueId: 'ISSUE-123', notify: false });
  });

  it('parses HTTP call expressions with named arguments', async () => {
    const { parseCallArguments } = await cliModulePromise;
    const parsed = parseCallArguments(['https://www.shadcn.io/api/mcp.getComponent(component: "vortex")']);
    expect(parsed.server).toBe('https://www.shadcn.io/api/mcp');
    expect(parsed.tool).toBe('getComponent');
    expect(parsed.args).toEqual({ component: 'vortex' });
  });

  it('rejects conflicting server names between flags and call syntax', async () => {
    const { parseCallArguments } = await cliModulePromise;
    expect(() => parseCallArguments(['--server', 'github', 'linear.create_comment(issueId: "123")'])).toThrow(
      /Conflicting server names/
    );
  });

  it('surfaces a helpful error when function-call syntax cannot be parsed', async () => {
    const { parseCallArguments } = await cliModulePromise;
    expect(() => parseCallArguments(['linear.create_comment(oops)'])).toThrow(CliUsageError);
  });
});

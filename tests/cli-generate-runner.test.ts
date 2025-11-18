import { describe, expect, it } from 'vitest';
import { parseGenerateFlags } from '../src/cli/generate/flags.js';
import { inferNameFromCommand } from '../src/cli/generate/name-utils.js';
import { buildGenerateCliCommand } from '../src/cli/generate/template-data.js';
import type { SerializedServerDefinition } from '../src/cli-metadata.js';

describe('generate-cli runner internals', () => {
  it('parses generate-cli flags including bundle/compile toggles', () => {
    const args = [
      '--server',
      'linear',
      '--command',
      'https://example.com/mcp.getComponents()',
      '--bundle',
      '--compile',
      '--minify',
    ];
    const parsed = parseGenerateFlags([...args]);
    expect(parsed.server).toBe('linear');
    expect(parsed.command).toBe('https://example.com/mcp');
    expect(parsed.bundle).toBe(true);
    expect(parsed.compile).toBe(true);
    expect(parsed.minify).toBe(true);
  });

  it('normalizes inferred names from URLs', () => {
    const args = ['--command', 'https://api.linear.app/mcp.getComponents'];
    const parsed = parseGenerateFlags([...args]);
    expect(parsed.command).toContain('https://');
    const inferred = inferNameFromCommand(parsed.command ?? '');
    expect(inferred).toBe('linear');
  });

  it('splits stdio commands and infers names from args', () => {
    const args = ['--command', 'npx -y chrome-devtools-mcp@latest'];
    const parsed = parseGenerateFlags([...args]);
    expect(parsed.command).toBeDefined();
    expect(typeof parsed.command).toBe('object');
    const spec = parsed.command as { command: string; args?: string[] };
    expect(spec.command).toBe('npx');
    expect(spec.args).toEqual(['-y', 'chrome-devtools-mcp@latest']);
    const inferred = parsed.command !== undefined ? inferNameFromCommand(parsed.command) : undefined;
    expect(inferred).toContain('chrome-devtools');
  });

  it('parses local script commands with extra args', () => {
    const args = ['--command', 'bun run ./servers/local-cli.ts --stdio --name local'];
    const parsed = parseGenerateFlags([...args]);
    const spec = parsed.command as { command: string; args?: string[] };
    expect(spec.command).toBe('bun');
    expect(spec.args).toEqual(['run', './servers/local-cli.ts', '--stdio', '--name', 'local']);
    const inferred = parsed.command !== undefined ? inferNameFromCommand(parsed.command) : undefined;
    expect(inferred).toBe('local-cli');
  });

  it('infers package names from scoped arguments', () => {
    const args = ['--command', 'npx -y @demo/tools@latest serve'];
    const parsed = parseGenerateFlags([...args]);
    const spec = parsed.command as { command: string; args?: string[] };
    expect(spec.args).toEqual(['-y', '@demo/tools@latest', 'serve']);
    const inferred = parsed.command !== undefined ? inferNameFromCommand(parsed.command) : undefined;
    expect(inferred).toBe('demo-tools');
  });

  it('infers npm package names without version specifiers in inline commands', () => {
    const args = ['--command', 'npx -y chrome-devtools-mcp'];
    const parsed = parseGenerateFlags([...args]);
    const spec = parsed.command as { command: string; args?: string[] };
    expect(spec.args).toEqual(['-y', 'chrome-devtools-mcp']);
    const inferred = parsed.command !== undefined ? inferNameFromCommand(parsed.command) : undefined;
    expect(inferred).toBe('chrome-devtools-mcp');
  });

  it('normalizes scheme-less HTTP selectors passed to --command', () => {
    const args = ['--command', 'shadcn.io/api/mcp.getComponents'];
    const parsed = parseGenerateFlags([...args]);
    expect(typeof parsed.command).toBe('string');
    expect((parsed.command as string).startsWith('https://')).toBe(true);
    const inferred = parsed.command !== undefined ? inferNameFromCommand(parsed.command) : undefined;
    expect(inferred).toBe('shadcn');
  });

  it('wraps single-token stdio commands when passed via --command', () => {
    const args = ['--command', './scripts/mcp-server.ts'];
    const parsed = parseGenerateFlags([...args]);
    expect(parsed.command).toBeDefined();
    const spec = parsed.command as { command: string; args?: string[] };
    expect(spec).toEqual({ command: './scripts/mcp-server.ts' });
    const inferred = parsed.command !== undefined ? inferNameFromCommand(parsed.command) : undefined;
    expect(inferred).toBe('mcp-server');
  });

  it('treats positional inline commands as generate-cli targets', () => {
    const args = ['npx -y chrome-devtools-mcp@latest'];
    const parsed = parseGenerateFlags([...args]);
    expect(parsed.command).toBeDefined();
    expect(parsed.server).toBeUndefined();
    const spec = parsed.command as { command: string; args?: string[] };
    expect(spec.command).toBe('npx');
    expect(spec.args).toEqual(['-y', 'chrome-devtools-mcp@latest']);
  });

  it('keeps bare names positional when no whitespace is present', () => {
    const args = ['linear'];
    const parsed = parseGenerateFlags([...args]);
    expect(parsed.server).toBe('linear');
    expect(parsed.command).toBeUndefined();
  });

  it('handles inline commands with extra interior whitespace', () => {
    const args = ['  bun   run   ./cli.ts   --stdio  '];
    const parsed = parseGenerateFlags([...args]);
    const spec = parsed.command as { command: string; args?: string[] };
    expect(spec.command).toBe('bun');
    expect(spec.args).toEqual(['run', './cli.ts', '--stdio']);
  });

  it('treats positional HTTPS URLs as ad-hoc servers and infers names', () => {
    const args = ['https://mcp.context7.com/mcp'];
    const parsed = parseGenerateFlags([...args]);
    expect(parsed.command).toBe('https://mcp.context7.com/mcp');
    expect(parsed.server).toBeUndefined();
    const inferred = parsed.command !== undefined ? inferNameFromCommand(parsed.command) : undefined;
    expect(inferred).toBe('context7');
  });

  it('builds regenerate commands honoring global flags and invocation overrides', () => {
    const definition: SerializedServerDefinition = {
      name: 'demo',
      description: 'Demo server',
      command: { kind: 'http', url: 'https://demo.mcp' },
    };
    const invocation = {
      outputPath: 'out.ts',
      runtime: 'bun' as const,
      timeoutMs: 45_000,
      minify: true,
      bundle: 'out.bundle.js',
    };
    const command = buildGenerateCliCommand(invocation, definition, { '--config': '/tmp/mcporter.json' });
    expect(command).toContain('--config /tmp/mcporter.json');
    expect(command).toContain('--server demo');
    expect(command).toContain('--bundle out.bundle.js');
    expect(command).toContain('--timeout 45000');
    expect(command).toContain('--minify');
  });
});

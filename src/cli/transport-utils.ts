import type { ServerDefinition } from '../config.js';

export function formatTransportSummary(definition: ServerDefinition): string {
  if (definition.command.kind === 'http') {
    const url = definition.command.url instanceof URL ? definition.command.url.href : String(definition.command.url);
    return `HTTP ${url}`;
  }
  const rendered = [definition.command.command, ...(definition.command.args ?? [])].join(' ').trim();
  return `STDIO ${rendered}`;
}

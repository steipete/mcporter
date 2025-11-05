#!/usr/bin/env node

/**
 * Lightweight helper to send a one-off message to a tmux-based agent session.
 *
 * Usage:
 *   bun scripts/agent-send.ts --session claude-haiku -- "/model"
 *
 * Options:
 *   --session NAME             Target tmux session (or session:window.pane)
 *   --entry single|double|none How many Enter keys to send (default single)
 *   --escape                   Send ESC before typing (to interrupt/resume)
 *   --wait-ms N                Extra wait (ms) after typing before Enter
 */

import { spawnSync } from 'node:child_process';

type EntryMode = 'single' | 'double' | 'none';

interface CliOptions {
  session: string;
  entry: EntryMode;
  escape: boolean;
  waitMs: number;
  message: string;
}

function usage(message?: string): never {
  if (message) {
    console.error(`Error: ${message}`);
  }
  console.error(`\
Usage: bun scripts/agent-send.ts --session <name[:window[.pane]]> [--entry single|double|none] [--escape] [--wait-ms N] -- "<message>"

Examples:
  bun scripts/agent-send.ts --session claude-haiku -- "/model"
  bun scripts/agent-send.ts --session ma-worker-1 --escape --entry double -- "Continue and focus on API routes"
`);
  process.exit(1);
}

function parseArgs(argv: string[]): CliOptions {
  let session: string | undefined;
  let entry: EntryMode = 'single';
  let shouldEscape = false;
  let waitMs = 400;
  const literalSeparator = argv.indexOf('--');
  const optionPart = literalSeparator === -1 ? argv : argv.slice(0, literalSeparator);
  const literalPart = literalSeparator === -1 ? [] : argv.slice(literalSeparator + 1);

  for (let i = 0; i < optionPart.length; i += 1) {
    const token = optionPart[i];
    if (typeof token !== 'string' || !token.startsWith('--')) {
      usage(`Unexpected argument: ${token ?? ''}`);
    }
    const key = token.slice(2);
    switch (key) {
      case 'session': {
        const value = optionPart[i + 1];
        if (!value) {
          usage('--session requires a value');
        }
        session = value;
        i += 1;
        break;
      }
      case 'entry': {
        const value = optionPart[i + 1];
        if (value !== 'single' && value !== 'double' && value !== 'none') {
          usage(`Unknown entry mode: ${value}`);
        }
        entry = value;
        i += 1;
        break;
      }
      case 'escape': {
        shouldEscape = true;
        break;
      }
      case 'wait-ms': {
        const value = optionPart[i + 1];
        if (!value || Number.isNaN(Number.parseInt(value, 10))) {
          usage('--wait-ms requires an integer value');
        }
        waitMs = Number.parseInt(value, 10);
        i += 1;
        break;
      }
      default:
        usage(`Unknown option: --${key}`);
    }
  }

  const message = literalPart.join(' ').trim();
  if (!session) {
    usage('Missing --session');
  }
  if (!message) {
    usage('Missing message (provide text after -- separator)');
  }

  return { session, entry, escape: shouldEscape, waitMs, message };
}

function runTmux(args: string[], allowFailure = false): string {
  const result = spawnSync('tmux', args, { encoding: 'utf8' });
  if (result.error) {
    if (allowFailure) {
      return '';
    }
    throw result.error;
  }
  if (result.status !== 0) {
    if (allowFailure) {
      return result.stderr?.trim() ?? '';
    }
    throw new Error(`tmux ${args.join(' ')} failed: ${result.stderr?.trim()}`);
  }
  return result.stdout?.trimEnd() ?? '';
}

function ensureSession(target: string): void {
  const session = target.split(':')[0] ?? target;
  const result = spawnSync('tmux', ['has-session', '-t', session]);
  if (result.status !== 0) {
    usage(`tmux session '${session}' not found. Start it first (e.g., tmux new-session -s ${session} ...)`);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendMessage(options: CliOptions): Promise<void> {
  ensureSession(options.session);

  if (options.escape) {
    runTmux(['send-keys', '-t', options.session, 'Escape'], true);
    await sleep(200);
  }

  // Clear existing prompt
  runTmux(['send-keys', '-t', options.session, 'Escape'], true);
  await sleep(120);
  runTmux(['send-keys', '-t', options.session, 'C-u'], true);
  await sleep(120);

  // Type the message
  runTmux(['send-keys', '-t', options.session, '-l', options.message], true);
  await sleep(Math.max(120, options.waitMs));

  // Send Enter(s)
  const pressEnter = () => runTmux(['send-keys', '-t', options.session, 'C-m'], true);
  switch (options.entry) {
    case 'single':
      pressEnter();
      break;
    case 'double':
      pressEnter();
      await sleep(200);
      pressEnter();
      break;
    case 'none':
      break;
    default: {
      const _never: never = options.entry;
      usage('Unsupported entry mode');
    }
  }

  await sleep(600);
  const tail = runTmux(['capture-pane', '-pt', options.session, '-S', '-6'], true);
  console.log(tail);
}

try {
  const options = parseArgs(process.argv.slice(2));
  await sendMessage(options);
} catch (error) {
  usage(error instanceof Error ? error.message : String(error));
}

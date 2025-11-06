import type { ChildProcess } from 'node:child_process';
import type { PassThrough } from 'node:stream';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Upstream TODO: Once typescript-sdk#579/#780/#1049 land, this shim can be dropped.
// We monkey-patch the transport so child processes actually exit and their stdio
// streams are destroyed; otherwise Node keeps the handles alive and mcporter hangs.

type MaybeChildProcess = ChildProcess & {
  stdio?: Array<unknown>;
};

interface StderrMeta {
  chunks: string[];
  command?: string;
  code?: number | null;
  listeners: Array<{
    stream: NodeJS.EventEmitter & { removeListener?: (event: string, listener: (...args: unknown[]) => void) => void };
    event: string;
    handler: (...args: unknown[]) => void;
  }>;
}

const STDERR_BUFFERS = new WeakMap<MaybeChildProcess, StderrMeta>();
const STDIO_LOGS_ENABLED = process.env.MCPORTER_STDIO_LOGS === '1';

function destroyStream(stream: unknown): void {
  if (!stream || typeof stream !== 'object') {
    return;
  }
  const emitter = stream as {
    on?: (event: string, listener: () => void) => void;
    off?: (event: string, listener: () => void) => void;
    removeListener?: (event: string, listener: () => void) => void;
    destroy?: () => void;
    end?: () => void;
    unref?: () => void;
  };
  const swallowError = () => {};
  try {
    emitter.on?.('error', swallowError);
  } catch {
    // ignore
  }
  try {
    emitter.destroy?.();
  } catch {
    // ignore
  }
  try {
    emitter.end?.();
  } catch {
    // ignore
  }
  try {
    emitter.unref?.();
  } catch {
    // ignore
  }
  try {
    emitter.off?.('error', swallowError);
  } catch {
    // ignore
  }
  try {
    emitter.removeListener?.('error', swallowError);
  } catch {
    // ignore
  }
}

function waitForChildClose(child: MaybeChildProcess | undefined, timeoutMs: number): Promise<void> {
  if (!child) {
    return Promise.resolve();
  }
  if (
    (child as { exitCode?: number | null }).exitCode !== null &&
    (child as { exitCode?: number | null }).exitCode !== undefined
  ) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const swallowProcessError = () => {};
    try {
      child.on?.('error', swallowProcessError);
    } catch {
      // ignore
    }
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };
    const cleanup = () => {
      child.removeListener('exit', finish);
      child.removeListener('close', finish);
      child.removeListener('error', finish);
      try {
        child.removeListener?.('error', swallowProcessError);
      } catch {
        // ignore
      }
      if (timer) {
        clearTimeout(timer);
      }
    };
    child.once('exit', finish);
    child.once('close', finish);
    child.once('error', finish);
    let timer: NodeJS.Timeout | undefined;
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(finish, timeoutMs);
      timer.unref?.();
    }
  });
}

function patchStdioClose(): void {
  const marker = Symbol.for('mcporter.stdio.patched');
  const proto = StdioClientTransport.prototype as unknown as Record<symbol, unknown>;
  if (proto[marker]) {
    return;
  }

  patchStdioStart();

  StdioClientTransport.prototype.close = async function patchedClose(): Promise<void> {
    const transport = this as unknown as {
      _process?: MaybeChildProcess | null;
      _stderrStream?: PassThrough | null;
      _abortController?: AbortController | null;
      _readBuffer?: { clear(): void } | null;
      onclose?: () => void;
    };
    const child = transport._process ?? null;
    const stderrStream = transport._stderrStream ?? null;
    const meta = child ? STDERR_BUFFERS.get(child) : undefined;

    if (stderrStream) {
      // Ensure any piped stderr stream is torn down so no file descriptors linger.
      destroyStream(stderrStream);
      transport._stderrStream = null;
    }

    // Abort active reads/writes and clear buffered state just like the SDK does.
    transport._abortController?.abort();
    transport._abortController = null;
    transport._readBuffer?.clear?.();
    transport._readBuffer = null;

    if (!child) {
      transport.onclose?.();
      return;
    }

    // Closing stdin/stdout/stderr proactively lets Node release the handles even
    // when the child ignores SIGTERM (common with npm/npx wrappers).
    destroyStream(child.stdin);
    destroyStream(child.stdout);
    destroyStream(child.stderr);

    const stdio = Array.isArray(child.stdio) ? child.stdio : [];
    for (const stream of stdio) {
      destroyStream(stream);
    }

    child.removeAllListeners?.();

    let exited = await waitForChildClose(child, 700).then(
      () => true,
      () => false
    );

    if (!exited) {
      // First escalation: polite SIGTERM.
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      exited = await waitForChildClose(child, 700).then(
        () => true,
        () => false
      );
    }

    if (!exited) {
      // Final escalation: SIGKILL. If this still fails, fall through and warn.
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      await waitForChildClose(child, 500).catch(() => {});
    }

    destroyStream(child.stdin);
    destroyStream(child.stdout);
    destroyStream(child.stderr);

    const stdioAfter = Array.isArray(child.stdio) ? child.stdio : [];
    for (const stream of stdioAfter) {
      // Some transports mutate stdio in-place; run the destroy sweep again to be sure.
      destroyStream(stream);
    }

    child.unref?.();

    if (meta) {
      // Remove any listeners we attached during start to avoid leaks before printing.
      for (const { stream, event, handler } of meta.listeners) {
        try {
          stream.removeListener?.(event, handler);
        } catch {
          // ignore
        }
      }
      const shouldPrint = STDIO_LOGS_ENABLED || (typeof meta.code === 'number' && meta.code !== 0);
      if (shouldPrint && meta.chunks.length > 0) {
        const heading = meta.command ? `[mcporter] stderr from ${meta.command}` : '[mcporter] stderr from stdio server';
        console.log(heading);
        process.stdout.write(meta.chunks.join(''));
        if (!meta.chunks[meta.chunks.length - 1]?.endsWith('\n')) {
          console.log('');
        }
      }
      STDERR_BUFFERS.delete(child);
    }

    transport._process = null;
    transport.onclose?.();
  };

  proto[marker] = true;
}

function patchStdioStart(): void {
  const marker = Symbol.for('mcporter.stdio.startPatched');
  const proto = StdioClientTransport.prototype as unknown as Record<symbol, unknown>;
  if (proto[marker]) {
    return;
  }

  // eslint-disable-next-line @typescript-eslint/unbound-method -- capturing the original method before patching
  const originalStart: typeof StdioClientTransport.prototype.start = StdioClientTransport.prototype.start;

  StdioClientTransport.prototype.start = async function patchedStart(this: unknown): Promise<void> {
    const transport = this as unknown as {
      _serverParams?: { stderr?: string; command?: string } | undefined;
      _process?: MaybeChildProcess | null;
      _stderrStream?: PassThrough | null;
    };

    if (transport._serverParams && transport._serverParams.stderr !== 'pipe') {
      transport._serverParams = {
        ...transport._serverParams,
        stderr: 'pipe',
      };
    }

    await originalStart.apply(this);

    const child = transport._process ?? null;
    if (child) {
      const meta: StderrMeta = {
        chunks: [],
        command: transport._serverParams?.command,
        code: null,
        listeners: [],
      };
      STDERR_BUFFERS.set(child, meta);

      const targetStream = transport._stderrStream ?? child.stderr;
      if (targetStream) {
        if (typeof (targetStream as { setEncoding?: (enc: string) => void }).setEncoding === 'function') {
          (targetStream as { setEncoding?: (enc: string) => void }).setEncoding?.('utf8');
        }
        const handleChunk = (chunk: unknown) => {
          if (typeof chunk === 'string') {
            meta.chunks.push(chunk);
          } else if (Buffer.isBuffer(chunk)) {
            meta.chunks.push(chunk.toString('utf8'));
          }
        };
        const swallowError = () => {};
        (targetStream as NodeJS.EventEmitter).on('data', handleChunk);
        (targetStream as NodeJS.EventEmitter).on('error', swallowError);
        meta.listeners.push({
          stream: targetStream as NodeJS.EventEmitter & {
            removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
          },
          event: 'data',
          handler: handleChunk,
        });
        meta.listeners.push({
          stream: targetStream as NodeJS.EventEmitter & {
            removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
          },
          event: 'error',
          handler: swallowError,
        });
      }

      child.once('exit', (code: number | null) => {
        const entry = STDERR_BUFFERS.get(child);
        if (entry) {
          entry.code = code;
        }
      });
    }
  };

  proto[marker] = true;
}

patchStdioClose();

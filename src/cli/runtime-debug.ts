import type { ChildProcess } from 'node:child_process';
import { logInfo, logWarn } from './logger-context.js';

export const DEBUG_HANG = process.env.MCPORTER_DEBUG_HANG === '1';

type ProcessWithHandles = NodeJS.Process & {
  _getActiveHandles?: () => unknown[];
  _getActiveRequests?: () => unknown[];
};

function describeHandle(handle: unknown): string {
  if (!handle || (typeof handle !== 'object' && typeof handle !== 'function')) {
    return String(handle);
  }
  const ctor = (handle as { constructor?: { name?: string } }).constructor?.name ?? typeof handle;
  if (ctor === 'Socket') {
    try {
      const socket = handle as {
        localAddress?: string;
        localPort?: number;
        remoteAddress?: string;
        remotePort?: number;
      };
      const parts: string[] = ['Socket'];
      if (socket.localAddress) {
        parts.push(`local=${socket.localAddress}:${socket.localPort ?? '?'}`);
      }
      if (socket.remoteAddress) {
        parts.push(`remote=${socket.remoteAddress}:${socket.remotePort ?? '?'}`);
      }
      if (typeof (socket as { address?: () => { address: string; port: number } | null }).address === 'function') {
        const addr = (socket as { address?: () => { address: string; port: number } | null }).address?.();
        if (addr) {
          parts.push(`addr=${addr.address}:${addr.port}`);
        }
      }
      const host = (handle as { _host?: string })._host;
      if (host) {
        parts.push(`host=${host}`);
      }
      const pipeName = (handle as { path?: string }).path;
      if (pipeName) {
        parts.push(`path=${pipeName}`);
      }
      const extraKeys = Reflect.ownKeys(handle as Record<string | symbol, unknown>)
        .filter((key) => typeof key === 'string' && key.startsWith('_') && !['_events', '_eventsCount'].includes(key))
        .slice(0, 4) as string[];
      if (extraKeys.length > 0) {
        parts.push(`keys=${extraKeys.join(',')}`);
      }
      return parts.join(' ');
    } catch {
      return ctor;
    }
  }
  if (typeof handle === 'object') {
    const pid = (handle as { pid?: number }).pid;
    if (typeof pid === 'number') {
      return `${ctor} (pid=${pid})`;
    }
    const fd = (handle as { fd?: number }).fd;
    if (typeof fd === 'number') {
      return `${ctor} (fd=${fd})`;
    }
  }
  return ctor;
}

export function dumpActiveHandles(label: string): void {
  if (!DEBUG_HANG) {
    return;
  }
  const proc = process as ProcessWithHandles;
  const activeHandles = proc._getActiveHandles?.() ?? [];
  const activeRequests = proc._getActiveRequests?.() ?? [];
  logInfo(`[debug] ${label}: ${activeHandles.length} active handle(s), ${activeRequests.length} request(s)`);
  for (const handle of activeHandles) {
    logInfo(`[debug] handle => ${describeHandle(handle)}`);
  }
  for (const request of activeRequests) {
    logInfo(`[debug] request => ${describeHandle(request)}`);
  }
}

export function terminateChildProcesses(label: string): void {
  const proc = process as ProcessWithHandles;
  const handles = proc._getActiveHandles?.() ?? [];
  for (const handle of handles) {
    if (!handle || typeof handle !== 'object') {
      continue;
    }
    const candidate = handle as ChildProcess;
    const ctor = (handle as { constructor?: { name?: string } }).constructor?.name ?? '';
    if (ctor === 'Socket' && typeof (handle as { destroy?: () => void }).destroy === 'function') {
      try {
        (handle as { destroy?: () => void }).destroy?.();
        if (typeof (handle as { unref?: () => void }).unref === 'function') {
          (handle as { unref?: () => void }).unref?.();
        }
      } catch {
        // ignore
      }
    }
    if (typeof (candidate.stdout as { destroy?: () => void } | undefined)?.destroy === 'function') {
      try {
        (candidate.stdout as { destroy?: () => void }).destroy?.();
      } catch {
        // ignore
      }
    }
    if (typeof (candidate.stderr as { destroy?: () => void } | undefined)?.destroy === 'function') {
      try {
        (candidate.stderr as { destroy?: () => void }).destroy?.();
      } catch {
        // ignore
      }
    }
    if (typeof (candidate.stdin as { end?: () => void } | undefined)?.end === 'function') {
      try {
        (candidate.stdin as { end?: () => void }).end?.();
      } catch {
        // ignore
      }
    }
    if (DEBUG_HANG) {
      const killed = candidate.kill?.('SIGKILL') ?? false;
      if (candidate.pid) {
        const outcome = killed ? 'killed' : 'kill-failed';
        logWarn(`[debug] forcibly ${outcome} child pid=${candidate.pid} (${label})`);
      }
    } else if (typeof candidate.kill === 'function' && typeof candidate.pid === 'number' && !candidate.killed) {
      try {
        candidate.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
  }
}

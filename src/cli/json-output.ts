import type { ConnectionIssue } from '../error-classifier.js';

export interface ConnectionIssueEnvelope {
  server: string;
  tool?: string;
  error: string;
  issue?: SerializedConnectionIssue;
}

export interface SerializedConnectionIssue {
  kind: ConnectionIssue['kind'];
  statusCode?: number;
  stdioExitCode?: number;
  stdioSignal?: string;
  rawMessage?: string;
}

export function buildConnectionIssueEnvelope(params: {
  server: string;
  tool?: string;
  error: unknown;
  issue?: ConnectionIssue;
}): ConnectionIssueEnvelope {
  return {
    server: params.server,
    tool: params.tool,
    error: formatErrorMessage(params.error),
    issue: serializeConnectionIssue(params.issue),
  };
}

export function serializeConnectionIssue(issue?: ConnectionIssue): SerializedConnectionIssue | undefined {
  if (!issue) {
    return undefined;
  }
  return {
    kind: issue.kind,
    statusCode: issue.statusCode,
    stdioExitCode: issue.stdioExitCode,
    stdioSignal: issue.stdioSignal,
    rawMessage: issue.rawMessage,
  };
}

export function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message ?? 'Unknown error';
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error === undefined || error === null) {
    return 'Unknown error';
  }
  try {
    return JSON.stringify(error);
  } catch {
    return 'Unknown error';
  }
}

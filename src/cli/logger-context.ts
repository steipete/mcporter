import { createPrefixedConsoleLogger, type Logger, type LogLevel, resolveLogLevelFromEnv } from '../logging.js';

let activeLogLevel: LogLevel = resolveLogLevelFromEnv();
let activeLogger: Logger = createPrefixedConsoleLogger('mcporter', activeLogLevel);

export function getActiveLogLevel(): LogLevel {
  return activeLogLevel;
}

export function getActiveLogger(): Logger {
  return activeLogger;
}

export function setLogLevel(level: LogLevel): void {
  activeLogLevel = level;
  activeLogger = createPrefixedConsoleLogger('mcporter', activeLogLevel);
}

export function setLogger(logger: Logger, level?: LogLevel): void {
  activeLogger = logger;
  if (level) {
    activeLogLevel = level;
  }
}

export function logInfo(message: string): void {
  activeLogger.info(message);
}

export function logWarn(message: string): void {
  activeLogger.warn(message);
}

export function logError(message: string, error?: unknown): void {
  activeLogger.error(message, error);
}

/**
 * Logging is injected, never global.
 *
 * The SDK is silent by default: a library that writes to the console uninvited
 * is a library that ends up wrapped just to shut it up.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogData = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, data?: LogData): void;
  info(message: string, data?: LogData): void;
  warn(message: string, data?: LogData): void;
  error(message: string, data?: LogData): void;
}

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export function consoleLogger(options: { level?: LogLevel } = {}): Logger {
  const min = RANK[options.level ?? 'info'];
  const write =
    (level: LogLevel, sink: (...args: unknown[]) => void) =>
    (message: string, data?: LogData): void => {
      if (RANK[level] < min) return;
      if (data && Object.keys(data).length > 0) sink(`[${level}] ${message}`, data);
      else sink(`[${level}] ${message}`);
    };
  return {
    debug: write('debug', console.debug),
    info: write('info', console.info),
    warn: write('warn', console.warn),
    error: write('error', console.error),
  };
}

/** Prefix every message with a scope, e.g. `[grid] Rung crossed`. */
export function scopedLogger(logger: Logger, scope: string): Logger {
  const tag = `[${scope}] `;
  return {
    debug: (m, d) => logger.debug(tag + m, d),
    info: (m, d) => logger.info(tag + m, d),
    warn: (m, d) => logger.warn(tag + m, d),
    error: (m, d) => logger.error(tag + m, d),
  };
}

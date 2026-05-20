/**
 * Production-safe logger with structured context support.
 *
 * Basic usage (unchanged):
 *   logger.info('Hello');
 *   logger.error('Failed', error);
 *
 * With context:
 *   const log = logger.withContext({ requestId: 'abc123', businessId: 'biz_456' });
 *   log.info('Processing booking');
 *   // Production: [INFO] Processing booking | requestId=abc123 businessId=biz_456
 *   // Dev: colorized console output as before
 */

const isDev = process.env.NODE_ENV !== 'production';

/** Generate a short request ID (8 hex chars) */
export function generateRequestId(): string {
  return crypto.randomUUID().slice(0, 8);
}

type LogContext = Record<string, string | number | boolean | undefined | null>;

/** Format context as key=value pairs for structured logging */
function formatContext(ctx: LogContext): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(ctx)) {
    if (value === undefined || value === null) continue;
    const str = String(value);
    // Quote values that contain spaces
    parts.push(str.includes(' ') ? `${key}="${str}"` : `${key}=${str}`);
  }
  return parts.length > 0 ? ' | ' + parts.join(' ') : '';
}

interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  withContext(ctx: LogContext): Logger;
}

function createLogger(context?: LogContext): Logger {
  const suffix = context ? formatContext(context) : '';

  function formatArgs(level: string, args: unknown[]): unknown[] {
    if (isDev) {
      // Dev: keep colorized console output, append context if present
      if (suffix) {
        return [...args, suffix];
      }
      return args;
    }
    // Production: structured key=value format
    const message = args
      .map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ');
    return [`[${level}] ${message}${suffix}`];
  }

  return {
    debug(...args: unknown[]) {
      if (isDev) console.log(...formatArgs('DEBUG', args));
    },
    info(...args: unknown[]) {
      if (isDev) console.log(...formatArgs('INFO', args));
    },
    warn(...args: unknown[]) {
      console.warn(...formatArgs('WARN', args));
    },
    error(...args: unknown[]) {
      console.error(...formatArgs('ERROR', args));
    },
    withContext(ctx: LogContext): Logger {
      return createLogger({ ...context, ...ctx });
    },
  };
}

export const logger: Logger = createLogger();

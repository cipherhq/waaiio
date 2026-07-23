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
 *
 * Output formats (selected via LOG_FORMAT env var):
 *   'json'    → {"level":"info","msg":"Processing booking","requestId":"abc123","businessId":"biz_456","ts":"..."}
 *   'keyval'  → [INFO] Processing booking | requestId=abc123 businessId=biz_456
 *   (default) → json in production, dev-friendly in development
 *
 * Format is resolved at log time, not module load time, so LOG_FORMAT and
 * NODE_ENV changes are picked up without restarting the process.
 */

type LogFormat = 'json' | 'keyval' | 'dev';

function getLogFormat(): LogFormat {
  const explicit = process.env.LOG_FORMAT as LogFormat | undefined;
  if (explicit === 'json' || explicit === 'keyval') return explicit;
  return process.env.NODE_ENV !== 'production' ? 'dev' : 'json';
}

/** Generate a short request ID (8 hex chars) */
export function generateRequestId(): string {
  return crypto.randomUUID().slice(0, 8);
}

export type LogContext = Record<string, string | number | boolean | undefined | null>;

/** Format context as key=value pairs for structured logging */
function formatContextKeyval(ctx: LogContext): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(ctx)) {
    if (value === undefined || value === null) continue;
    const str = String(value);
    parts.push(str.includes(' ') ? `${key}="${str}"` : `${key}=${str}`);
  }
  return parts.length > 0 ? ' | ' + parts.join(' ') : '';
}

/** Build a clean context object (no undefined/null values) */
function cleanContext(ctx: LogContext): Record<string, string | number | boolean> {
  const clean: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(ctx)) {
    if (value !== undefined && value !== null) clean[key] = value;
  }
  return clean;
}

/** Extract a condensed stack trace from an Error, or undefined if unavailable. */
function formatStack(error: Error): string | undefined {
  if (!error.stack) return undefined;
  return error.stack.split('\n').slice(1, 4).map(l => l.trim()).join(' > ');
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  withContext(ctx: LogContext): Logger;
}

function createLogger(context?: LogContext): Logger {
  const ctxSuffix = context ? formatContextKeyval(context) : '';
  const ctxClean = context ? cleanContext(context) : {};

  function extractMessage(args: unknown[]): string {
    return args
      .map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ');
  }

  function formatArgs(level: string, args: unknown[]): unknown[] {
    const format = getLogFormat();

    if (format === 'dev') {
      if (ctxSuffix) return [...args, ctxSuffix];
      return args;
    }
    if (format === 'json') {
      const msg = extractMessage(args);
      const entry: Record<string, unknown> = {
        level,
        msg,
        ts: new Date().toISOString(),
        ...ctxClean,
      };
      for (const a of args) {
        if (a instanceof Error) {
          entry.stack = formatStack(a);
          break;
        }
      }
      return [JSON.stringify(entry)];
    }
    // keyval format
    const message = extractMessage(args);
    return [`[${level.toUpperCase()}] ${message}${ctxSuffix}`];
  }

  return {
    debug(...args: unknown[]) {
      if (getLogFormat() === 'dev') console.log(...formatArgs('debug', args));
    },
    info(...args: unknown[]) {
      console.log(...formatArgs('info', args));
    },
    warn(...args: unknown[]) {
      console.warn(...formatArgs('warn', args));
    },
    error(...args: unknown[]) {
      console.error(...formatArgs('error', args));
    },
    withContext(ctx: LogContext): Logger {
      return createLogger({ ...context, ...ctx });
    },
  };
}

export const logger: Logger = createLogger();

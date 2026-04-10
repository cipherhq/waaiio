/**
 * Production-safe logger.
 * In development: all logs output normally.
 * In production: only warn and error output; debug/info are silenced.
 */

const isDev = process.env.NODE_ENV !== 'production';

export const logger = {
  debug(...args: unknown[]) {
    if (isDev) console.log(...args);
  },
  info(...args: unknown[]) {
    if (isDev) console.log(...args);
  },
  warn(...args: unknown[]) {
    console.warn(...args);
  },
  error(...args: unknown[]) {
    console.error(...args);
  },
};

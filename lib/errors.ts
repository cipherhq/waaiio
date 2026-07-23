/**
 * Error normalization for safe structured logging and observability.
 *
 * Converts unknown thrown values into a consistent shape without exposing
 * sensitive data (stack traces, credentials, provider payloads).
 *
 * Usage:
 *   import { normalizeError } from '@/lib/errors';
 *
 *   try { ... } catch (err) {
 *     const safe = normalizeError(err);
 *     logger.error('Operation failed', safe);
 *   }
 */

/** Fields that must never appear in normalized error output. */
const SENSITIVE_KEYS = new Set([
  'authorization', 'authorization_code', 'access_token', 'secret_key',
  'secret', 'password', 'token', 'api_key', 'apiKey', 'private_key',
  'card_number', 'cvv', 'cvc', 'card_cvc', 'card_cvv',
  'phone', 'email', 'customer_email', 'customer_phone',
  'signature', 'webhook_secret', 'raw_body', 'body',
  'stripe_account', 'paystack_secret', 'flutterwave_secret',
]);

export interface NormalizedError {
  name: string;
  message: string;
  code?: string;
  retryable?: boolean;
}

/**
 * Normalize an unknown thrown value into a safe, structured error shape.
 *
 * - Error instances: extracts name, message, and code (if present)
 * - Strings: uses the string as the message
 * - Objects with message: extracts message and code safely
 * - null/undefined: produces a generic "Unknown error" message
 * - Arbitrary values: produces a type-descriptive message
 *
 * Never includes stack traces, credentials, or raw provider payloads.
 * Does not mutate the original thrown value.
 */
export function normalizeError(error: unknown): NormalizedError {
  if (error instanceof Error) {
    const result: NormalizedError = {
      name: error.name,
      message: error.message,
    };
    // Extract provider error code if present (e.g. Paystack, Stripe, Flutterwave)
    const code = (error as unknown as Record<string, unknown>).code;
    if (typeof code === 'string') {
      result.code = code;
    }
    // Classify known retryable errors
    if (error.name === 'AbortError' || error.message.includes('timeout')) {
      result.retryable = true;
    } else if (error.message.includes('ECONNREFUSED') || error.message.includes('ECONNRESET')) {
      result.retryable = true;
    } else if (error.message.includes('fetch failed') || error.message.includes('network')) {
      result.retryable = true;
    }
    return result;
  }

  if (typeof error === 'string') {
    return { name: 'Error', message: error };
  }

  if (error === null || error === undefined) {
    return { name: 'Error', message: 'Unknown error (null or undefined thrown)' };
  }

  if (typeof error === 'object') {
    const obj = error as Record<string, unknown>;
    const message = typeof obj.message === 'string' ? obj.message : 'Unknown error';
    const result: NormalizedError = { name: 'Error', message };
    if (typeof obj.code === 'string') {
      result.code = obj.code;
    }
    return result;
  }

  return { name: 'Error', message: `Unknown error (${typeof error})` };
}

/**
 * Extract safe fields from an error object for structured logging.
 * Returns a plain object with only safe, non-sensitive keys.
 * Suitable for passing to logger.withContext() or observe().
 */
export function safeErrorContext(error: unknown): Record<string, string | number | boolean> {
  const norm = normalizeError(error);
  const ctx: Record<string, string | number | boolean> = {
    errorName: norm.name,
    errorMessage: norm.message,
  };
  if (norm.code) ctx.errorCode = norm.code;
  if (norm.retryable !== undefined) ctx.retryable = norm.retryable;
  return ctx;
}

/**
 * Check whether an object key is sensitive and should not be logged.
 * Exported for testing only.
 */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase());
}

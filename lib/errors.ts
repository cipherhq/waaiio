/**
 * Error normalization and log-safe error context.
 *
 * normalizeError() converts unknown thrown values into a consistent shape
 * for caller-visible behavior (return values, retryability classification).
 * Its .message field preserves the original error text, which may contain
 * sensitive information — hostnames, email addresses, phone numbers, or
 * credentials embedded by providers or network errors. normalizeError()
 * output must NOT be passed directly to a logger.
 *
 * safeLogErrorContext() is the logging-safe API. It validates every emitted
 * string with isSafeIdentifier() and never returns message text, stack
 * traces, or raw error data.
 *
 * Usage:
 *   import { safeLogErrorContext } from '@/lib/errors';
 *
 *   try { ... } catch (err) {
 *     logger.withContext({ op: 'payment.init', ...safeLogErrorContext(err) })
 *       .error('Payment init failed');
 *   }
 *
 * For caller-visible return values that need the original message:
 *   import { normalizeError } from '@/lib/errors';
 *   return { success: false, errorMessage: normalizeError(err).message };
 */

import { isSafeIdentifier } from '@/lib/redact';

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
 * Normalize an unknown thrown value into a structured error shape.
 *
 * - Error instances: extracts name, message, and code (if present)
 * - Strings: uses the string as the message
 * - Objects with message: extracts message and code
 * - null/undefined: produces a generic "Unknown error" message
 * - Arbitrary values: produces a type-descriptive message
 *
 * The .message field preserves the original error text verbatim.
 * This text may contain sensitive information (hostnames, PII, credentials).
 * Do NOT pass normalizeError() output directly to a logger.
 * Use safeLogErrorContext() for logging.
 *
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
 * Extract log-safe error metadata from an unknown thrown value.
 *
 * Returns only validated identifier fields — never free-form message text,
 * stack traces, raw errors, or provider response data.
 *
 * Every emitted string passes isSafeIdentifier().
 * Suitable for logger.withContext() and observability context.
 */
export function safeLogErrorContext(error: unknown): Record<string, string | number | boolean> {
  const norm = normalizeError(error);
  const ctx: Record<string, string | number | boolean> = {};
  if (isSafeIdentifier(norm.name)) ctx.errorName = norm.name;
  if (norm.code && isSafeIdentifier(norm.code)) ctx.errorCode = norm.code;
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

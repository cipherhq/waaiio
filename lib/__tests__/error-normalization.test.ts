/**
 * Error Normalization Tests
 *
 * Verifies normalizeError handles all thrown value types safely
 * and never exposes sensitive data.
 */
import { describe, it, expect } from 'vitest';
import { normalizeError, safeLogErrorContext, isSensitiveKey } from '@/lib/errors';
import { readFileSync } from 'fs';

// ── normalizeError unit tests ──

describe('normalizeError', () => {
  it('normalizes Error instances', () => {
    const err = new Error('connection failed');
    const norm = normalizeError(err);
    expect(norm.name).toBe('Error');
    expect(norm.message).toBe('connection failed');
  });

  it('preserves error name', () => {
    const err = new TypeError('invalid argument');
    const norm = normalizeError(err);
    expect(norm.name).toBe('TypeError');
    expect(norm.message).toBe('invalid argument');
  });

  it('extracts error code when present', () => {
    const err = Object.assign(new Error('rate limited'), { code: 'RATE_LIMIT' });
    const norm = normalizeError(err);
    expect(norm.code).toBe('RATE_LIMIT');
  });

  it('normalizes string errors', () => {
    const norm = normalizeError('something broke');
    expect(norm.name).toBe('Error');
    expect(norm.message).toBe('something broke');
  });

  it('normalizes null', () => {
    const norm = normalizeError(null);
    expect(norm.name).toBe('Error');
    expect(norm.message).toContain('null');
  });

  it('normalizes undefined', () => {
    const norm = normalizeError(undefined);
    expect(norm.name).toBe('Error');
    expect(norm.message).toContain('null or undefined');
  });

  it('normalizes plain objects with message', () => {
    const norm = normalizeError({ message: 'provider error', code: 'AUTH_FAILED' });
    expect(norm.message).toBe('provider error');
    expect(norm.code).toBe('AUTH_FAILED');
  });

  it('normalizes plain objects without message', () => {
    const norm = normalizeError({ status: 500 });
    expect(norm.message).toBe('Unknown error');
  });

  it('normalizes arbitrary values', () => {
    const norm = normalizeError(42);
    expect(norm.message).toContain('number');
  });

  it('does not mutate the original error', () => {
    const err = new Error('original');
    const before = err.message;
    normalizeError(err);
    expect(err.message).toBe(before);
  });

  it('classifies timeout errors as retryable', () => {
    const err = new Error('request timeout');
    const norm = normalizeError(err);
    expect(norm.retryable).toBe(true);
  });

  it('classifies AbortError as retryable', () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
    err.name = 'AbortError';
    const norm = normalizeError(err);
    expect(norm.retryable).toBe(true);
  });

  it('classifies ECONNREFUSED as retryable', () => {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:5432');
    const norm = normalizeError(err);
    expect(norm.retryable).toBe(true);
  });

  it('does not set retryable for non-retryable errors', () => {
    const err = new Error('invalid payment amount');
    const norm = normalizeError(err);
    expect(norm.retryable).toBeUndefined();
  });

  it('does not include stack traces', () => {
    const err = new Error('test');
    const norm = normalizeError(err);
    expect(JSON.stringify(norm)).not.toContain('at ');
    expect((norm as Record<string, unknown>).stack).toBeUndefined();
  });
});

// ── safeLogErrorContext ──

describe('safeLogErrorContext', () => {
  it('returns validated errorName', () => {
    const ctx = safeLogErrorContext(new Error('db timeout'));
    expect(ctx.errorName).toBe('Error');
  });

  it('never includes errorMessage, message, or stack', () => {
    const ctx = safeLogErrorContext(new Error('secret-host.internal connection failed for admin@db.com'));
    expect(ctx).not.toHaveProperty('errorMessage');
    expect(ctx).not.toHaveProperty('message');
    expect(ctx).not.toHaveProperty('stack');
  });

  it('includes code when safe', () => {
    const err = Object.assign(new Error('fail'), { code: 'RATE_LIMIT' });
    const ctx = safeLogErrorContext(err);
    expect(ctx.errorCode).toBe('RATE_LIMIT');
  });

  it('omits code when unsafe', () => {
    const err = Object.assign(new Error('fail'), { code: 'secret_key_expired' });
    const ctx = safeLogErrorContext(err);
    expect(ctx).not.toHaveProperty('errorCode');
  });

  it('includes retryable when known', () => {
    const ctx = safeLogErrorContext(new Error('connect ECONNRESET'));
    expect(ctx.retryable).toBe(true);
  });

  it('omits unsafe errorName', () => {
    const err = new Error('fail');
    err.name = 'access_token_Error';
    const ctx = safeLogErrorContext(err);
    expect(ctx).not.toHaveProperty('errorName');
  });
});

// ── Sensitive key detection ──

describe('isSensitiveKey', () => {
  it('detects authorization keys', () => {
    expect(isSensitiveKey('authorization')).toBe(true);
    expect(isSensitiveKey('authorization_code')).toBe(true);
    expect(isSensitiveKey('access_token')).toBe(true);
  });

  it('detects credential keys', () => {
    expect(isSensitiveKey('secret_key')).toBe(true);
    expect(isSensitiveKey('password')).toBe(true);
    expect(isSensitiveKey('api_key')).toBe(true);
  });

  it('detects PII keys', () => {
    expect(isSensitiveKey('email')).toBe(true);
    expect(isSensitiveKey('phone')).toBe(true);
    expect(isSensitiveKey('card_number')).toBe(true);
  });

  it('allows safe keys', () => {
    expect(isSensitiveKey('businessId')).toBe(false);
    expect(isSensitiveKey('amount')).toBe(false);
    expect(isSensitiveKey('gateway')).toBe(false);
    expect(isSensitiveKey('paymentId')).toBe(false);
  });
});

// ── Integration: payment files use normalizeError ──

describe('Payment files use normalizeError', () => {
  const paystackCode = readFileSync('lib/payments/paystack.ts', 'utf-8');
  const flutterwaveCode = readFileSync('lib/payments/flutterwave.ts', 'utf-8');
  const stripeCode = readFileSync('lib/payments/stripe.ts', 'utf-8');
  const chargeSavedCode = readFileSync('lib/payments/charge-saved.ts', 'utf-8');

  it('Paystack uses normalizeError in catch blocks', () => {
    expect(paystackCode).toContain("normalizeError(error).message");
    expect(paystackCode).not.toContain("(error as Error).message");
  });

  it('Flutterwave uses normalizeError in catch blocks', () => {
    expect(flutterwaveCode).toContain("normalizeError(error).message");
    expect(flutterwaveCode).not.toContain("(error as Error).message");
  });

  it('Stripe uses normalizeError in catch blocks', () => {
    expect(stripeCode).toContain("normalizeError(error).message");
    // Stripe still has one (error as Error) for the init catch — that's the existing pattern
  });

  it('charge-saved uses normalizeError in catch blocks', () => {
    expect(chargeSavedCode).toContain("normalizeError(error).message");
  });
});

// ── Integration: observability uses normalizeError ──

describe('Observability uses safeLogErrorContext', () => {
  const obsCode = readFileSync('lib/observability.ts', 'utf-8');

  it('observe() uses safeLogErrorContext for error events', () => {
    expect(obsCode).toContain("safeLogErrorContext(error)");
  });

  it('observeProvider() uses safeLogErrorContext for error events', () => {
    // Both observe and observeProvider use safeLogErrorContext
    const normCount = (obsCode.match(/safeLogErrorContext\(error\)/g) || []).length;
    expect(normCount).toBeGreaterThanOrEqual(2);
  });

  it('does not pass raw error object to logger', () => {
    // Should not contain 'error as Error' in the failure paths
    expect(obsCode).not.toContain('error as Error');
  });
});

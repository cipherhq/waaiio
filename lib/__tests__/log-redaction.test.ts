/**
 * Log Redaction Tests
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { redact, maskPhone, maskEmail, safeProviderError, isSafeIdentifier } from '@/lib/redact';
import { normalizeError, safeLogErrorContext } from '@/lib/errors';
import { readFileSync } from 'fs';

// ── redact() — key format variants ──

describe('redact key normalization', () => {
  it('redacts snake_case keys', () => {
    expect((redact({ secret_key: 'abc' }) as Record<string, unknown>).secret_key).toBe('[REDACTED]');
  });

  it('redacts camelCase keys', () => {
    expect((redact({ secretKey: 'abc' }) as Record<string, unknown>).secretKey).toBe('[REDACTED]');
    expect((redact({ accessToken: 'xyz' }) as Record<string, unknown>).accessToken).toBe('[REDACTED]');
  });

  it('redacts authorization_code and authorizationCode', () => {
    expect((redact({ authorization_code: 'x' }) as Record<string, unknown>).authorization_code).toBe('[REDACTED]');
    expect((redact({ authorizationCode: 'x' }) as Record<string, unknown>).authorizationCode).toBe('[REDACTED]');
  });

  it('redacts refresh_token and refreshToken', () => {
    expect((redact({ refresh_token: 'x' }) as Record<string, unknown>).refresh_token).toBe('[REDACTED]');
    expect((redact({ refreshToken: 'x' }) as Record<string, unknown>).refreshToken).toBe('[REDACTED]');
  });

  it('redacts client_secret and clientSecret', () => {
    expect((redact({ client_secret: 'x' }) as Record<string, unknown>).client_secret).toBe('[REDACTED]');
    expect((redact({ clientSecret: 'x' }) as Record<string, unknown>).clientSecret).toBe('[REDACTED]');
  });

  it('redacts card_number, cardNumber, account_number, accountNumber', () => {
    expect((redact({ card_number: '4242' }) as Record<string, unknown>).card_number).toBe('[REDACTED]');
    expect((redact({ cardNumber: '4242' }) as Record<string, unknown>).cardNumber).toBe('[REDACTED]');
    expect((redact({ account_number: '123' }) as Record<string, unknown>).account_number).toBe('[REDACTED]');
    expect((redact({ accountNumber: '123' }) as Record<string, unknown>).accountNumber).toBe('[REDACTED]');
  });

  it('redacts webhook_secret, webhookSecret, verif_hash, verifHash, raw_body, rawBody', () => {
    expect((redact({ webhook_secret: 'x' }) as Record<string, unknown>).webhook_secret).toBe('[REDACTED]');
    expect((redact({ webhookSecret: 'x' }) as Record<string, unknown>).webhookSecret).toBe('[REDACTED]');
    expect((redact({ verif_hash: 'x' }) as Record<string, unknown>).verif_hash).toBe('[REDACTED]');
    expect((redact({ verifHash: 'x' }) as Record<string, unknown>).verifHash).toBe('[REDACTED]');
    expect((redact({ raw_body: 'x' }) as Record<string, unknown>).raw_body).toBe('[REDACTED]');
    expect((redact({ rawBody: 'x' }) as Record<string, unknown>).rawBody).toBe('[REDACTED]');
  });

  it('preserves safe identifiers', () => {
    const r = redact({ paymentId: 'p-1', businessId: 'b-1', gateway: 'stripe', amount: 5000 }) as Record<string, unknown>;
    expect(r.paymentId).toBe('p-1');
    expect(r.businessId).toBe('b-1');
    expect(r.gateway).toBe('stripe');
    expect(r.amount).toBe(5000);
  });

  it('handles nested, arrays, circular, null, primitives', () => {
    const nested = redact({ data: { email: 'a@b.com', amount: 100 } }) as Record<string, Record<string, unknown>>;
    expect(nested.data.email).toBe('[REDACTED]');
    expect(nested.data.amount).toBe(100);

    const circ: Record<string, unknown> = { id: '1' };
    circ.self = circ;
    expect(() => redact(circ)).not.toThrow();

    const obj = { secret_key: 'orig' };
    redact(obj);
    expect(obj.secret_key).toBe('orig'); // not mutated

    expect(redact(null)).toBeNull();
    expect(redact('hello')).toBe('hello');
    expect(redact(42)).toBe(42);
  });
});

// ── safeProviderError — strict validation ──

describe('safeProviderError strict validation', () => {
  it('extracts safe identifiers', () => {
    expect(safeProviderError({ code: 'RATE_LIMIT' })).toContain('code=RATE_LIMIT');
    expect(safeProviderError({ error: 'invalid_request' })).toContain('error=invalid_request');
    expect(safeProviderError({ type: 'authentication_error' })).toContain('type=authentication_error');
    expect(safeProviderError({ status: 400 })).toContain('status=400');
    expect(safeProviderError({ status: false })).toContain('status=false');
  });

  it('extracts nested error.code and error.type', () => {
    expect(safeProviderError({ error: { code: 'INVALID_CARD' } })).toContain('code=INVALID_CARD');
    expect(safeProviderError({ error: { type: 'card_error' } })).toContain('type=card_error');
  });

  it('rejects card numbers (long digit sequences)', () => {
    expect(safeProviderError({ code: '4242424242424242' })).toBe('Provider request failed');
    expect(safeProviderError({ status: '0123456789' })).toBe('Provider request failed');
  });

  it('rejects credential prefixes', () => {
    expect(safeProviderError({ code: 'secret_key_abc123' })).toBe('Provider request failed');
    expect(safeProviderError({ error: 'Bearer abc123' })).toBe('Provider request failed');
    expect(safeProviderError({ error: 'client_secret=abc' })).toBe('Provider request failed');
    expect(safeProviderError({ error: 'authorization_code_xyz' })).toBe('Provider request failed');
  });

  it('rejects email addresses', () => {
    expect(safeProviderError({ error: 'customer@example.com' })).toBe('Provider request failed');
  });

  it('rejects phone numbers', () => {
    expect(safeProviderError({ error: '+2348012345678' })).toBe('Provider request failed');
  });

  it('rejects strings with whitespace', () => {
    expect(safeProviderError({ code: 'invalid card number' })).toBe('Provider request failed');
  });

  it('rejects long strings', () => {
    expect(safeProviderError({ code: 'a'.repeat(61) })).toBe('Provider request failed');
  });

  it('returns safe default for null/unknown', () => {
    expect(safeProviderError(null)).toBe('Provider error');
    expect(safeProviderError({ nothing: true })).toBe('Provider request failed');
  });
});

// ── maskPhone / maskEmail ──

describe('maskPhone', () => {
  it('masks phone', () => { expect(maskPhone('+2348012345678')).toBe('+234****5678'); });
  it('handles null', () => { expect(maskPhone(null)).toBe('[no phone]'); });
});

describe('maskEmail', () => {
  it('masks email', () => { expect(maskEmail('customer@example.com')).toBe('c***@example.com'); });
  it('handles null', () => { expect(maskEmail(null)).toBe('[no email]'); });
});

// ── Behavioral: BulkSMS ──

describe('BulkSMS behavioral tests', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { delete process.env.BULKSMS_NG_API_TOKEN; });

  it('successful send: returns { sent: true }, logs no phone/body/response', async () => {
    process.env.BULKSMS_NG_API_TOKEN = 'test-token';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'success' }),
    }));

    const captured: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { captured.push(args.map(String).join(' ')); });

    vi.resetModules();
    const { sendSms } = await import('@/lib/sms/bulksms-ng');
    const result = await sendSms({ to: '+2348012345678', message: 'Secret meeting at 9pm' });

    expect(result).toEqual({ sent: true });
    for (const line of captured) {
      expect(line).not.toContain('8012345678');
      expect(line).not.toContain('Secret meeting');
      expect(line).not.toContain('status');
    }
    vi.unstubAllGlobals();
  });

  it('HTTP error: returns original error string, logs only safe status', async () => {
    process.env.BULKSMS_NG_API_TOKEN = 'test-token';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: () => Promise.resolve('Rate limit exceeded for customer@mail.com'),
    }));

    const captured: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { captured.push(args.map(String).join(' ')); });

    vi.resetModules();
    const { sendSms } = await import('@/lib/sms/bulksms-ng');
    const result = await sendSms({ to: '2348012345678', message: 'Hello' });

    expect(result).toEqual({ sent: false, error: 'SMS API error: 429' });
    for (const line of captured) {
      expect(line).not.toContain('customer@mail.com');
      expect(line).not.toContain('Rate limit exceeded');
      expect(line).not.toContain('8012345678');
    }
    vi.unstubAllGlobals();
  });

  it('thrown Error: returns original Error.message, logs safe metadata only', async () => {
    process.env.BULKSMS_NG_API_TOKEN = 'test-token';
    const sensitiveMsg = 'ECONNREFUSED to secret-server.internal:3000';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(sensitiveMsg)));

    const captured: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { captured.push(args.map(String).join(' ')); });

    vi.resetModules();
    const { sendSms } = await import('@/lib/sms/bulksms-ng');
    const result = await sendSms({ to: '2348012345678', message: 'Hello' });

    // Return value preserves original Error.message (pre-PR behavior)
    expect(result).toEqual({ sent: false, error: sensitiveMsg });
    // But the log does NOT contain the sensitive message
    for (const line of captured) {
      expect(line).not.toContain('secret-server.internal');
    }
    vi.unstubAllGlobals();
  });

  it('thrown string: returns "SMS send failed" (pre-PR behavior)', async () => {
    process.env.BULKSMS_NG_API_TOKEN = 'test-token';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue('some raw string'));

    vi.resetModules();
    const { sendSms } = await import('@/lib/sms/bulksms-ng');
    const result = await sendSms({ to: '2348012345678', message: 'Hello' });

    expect(result).toEqual({ sent: false, error: 'SMS send failed' });
    vi.unstubAllGlobals();
  });
});

// ── Integration: corrected logging paths ──

describe('Corrected logging paths (structural)', () => {
  const stripeCode = readFileSync('lib/payments/stripe.ts', 'utf-8');
  const paystackCode = readFileSync('lib/payments/paystack.ts', 'utf-8');
  const squareCode = readFileSync('lib/payments/square.ts', 'utf-8');
  const paypalCode = readFileSync('lib/payments/paypal.ts', 'utf-8');
  const embeddedSignup = readFileSync('app/api/whatsapp/embedded-signup/route.ts', 'utf-8');
  const sendConfirmation = readFileSync('lib/payments/send-confirmation.ts', 'utf-8');
  const notifyFailed = readFileSync('lib/payments/notify-charge-failed.ts', 'utf-8');
  const bulksms = readFileSync('lib/sms/bulksms-ng.ts', 'utf-8');
  const refundRoute = readFileSync('app/api/payments/refund/route.ts', 'utf-8');

  it('Stripe no longer logs key prefix or key length', () => {
    expect(stripeCode).not.toContain('keyPrefix');
    expect(stripeCode).not.toContain('keyLength');
  });

  it('all providers import safeProviderError (not safeProviderMessage)', () => {
    expect(stripeCode).toContain('safeProviderError');
    expect(paystackCode).toContain('safeProviderError');
    expect(squareCode).toContain('safeProviderError');
    expect(paypalCode).toContain('safeProviderError');
  });

  it('embedded-signup preserves original response body', () => {
    expect(embeddedSignup).toContain("JSON.stringify(tokenData).slice(0, 200)");
  });

  it('send-confirmation does not log email/phone in logger calls', () => {
    expect(sendConfirmation.match(/logger\.\w+\(`[^`]*\$\{guestEmail\}/g) || []).toHaveLength(0);
    expect(sendConfirmation.match(/logger\.\w+\(`[^`]*\$\{donorEmail\}/g) || []).toHaveLength(0);
  });

  it('BulkSMS uses static imports only', () => {
    expect(bulksms).not.toContain('await import');
  });

  it('refund route uses safeLogErrorContext and structured context', () => {
    expect(refundRoute).toContain("import { safeLogErrorContext } from '@/lib/errors'");
    expect(refundRoute).not.toContain('await import');
    expect(refundRoute).toContain('logger.withContext');
    expect(refundRoute).toContain('safeLogErrorContext(error)');
  });

  it('embedded-signup uses safeProviderError and safeLogErrorContext for logging', () => {
    expect(embeddedSignup).toContain('safeProviderError(tokenData)');
    expect(embeddedSignup).not.toMatch(/logger.*tokenData\.error/);
    expect(embeddedSignup).toContain("import { safeLogErrorContext } from '@/lib/errors'");
    expect(embeddedSignup).toContain("safeLogErrorContext");
    // No raw error objects passed to logger
    expect(embeddedSignup).not.toMatch(/logger\.\w+\([^)]*,\s*(exchangeErr|channelError|err|error)\s*\)/);
    // No displayNumber in success log
    expect(embeddedSignup).not.toMatch(/logger.*displayNumber/);
  });

  it('square-callback uses safeProviderError and safeLogErrorContext for logging', () => {
    const squareCallback = readFileSync('app/api/payouts/square-callback/route.ts', 'utf-8');
    expect(squareCallback).toContain('safeProviderError(tokenData)');
    expect(squareCallback).not.toMatch(/logger.*tokenData\.error/);
    expect(squareCallback).not.toMatch(/logger\.\w+\([^)]*,\s*merchantData\s*\)/);
    expect(squareCallback).not.toMatch(/logger\.\w+\([^)]*\.message/);
    expect(squareCallback).toContain("import { safeLogErrorContext } from '@/lib/errors'");
  });

  it('BulkSMS validates norm.name with isSafeIdentifier, refund uses safeLogErrorContext', () => {
    expect(bulksms).toContain('isSafeIdentifier(norm.name)');
    expect(refundRoute).toContain('safeLogErrorContext(error)');
  });

  it('all providers use safeLogErrorContext for catch blocks', () => {
    expect(stripeCode).toContain('safeLogErrorContext(error)');
    expect(paystackCode).toContain('safeLogErrorContext(error)');
    expect(squareCode).toContain('safeLogErrorContext(error)');
    expect(paypalCode).toContain('safeLogErrorContext(error)');
    // No raw .message in logger calls
    expect(stripeCode).not.toMatch(/logger\.\w+\([^)]*\.message/);
    expect(paystackCode).not.toMatch(/logger\.\w+\([^)]*\.message/);
    expect(squareCode).not.toMatch(/logger\.\w+\([^)]*\.message/);
    expect(paypalCode).not.toMatch(/logger\.\w+\([^)]*\.message/);
    // No stack traces in logger calls
    expect(stripeCode).not.toMatch(/logger\.\w+\([^)]*\.stack/);
    expect(paypalCode).not.toMatch(/logger\.\w+\([^)]*\.stack/);
  });

  it('send-confirmation uses logSafeError helper, no raw errors to logger', () => {
    expect(sendConfirmation).toContain('logSafeError(');
    expect(sendConfirmation).not.toMatch(/logger\.error\(`[^`]*error:\`,\s*(pcErr|err|emailErr|ticketErr|notifyErr|donationEmailErr)\s*\)/);
  });

  it('observability helpers use safeLogErrorContext (no errorMessage)', () => {
    const obs = readFileSync('lib/observability.ts', 'utf-8');
    const webhooks = readFileSync('lib/observability/webhooks.ts', 'utf-8');
    const cron = readFileSync('lib/observability/cron.ts', 'utf-8');
    expect(obs).toContain('safeLogErrorContext');
    expect(obs).not.toContain('errorMessage');
    expect(obs).not.toMatch(/as unknown as string/);
    expect(webhooks).toContain('safeLogErrorContext');
    expect(webhooks).not.toContain('errorMessage');
    expect(cron).toContain('safeLogErrorContext');
    expect(cron).not.toContain('errorMessage');
  });
});

// ── isSafeIdentifier ──

describe('isSafeIdentifier', () => {
  it('accepts legitimate identifiers', () => {
    expect(isSafeIdentifier('RATE_LIMIT')).toBe(true);
    expect(isSafeIdentifier('invalid_request')).toBe(true);
    expect(isSafeIdentifier('authentication_error')).toBe(true);
    expect(isSafeIdentifier('card_error')).toBe(true);
    expect(isSafeIdentifier('Error')).toBe(true);
    expect(isSafeIdentifier('TypeError')).toBe(true);
  });

  it('rejects credential prefixes', () => {
    expect(isSafeIdentifier('secret_key_abc')).toBe(false);
    expect(isSafeIdentifier('bearer_token_xyz')).toBe(false);
    expect(isSafeIdentifier('bearer_token')).toBe(false);
    expect(isSafeIdentifier('access_token_xyz')).toBe(false);
    expect(isSafeIdentifier('refresh_token_abc')).toBe(false);
    expect(isSafeIdentifier('api_key_123')).toBe(false);
    expect(isSafeIdentifier('secret_key_abc')).toBe(false);
    expect(isSafeIdentifier('client_secret_xyz')).toBe(false);
    expect(isSafeIdentifier('authorization_code_abc')).toBe(false);
    expect(isSafeIdentifier('webhook_secret_xyz')).toBe(false);
  });

  it('rejects long digit sequences', () => {
    expect(isSafeIdentifier('42424242')).toBe(false);
    expect(isSafeIdentifier('0123456789')).toBe(false);
  });

  it('rejects whitespace', () => {
    expect(isSafeIdentifier('invalid card')).toBe(false);
  });

  it('rejects special characters', () => {
    expect(isSafeIdentifier('user@host')).toBe(false);
    expect(isSafeIdentifier('+234')).toBe(false);
  });

  it('rejects long strings', () => {
    expect(isSafeIdentifier('a'.repeat(61))).toBe(false);
  });
});

// ── safeProviderError extended credential rejection ──

describe('safeProviderError credential rejection (extended)', () => {
  it('rejects access_token prefix in code', () => {
    expect(safeProviderError({ code: 'access_token_expired' })).toBe('Provider request failed');
  });

  it('rejects refresh_token prefix in type', () => {
    expect(safeProviderError({ type: 'refresh_token_invalid' })).toBe('Provider request failed');
  });

  it('rejects api_key prefix in error', () => {
    expect(safeProviderError({ error: 'api_key_revoked' })).toBe('Provider request failed');
  });

  it('rejects webhook_secret prefix in nested code', () => {
    expect(safeProviderError({ error: { code: 'webhook_secret_missing' } })).toBe('Provider request failed');
  });

  it('rejects secret_key prefix in status', () => {
    expect(safeProviderError({ status: 'secret_key_invalid' })).toBe('Provider request failed');
  });

  it('accepts legitimate identifiers', () => {
    expect(safeProviderError({ code: 'RATE_LIMIT', type: 'api_error' })).toContain('code=RATE_LIMIT');
    expect(safeProviderError({ error: 'invalid_request' })).toContain('error=invalid_request');
  });
});

// ── Executable route tests ──

describe('Embedded-signup behavioral', () => {
  it('safeProviderError filters sensitive provider fields', () => {
    // Simulate a Meta token exchange failure containing PII
    const tokenData = {
      error: {
        message: 'Invalid OAuth token for user@facebook.com',
        type: 'OAuthException',
        code: 190,
      },
    };
    const logged = safeProviderError(tokenData);
    expect(logged).not.toContain('user@facebook.com');
    expect(logged).not.toContain('Invalid OAuth');
    expect(logged).toContain('type=OAuthException');
  });
});

describe('Square-callback behavioral', () => {
  it('safeProviderError filters sensitive Square token response', () => {
    const tokenData = {
      error: 'unauthorized_client',
      error_description: 'Client with id sq0idp-xxx for merchant MC123',
    };
    const logged = safeProviderError(tokenData);
    expect(logged).not.toContain('sq0idp');
    expect(logged).not.toContain('MC123');
    expect(logged).toContain('error=unauthorized_client');
  });
});

describe('Refund route behavioral', () => {
  it('safeLogErrorContext filters sensitive error names/codes', () => {
    const err = Object.assign(new Error('Refund failed for customer@email.com account 0123456789'), {
      name: 'secret_key_PaymentError',
      code: 'authorization_code_expired',
    });
    const ctx = safeLogErrorContext(err);
    expect(ctx.errorName).toBeUndefined();
    expect(ctx.errorCode).toBeUndefined();
    expect(ctx).not.toHaveProperty('errorMessage');
  });

  it('safeLogErrorContext retains safe names, codes, and retryable', () => {
    const err = Object.assign(new Error('Connection timeout'), {
      name: 'AbortError',
      code: 'ETIMEDOUT',
    });
    const ctx = safeLogErrorContext(err);
    expect(ctx.errorName).toBe('AbortError');
    expect(ctx.errorCode).toBe('ETIMEDOUT');
    expect(ctx.retryable).toBe(true);
  });

  it('safeLogErrorContext never includes errorMessage field', () => {
    const cases = [
      new Error('ECONNREFUSED to secret-host.internal'),
      'a raw string error',
      null,
      { message: 'object with message', code: 'RATE_LIMIT' },
    ];
    for (const err of cases) {
      const ctx = safeLogErrorContext(err);
      expect(ctx).not.toHaveProperty('errorMessage');
    }
  });
});

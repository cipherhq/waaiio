/**
 * Route Handler Redaction Tests
 *
 * These tests import and invoke the actual route handlers with mocked
 * dependencies, asserting that:
 * - Response bodies and status codes are preserved exactly
 * - Continuation and non-fatal behavior remains unchanged
 * - Captured logs contain no sensitive values
 * - No raw error objects are emitted to the logger
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Shared log capture ──

let capturedErrors: string[] = [];
let capturedLogs: string[] = [];

function captureAll(...args: unknown[]): void {
  capturedLogs.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
}

function captureErrors(...args: unknown[]): void {
  const line = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  capturedErrors.push(line);
  capturedLogs.push(line);
}

// ── Helpers ──

function assertNoSensitiveData(lines: string[], sensitiveValues: string[]) {
  for (const line of lines) {
    for (const val of sensitiveValues) {
      expect(line).not.toContain(val);
    }
  }
}

// ═══════════════════════════════════════════════════════════
// Embedded Signup Route Handler Tests
// ═══════════════════════════════════════════════════════════

describe('Embedded-signup route handler', () => {
  beforeEach(() => {
    capturedErrors = [];
    capturedLogs = [];
    vi.restoreAllMocks();
    vi.resetModules();

    // Set required env vars
    process.env.NEXT_PUBLIC_META_APP_ID = 'test-app-id';
    process.env.META_APP_SECRET = 'test-app-secret';
    process.env.NEXT_PUBLIC_APP_URL = 'https://test.waaiio.com';

    // Capture console output
    vi.spyOn(console, 'error').mockImplementation(captureErrors);
    vi.spyOn(console, 'log').mockImplementation(captureAll);
    vi.spyOn(console, 'warn').mockImplementation(captureAll);
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_META_APP_ID;
    delete process.env.META_APP_SECRET;
    delete process.env.NEXT_PUBLIC_APP_URL;
    vi.unstubAllGlobals();
  });

  function mockRequest(body: Record<string, unknown>): Request {
    return new Request('https://test.waaiio.com/api/whatsapp/embedded-signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  // Helper to set up all mocks needed for the embedded signup handler
  function setupEmbeddedSignupMocks(overrides: {
    tokenResponse?: Record<string, unknown>;
    longLivedTokenThrow?: Error;
    channelInsertError?: Record<string, unknown> | null;
    channelData?: Record<string, unknown>;
    templateThrow?: Error;
    outerThrow?: boolean;
    phonesData?: Record<string, unknown>;
  } = {}) {
    const mockUser = { id: 'user-123' };
    const mockBiz = { id: 'biz-456', name: 'Test Biz', country_code: 'US' };

    // Mock supabase/server
    vi.doMock('@/lib/supabase/server', () => ({
      createClient: vi.fn().mockResolvedValue({
        auth: { getUser: vi.fn().mockResolvedValue({ data: { user: mockUser } }) },
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: mockBiz }),
              }),
            }),
          }),
        }),
      }),
    }));

    // Mock supabase/service
    const channelError = overrides.channelInsertError !== undefined ? overrides.channelInsertError : null;
    const channelData = overrides.channelData || { id: 'ch-789' };
    const mockServiceFrom = vi.fn().mockReturnValue({
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: channelData, error: channelError }),
        }),
      }),
    });

    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn().mockReturnValue({ from: mockServiceFrom }),
    }));

    // Mock MetaCloudService
    const exchangeTokenMock = overrides.longLivedTokenThrow
      ? vi.fn().mockRejectedValue(overrides.longLivedTokenThrow)
      : vi.fn().mockResolvedValue({ access_token: 'long-lived-token-abc' });

    vi.doMock('@/lib/channels/meta-cloud', () => ({
      MetaCloudService: { exchangeToken: exchangeTokenMock },
    }));

    // Mock template provisioning
    if (overrides.templateThrow) {
      vi.doMock('@/lib/channels/provision-templates', () => ({
        provisionTemplates: vi.fn().mockRejectedValue(overrides.templateThrow),
      }));
    } else {
      vi.doMock('@/lib/channels/provision-templates', () => ({
        provisionTemplates: vi.fn().mockResolvedValue(undefined),
      }));
    }

    // Set up fetch mock
    const tokenResponse = overrides.tokenResponse || {
      access_token: 'short-lived-token-xyz',
    };
    const phonesData = overrides.phonesData || {
      data: [{ id: 'phone-num-id-123', display_phone_number: '+1234567890', verified_name: 'Test', quality_rating: 'GREEN' }],
    };

    const fetchResponses: Array<{ json: () => Promise<unknown> }> = [];

    if (overrides.outerThrow) {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(
        new Error('ECONNREFUSED to secret-internal.meta.com:443')
      ));
    } else {
      // Token exchange → debug_token → subscribe → phone_numbers → register
      fetchResponses.push(
        { json: () => Promise.resolve(tokenResponse) },
        { json: () => Promise.resolve({ data: { granular_scopes: [{ permission: 'whatsapp_business_management', target_ids: ['waba-001'] }] } }) },
        { json: () => Promise.resolve({ success: true }) },
        { json: () => Promise.resolve(phonesData) },
        { json: () => Promise.resolve({ success: true }) },
      );

      let fetchCallIndex = 0;
      vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
        const resp = fetchResponses[fetchCallIndex] || { json: () => Promise.resolve({}) };
        fetchCallIndex++;
        return Promise.resolve(resp);
      }));
    }
  }

  it('token-exchange failure with PII: returns 400, logs no email/phone/token', async () => {
    setupEmbeddedSignupMocks({
      tokenResponse: {
        error: {
          message: 'Invalid OAuth for user@facebook.com with phone +2348012345678',
          type: 'OAuthException',
          code: 190,
        },
      },
    });

    const { POST } = await import('@/app/api/whatsapp/embedded-signup/route');
    const res = await POST(mockRequest({ business_id: 'biz-456', code: 'auth-code-secret' }) as any);
    const body = await res.json();

    // Exact response body and status preserved
    expect(res.status).toBe(400);
    expect(body.error).toBe('Failed to exchange auth code');
    // NOTE: The response details field exposes provider error info (pre-existing API contract).
    // tokenData.error.message is tried first, so the raw message appears in the response body.
    // This is deferred to a separate response-safety PR — only the LOG must be safe.
    expect(body.details).toBe('Invalid OAuth for user@facebook.com with phone +2348012345678');

    // Logs must not contain sensitive data
    assertNoSensitiveData(capturedErrors, [
      'user@facebook.com',
      '+2348012345678',
      'auth-code-secret',
      'Invalid OAuth',
    ]);
  });

  it('long-lived token failure continues with short-lived token', async () => {
    const sensitiveError = new Error('Token exchange failed for user@facebook.com token=EAABsbcs...');
    setupEmbeddedSignupMocks({
      longLivedTokenThrow: sensitiveError,
    });

    const { POST } = await import('@/app/api/whatsapp/embedded-signup/route');
    const res = await POST(mockRequest({ business_id: 'biz-456', code: 'auth-code' }) as any);
    const body = await res.json();

    // Continuation: should succeed despite long-lived token failure
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.channel_id).toBe('ch-789');

    // Logs capture the error but not the sensitive content
    assertNoSensitiveData(capturedLogs, [
      'user@facebook.com',
      'EAABsbcs',
      'Token exchange failed for',
    ]);

    // Should have logged the warning
    const hasWarning = capturedLogs.some(l => l.includes('Long-lived token exchange failed'));
    expect(hasWarning).toBe(true);
  });

  it('channel insert failure with sensitive DB error: returns 500, logs no raw error', async () => {
    setupEmbeddedSignupMocks({
      channelInsertError: {
        message: 'duplicate key value violates unique constraint "whatsapp_channels_phone_number_key" for phone +2348012345678',
        code: '23505',
        details: 'Key (phone_number)=(+2348012345678) already exists.',
      },
      channelData: null,
    });

    const { POST } = await import('@/app/api/whatsapp/embedded-signup/route');
    const res = await POST(mockRequest({ business_id: 'biz-456', code: 'auth-code' }) as any);
    const body = await res.json();

    // Exact response preserved
    expect(res.status).toBe(500);
    expect(body).toEqual({ error: 'Failed to save channel' });

    // Logs must not contain the raw DB error text
    assertNoSensitiveData(capturedErrors, [
      'duplicate key value',
      '+2348012345678',
      'phone_number_key',
      'Key (phone_number)',
    ]);

    // The safe error code (23505) is a valid identifier so may appear
    const hasChannelInsert = capturedErrors.some(l => l.includes('Channel insert failed'));
    expect(hasChannelInsert).toBe(true);
  });

  it('template provisioning failure is non-fatal', async () => {
    setupEmbeddedSignupMocks({
      templateThrow: new Error('Template API: 403 Forbidden for account user@meta.com'),
    });

    const { POST } = await import('@/app/api/whatsapp/embedded-signup/route');
    const res = await POST(mockRequest({ business_id: 'biz-456', code: 'auth-code' }) as any);
    const body = await res.json();

    // Non-fatal: still succeeds
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.channel_id).toBe('ch-789');

    // Template error logged but without sensitive content
    assertNoSensitiveData(capturedLogs, [
      'user@meta.com',
      '403 Forbidden for account',
    ]);

    const hasTemplateWarning = capturedLogs.some(l => l.includes('Template provisioning warning'));
    expect(hasTemplateWarning).toBe(true);
  });

  it('outer thrown failure: returns 500, logs no raw error message', async () => {
    setupEmbeddedSignupMocks({ outerThrow: true });

    const { POST } = await import('@/app/api/whatsapp/embedded-signup/route');
    const res = await POST(mockRequest({ business_id: 'biz-456', code: 'auth-code' }) as any);
    const body = await res.json();

    // Exact response preserved
    expect(res.status).toBe(500);
    expect(body).toEqual({ error: 'Signup failed. Please try again.' });

    // Logs must not contain the internal error message
    assertNoSensitiveData(capturedErrors, [
      'secret-internal.meta.com',
      'ECONNREFUSED',
    ]);

    const hasSignupFailed = capturedErrors.some(l => l.includes('Signup failed'));
    expect(hasSignupFailed).toBe(true);
  });

  it('successful completion log does not contain displayNumber', async () => {
    setupEmbeddedSignupMocks({});

    const { POST } = await import('@/app/api/whatsapp/embedded-signup/route');
    const res = await POST(mockRequest({ business_id: 'biz-456', code: 'auth-code' }) as any);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);

    // The success log must NOT contain the phone number
    const successLogs = capturedLogs.filter(l => l.includes('Success'));
    for (const line of successLogs) {
      expect(line).not.toContain('+1234567890');
      expect(line).not.toContain('displayNumber');
    }
  });
});

// ═══════════════════════════════════════════════════════════
// Square Callback Route Handler Tests
// ═══════════════════════════════════════════════════════════

describe('Square-callback route handler', () => {
  beforeEach(() => {
    capturedErrors = [];
    capturedLogs = [];
    vi.restoreAllMocks();
    vi.resetModules();

    process.env.SQUARE_OAUTH_APP_ID = 'sq-app-id';
    process.env.SQUARE_OAUTH_APP_SECRET = 'sq-secret';
    process.env.SQUARE_ENVIRONMENT = 'sandbox';
    process.env.NEXT_PUBLIC_APP_URL = 'https://test.waaiio.com';

    vi.spyOn(console, 'error').mockImplementation(captureErrors);
    vi.spyOn(console, 'log').mockImplementation(captureAll);
    vi.spyOn(console, 'warn').mockImplementation(captureAll);
  });

  afterEach(() => {
    delete process.env.SQUARE_OAUTH_APP_ID;
    delete process.env.SQUARE_OAUTH_APP_SECRET;
    delete process.env.SQUARE_ENVIRONMENT;
    delete process.env.NEXT_PUBLIC_APP_URL;
    vi.unstubAllGlobals();
  });

  function mockCallbackRequest(params: Record<string, string>): Request {
    const url = new URL('https://test.waaiio.com/api/payouts/square-callback');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return new Request(url.toString(), { method: 'GET' });
  }

  function setupSquareCallbackMocks() {
    // Mock supabase client
    vi.doMock('@/lib/supabase/server', () => ({
      createClient: vi.fn().mockResolvedValue({
        from: vi.fn().mockReturnValue({
          update: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }),
          insert: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      }),
    }));
  }

  it('token-exchange failure: redirects correctly, logs no provider data', async () => {
    setupSquareCallbackMocks();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        error: 'unauthorized_client',
        error_description: 'Client sq0idp-xyzABC for merchant MCH-secret-123 is not authorized',
        access_token: null,
      }),
    }));

    const { GET } = await import('@/app/api/payouts/square-callback/route');
    const res = await GET(mockCallbackRequest({ code: 'auth-code-xyz', state: 'biz-456:random' }) as any);

    // Exact redirect URL preserved
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://test.waaiio.com/dashboard/payouts?error=token_exchange_failed');

    // Logs contain no sensitive provider data
    assertNoSensitiveData(capturedErrors, [
      'sq0idp',
      'MCH-secret-123',
      'is not authorized',
      'auth-code-xyz',
    ]);
  });

  it('merchant-verification failure with sensitive payload: redirects, logs safe', async () => {
    setupSquareCallbackMocks();

    let fetchCall = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      fetchCall++;
      if (fetchCall === 1) {
        // Token exchange succeeds
        return Promise.resolve({
          json: () => Promise.resolve({
            access_token: 'fake-square-access-token-value',
            merchant_id: 'MCHID123',
          }),
        });
      }
      // Merchant verification returns sensitive data without merchant
      return Promise.resolve({
        json: () => Promise.resolve({
          errors: [{
            category: 'AUTHENTICATION_ERROR',
            code: 'UNAUTHORIZED',
            detail: 'OAuth access token for merchant MCHID123 with email admin@business.com is expired',
          }],
          // No .merchant key
        }),
      });
    }));

    const { GET } = await import('@/app/api/payouts/square-callback/route');
    const res = await GET(mockCallbackRequest({ code: 'auth-code', state: 'biz-456:random' }) as any);

    // Exact redirect preserved
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://test.waaiio.com/dashboard/payouts?error=not_verified');

    // Logs must not contain sensitive payload fields
    assertNoSensitiveData(capturedErrors, [
      'admin@business.com',
      'fake-square-access-token-value',
      'is expired',
      'MCHID123',
    ]);

    // Should have logged the merchant verification failure message
    const hasMerchantFail = capturedErrors.some(l => l.includes('Merchant verification failed'));
    expect(hasMerchantFail).toBe(true);
  });

  it('outer thrown failure: redirects, logs no error message', async () => {
    setupSquareCallbackMocks();

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(
      new Error('ECONNREFUSED to square-internal.squareup.com:443 for merchant admin@corp.com')
    ));

    const { GET } = await import('@/app/api/payouts/square-callback/route');
    const res = await GET(mockCallbackRequest({ code: 'auth-code', state: 'biz-456:random' }) as any);

    // Exact redirect preserved
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://test.waaiio.com/dashboard/payouts?error=callback_failed');

    // Logs must not contain the sensitive error message
    assertNoSensitiveData(capturedErrors, [
      'square-internal.squareup.com',
      'admin@corp.com',
      'ECONNREFUSED',
    ]);

    const hasCallbackFailed = capturedErrors.some(l => l.includes('Callback failed'));
    expect(hasCallbackFailed).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// Refund Route Handler Tests
// ═══════════════════════════════════════════════════════════

describe('Refund route handler', () => {
  beforeEach(() => {
    capturedErrors = [];
    capturedLogs = [];
    vi.restoreAllMocks();
    vi.resetModules();

    vi.spyOn(console, 'error').mockImplementation(captureErrors);
    vi.spyOn(console, 'log').mockImplementation(captureAll);
    vi.spyOn(console, 'warn').mockImplementation(captureAll);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockRefundRequest(body: Record<string, unknown>): Request {
    return new Request('https://test.waaiio.com/api/payments/refund', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('thrown error with sensitive content: returns 500 with exact body, logs omit message/name/code', async () => {
    const sensitiveMsg = 'Refund failed for customer@email.com card 4242424242424242 account 0123456789';
    const sensitiveError = Object.assign(new Error(sensitiveMsg), {
      name: 'secret_key_PaymentError',
      code: 'authorization_code_expired',
    });

    // Mock supabase to authenticate, find business and payment, then throw on processRefund
    vi.doMock('@/lib/supabase/server', () => ({
      createClient: vi.fn().mockResolvedValue({
        auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-123' } } }) },
        from: vi.fn().mockImplementation((table: string) => {
          if (table === 'businesses') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    single: vi.fn().mockResolvedValue({ data: { id: 'biz-456' } }),
                  }),
                }),
              }),
            };
          }
          if (table === 'payments') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    single: vi.fn().mockResolvedValue({ data: { id: 'pay-789', business_id: 'biz-456' } }),
                  }),
                }),
              }),
            };
          }
          return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({ data: null }) };
        }),
      }),
    }));

    vi.doMock('@/lib/payments/refund-handler', () => ({
      processRefund: vi.fn().mockRejectedValue(sensitiveError),
    }));

    const { POST } = await import('@/app/api/payments/refund/route');
    const res = await POST(mockRefundRequest({
      paymentId: 'pay-789',
      businessId: 'biz-456',
      amount: 50,
      reason: 'test',
    }) as any);
    const body = await res.json();

    // Exact response body and status
    expect(res.status).toBe(500);
    expect(body).toEqual({ error: 'Internal server error' });

    // Logs must omit sensitive content
    assertNoSensitiveData(capturedErrors, [
      'customer@email.com',
      '4242424242424242',
      '0123456789',
      'secret_key_PaymentError',
      'authorization_code_expired',
      sensitiveMsg,
    ]);

    // Should have logged something about refund error
    const hasRefundError = capturedErrors.some(l => l.includes('Refund API error'));
    expect(hasRefundError).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// Observability Helpers Tests
// ═══════════════════════════════════════════════════════════

describe('Observability helpers — no sensitive messages', () => {
  beforeEach(() => {
    capturedErrors = [];
    capturedLogs = [];
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(captureErrors);
    vi.spyOn(console, 'log').mockImplementation(captureAll);
  });

  const sensitiveMsg = 'ECONNREFUSED to secret-host.internal:5432 user=admin@db.com';

  it('observe() does not log sensitive thrown message', async () => {
    const { observe } = await import('@/lib/observability');
    await expect(observe('test.op', { gateway: 'stripe' }, async () => {
      throw new Error(sensitiveMsg);
    })).rejects.toThrow();

    const failedLog = capturedErrors.find(l => l.includes('test.op failed'));
    expect(failedLog).toBeDefined();
    assertNoSensitiveData(capturedErrors, ['secret-host.internal', 'admin@db.com', sensitiveMsg]);
    // Event name and retryable should be present
    expect(failedLog).toContain('test.op failed');
  });

  it('observeProvider() does not log sensitive thrown message', async () => {
    const { observeProvider } = await import('@/lib/observability');
    await expect(observeProvider({ gateway: 'paystack' }, async () => {
      throw new Error(sensitiveMsg);
    })).rejects.toThrow();

    assertNoSensitiveData(capturedErrors, ['secret-host.internal', 'admin@db.com']);
    const failedLog = capturedErrors.find(l => l.includes('provider.request failed'));
    expect(failedLog).toBeDefined();
  });

  it('observeWithTiming() does not log sensitive thrown message', async () => {
    const { observeWithTiming } = await import('@/lib/observability');
    await expect(observeWithTiming('timed.op', {}, async () => {
      throw new Error(sensitiveMsg);
    })).rejects.toThrow();

    assertNoSensitiveData(capturedErrors, ['secret-host.internal', 'admin@db.com']);
    const failedLog = capturedErrors.find(l => l.includes('timed.op failed'));
    expect(failedLog).toBeDefined();
  });

  it('observe() preserves event name, retryable, and duration context', async () => {
    const { observe } = await import('@/lib/observability');
    const timeoutErr = new Error('Request timeout');
    timeoutErr.name = 'AbortError';
    await expect(observe('payment.init', { gateway: 'stripe', requestId: 'req-abc' }, async () => {
      throw timeoutErr;
    })).rejects.toThrow();

    const failedLog = capturedErrors.find(l => l.includes('payment.init failed'));
    expect(failedLog).toBeDefined();
    // Should contain safe metadata
    expect(failedLog).toContain('AbortError');
    // Should NOT contain the message text
    expect(failedLog).not.toContain('Request timeout');
  });
});

describe('Webhook observability — no sensitive messages', () => {
  beforeEach(() => {
    capturedErrors = [];
    capturedLogs = [];
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(captureErrors);
    vi.spyOn(console, 'log').mockImplementation(captureAll);
  });

  it('webhook.failed does not log a sensitive message', async () => {
    const { createWebhookLogger } = await import('@/lib/observability/webhooks');
    const wh = createWebhookLogger('paystack', 'req-123');
    const sensitiveErr = new Error('Webhook verify failed for merchant admin@business.com credential=secretval_xxx');
    wh.failed(sensitiveErr, { durationMs: 42 });

    assertNoSensitiveData(capturedErrors, ['admin@business.com', 'secretval_xxx', 'Webhook verify failed']);
    const failedLog = capturedErrors.find(l => l.includes('webhook.failed'));
    expect(failedLog).toBeDefined();
  });
});

describe('Cron observability — no sensitive messages', () => {
  beforeEach(() => {
    capturedErrors = [];
    capturedLogs = [];
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(captureErrors);
    vi.spyOn(console, 'log').mockImplementation(captureAll);
  });

  it('cron.failed does not log a sensitive message', async () => {
    const { createCronLogger } = await import('@/lib/observability/cron');
    const cron = createCronLogger('retry-charges');
    const sensitiveErr = new Error('DB connection to secret-db.internal failed for user admin@corp.com');
    cron.failed(sensitiveErr, { processedCount: 5, failureCount: 1 });

    assertNoSensitiveData(capturedErrors, ['secret-db.internal', 'admin@corp.com', 'DB connection']);
    const failedLog = capturedErrors.find(l => l.includes('cron.failed'));
    expect(failedLog).toBeDefined();
  });

  it('cron.item.failed does not log a sensitive message', async () => {
    const { createCronLogger } = await import('@/lib/observability/cron');
    const cron = createCronLogger('process-subscriptions');
    const sensitiveErr = new Error('Charge failed for customer +2348012345678 card 4242424242424242');
    cron.itemFailed(sensitiveErr, { subscriptionId: 'sub-001', gateway: 'paystack' });

    assertNoSensitiveData(capturedErrors, ['+2348012345678', '4242424242424242', 'Charge failed']);
    const failedLog = capturedErrors.find(l => l.includes('cron.item.failed'));
    expect(failedLog).toBeDefined();
  });

  it('cron preserves runId and job name in all events', async () => {
    const { createCronLogger } = await import('@/lib/observability/cron');
    const cron = createCronLogger('test-job');
    expect(cron.runId).toMatch(/^run-/);

    cron.started();
    const startLog = capturedLogs.find(l => l.includes('cron.started'));
    expect(startLog).toBeDefined();
    expect(startLog).toContain('test-job');
  });
});

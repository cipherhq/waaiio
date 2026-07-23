/**
 * Console.error Cleanup Tests
 *
 * Three tiers of evidence:
 * 1. Source-level audit: no unapproved console.error with exact per-file counts
 * 2. Executable production-function tests: real functions invoked with mocked deps
 * 3. Helper-unit tests: safeLogErrorContext validation (supplemental)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

// ── Shared log capture ──

let capturedErrors: string[] = [];
let capturedLogs: string[] = [];

function captureErrors(...args: unknown[]): void {
  const line = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  capturedErrors.push(line);
  capturedLogs.push(line);
}

function captureAll(...args: unknown[]): void {
  capturedLogs.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
}

function assertNoSensitiveData(lines: string[], sensitiveValues: string[]) {
  for (const line of lines) {
    for (const val of sensitiveValues) {
      expect(line).not.toContain(val);
    }
  }
}

function parseJsonLogs(lines: string[]): Array<Record<string, unknown>> {
  return lines
    .filter(l => l.startsWith('{'))
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e): e is Record<string, unknown> => e !== null);
}

// ═══════════════════════════════════════════════════════════
// 1. Source-level audit with exact per-file counts
// ═══════════════════════════════════════════════════════════

describe('Production console.error allowlist (exact counts)', () => {
  /**
   * Exact per-file allowlist. Each entry specifies the expected count
   * and whether the file must have a 'use client' directive.
   *
   * Test fails if:
   * - A new console.error appears in an allowlisted file
   * - An expected occurrence is removed without updating the count
   * - A client file loses its 'use client' directive
   * - Any console.error appears in an unlisted app/ or lib/ file
   */
  interface AllowEntry {
    count: number;
    client: boolean;
    reason: string;
  }

  const ALLOWLIST: Record<string, AllowEntry> = {
    // Server-side logger sink
    'lib/logger.ts': { count: 1, client: false, reason: 'Logger output sink — console.error IS the final structured output channel' },
    // Client-side 'use client' pages — browser code, server logger unavailable
    'app/dashboard/analytics/page.tsx': { count: 1, client: true, reason: 'Browser error debugging for analytics load failure' },
    'app/dashboard/calendar/page.tsx': { count: 1, client: true, reason: 'Browser error debugging for calendar load failure' },
    'app/dashboard/capabilities/page.tsx': { count: 1, client: true, reason: 'Browser error debugging for capability sort save' },
    'app/dashboard/contracts/page.tsx': { count: 6, client: true, reason: 'Browser error debugging for contract CRUD operations' },
    'app/dashboard/events/scan/page.tsx': { count: 1, client: true, reason: 'Browser error debugging for camera init' },
    'app/dashboard/invoices/page.tsx': { count: 5, client: true, reason: 'Browser error debugging for invoice CRUD operations' },
    'app/dashboard/notifications/page.tsx': { count: 3, client: true, reason: 'Browser error debugging for notification operations' },
    'app/dashboard/orders/page.tsx': { count: 1, client: true, reason: 'Browser error debugging for order load failure' },
    'app/dashboard/page.tsx': { count: 1, client: true, reason: 'Browser error debugging for dashboard load failure' },
    'app/dashboard/products/page.tsx': { count: 1, client: true, reason: 'Browser error debugging for product save' },
    'app/dashboard/properties/page.tsx': { count: 2, client: true, reason: 'Browser error debugging for property CRUD' },
    'app/dashboard/reservations/page.tsx': { count: 2, client: true, reason: 'Browser error debugging for reservation queries' },
    'app/dashboard/staff/page.tsx': { count: 3, client: true, reason: 'Browser error debugging for staff operations' },
    'app/dashboard/settings/tabs/AccountTab.tsx': { count: 2, client: true, reason: 'Browser error debugging for subscription downgrade' },
    'app/get-started/OnboardingWizard.tsx': { count: 2, client: true, reason: 'Browser error debugging for signup/onboarding' },
    'app/sign/[token]/page.tsx': { count: 1, client: true, reason: 'Browser error debugging for PDF rendering' },
  };

  function collectTsFiles(dir: string, base: string): string[] {
    const files: string[] = [];
    try {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const rel = relative(base, full);
        if (['node_modules', '.next', 'admin', 'supabase', 'scripts', '.claude', '.git', 'e2e', '__shortest__', '__tests__'].some(d => rel.startsWith(d) || rel.includes(`/${d}/`) || entry === d)) continue;
        const stat = statSync(full);
        if (stat.isDirectory()) {
          files.push(...collectTsFiles(full, base));
        } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith('.test.ts') && !entry.endsWith('.test.tsx') && !entry.endsWith('.d.ts')) {
          files.push(rel);
        }
      }
    } catch { /* skip inaccessible */ }
    return files;
  }

  it('no console.error in unlisted app/ and lib/ files', () => {
    const root = process.cwd();
    const allFiles = [...collectTsFiles(join(root, 'app'), root), ...collectTsFiles(join(root, 'lib'), root)];
    const violations: string[] = [];
    for (const file of allFiles) {
      if (ALLOWLIST[file]) continue;
      const content = readFileSync(join(root, file), 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('console.error')) {
          violations.push(`${file}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }
    if (violations.length > 0) {
      throw new Error(`Found ${violations.length} unapproved console.error call(s):\n` + violations.map(v => `  ${v}`).join('\n'));
    }
  });

  it('every allowlisted file has exactly the expected console.error count', () => {
    const root = process.cwd();
    for (const [file, entry] of Object.entries(ALLOWLIST)) {
      const content = readFileSync(join(root, file), 'utf-8');
      const actual = (content.match(/console\.error/g) || []).length;
      expect(actual, `${file}: expected ${entry.count}, found ${actual}`).toBe(entry.count);
    }
  });

  it('every client-flagged allowlist file has use client directive', () => {
    const root = process.cwd();
    for (const [file, entry] of Object.entries(ALLOWLIST)) {
      if (!entry.client) continue;
      const content = readFileSync(join(root, file), 'utf-8');
      const firstLines = content.split('\n').slice(0, 3).join('\n');
      expect(firstLines, `${file} must be a 'use client' component`).toContain("'use client'");
    }
  });

  it('lib/logger.ts is the only non-client allowance', () => {
    const serverEntries = Object.entries(ALLOWLIST).filter(([, e]) => !e.client);
    expect(serverEntries).toHaveLength(1);
    expect(serverEntries[0][0]).toBe('lib/logger.ts');
  });
});

// ═══════════════════════════════════════════════════════════
// 2. Executable: rate-limit Redis fallback
// ═══════════════════════════════════════════════════════════

describe('Executable: rate-limit Redis fallback', () => {
  beforeEach(() => {
    capturedErrors = [];
    capturedLogs = [];
    vi.restoreAllMocks();
    vi.resetModules();
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-redis.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
    process.env.LOG_FORMAT = 'json';
    vi.spyOn(console, 'error').mockImplementation(captureErrors);
    vi.spyOn(console, 'log').mockImplementation(captureAll);
  });

  afterEach(() => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.LOG_FORMAT;
    vi.unstubAllGlobals();
  });

  it('checkRateLimitAsync falls back to in-memory on Redis error, emits safe structured log', async () => {
    const sensitiveMsg = 'ECONNREFUSED to redis-secret.internal.corp:6379 password=admin123';

    // Mock the Upstash modules so Redis is "configured" but limit() throws
    class MockRedis {}
    vi.doMock('@upstash/redis', () => ({ Redis: MockRedis }));

    class MockRatelimit {
      async limit() { throw new Error(sensitiveMsg); }
      static slidingWindow() { return {}; }
    }
    vi.doMock('@upstash/ratelimit', () => ({ Ratelimit: MockRatelimit }));

    const { checkRateLimitAsync } = await import('@/lib/rate-limit');
    const uniqueKey = `test-rl-${Date.now()}-${Math.random()}`;
    const result = await checkRateLimitAsync(uniqueKey, 5, 60000);

    // In-memory fallback used — first request is allowed
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
    expect(typeof result.resetAt).toBe('number');

    // Structured error log emitted
    const entries = parseJsonLogs(capturedErrors);
    const rlEntry = entries.find(e => e.op === 'rate-limit.redis');
    expect(rlEntry).toBeDefined();
    expect(rlEntry!.msg).toContain('RATE-LIMIT');
    expect(rlEntry!.level).toBe('error');

    // Sensitive data absent from all logs
    assertNoSensitiveData(capturedErrors, [
      'redis-secret.internal.corp',
      'password=admin123',
      sensitiveMsg,
    ]);

    // No direct console.error (only structured logger)
    const rawConsoleErrors = capturedErrors.filter(l => !l.startsWith('{'));
    expect(rawConsoleErrors).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 3. Executable: Flutterwave createPlan structured logging
// ═══════════════════════════════════════════════════════════

describe('Executable: Flutterwave createPlan', () => {
  beforeEach(() => {
    capturedErrors = [];
    capturedLogs = [];
    vi.restoreAllMocks();
    vi.resetModules();
    process.env.FLUTTERWAVE_SECRET_KEY = 'test-key';
    process.env.LOG_FORMAT = 'json';
    vi.spyOn(console, 'error').mockImplementation(captureErrors);
    vi.spyOn(console, 'log').mockImplementation(captureAll);
  });

  afterEach(() => {
    delete process.env.FLUTTERWAVE_SECRET_KEY;
    delete process.env.LOG_FORMAT;
    vi.unstubAllGlobals();
  });

  it('provider-declared failure: returns null, structured JSON log with safe provider info', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        status: 'error',
        message: 'Invalid secret key for merchant admin@business.com',
        data: null,
      }),
    }));

    const { createPlan } = await import('@/lib/payments/flutterwave-recurring');
    const result = await createPlan('Test Plan', 5000, 'monthly');

    expect(result).toBeNull();

    const entries = parseJsonLogs(capturedErrors);
    const entry = entries.find(e => e.op === 'flutterwave.create-plan');
    expect(entry).toBeDefined();
    expect(entry!.msg).toBe('Flutterwave create plan failed');
    expect(entry!.gateway).toBe('flutterwave');
    // providerInfo contains only safe bounded metadata
    expect(typeof entry!.providerInfo).toBe('string');
    expect(String(entry!.providerInfo)).not.toContain('admin@business.com');
    expect(String(entry!.providerInfo)).not.toContain('Invalid secret key');
    // No stack
    expect(entry!.stack).toBeUndefined();
  });

  it('thrown network failure: returns null, safe errorName/retryable in structured log', async () => {
    const sensitiveMsg = 'ECONNREFUSED to flutterwave-internal.secret.com:443';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(sensitiveMsg)));

    const { createPlan } = await import('@/lib/payments/flutterwave-recurring');
    const result = await createPlan('Test Plan', 5000, 'monthly');

    expect(result).toBeNull();

    const entries = parseJsonLogs(capturedErrors);
    const entry = entries.find(e => e.op === 'flutterwave.create-plan');
    expect(entry).toBeDefined();
    expect(entry!.errorName).toBe('Error');
    expect(entry!.retryable).toBe(true); // ECONNREFUSED is retryable
    // Sensitive data absent
    assertNoSensitiveData(capturedErrors, [sensitiveMsg, 'flutterwave-internal.secret.com']);
    expect(entry!.stack).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════
// 4. Executable: OTP send route non-fatal continuation
// ═══════════════════════════════════════════════════════════

describe('Executable: OTP send route channel-failure continuation', () => {
  beforeEach(() => {
    capturedErrors = [];
    capturedLogs = [];
    vi.restoreAllMocks();
    vi.resetModules();
    process.env.LOG_FORMAT = 'json';
    process.env.META_CLOUD_PHONE_NUMBER_ID = 'env-phone-id';
    process.env.META_CLOUD_ACCESS_TOKEN = 'env-access-token';
    process.env.OTP_HMAC_SECRET = 'test-hmac-secret-key-for-otp-generation';
    vi.spyOn(console, 'error').mockImplementation(captureErrors);
    vi.spyOn(console, 'log').mockImplementation(captureAll);
  });

  afterEach(() => {
    delete process.env.LOG_FORMAT;
    delete process.env.META_CLOUD_PHONE_NUMBER_ID;
    delete process.env.META_CLOUD_ACCESS_TOKEN;
    delete process.env.OTP_HMAC_SECRET;
    vi.unstubAllGlobals();
  });

  it('channel failure is non-fatal, env fallback succeeds, returns 200 with pin_id', async () => {
    const sensitiveChannelErr = 'ECONNREFUSED to whatsapp-internal.meta.com:443 for phone +2348012345678';

    // Mock brute-force as unblocked
    vi.doMock('@/lib/brute-force', () => ({
      checkBruteForce: vi.fn().mockReturnValue({ blocked: false }),
    }));

    // Mock rate-limits as allowed
    vi.doMock('@/lib/rate-limit', () => ({
      rateLimitResponseAsync: vi.fn().mockResolvedValue(null),
      getRateLimitKey: vi.fn().mockReturnValue('otp-send:127.0.0.1'),
    }));

    // Mock OTP generation deterministically
    vi.doMock('@/lib/otp-phone-token', () => ({
      generatePhoneOtp: vi.fn().mockReturnValue({ code: '123456', token: 'deterministic-token-abc' }),
    }));

    // Mock service-client WhatsApp-channel lookup to throw sensitive error
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockRejectedValue(new Error(sensitiveChannelErr)),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    }));

    // Mock MetaCloudService — env fallback sends successfully
    vi.doMock('@/lib/channels/meta-cloud', () => {
      return {
        MetaCloudService: class {
          async sendText() { return undefined; }
        },
      };
    });

    const { POST } = await import('@/app/api/auth/otp/send/route');
    const req = new Request('https://test.waaiio.com/api/auth/otp/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '127.0.0.1' },
      body: JSON.stringify({ phone: '+2348012345678' }),
    });
    const res = await POST(req as any);
    const body = await res.json();

    // Exact existing successful response
    expect(res.status).toBe(200);
    expect(body).toEqual({
      message: 'OTP sent via WhatsApp',
      pin_id: 'deterministic-token-abc',
    });

    // One structured channel-failure log emitted
    const entries = parseJsonLogs(capturedErrors);
    const channelEntry = entries.find(e => e.op === 'otp-send.whatsapp-channel');
    expect(channelEntry).toBeDefined();
    expect(channelEntry!.msg).toContain('WhatsApp channel send failed');

    // Sensitive data absent
    assertNoSensitiveData(capturedErrors, [
      'whatsapp-internal.meta.com',
      '+2348012345678',
      sensitiveChannelErr,
    ]);
  });
});

// ═══════════════════════════════════════════════════════════
// 5. Executable: recordPlatformFee Sentry behavior
// ═══════════════════════════════════════════════════════════

describe('Executable: recordPlatformFee Sentry preservation', () => {
  beforeEach(() => {
    capturedErrors = [];
    capturedLogs = [];
    vi.restoreAllMocks();
    vi.resetModules();
    process.env.LOG_FORMAT = 'json';
    vi.spyOn(console, 'error').mockImplementation(captureErrors);
    vi.spyOn(console, 'log').mockImplementation(captureAll);
  });

  afterEach(() => {
    delete process.env.LOG_FORMAT;
    vi.unstubAllGlobals();
  });

  function setupMocks(feeError: { message: string; code?: string } | null) {
    const sentryCapture = vi.fn();
    vi.doMock('@sentry/nextjs', () => ({
      captureException: sentryCapture,
    }));

    vi.doMock('@/lib/getPlatformFees', () => ({
      getPlatformFees: vi.fn().mockReturnValue({
        feePercentage: 3,
        feeFlat: 0,
        feeTotal: 150,
      }),
    }));

    // Build chainable supabase mock
    const insertFn = vi.fn().mockResolvedValue({ error: feeError });
    const mockSupabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'platform_fees') {
          return { insert: insertFn };
        }
        if (table === 'businesses') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: {
                    id: 'biz-123',
                    subscription_tier: 'growth',
                    payout_mode: 'platform',
                    is_in_trial: false,
                    reseller_id: null,
                  },
                }),
              }),
            }),
          };
        }
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: null }),
              maybeSingle: vi.fn().mockResolvedValue({ data: null }),
            }),
          }),
        };
      }),
    };

    return { sentryCapture, mockSupabase };
  }

  it('duplicate error: no Sentry capture, safe structured log emitted', async () => {
    const { sentryCapture, mockSupabase } = setupMocks({
      message: 'duplicate key value violates unique constraint "platform_fees_booking_id_key" for customer admin@corp.com',
      code: '23505',
    });

    const { recordPlatformFee } = await import('@/lib/payments/process-success');
    await recordPlatformFee(mockSupabase as any, {
      bookingId: 'booking-001',
      businessId: 'biz-123',
      paymentAmount: 5000,
    });

    // Sentry NOT called for duplicate
    expect(sentryCapture).not.toHaveBeenCalled();

    // Structured log emitted
    const entries = parseJsonLogs(capturedErrors);
    const feeEntry = entries.find(e => e.op === 'platform-fee.insert');
    expect(feeEntry).toBeDefined();
    expect(feeEntry!.msg).toContain('Insert error');
    // Safe error code present (23505 passes isSafeIdentifier)
    expect(feeEntry!.errorCode).toBe('23505');
    // Sensitive message absent
    assertNoSensitiveData(capturedErrors, ['admin@corp.com', 'duplicate key value', 'platform_fees_booking_id_key']);
  });

  it('non-duplicate error: Sentry captures with existing tags/extra, safe log emitted', async () => {
    const sensitiveMsg = 'connection to secret-db.internal:5432 refused for user admin@corp.com';
    const { sentryCapture, mockSupabase } = setupMocks({
      message: sensitiveMsg,
      code: 'ECONNREFUSED',
    });

    const { recordPlatformFee } = await import('@/lib/payments/process-success');
    await recordPlatformFee(mockSupabase as any, {
      bookingId: 'booking-002',
      businessId: 'biz-123',
      paymentAmount: 5000,
    });

    // Sentry IS called for non-duplicate
    expect(sentryCapture).toHaveBeenCalledTimes(1);
    const [sentryErr, sentryCtx] = sentryCapture.mock.calls[0];
    // Existing tags preserved
    expect(sentryCtx.tags).toEqual({ component: 'process-success', operation: 'platform-fee' });
    // Existing extra preserved
    expect(sentryCtx.extra).toEqual({ businessId: 'biz-123', bookingId: 'booking-002', invoiceId: undefined });
    // Sentry error message exists (this is the existing behavior)
    expect(sentryErr).toBeInstanceOf(Error);

    // Log does not contain sensitive message
    assertNoSensitiveData(capturedErrors, ['secret-db.internal', 'admin@corp.com', sensitiveMsg]);

    // Structured log emitted
    const entries = parseJsonLogs(capturedErrors);
    const feeEntry = entries.find(e => e.op === 'platform-fee.insert');
    expect(feeEntry).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// 6. Structural: no raw errors in changed files
// ═══════════════════════════════════════════════════════════

describe('Structural: corrected files have no raw error logging', () => {
  it('no raw error objects passed to logger in any corrected file', () => {
    const files = [
      'lib/bot/flows/scheduling.flow.ts',
      'lib/bot/flows/ticketing.flow.ts',
      'lib/bot/flows/shared/payment.ts',
      'lib/bot/flows/shared/post-completion.ts',
      'lib/payments/process-success.ts',
      'lib/payments/flutterwave-recurring.ts',
      'lib/rate-limit.ts',
      'lib/recurring/reminder-worker.ts',
      'app/api/payments/stripe-webhook/route.ts',
      'app/api/whatsapp/templates/provision/route.ts',
    ];
    for (const f of files) {
      const code = readFileSync(f, 'utf-8');
      expect(code, `${f} still has console.error`).not.toContain('console.error');
      // No raw error as second arg: logger.xxx('...', err)
      const rawErrMatch = code.match(/logger\.\w+\([^)]*,\s*(err|error|feeErr)\s*\)/g);
      expect(rawErrMatch, `${f} has raw error in logger call: ${rawErrMatch}`).toBeNull();
    }
  });

  it('provider safeProviderError uses withContext, not message arg', () => {
    const files = [
      'lib/payments/flutterwave-recurring.ts',
      'lib/payments/paystack-recurring.ts',
      'lib/payments/stripe-recurring.ts',
    ];
    for (const f of files) {
      const code = readFileSync(f, 'utf-8');
      // Should use providerInfo in context, not as message arg
      expect(code).toContain('providerInfo: safeProviderError');
      expect(code).not.toMatch(/logger\.\w+\([^)]*,\s*safeProviderError/);
    }
  });
});

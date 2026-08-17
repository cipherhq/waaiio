/**
 * OTP Delivery Observability Tests
 *
 * Proves:
 * 1. Delivery attempts are recorded for both paths
 * 2. Meta message ID is never returned to the client
 * 3. Sensitive data is never stored or logged
 * 4. Observability failure does not cause resend
 * 5. Webhook status events are persisted correctly
 * 6. Duplicate and out-of-order callbacks are handled
 * 7. Contract webhook handling is preserved
 * 8. Migration 246 security is preserved
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { readFileSync } from 'fs';

// ═══════════════════════════════════════════════════════════
// Test helpers
// ═══════════════════════════════════════════════════════════

function makeOtpRequest() {
  return new NextRequest('https://www.waaiio.com/api/auth/otp/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '127.0.0.1' },
    body: JSON.stringify({ phone: '+2348012345678' }),
  });
}

// ═══════════════════════════════════════════════════════════
// 1. Route delivery attempt recording
// ═══════════════════════════════════════════════════════════

describe('OTP delivery attempt recording', () => {
  let insertedRows: Array<Record<string, unknown>>;

  function setupMocks(channelAvailable: boolean) {
    insertedRows = [];

    vi.doMock('@/lib/brute-force', () => ({ checkBruteForce: vi.fn().mockReturnValue({ blocked: false }) }));
    vi.doMock('@/lib/rate-limit', () => ({
      rateLimitResponseAsync: vi.fn().mockResolvedValue(null),
      getRateLimitKey: vi.fn().mockReturnValue('test'),
    }));
    vi.doMock('@/lib/otp-phone-token', () => ({
      generatePhoneOtp: vi.fn().mockResolvedValue({ code: '654321', challengeId: 'a'.repeat(64) }),
    }));

    const insertMock = vi.fn().mockImplementation((row: Record<string, unknown>) => {
      insertedRows.push(row);
      return { error: null };
    });

    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn().mockReturnValue({
        from: vi.fn().mockImplementation((table: string) => {
          if (table === 'whatsapp_channels') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                      limit: vi.fn().mockReturnValue({
                        maybeSingle: vi.fn().mockResolvedValue({
                          data: channelAvailable
                            ? { phone_number_id: 'db-pnid', meta_access_token: 'db-token' }
                            : null,
                        }),
                      }),
                    }),
                  }),
                }),
              }),
            };
          }
          if (table === 'otp_delivery_attempts') {
            return { insert: insertMock };
          }
          return {};
        }),
        rpc: vi.fn().mockResolvedValue({ error: null }),
      }),
    }));

    vi.doMock('@/lib/channels/meta-cloud', () => ({
      MetaCloudService: class {
        async sendAuthenticationTemplate() { return { messageId: 'wamid.test123' }; }
      },
    }));
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    process.env.META_CLOUD_PHONE_NUMBER_ID = 'env-pnid';
    process.env.META_CLOUD_ACCESS_TOKEN = 'env-token';
    process.env.PHONE_OTP_HMAC_SECRET = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab';
  });

  afterEach(() => {
    delete process.env.META_CLOUD_PHONE_NUMBER_ID;
    delete process.env.META_CLOUD_ACCESS_TOKEN;
    delete process.env.PHONE_OTP_HMAC_SECRET;
    vi.unstubAllGlobals();
  });

  it('records database_channel delivery attempt', async () => {
    setupMocks(true);
    const { POST } = await import('@/app/api/auth/otp/send/route');
    const res = await POST(makeOtpRequest());
    expect(res.status).toBe(200);
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].delivery_path).toBe('database_channel');
    expect(insertedRows[0].wa_message_id).toBe('wamid.test123');
    expect(insertedRows[0].challenge_id).toBe('a'.repeat(64));
  });

  it('records env_fallback delivery attempt', async () => {
    setupMocks(false);
    const { POST } = await import('@/app/api/auth/otp/send/route');
    const res = await POST(makeOtpRequest());
    expect(res.status).toBe(200);
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].delivery_path).toBe('env_fallback');
    expect(insertedRows[0].wa_message_id).toBe('wamid.test123');
  });

  it('Meta message ID is never returned to the client', async () => {
    setupMocks(true);
    const { POST } = await import('@/app/api/auth/otp/send/route');
    const res = await POST(makeOtpRequest());
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain('wamid');
    expect(body.pin_id).toBe('a'.repeat(64));
    expect(body.message).toBe('OTP sent via WhatsApp');
    expect(Object.keys(body)).toEqual(['message', 'pin_id']);
  });

  it('OTP and phone are never stored in delivery tables', async () => {
    setupMocks(true);
    const { POST } = await import('@/app/api/auth/otp/send/route');
    await POST(makeOtpRequest());
    const inserted = JSON.stringify(insertedRows);
    expect(inserted).not.toContain('654321');
    expect(inserted).not.toContain('2348012345678');
    expect(inserted).not.toContain('+234');
  });

  it('Supabase returned error does not cause resend', async () => {
    vi.restoreAllMocks();
    vi.resetModules();

    let sendCount = 0;
    const warnings: string[] = [];
    vi.doMock('@/lib/brute-force', () => ({ checkBruteForce: vi.fn().mockReturnValue({ blocked: false }) }));
    vi.doMock('@/lib/rate-limit', () => ({
      rateLimitResponseAsync: vi.fn().mockResolvedValue(null),
      getRateLimitKey: vi.fn().mockReturnValue('test'),
    }));
    vi.doMock('@/lib/otp-phone-token', () => ({
      generatePhoneOtp: vi.fn().mockResolvedValue({ code: '654321', challengeId: 'b'.repeat(64) }),
    }));
    vi.doMock('@/lib/logger', () => ({
      logger: {
        withContext: () => ({
          error: () => {},
          warn: (msg: string) => { warnings.push(msg); },
          info: () => {},
          debug: () => {},
        }),
        error: () => {},
        warn: () => {},
        info: () => {},
        debug: () => {},
      },
    }));
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn().mockReturnValue({
        from: vi.fn().mockImplementation((table: string) => {
          if (table === 'whatsapp_channels') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                      limit: vi.fn().mockReturnValue({
                        maybeSingle: vi.fn().mockResolvedValue({ data: null }),
                      }),
                    }),
                  }),
                }),
              }),
            };
          }
          if (table === 'otp_delivery_attempts') {
            return {
              insert: vi.fn().mockReturnValue({
                data: null,
                error: { code: '42501', message: 'permission denied for table otp_delivery_attempts' },
              }),
            };
          }
          return {};
        }),
        rpc: vi.fn().mockResolvedValue({ error: null }),
      }),
    }));
    vi.doMock('@/lib/channels/meta-cloud', () => ({
      MetaCloudService: class {
        async sendAuthenticationTemplate() {
          sendCount++;
          return { messageId: 'wamid.obs-fail' };
        }
      },
    }));

    const { POST } = await import('@/app/api/auth/otp/send/route');
    const res = await POST(makeOtpRequest());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe('OTP sent via WhatsApp');
    expect(sendCount).toBe(1);
    // Warning was emitted exactly once
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Failed to record delivery attempt');
    // Warning must not contain sensitive data
    const allWarnings = warnings.join(' ');
    expect(allWarnings).not.toContain('654321');
    expect(allWarnings).not.toContain('2348012345678');
    expect(allWarnings).not.toContain('wamid');
    expect(allWarnings).not.toContain('b'.repeat(64));
  });

  it('thrown exception does not cause resend', async () => {
    vi.restoreAllMocks();
    vi.resetModules();

    let sendCount = 0;
    vi.doMock('@/lib/brute-force', () => ({ checkBruteForce: vi.fn().mockReturnValue({ blocked: false }) }));
    vi.doMock('@/lib/rate-limit', () => ({
      rateLimitResponseAsync: vi.fn().mockResolvedValue(null),
      getRateLimitKey: vi.fn().mockReturnValue('test'),
    }));
    vi.doMock('@/lib/otp-phone-token', () => ({
      generatePhoneOtp: vi.fn().mockResolvedValue({ code: '654321', challengeId: 'c'.repeat(64) }),
    }));
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn().mockReturnValue({
        from: vi.fn().mockImplementation((table: string) => {
          if (table === 'whatsapp_channels') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                      limit: vi.fn().mockReturnValue({
                        maybeSingle: vi.fn().mockResolvedValue({ data: null }),
                      }),
                    }),
                  }),
                }),
              }),
            };
          }
          if (table === 'otp_delivery_attempts') {
            return {
              insert: vi.fn().mockImplementation(() => { throw new Error('Network failure'); }),
            };
          }
          return {};
        }),
        rpc: vi.fn().mockResolvedValue({ error: null }),
      }),
    }));
    vi.doMock('@/lib/channels/meta-cloud', () => ({
      MetaCloudService: class {
        async sendAuthenticationTemplate() {
          sendCount++;
          return { messageId: 'wamid.throw-fail' };
        }
      },
    }));

    const { POST } = await import('@/app/api/auth/otp/send/route');
    const res = await POST(makeOtpRequest());

    expect(res.status).toBe(200);
    expect(sendCount).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. OTP and phone never logged
// ═══════════════════════════════════════════════════════════

describe('No sensitive data in logs', () => {
  it('route does not log OTP, phone, or message ID', () => {
    const code = readFileSync('app/api/auth/otp/send/route.ts', 'utf-8');
    // No logger call passes the OTP code variable directly
    // The only 'code' references in logger calls must be errorCode (safe operational context)
    const loggerLines = code.split('\n').filter(l => /logger\.\w+/.test(l));
    for (const line of loggerLines) {
      // If line contains 'code', it must be 'errorCode' or 'safeLogErrorContext', not bare 'code'
      if (/\bcode\b/.test(line)) {
        expect(line.includes('errorCode') || line.includes('safeLogErrorContext')).toBe(true);
      }
    }
    // No logger call contains the phone variable
    expect(code).not.toMatch(/logger\.\w+\([^)]*\bphone\b/);
    // No logger call contains waMessageId
    expect(code).not.toMatch(/logger\.\w+\([^)]*waMessageId/);
    // sendAuthenticationTemplate is used, not sendText
    expect(code).not.toContain('.sendText(');
    expect(code).toContain('sendAuthenticationTemplate');
  });

  it('webhook does not log phone, OTP, or message ID for OTP statuses', () => {
    const code = readFileSync('app/api/webhook/meta-cloud/route.ts', 'utf-8');
    // Extract only the OTP delivery status tracking block
    const start = code.indexOf('// OTP delivery status tracking');
    const end = code.indexOf('}\n          }\n        }\n\n        if (messages.length');
    const otpBlock = code.slice(start, end);
    expect(otpBlock.length).toBeGreaterThan(50);
    // OTP block should not log sensitive values (wamid, phone, otp, tokens)
    // Operational logs for insert/lookup failures are allowed (they log only op context + errorCode)
    expect(otpBlock).not.toMatch(/log\.\w+Context\(\{[^}]*wamid/);
    expect(otpBlock).not.toMatch(/log\.\w+Context\(\{[^}]*phone/);
    expect(otpBlock).not.toMatch(/log\.\w+Context\(\{[^}]*challengeId/);
    expect(otpBlock).not.toMatch(/console\.\w+\(/);
  });
});

// ═══════════════════════════════════════════════════════════
// 3. Executable webhook handler tests
// ═══════════════════════════════════════════════════════════

describe('OTP webhook handler — executable tests', () => {
  // Shared state captured by mocks
  let insertedEvents: Array<Record<string, unknown>>;
  let warnings: Array<{ ctx: Record<string, unknown>; msg: string }>;
  let contractUpdateCalls: Array<Record<string, unknown>>;
  let insertBehavior: (row: Record<string, unknown>) => { error: unknown };
  let attemptLookupResult: { data: unknown; error: unknown };
  let contractLookupData: { id: string; wa_delivery_status: string | null } | null;

  // Shared helpers
  function buildWebhookBody(
    wamid: string, status: string, timestamp = '1753383000',
    errors?: Array<{ code: number; title: string }>,
  ) {
    return {
      object: 'whatsapp_business_account',
      entry: [{
        id: 'waba-id',
        changes: [{
          value: {
            messaging_product: 'whatsapp',
            metadata: { phone_number_id: 'test-pnid', display_phone_number: '12029226251' },
            statuses: [{
              id: wamid, status, timestamp,
              ...(errors ? { errors } : {}),
            }],
          },
          field: 'messages',
        }],
      }],
    };
  }

  function makeWebhookRequest(body: unknown) {
    return new NextRequest('https://www.waaiio.com/api/webhook/meta-cloud', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': 'sha256=test' },
      body: JSON.stringify(body),
    });
  }

  function makeChainableLogObj(): Record<string, unknown> {
    const obj: Record<string, unknown> = {
      error: () => {},
      warn: (msg: string) => { warnings.push({ ctx: {}, msg }); },
      info: () => {},
      debug: () => {},
      withContext: (ctx: Record<string, unknown>) => {
        const child: Record<string, unknown> = {
          error: () => {},
          warn: (msg: string) => { warnings.push({ ctx, msg }); },
          info: () => {},
          debug: () => {},
          withContext: (ctx2: Record<string, unknown>) => {
            const grandchild: Record<string, unknown> = {
              error: () => {},
              warn: (msg: string) => { warnings.push({ ctx: { ...ctx, ...ctx2 }, msg }); },
              info: () => {},
              debug: () => {},
              withContext: () => grandchild,
            };
            return grandchild;
          },
        };
        return child;
      },
    };
    return obj;
  }

  function setupMocks() {
    // All mutable test state is referenced by variable, not captured by closure,
    // so a single doMock registration works for all tests — avoiding vi.doMock
    // re-registration nondeterminism when resetModules() doesn't fully clear
    // prior doMock entries.

    vi.doMock('crypto', async () => {
      const actual = await vi.importActual<typeof import('crypto')>('crypto');
      return { ...actual, createHmac: () => ({ update: () => ({ digest: () => 'test' }) }), timingSafeEqual: () => true };
    });

    vi.doMock('@/lib/logger', () => ({
      logger: makeChainableLogObj(),
      generateRequestId: () => 'test-req-id',
    }));

    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: () => ({
        from: (table: string) => {
          if (table === 'contracts') {
            return {
              select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: contractLookupData }) }) }),
              update: (data: Record<string, unknown>) => {
                contractUpdateCalls.push(data);
                return { eq: () => ({ in: () => Promise.resolve({ error: null }) }) };
              },
            };
          }
          if (table === 'contract_signers') {
            return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }) }) };
          }
          if (table === 'otp_delivery_attempts') {
            return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(attemptLookupResult) }) }) };
          }
          if (table === 'otp_delivery_status_events') {
            return { insert: (row: Record<string, unknown>) => insertBehavior(row) };
          }
          return {};
        },
      }),
    }));
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    insertedEvents = [];
    warnings = [];
    contractUpdateCalls = [];
    contractLookupData = null;
    insertBehavior = (row) => { insertedEvents.push(row); return { error: null }; };
    attemptLookupResult = { data: { id: 'attempt-uuid-1' }, error: null };
    process.env.META_CLOUD_WABA_ID = 'test-waba';
    process.env.META_APP_SECRET = 'test-secret';
    setupMocks();
  });

  afterEach(() => {
    delete process.env.META_CLOUD_WABA_ID;
    delete process.env.META_APP_SECRET;
  });

  // A. Duplicate 23505 test
  it('duplicate 23505: first insert succeeds, second is silently ignored', async () => {
    let callCount = 0;
    insertBehavior = (row) => {
      callCount++;
      if (callCount === 1) { insertedEvents.push(row); return { error: null }; }
      return { error: { code: '23505', message: 'duplicate key value' } };
    };

    const { POST } = await import('@/app/api/webhook/meta-cloud/route');
    const res1 = await POST(makeWebhookRequest(buildWebhookBody('wamid.dup', 'delivered')));
    const res2 = await POST(makeWebhookRequest(buildWebhookBody('wamid.dup', 'delivered')));

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(insertedEvents).toHaveLength(1);
    expect(insertedEvents[0].status).toBe('delivered');
    // No warning for 23505
    const statusWarnings = warnings.filter(w => w.msg?.includes('Delivery status insert failed'));
    expect(statusWarnings).toHaveLength(0);
    // No identifiers in any warning
    const allWarnText = JSON.stringify(warnings);
    expect(allWarnText).not.toContain('wamid');
    expect(allWarnText).not.toContain('phone');
  });

  // B. Non-23505 insert error test
  it('non-23505 error: webhook succeeds, emits one sanitized warning', async () => {
    insertBehavior = () => ({ error: { code: '42P01', message: 'relation "otp_delivery_status_events" does not exist' } });

    const { POST } = await import('@/app/api/webhook/meta-cloud/route');
    const res = await POST(makeWebhookRequest(buildWebhookBody('wamid.err', 'sent')));

    expect(res.status).toBe(200);
    const statusWarnings = warnings.filter(w => w.msg?.includes('Delivery status insert failed'));
    expect(statusWarnings).toHaveLength(1);
    // Context contains only safe operational data
    expect(statusWarnings[0].ctx.op).toBe('delivery-status.insert');
    expect(statusWarnings[0].ctx.errorCode).toBe('42P01');
    // No identifiers in context or message
    const warnStr = JSON.stringify(statusWarnings[0]);
    expect(warnStr).not.toContain('wamid');
    expect(warnStr).not.toContain('phone');
    expect(warnStr).not.toContain('otp');
    expect(warnStr).not.toContain('challenge');
    expect(warnStr).not.toContain('relation');
  });

  // C. Invalid timestamp tests
  it('non-numeric timestamp: handler succeeds, uses received time', async () => {
    vi.useFakeTimers({ now: new Date('2026-07-24T20:00:00Z') });

    const { POST } = await import('@/app/api/webhook/meta-cloud/route');
    const res = await POST(makeWebhookRequest(buildWebhookBody('wamid.ts1', 'sent', 'not-a-number')));

    expect(res.status).toBe(200);
    expect(insertedEvents).toHaveLength(1);
    expect(insertedEvents[0].event_timestamp).toBe('2026-07-24T20:00:00.000Z');
    const tsWarnings = warnings.filter(w => w.msg?.includes('Invalid status timestamp'));
    expect(tsWarnings).toHaveLength(1);
    expect(tsWarnings[0].ctx.op).toBe('delivery-status.timestamp');
    expect(JSON.stringify(tsWarnings[0])).not.toContain('wamid');

    vi.useRealTimers();
  });

  it('out-of-range timestamp: handler succeeds, uses received time', async () => {
    vi.useFakeTimers({ now: new Date('2026-07-24T20:00:00Z') });

    const { POST } = await import('@/app/api/webhook/meta-cloud/route');
    const res = await POST(makeWebhookRequest(buildWebhookBody('wamid.ts2', 'delivered', '999999999999999999999')));

    expect(res.status).toBe(200);
    expect(insertedEvents).toHaveLength(1);
    expect(insertedEvents[0].event_timestamp).toBe('2026-07-24T20:00:00.000Z');
    const tsWarnings = warnings.filter(w => w.msg?.includes('Invalid status timestamp'));
    expect(tsWarnings).toHaveLength(1);

    vi.useRealTimers();
  });

  // D. Attempt lookup error test
  it('attempt lookup error: webhook succeeds, no status insert, one sanitized warning', async () => {
    attemptLookupResult = { data: null, error: { code: '42P01', message: 'relation does not exist' } };

    const { POST } = await import('@/app/api/webhook/meta-cloud/route');
    const res = await POST(makeWebhookRequest(buildWebhookBody('wamid.lookup-err', 'sent')));

    expect(res.status).toBe(200);
    expect(insertedEvents).toHaveLength(0);
    const lookupWarnings = warnings.filter(w => w.msg?.includes('Delivery attempt lookup failed'));
    expect(lookupWarnings).toHaveLength(1);
    expect(lookupWarnings[0].ctx.op).toBe('delivery-status.lookup');
    expect(lookupWarnings[0].ctx.errorCode).toBe('42P01');
    const warnStr = JSON.stringify(lookupWarnings[0]);
    expect(warnStr).not.toContain('wamid');
    expect(warnStr).not.toContain('relation does not exist');
  });

  // E. Unknown message ID test
  it('unknown message ID: webhook succeeds, no OTP insert, no warning', async () => {
    attemptLookupResult = { data: null, error: null };

    const { POST } = await import('@/app/api/webhook/meta-cloud/route');
    const res = await POST(makeWebhookRequest(buildWebhookBody('wamid.unknown', 'delivered')));

    expect(res.status).toBe(200);
    expect(insertedEvents).toHaveLength(0);
    const otpWarnings = warnings.filter(w =>
      w.msg?.includes('Delivery status insert') || w.msg?.includes('Delivery attempt lookup'),
    );
    expect(otpWarnings).toHaveLength(0);
  });

  // F. Out-of-order test
  it('out-of-order: delivered then sent both recorded independently', async () => {
    const { POST } = await import('@/app/api/webhook/meta-cloud/route');
    await POST(makeWebhookRequest(buildWebhookBody('wamid.ooo', 'delivered')));
    await POST(makeWebhookRequest(buildWebhookBody('wamid.ooo', 'sent')));

    expect(insertedEvents).toHaveLength(2);
    const statuses = insertedEvents.map(e => e.status);
    expect(statuses).toContain('delivered');
    expect(statuses).toContain('sent');
  });

  // G. Contract regression test
  it('contract match: contract update executes, OTP tracking also runs', async () => {
    // Set contract lookup to return a match — uses shared mutable variable
    // referenced by the mock (no doMock re-registration needed)
    contractLookupData = { id: 'contract-1', wa_delivery_status: null };
    attemptLookupResult = { data: { id: 'attempt-uuid-contract' }, error: null };

    const { POST } = await import('@/app/api/webhook/meta-cloud/route');
    const res = await POST(makeWebhookRequest(buildWebhookBody('wamid.both', 'delivered')));

    expect(res.status).toBe(200);
    // Contract was updated
    expect(contractUpdateCalls).toHaveLength(1);
    expect(contractUpdateCalls[0].wa_delivery_status).toBe('delivered');
    // OTP status also recorded
    expect(insertedEvents).toHaveLength(1);
    expect(insertedEvents[0].status).toBe('delivered');
  });

  // Original status persistence tests (kept executable)
  for (const statusValue of ['sent', 'delivered', 'read'] as const) {
    it(`persists "${statusValue}" webhook status`, async () => {
      const { POST } = await import('@/app/api/webhook/meta-cloud/route');
      await POST(makeWebhookRequest(buildWebhookBody('wamid.otp123', statusValue)));

      expect(insertedEvents).toHaveLength(1);
      expect(insertedEvents[0].attempt_id).toBe('attempt-uuid-1');
      expect(insertedEvents[0].status).toBe(statusValue);
      expect(insertedEvents[0].error_code).toBeUndefined();
    });
  }

  it('persists "failed" status with sanitized error info', async () => {
    const { POST } = await import('@/app/api/webhook/meta-cloud/route');
    const body = buildWebhookBody('wamid.otp456', 'failed', '1753383000', [{ code: 131026, title: 'Message Undeliverable' }]);
    await POST(makeWebhookRequest(body));

    expect(insertedEvents).toHaveLength(1);
    expect(insertedEvents[0].status).toBe('failed');
    expect(insertedEvents[0].error_code).toBe('131026');
    expect(insertedEvents[0].error_title).toBe('Message Undeliverable');
    expect(insertedEvents[0].error_category).toBe('message_undeliverable');
    const serialized = JSON.stringify(insertedEvents);
    expect(serialized).not.toMatch(/\+?\d{10,}/);
  });
});

// ═══════════════════════════════════════════════════════════
// 4. Static safety checks
// ═══════════════════════════════════════════════════════════

describe('Static safety — migration and schema', () => {
  it('Migration 246 privileges remain unchanged', () => {
    const migration = readFileSync('supabase/migrations/246_phone_otp_challenges.sql', 'utf-8');
    // service_role: SELECT + INSERT only
    expect(migration).toContain('GRANT SELECT, INSERT ON TABLE public.phone_otp_challenges TO service_role');
    // No UPDATE or DELETE grants
    expect(migration).not.toMatch(/GRANT\s+(UPDATE|DELETE)\s+ON\s+TABLE\s+public\.phone_otp_challenges/);
    // Revoke from public, anon, authenticated
    expect(migration).toContain('REVOKE ALL ON TABLE public.phone_otp_challenges FROM PUBLIC, anon, authenticated');
    // RLS enabled
    expect(migration).toContain('ALTER TABLE public.phone_otp_challenges ENABLE ROW LEVEL SECURITY');
  });

  it('Migration 248 does not modify phone_otp_challenges', () => {
    const migration = readFileSync('supabase/migrations/248_otp_delivery_tracking.sql', 'utf-8');
    expect(migration).not.toContain('ALTER TABLE public.phone_otp_challenges');
    expect(migration).not.toMatch(/GRANT.*ON.*phone_otp_challenges/);
  });

  it('OTP delivery tables have RLS and restricted privileges', () => {
    const migration = readFileSync('supabase/migrations/248_otp_delivery_tracking.sql', 'utf-8');
    // RLS enabled on both tables
    expect(migration).toContain('ALTER TABLE public.otp_delivery_attempts ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('ALTER TABLE public.otp_delivery_status_events ENABLE ROW LEVEL SECURITY');
    // No anon or authenticated privileges
    expect(migration).toContain('REVOKE ALL ON TABLE public.otp_delivery_attempts FROM PUBLIC, anon, authenticated');
    expect(migration).toContain('REVOKE ALL ON TABLE public.otp_delivery_status_events FROM PUBLIC, anon, authenticated');
    // service_role: SELECT + INSERT only (append-only)
    expect(migration).toContain('GRANT SELECT, INSERT ON TABLE public.otp_delivery_attempts TO service_role');
    expect(migration).toContain('GRANT SELECT, INSERT ON TABLE public.otp_delivery_status_events TO service_role');
    // No UPDATE or DELETE
    expect(migration).not.toMatch(/GRANT\s+(UPDATE|DELETE)\s+ON\s+TABLE\s+public\.otp_delivery_(attempts|status_events)/);
  });

  it('delivery tables do not store plaintext phone or OTP columns', () => {
    const migration = readFileSync('supabase/migrations/248_otp_delivery_tracking.sql', 'utf-8');
    expect(migration).not.toMatch(/\bphone\b.*text/i);
    expect(migration).not.toMatch(/\botp\b.*text/i);
    expect(migration).not.toMatch(/\bcode\b.*text/i);
    // Should have challenge_id and wa_message_id but not phone/otp columns
    expect(migration).toContain('challenge_id');
    expect(migration).toContain('wa_message_id');
  });

  it('route source does not contain Meta Graph API URL literals', () => {
    const code = readFileSync('app/api/auth/otp/send/route.ts', 'utf-8');
    expect(code).not.toContain('graph.facebook.com');
    expect(code).not.toContain('fetch(');
  });

  it('service_role revoke occurs before grant for both tables', () => {
    const migration = readFileSync('supabase/migrations/248_otp_delivery_tracking.sql', 'utf-8');
    for (const table of ['otp_delivery_attempts', 'otp_delivery_status_events']) {
      const revokeIdx = migration.indexOf(`REVOKE ALL ON TABLE public.${table} FROM service_role`);
      const grantIdx = migration.indexOf(`GRANT SELECT, INSERT ON TABLE public.${table} TO service_role`);
      expect(revokeIdx).toBeGreaterThan(-1);
      expect(grantIdx).toBeGreaterThan(-1);
      expect(revokeIdx).toBeLessThan(grantIdx);
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 5. Diagnostic helper
// ═══════════════════════════════════════════════════════════

describe('OTP delivery diagnostics', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('attempt lookup error throws OtpDiagnosticError', async () => {
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({
                data: null,
                error: { code: '42P01', message: 'relation does not exist' },
              }),
            }),
          }),
        }),
      }),
    }));

    const { getOtpDeliveryStatus, OtpDiagnosticError } = await import('@/lib/otp-delivery-diagnostics');
    await expect(getOtpDeliveryStatus('test')).rejects.toThrow(OtpDiagnosticError);
    await expect(getOtpDeliveryStatus('test')).rejects.toThrow('attempt-lookup');
  });

  it('status history lookup error throws OtpDiagnosticError', async () => {
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: () => ({
        from: (table: string) => {
          if (table === 'otp_delivery_attempts') {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: () => Promise.resolve({
                    data: { id: 'a-1', challenge_id: 'ch', delivery_path: 'env_fallback', accepted_at: '2026-01-01' },
                    error: null,
                  }),
                }),
              }),
            };
          }
          if (table === 'otp_delivery_status_events') {
            return {
              select: () => ({
                eq: () => ({
                  order: () => Promise.resolve({
                    data: null,
                    error: { code: '42501', message: 'permission denied' },
                  }),
                }),
              }),
            };
          }
          return {};
        },
      }),
    }));

    const { getOtpDeliveryStatus, OtpDiagnosticError } = await import('@/lib/otp-delivery-diagnostics');
    await expect(getOtpDeliveryStatus('ch')).rejects.toThrow(OtpDiagnosticError);
    await expect(getOtpDeliveryStatus('ch')).rejects.toThrow('status-history-lookup');
  });

  it('legitimate no-attempt returns null', async () => {
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: null, error: null }),
            }),
          }),
        }),
      }),
    }));

    const { getOtpDeliveryStatus } = await import('@/lib/otp-delivery-diagnostics');
    const result = await getOtpDeliveryStatus('nonexistent-challenge');
    expect(result).toBeNull();
  });

  it('successful attempt with no webhook events returns empty history', async () => {
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: () => ({
        from: (table: string) => {
          if (table === 'otp_delivery_attempts') {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: () => Promise.resolve({
                    data: { id: 'a-1', challenge_id: 'ch-1', delivery_path: 'database_channel', accepted_at: '2026-01-01T00:00:00Z' },
                    error: null,
                  }),
                }),
              }),
            };
          }
          if (table === 'otp_delivery_status_events') {
            return {
              select: () => ({
                eq: () => ({
                  order: () => Promise.resolve({ data: [], error: null }),
                }),
              }),
            };
          }
          return {};
        },
      }),
    }));

    const { getOtpDeliveryStatus } = await import('@/lib/otp-delivery-diagnostics');
    const result = await getOtpDeliveryStatus('ch-1');
    expect(result).not.toBeNull();
    expect(result!.challengeId).toBe('ch-1');
    expect(result!.deliveryPath).toBe('database_channel');
    expect(result!.latestStatus).toBeNull();
    expect(result!.statusHistory).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 6. Webhook input hardening
// ═══════════════════════════════════════════════════════════

describe('Webhook input hardening', () => {
  function buildWebhookBody(wamid: string, status: string, timestamp: string) {
    return {
      object: 'whatsapp_business_account',
      entry: [{
        id: 'waba-id',
        changes: [{
          value: {
            messaging_product: 'whatsapp',
            metadata: { phone_number_id: 'test-pnid', display_phone_number: '12029226251' },
            statuses: [{ id: wamid, status, timestamp }],
          },
          field: 'messages',
        }],
      }],
    };
  }

  function makeWebhookRequest(body: unknown) {
    return new NextRequest('https://www.waaiio.com/api/webhook/meta-cloud', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': 'sha256=test' },
      body: JSON.stringify(body),
    });
  }

  it('invalid timestamp does not throw, uses received time', () => {
    // Verify structurally that the code handles invalid timestamps
    const code = readFileSync('app/api/webhook/meta-cloud/route.ts', 'utf-8');
    const otpBlock = code.slice(code.indexOf('// OTP delivery status tracking'));
    expect(otpBlock).toContain('Number.isFinite(tsNum)');
    expect(otpBlock).toContain('new Date().toISOString()');
    expect(otpBlock).toContain('Invalid status timestamp');
  });

  it('attempt lookup error emits sanitized warning, does not crash webhook', () => {
    const code = readFileSync('app/api/webhook/meta-cloud/route.ts', 'utf-8');
    const otpBlock = code.slice(code.indexOf('// OTP delivery status tracking'));
    // Attempt lookup error is explicitly handled
    expect(otpBlock).toContain('attemptLookupErr');
    expect(otpBlock).toContain('Delivery attempt lookup failed');
    // Error code logged but not raw message
    expect(otpBlock).toContain('errorCode: attemptLookupErr.code');
    // Lookup failure does not throw — uses else-if chain
    expect(otpBlock).toContain('} else if (otpAttempt)');
  });

  it('status insert error includes errorCode in log context', () => {
    const code = readFileSync('app/api/webhook/meta-cloud/route.ts', 'utf-8');
    const otpBlock = code.slice(code.indexOf('// OTP delivery status tracking'));
    expect(otpBlock).toContain('errorCode: statusErr.code');
  });
});

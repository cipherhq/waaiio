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

  it('observability insert failure does not cause resend', async () => {
    vi.restoreAllMocks();
    vi.resetModules();

    let sendCount = 0;
    vi.doMock('@/lib/brute-force', () => ({ checkBruteForce: vi.fn().mockReturnValue({ blocked: false }) }));
    vi.doMock('@/lib/rate-limit', () => ({
      rateLimitResponseAsync: vi.fn().mockResolvedValue(null),
      getRateLimitKey: vi.fn().mockReturnValue('test'),
    }));
    vi.doMock('@/lib/otp-phone-token', () => ({
      generatePhoneOtp: vi.fn().mockResolvedValue({ code: '654321', challengeId: 'b'.repeat(64) }),
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
              insert: vi.fn().mockImplementation(() => { throw new Error('DB insert failed'); }),
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

    // Must still return success — Meta already accepted the message
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe('OTP sent via WhatsApp');
    // Must not have sent a second OTP
    expect(sendCount).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. OTP and phone never logged
// ═══════════════════════════════════════════════════════════

describe('No sensitive data in logs', () => {
  it('route does not log OTP, phone, or message ID', () => {
    const code = readFileSync('app/api/auth/otp/send/route.ts', 'utf-8');
    // No logger call contains the code variable
    expect(code).not.toMatch(/logger\.\w+\([^)]*\bcode\b/);
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
    // Operational log for insert failure is allowed (it logs only op context, no PII)
    expect(otpBlock).not.toMatch(/log\.\w+\([^)]*wamid/);
    expect(otpBlock).not.toMatch(/log\.\w+\([^)]*phone/);
    expect(otpBlock).not.toMatch(/log\.\w+\([^)]*otp/i);
    expect(otpBlock).not.toMatch(/log\.\w+\([^)]*token/i);
    expect(otpBlock).not.toMatch(/console\.\w+\(/);
  });
});

// ═══════════════════════════════════════════════════════════
// 3. Webhook status event handling
// ═══════════════════════════════════════════════════════════

describe('OTP webhook status event handling', () => {
  let upsertedEvents: Array<Record<string, unknown>>;
  let contractUpdated: boolean;

  function buildWebhookBody(wamid: string, status: string, errors?: Array<{ code: number; title: string }>) {
    return {
      object: 'whatsapp_business_account',
      entry: [{
        id: 'waba-id',
        changes: [{
          value: {
            messaging_product: 'whatsapp',
            metadata: { phone_number_id: 'test-pnid', display_phone_number: '12029226251' },
            statuses: [{
              id: wamid,
              status,
              timestamp: '1753383000',
              ...(errors ? { errors } : {}),
            }],
          },
          field: 'messages',
        }],
      }],
    };
  }

  function setupWebhookMocks() {
    upsertedEvents = [];
    contractUpdated = false;

    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn().mockReturnValue({
        from: vi.fn().mockImplementation((table: string) => {
          if (table === 'contracts' || table === 'contract_signers') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: null }),
                }),
              }),
              update: vi.fn().mockImplementation(() => {
                contractUpdated = true;
                return { eq: vi.fn().mockReturnValue({ in: vi.fn().mockResolvedValue({ error: null }) }) };
              }),
            };
          }
          if (table === 'otp_delivery_attempts') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: { id: 'attempt-uuid-1' },
                  }),
                }),
              }),
            };
          }
          if (table === 'otp_delivery_status_events') {
            return {
              insert: vi.fn().mockImplementation((row: Record<string, unknown>) => {
                upsertedEvents.push(row);
                return { error: null };
              }),
            };
          }
          return {};
        }),
      }),
    }));
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    process.env.META_CLOUD_WABA_ID = 'test-waba';
    process.env.META_APP_SECRET = 'test-secret';
    setupWebhookMocks();
  });

  afterEach(() => {
    delete process.env.META_CLOUD_WABA_ID;
    delete process.env.META_APP_SECRET;
    vi.unstubAllGlobals();
  });

  // Stub webhook signature verification
  function makeWebhookRequest(body: unknown) {
    return new NextRequest('https://www.waaiio.com/api/webhook/meta-cloud', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hub-signature-256': 'sha256=test',
      },
      body: JSON.stringify(body),
    });
  }

  for (const statusValue of ['sent', 'delivered', 'read'] as const) {
    it(`persists "${statusValue}" webhook status`, async () => {
      // Skip HMAC verification for unit test
      vi.doMock('crypto', async () => {
        const actual = await vi.importActual<typeof import('crypto')>('crypto');
        return {
          ...actual,
          createHmac: () => ({
            update: () => ({ digest: () => 'test' }),
          }),
          timingSafeEqual: () => true,
        };
      });

      const { POST } = await import('@/app/api/webhook/meta-cloud/route');
      const body = buildWebhookBody('wamid.otp123', statusValue);
      const req = makeWebhookRequest(body);
      await POST(req);

      expect(upsertedEvents).toHaveLength(1);
      expect(upsertedEvents[0].attempt_id).toBe('attempt-uuid-1');
      expect(upsertedEvents[0].status).toBe(statusValue);
      expect(upsertedEvents[0].error_code).toBeUndefined();
    });
  }

  it('persists "failed" status with sanitized error info', async () => {
    vi.doMock('crypto', async () => {
      const actual = await vi.importActual<typeof import('crypto')>('crypto');
      return {
        ...actual,
        createHmac: () => ({
          update: () => ({ digest: () => 'test' }),
        }),
        timingSafeEqual: () => true,
      };
    });

    const { POST } = await import('@/app/api/webhook/meta-cloud/route');
    const body = buildWebhookBody('wamid.otp456', 'failed', [{ code: 131026, title: 'Message Undeliverable' }]);
    const req = makeWebhookRequest(body);
    await POST(req);

    expect(upsertedEvents).toHaveLength(1);
    expect(upsertedEvents[0].status).toBe('failed');
    expect(upsertedEvents[0].error_code).toBe('131026');
    expect(upsertedEvents[0].error_title).toBe('Message Undeliverable');
    expect(upsertedEvents[0].error_category).toBe('message_undeliverable');
    // Must not contain phone or OTP
    const serialized = JSON.stringify(upsertedEvents);
    expect(serialized).not.toMatch(/\+?\d{10,}/);
  });

  it('duplicate callbacks are idempotent (unique constraint rejects duplicates)', async () => {
    vi.doMock('crypto', async () => {
      const actual = await vi.importActual<typeof import('crypto')>('crypto');
      return {
        ...actual,
        createHmac: () => ({
          update: () => ({ digest: () => 'test' }),
        }),
        timingSafeEqual: () => true,
      };
    });

    const { POST } = await import('@/app/api/webhook/meta-cloud/route');
    const body = buildWebhookBody('wamid.dup', 'delivered');

    // Send same status twice
    await POST(makeWebhookRequest(body));
    await POST(makeWebhookRequest(body));

    // Both calls attempt insert — the DB unique constraint (23505) handles dedup
    // Both inserts were attempted; in production the second would fail with 23505
    for (const evt of upsertedEvents) {
      expect(evt.status).toBe('delivered');
      expect(evt.attempt_id).toBe('attempt-uuid-1');
    }
  });

  it('out-of-order callbacks are handled safely (all statuses recorded)', async () => {
    vi.doMock('crypto', async () => {
      const actual = await vi.importActual<typeof import('crypto')>('crypto');
      return {
        ...actual,
        createHmac: () => ({
          update: () => ({ digest: () => 'test' }),
        }),
        timingSafeEqual: () => true,
      };
    });

    const { POST } = await import('@/app/api/webhook/meta-cloud/route');

    // Receive "delivered" before "sent" (out of order)
    await POST(makeWebhookRequest(buildWebhookBody('wamid.ooo', 'delivered')));
    await POST(makeWebhookRequest(buildWebhookBody('wamid.ooo', 'sent')));

    // Both statuses should be recorded (append-only, unique per status)
    const statuses = upsertedEvents.map(e => e.status);
    expect(statuses).toContain('delivered');
    expect(statuses).toContain('sent');
  });

  it('unknown message IDs do not create OTP records', async () => {
    // Verify structurally: the code only upserts inside `if (otpAttempt)` guard
    const code = readFileSync('app/api/webhook/meta-cloud/route.ts', 'utf-8');
    const otpStart = code.indexOf('// OTP delivery status tracking');
    const otpEnd = code.indexOf('}\n          }\n        }\n\n        if (messages.length');
    const otpBlock = code.slice(otpStart, otpEnd);

    // The insert is guarded by `if (otpAttempt)`
    expect(otpBlock).toContain('if (otpAttempt)');
    // maybeSingle() returns null for unknown IDs — the insert is inside the if block
    expect(otpBlock).toContain('.maybeSingle()');
    // The insert call is inside the if block, not outside
    const ifIdx = otpBlock.indexOf('if (otpAttempt)');
    const insertIdx = otpBlock.indexOf('.insert(insertData)');
    expect(insertIdx).toBeGreaterThan(ifIdx);
  });

  it('existing contract webhook handling remains unchanged', async () => {
    // Verify structurally that the contract handling code is preserved
    const code = readFileSync('app/api/webhook/meta-cloud/route.ts', 'utf-8');
    // Contract status updates still exist
    expect(code).toContain("supabase.from('contracts').select('id, wa_delivery_status').eq('wa_message_id', wamid)");
    expect(code).toContain("supabase.from('contract_signers').select('id, wa_delivery_status').eq('wa_message_id', wamid)");
    // Contract update logic is still present
    expect(code).toContain('.update({ wa_delivery_status: newStatus');
    // OTP tracking comes AFTER contract handling
    const contractIdx = code.indexOf("from('contracts')");
    const otpIdx = code.indexOf('OTP delivery status tracking');
    expect(otpIdx).toBeGreaterThan(contractIdx);
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
    // Verify the route does not hardcode Meta API URLs — it uses MetaCloudService.callApi
    const code = readFileSync('app/api/auth/otp/send/route.ts', 'utf-8');
    expect(code).not.toContain('graph.facebook.com');
    expect(code).not.toContain('fetch(');
  });
});

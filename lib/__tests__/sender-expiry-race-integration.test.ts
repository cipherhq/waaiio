/**
 * Production-shaped sender expiry-race integration test (#261)
 *
 * Invokes the REAL MetaCloudSender.sendText() with real withRetry,
 * real withAttemptAndGuard, real markSending (financiallyReserved=true),
 * and real GateBlockError classification — against real PostgreSQL.
 *
 * Infrastructure boundaries mocked at the Supabase client level (PostgREST
 * not available in CI), routed to psql for DB operations.
 * Provider method is spied to prove zero invocations.
 *
 *   TEST_DATABASE_URL=postgresql://localhost:5432/waaiio_test \
 *     npx vitest run lib/__tests__/sender-expiry-race-integration.test.ts
 */

import { execSync } from 'child_process';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const dbUrl = process.env.TEST_DATABASE_URL || '';
const canRun = dbUrl.length > 0;

function psql(sql: string): string {
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql, encoding: 'utf-8', timeout: 30000,
  }).trim();
}

function psqlMayFail(sql: string): string {
  try {
    return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
      input: sql, encoding: 'utf-8', timeout: 30000,
    }).trim();
  } catch (e: unknown) {
    return (e as { stderr?: string }).stderr || String(e);
  }
}

const OWNER_ID = '00000000-0000-0000-0000-000000000e44';
const UNIQUE_PHONE = '+2349099999944';

/**
 * Supabase client mock that routes to psql.
 * Handles the exact call patterns used by attempt-recording.ts and message-sender.ts.
 */
function makePsqlClient() {
  return {
    from: (table: string) => {
      let pendingInsert: Record<string, unknown> | null = null;
      let pendingUpdate: Record<string, unknown> | null = null;

      function sqlVal(v: unknown): string {
        if (v === null || v === undefined) return 'NULL';
        if (typeof v === 'boolean') return v ? 'true' : 'false';
        if (typeof v === 'number') return String(v);
        return `'${String(v).replace(/'/g, "''")}'`;
      }

      const builder: Record<string, unknown> = {
        insert(row: Record<string, unknown>) { pendingInsert = row; return builder; },
        update(vals: Record<string, unknown>) { pendingUpdate = vals; return builder; },
        select() { return builder; },
        eq(col: string, val: unknown) {
          if (pendingUpdate) {
            const set = Object.entries(pendingUpdate).map(([k, v]) => `${k} = ${sqlVal(v)}`).join(', ');
            const res = psqlMayFail(`UPDATE ${table} SET ${set} WHERE ${col} = ${sqlVal(val)};`);
            const hasErr = res.toLowerCase().includes('error');
            pendingUpdate = null;
            // Return a thenable so `await supabase.from().update().eq()` works
            const result = { data: null, error: hasErr ? { message: res, code: 'DB_ERROR' } : null };
            return { then: (fn: (v: typeof result) => void) => fn(result), ...result };
          }
          return builder;
        },
        async single() {
          if (pendingInsert) {
            const cols = Object.keys(pendingInsert);
            const vals = cols.map(k => sqlVal(pendingInsert![k]));
            const res = psqlMayFail(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${vals.join(',')}) RETURNING id;`);
            pendingInsert = null;
            if (res.toLowerCase().includes('error')) {
              return { data: null, error: { message: res } };
            }
            return { data: { id: res.trim().split('\n').pop() }, error: null };
          }
          return { data: null, error: null };
        },
      };
      return builder;
    },
    rpc: async (name: string, params: Record<string, unknown>) => {
      const args = Object.entries(params).map(([k, v]) => `${k} => '${String(v)}'`).join(', ');
      const res = psqlMayFail(`SELECT ${name}(${args});`);
      if (res.toLowerCase().includes('error')) {
        return { data: null, error: { message: res } };
      }
      try { return { data: JSON.parse(res), error: null }; }
      catch { return { data: res, error: null }; }
    },
  };
}

// Mock infrastructure boundaries before production imports
vi.mock('@/lib/channels/send-guard', () => ({
  assertMessagingAllowed: vi.fn().mockResolvedValue(undefined),
  isMessagingAllowed: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: vi.fn(() => makePsqlClient()),
}));

describe.skipIf(!canRun)('Sender expiry-race integration (#261 production-shaped proof)', () => {
  let bizId: string;

  beforeAll(() => {
    psqlMayFail(`INSERT INTO auth.users (id, email, raw_app_meta_data) VALUES ('${OWNER_ID}', 'sender-e44@test.com', '{}') ON CONFLICT (id) DO NOTHING;`);
    bizId = psql('SELECT gen_random_uuid();');
    psqlMayFail(`INSERT INTO businesses (id, name, slug, owner_id, address, city, neighborhood, phone, messaging_suspended) VALUES ('${bizId}', 'SenderTest44', 'slug-e44-${Date.now()}', '${OWNER_ID}', '1 Test', 'T', 'T', '+1', false);`);

    psql(`INSERT INTO messaging_allowances (business_id, type, amount_minor, currency_code, remaining_minor, source_ref) VALUES ('${bizId}', 'trial_grant', 50000, 'NGN', 50000, 'e44-${Date.now()}');`);
  });

  beforeEach(() => { vi.clearAllMocks(); });

  it('44. Real MetaCloudSender.sendText + withRetry: expiry-first → GateBlockError, provider=0, no retry attempt', async () => {
    // Ensure gate-ON config is the absolute latest
    psql(`
      INSERT INTO platform_config_versions (config_snapshot, effective_from, created_by)
      VALUES ('${JSON.stringify({
        messaging_financial_gate: true,
        messaging_pricing: {
          NGN: { default_cost_minor: 500, rates: { NG: { service: 200 } }, default_spend_cap_minor: 50000 },
        },
        messaging_reservation_ttl_seconds: 1,
      })}'::JSONB, NOW(), '${OWNER_ID}');
    `);

    // #257 gate OFF (default production state)
    const { setSendAttemptGate } = await import('@/lib/channels/attempt-recording');
    setSendAttemptGate(false);

    const { MetaCloudSender } = await import('@/lib/channels/message-sender');
    const { MetaCloudService } = await import('@/lib/channels/meta-cloud');
    const { GateBlockError } = await import('@/lib/channels/attempt-recording');

    // Real MetaCloudService with provider spy
    const cloud = new MetaCloudService({ accessToken: 'fake', phoneNumberId: 'fake' });
    const providerSpy = vi.spyOn(cloud, 'sendText').mockResolvedValue({ messageId: 'wamid.nope' });

    // Real MetaCloudSender with psql-backed Supabase client
    const sender = new MetaCloudSender(cloud, makePsqlClient() as never);
    sender.bindBusiness(bizId);

    // Deterministic release: on the 2nd beforeEachAttempt (post-auth, pre-markSending),
    // find and release the reserved attempt
    let callNum = 0;
    sender.beforeEachAttempt = () => {
      callNum++;
      if (callNum === 2) {
        // The attempt was just authorized (reserved). Find it and release.
        const aid = psqlMayFail(
          `SELECT id FROM message_send_attempts WHERE business_id = '${bizId}' AND recipient_phone = '${UNIQUE_PHONE}' AND financial_disposition = 'reserved' ORDER BY created_at DESC LIMIT 1;`
        );
        if (aid && !aid.includes('ERROR') && aid.trim().length > 0) {
          psql('SELECT pg_sleep(1.2);');
          psqlMayFail(`SELECT safe_release_expired_reservation('${aid.trim()}');`);
        }
      }
    };

    // === INVOKE THE REAL PRODUCTION SEND PATH ===
    let sendError: Error | null = null;
    try {
      await sender.sendText({
        to: UNIQUE_PHONE,
        text: 'Should never reach provider',
        messageCategory: 'service',
      });
    } catch (err) {
      sendError = err as Error;
    }

    // === ASSERTIONS ===

    // 1. Send rejected with GateBlockError (from real markSending + real withRetry)
    expect(sendError).not.toBeNull();
    expect(sendError).toBeInstanceOf(GateBlockError);

    // 2. Provider spy: exactly zero calls
    expect(providerSpy).toHaveBeenCalledTimes(0);

    // 3. Exactly one attempt for this business+phone correlation
    const count = psql(`SELECT count(*) FROM message_send_attempts WHERE business_id = '${bizId}' AND recipient_phone = '${UNIQUE_PHONE}';`);
    expect(parseInt(count)).toBe(1);

    // 4. That attempt: pending_authorization + released
    const row = psql(`SELECT status || '|' || financial_disposition FROM message_send_attempts WHERE business_id = '${bizId}' AND recipient_phone = '${UNIQUE_PHONE}';`);
    expect(row).toBe('pending_authorization|released');

    // 5. No retry-created reservation exists
    const reserved = psql(`SELECT count(*) FROM message_send_attempts WHERE business_id = '${bizId}' AND recipient_phone = '${UNIQUE_PHONE}' AND financial_disposition = 'reserved';`);
    expect(parseInt(reserved)).toBe(0);

    providerSpy.mockRestore();
  }, 60000);
});

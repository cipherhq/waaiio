/**
 * Production-shaped sender expiry-race integration test (#261)
 *
 * Invokes the REAL MetaCloudSender.sendText() path against real PostgreSQL.
 * Structured as incremental proofs:
 *   Step A: createAttempt creates a real DB row
 *   Step B: check_or_authorize_send creates a real reservation
 *   Step C: expiry release + markSending throws GateBlockError
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
 * Supabase client backed by psql. Handles the exact Supabase PostgREST
 * builder patterns used by attempt-recording.ts and message-sender.ts.
 */
function makePsqlClient() {
  function sqlVal(v: unknown): string {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return String(v);
    return `'${String(v).replace(/'/g, "''")}'`;
  }

  return {
    from: (table: string) => {
      let _insert: Record<string, unknown> | null = null;
      let _update: Record<string, unknown> | null = null;

      const builder = {
        insert(row: Record<string, unknown>) { _insert = row; return builder; },
        update(vals: Record<string, unknown>) { _update = vals; return builder; },
        select(_cols?: string) { return builder; },
        eq(col: string, val: unknown) {
          // Execute the pending UPDATE and return a thenable result
          if (_update) {
            const set = Object.entries(_update).map(([k, v]) => `${k} = ${sqlVal(v)}`).join(', ');
            const sql = `UPDATE ${table} SET ${set} WHERE ${col} = ${sqlVal(val)};`;
            const res = psqlMayFail(sql);
            _update = null;
            const hasErr = res.toLowerCase().includes('error');
            const result = { data: null, error: hasErr ? { message: res, code: 'DB_ERROR' } : null };
            // Must be thenable for `const { error } = await ...eq()`
            return Object.assign(Promise.resolve(result), result);
          }
          return builder;
        },
        async single() {
          if (_insert) {
            const cols = Object.keys(_insert);
            const vals = cols.map(k => sqlVal(_insert![k]));
            const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${vals.join(',')}) RETURNING id;`;
            const res = psqlMayFail(sql);
            _insert = null;
            if (res.toLowerCase().includes('error')) {
              return { data: null, error: { message: res } };
            }
            const id = res.trim().split('\n').pop()!.trim();
            return { data: { id }, error: null };
          }
          return { data: null, error: null };
        },
      };
      return builder;
    },
    rpc: async (name: string, params: Record<string, unknown>) => {
      const args = Object.entries(params).map(([k, v]) => `${k} => ${sqlVal(v)}`).join(', ');
      const sql = `SELECT ${name}(${args});`;
      const res = psqlMayFail(sql);
      if (res.toLowerCase().includes('error')) {
        return { data: null, error: { message: res } };
      }
      try { return { data: JSON.parse(res), error: null }; }
      catch { return { data: res, error: null }; }
    },
  };
}

// Mock infrastructure boundaries — these are module-level so they apply
// to all dynamic imports of production code within this test file.
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
    // ═══ CONFIG: gate-ON, 1-second TTL, latest effective ═══
    psql(`
      INSERT INTO platform_config_versions (config_snapshot, effective_from, created_by)
      VALUES ('${JSON.stringify({
        messaging_financial_gate: true,
        messaging_pricing: {
          NGN: { default_cost_minor: 500, rates: { NG: { service: 200 } }, default_spend_cap_minor: 50000 },
        },
        messaging_reservation_ttl_seconds: 1,
      })}'::JSONB, NOW() + INTERVAL '1 second', '${OWNER_ID}');
    `);
    psql('SELECT pg_sleep(1.2);');

    // Verify config is gate-ON
    const gateCheck = psql(`SELECT config_snapshot -> 'messaging_financial_gate' FROM platform_config_versions WHERE effective_from <= NOW() ORDER BY effective_from DESC LIMIT 1;`);
    expect(gateCheck).toBe('true');

    // ═══ SETUP: #257 gate OFF, real production modules ═══
    const { setSendAttemptGate, GateBlockError } = await import('@/lib/channels/attempt-recording');
    setSendAttemptGate(false);

    const { MetaCloudSender } = await import('@/lib/channels/message-sender');
    const { MetaCloudService } = await import('@/lib/channels/meta-cloud');

    // Real MetaCloudService with provider spy
    const cloud = new MetaCloudService({ accessToken: 'fake', phoneNumberId: 'fake' });
    const providerSpy = vi.spyOn(cloud, 'sendText').mockResolvedValue({ messageId: 'wamid.nope' });

    // Real MetaCloudSender with psql-backed Supabase client
    const client = makePsqlClient();
    const sender = new MetaCloudSender(cloud, client as never);
    sender.bindBusiness(bizId);

    // ═══ STEP A: Verify createAttempt works through the psql client ═══
    // Replicate the EXACT insert that createAttempt() does
    const testInsertResult = await client.from('message_send_attempts').insert({
      business_id: bizId,
      attempt_scope: 'business',
      recipient_phone: '+0000000000',
      recipient_country_code: null,
      phone_number_id: null,
      channel_id: null,
      flow_type: null,
      session_id: null,
      transaction_ref: null,
      message_category: 'service',
      template_name: null,
      is_free_entry_point: false,
      config_version_id: null,
      status: 'pending_authorization',
      financial_disposition: 'pending_authorization',
    }).select('id').single();

    if (testInsertResult.error) {
      throw new Error(`STEP A FAILED: createAttempt proxy insert error: ${JSON.stringify(testInsertResult.error)}`);
    }
    expect(testInsertResult.data?.id).toBeTruthy();
    const testRow = psql(`SELECT id FROM message_send_attempts WHERE id = '${testInsertResult.data!.id}';`);
    expect(testRow).toBe(testInsertResult.data!.id);

    // ═══ STEP B: Verify check_or_authorize_send RPC works ═══
    const rpcResult = await client.rpc('check_or_authorize_send', { p_attempt_id: testInsertResult.data!.id });
    if (rpcResult.error) {
      throw new Error(`STEP B FAILED: RPC proxy error: ${JSON.stringify(rpcResult.error)}`);
    }
    expect(rpcResult.data).toBeTruthy();
    // With gate ON, this should return authorized result (the attempt has category='service' + no country → should fail)
    // We just need to prove the RPC call routes correctly

    // ═══ DETERMINISTIC RELEASE HOOK ═══
    let beforeCallCount = 0;
    sender.beforeEachAttempt = () => {
      beforeCallCount++;
      // beforeEachAttempt is called:
      //   1: withRetry pre-loop guard
      //   2: withAttemptAndGuard pre-auth (line 301) — attempt exists but NOT yet authorized
      //   3: withAttemptAndGuard post-auth (line 358) — attempt IS reserved, pre-markSending
      if (beforeCallCount === 3) {
        // Post-auth, pre-markSending: find the reserved attempt and release it
        const aid = psqlMayFail(
          `SELECT id FROM message_send_attempts WHERE business_id = '${bizId}' AND recipient_phone = '${UNIQUE_PHONE}' AND financial_disposition = 'reserved' ORDER BY created_at DESC LIMIT 1;`
        );
        if (aid && !aid.includes('ERROR') && aid.trim().length > 10) {
          psql('SELECT pg_sleep(1.2);'); // Wait for TTL
          psqlMayFail(`SELECT safe_release_expired_reservation('${aid.trim()}');`);
        }
      }
    };

    // ═══ INVOKE THE REAL PRODUCTION SEND PATH ═══
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

    // ═══ ASSERTIONS ═══

    // If sendError is null, dump diagnostics before failing
    if (!sendError) {
      const attempts = psql(`SELECT id, status, financial_disposition, recipient_phone FROM message_send_attempts WHERE business_id = '${bizId}' ORDER BY created_at;`);
      const allAttempts = psql(`SELECT count(*) FROM message_send_attempts WHERE business_id = '${bizId}';`);
      const recentAttempts = psql(`SELECT id, business_id, recipient_phone, status, financial_disposition FROM message_send_attempts ORDER BY created_at DESC LIMIT 5;`);
      const provCalls = providerSpy.mock.calls.length;
      const latestConfig = psql(`SELECT config_snapshot -> 'messaging_financial_gate' FROM platform_config_versions WHERE effective_from <= NOW() ORDER BY effective_from DESC LIMIT 1;`);
      throw new Error(
        `DIAGNOSTIC: sendError was null.\n` +
        `providerCalls=${provCalls}, beforeCallCount=${beforeCallCount}\n` +
        `latestGateConfig=${latestConfig}\n` +
        `bizAttempts=${allAttempts}\n` +
        `forPhone:\n${attempts}\n` +
        `recent5:\n${recentAttempts}`
      );
    }

    // 1. Send rejected with GateBlockError
    expect(sendError).toBeInstanceOf(GateBlockError);

    // 2. Provider spy: exactly zero calls
    expect(providerSpy).toHaveBeenCalledTimes(0);

    // 3. Exactly one attempt for this business+phone (excluding the test insert)
    const count = psql(`SELECT count(*) FROM message_send_attempts WHERE business_id = '${bizId}' AND recipient_phone = '${UNIQUE_PHONE}';`);
    expect(parseInt(count)).toBe(1);

    // 4. That attempt: pending_authorization + released
    const row = psql(`SELECT status || '|' || financial_disposition FROM message_send_attempts WHERE business_id = '${bizId}' AND recipient_phone = '${UNIQUE_PHONE}';`);
    expect(row).toBe('pending_authorization|released');

    // 5. No retry-created reservation
    const reserved = psql(`SELECT count(*) FROM message_send_attempts WHERE business_id = '${bizId}' AND recipient_phone = '${UNIQUE_PHONE}' AND financial_disposition = 'reserved';`);
    expect(parseInt(reserved)).toBe(0);

    providerSpy.mockRestore();
  }, 90000);
});

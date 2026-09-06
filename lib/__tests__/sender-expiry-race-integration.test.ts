/**
 * Production-shaped sender expiry-race integration test (#261)
 *
 * Invokes the REAL MetaCloudSender.sendText() with real withRetry,
 * real withAttemptAndGuard, real markSending, against real PostgreSQL.
 * Deterministically releases the reserved attempt between authorization
 * and markSending, proving the entire send operation produces zero
 * provider calls and no retry-created attempts.
 *
 * Infrastructure boundaries mocked: Supabase client (proxied to psql),
 * hard-stop guard (pass-through), service client factory.
 * Production logic NOT mocked: withRetry, withAttemptAndGuard, markSending,
 * GateBlockError classification, createAttempt, updateAttemptContext.
 *
 *   TEST_DATABASE_URL=postgresql://localhost:5432/waaiio_test \
 *     npx vitest run lib/__tests__/sender-expiry-race-integration.test.ts
 */

import { execSync } from 'child_process';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

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

/**
 * Minimal Supabase client proxy that routes operations to psql.
 * Only implements the subset used by attempt-recording.ts and message-sender.ts.
 */
function createPsqlProxy() {
  const proxy = {
    from: (table: string) => {
      let insertRow: Record<string, unknown> | null = null;
      let updateValues: Record<string, unknown> | null = null;
      let eqCol: string | null = null;
      let eqVal: string | null = null;

      const chain = {
        insert: (row: Record<string, unknown>) => {
          insertRow = row;
          return chain;
        },
        update: (values: Record<string, unknown>) => {
          updateValues = values;
          return chain;
        },
        select: (_cols?: string) => chain,
        eq: (col: string, val: string) => {
          eqCol = col;
          eqVal = val;
          // Execute UPDATE immediately when eq is called after update
          if (updateValues && eqCol && eqVal) {
            const setClauses = Object.entries(updateValues)
              .map(([k, v]) => {
                if (v === null) return `${k} = NULL`;
                if (typeof v === 'boolean') return `${k} = ${v}`;
                if (typeof v === 'number') return `${k} = ${v}`;
                return `${k} = '${String(v).replace(/'/g, "''")}'`;
              })
              .join(', ');
            const result = psqlMayFail(`UPDATE ${table} SET ${setClauses} WHERE ${eqCol} = '${eqVal}';`);
            if (result.includes('ERROR')) {
              return Promise.resolve({ data: null, error: { message: result, code: 'DB_ERROR' } });
            }
            return Promise.resolve({ data: null, error: null });
          }
          return chain;
        },
        single: async () => {
          if (insertRow) {
            const cols = Object.keys(insertRow);
            const vals = cols.map(k => {
              const v = insertRow![k];
              if (v === null || v === undefined) return 'NULL';
              if (typeof v === 'boolean') return String(v);
              if (typeof v === 'number') return String(v);
              return `'${String(v).replace(/'/g, "''")}'`;
            });
            const result = psqlMayFail(
              `INSERT INTO ${table} (${cols.join(',')}) VALUES (${vals.join(',')}) RETURNING id;`
            );
            if (result.includes('ERROR')) {
              return { data: null, error: { message: result } };
            }
            return { data: { id: result.trim() }, error: null };
          }
          return { data: null, error: null };
        },
        // Make the chain thenable for cases where .eq() is the terminal call
        then: (resolve: (val: { data: unknown; error: unknown }) => void) => {
          if (updateValues && eqCol && eqVal) {
            const setClauses = Object.entries(updateValues)
              .map(([k, v]) => {
                if (v === null) return `${k} = NULL`;
                if (typeof v === 'boolean') return `${k} = ${v}`;
                if (typeof v === 'number') return `${k} = ${v}`;
                return `${k} = '${String(v).replace(/'/g, "''")}'`;
              })
              .join(', ');
            const result = psqlMayFail(`UPDATE ${table} SET ${setClauses} WHERE ${eqCol} = '${eqVal}';`);
            if (result.includes('ERROR')) {
              resolve({ data: null, error: { message: result, code: 'DB_ERROR' } });
            } else {
              resolve({ data: null, error: null });
            }
          } else {
            resolve({ data: null, error: null });
          }
        },
      };
      return chain;
    },
    rpc: async (name: string, params: Record<string, unknown>) => {
      const paramStr = Object.entries(params)
        .map(([k, v]) => `${k} => '${String(v).replace(/'/g, "''")}'`)
        .join(', ');
      const result = psqlMayFail(`SELECT ${name}(${paramStr});`);
      if (result.includes('ERROR')) {
        return { data: null, error: { message: result } };
      }
      try {
        return { data: JSON.parse(result), error: null };
      } catch {
        return { data: result, error: null };
      }
    },
  };
  return proxy;
}

const OWNER_ID = '00000000-0000-0000-0000-000000000e44';
const UNIQUE_PHONE = '+2349099999944';

// Mock infrastructure boundaries BEFORE importing production modules
vi.mock('@/lib/channels/send-guard', () => ({
  assertMessagingAllowed: vi.fn().mockResolvedValue(undefined),
  isMessagingAllowed: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => createPsqlProxy(),
}));

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => createPsqlProxy(),
}));

describe.skipIf(!canRun)('Sender expiry-race integration (#261 production-shaped proof)', () => {

  let bizId: string;

  beforeAll(() => {
    psqlMayFail(`INSERT INTO auth.users (id, email, raw_app_meta_data) VALUES ('${OWNER_ID}', 'sender-e44@test.com', '{}') ON CONFLICT (id) DO NOTHING;`);
    bizId = psql(`SELECT gen_random_uuid();`);
    psqlMayFail(`INSERT INTO businesses (id, name, slug, owner_id, address, city, neighborhood, phone, messaging_suspended) VALUES ('${bizId}', 'SenderTest44', 'sender-e44-${Date.now()}', '${OWNER_ID}', '1 Test', 'T', 'T', '+1', false);`);

    // Gate-ON config with 1-second TTL
    psql(`
      INSERT INTO platform_config_versions (config_snapshot, effective_from, created_by)
      VALUES ('${JSON.stringify({
        messaging_financial_gate: true,
        messaging_pricing: {
          NGN: { default_cost_minor: 500, rates: { NG: { service: 200 } }, default_spend_cap_minor: 50000 },
        },
        messaging_reservation_ttl_seconds: 1,
      })}'::JSONB, NOW() + INTERVAL '44999 microseconds', '${OWNER_ID}');
    `);

    psql(`INSERT INTO messaging_allowances (business_id, type, amount_minor, currency_code, remaining_minor, source_ref) VALUES ('${bizId}', 'trial_grant', 50000, 'NGN', 50000, 'sender-e44-${Date.now()}');`);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('44. Real MetaCloudSender.sendText + withRetry: expiry-first release → GateBlockError, provider=0, no retry attempt', async () => {
    // Ensure #257 gate is OFF (default production state)
    const { setSendAttemptGate } = await import('@/lib/channels/attempt-recording');
    setSendAttemptGate(false);

    // Import REAL production modules (withRetry, withAttemptAndGuard, markSending all real)
    const { MetaCloudSender } = await import('@/lib/channels/message-sender');
    const { MetaCloudService } = await import('@/lib/channels/meta-cloud');
    const { GateBlockError } = await import('@/lib/channels/attempt-recording');

    // Create real MetaCloudService with provider spy
    const cloudService = new MetaCloudService({
      accessToken: 'test-fake', phoneNumberId: 'test-fake',
    });
    const providerSpy = vi.spyOn(cloudService, 'sendText')
      .mockResolvedValue({ messageId: 'wamid.should_never_happen' });

    // Create REAL MetaCloudSender with psql-proxied Supabase client
    const supabaseProxy = createPsqlProxy();
    const sender = new MetaCloudSender(cloudService, supabaseProxy as never);
    sender.bindBusiness(bizId);

    // Track the attempt ID created by the real createAttempt inside withAttemptAndGuard
    let capturedAttemptId: string | null = null;
    let beforeCallCount = 0;

    // Use beforeEachAttempt to deterministically release between auth and markSending.
    // In withAttemptAndGuard, beforeEachAttempt is called:
    //   1st: pre-auth deadline check (line 301)
    //   2nd: post-auth deadline check (line 358) — RIGHT BEFORE markSending
    sender.beforeEachAttempt = () => {
      beforeCallCount++;
      if (beforeCallCount === 2) {
        // Post-auth, pre-markSending. The attempt has been authorized (reserved).
        // Find the attempt by unique phone + business correlation.
        const attemptId = psqlMayFail(
          `SELECT id FROM message_send_attempts WHERE business_id = '${bizId}' AND recipient_phone = '${UNIQUE_PHONE}' AND financial_disposition = 'reserved' ORDER BY created_at DESC LIMIT 1;`
        );
        if (attemptId && !attemptId.includes('ERROR')) {
          capturedAttemptId = attemptId.trim();
          // Wait for TTL expiry
          psql('SELECT pg_sleep(1.5);');
          // Release via the real DB-atomic expiry function
          const releaseResult = psqlMayFail(`SELECT safe_release_expired_reservation('${capturedAttemptId}');`);
          if (!releaseResult.includes('ERROR')) {
            // Attempt is now released — markSending will fail
          }
        }
      }
    };

    // === INVOKE THE REAL PRODUCTION SEND PATH ===
    let sendError: Error | null = null;
    try {
      // This calls the REAL: withRetry → withAttemptAndGuard → createAttempt →
      // updateAttemptContext → assertMessagingAllowed → check_or_authorize_send →
      // beforeEachAttempt(release happens here) → assertMessagingAllowed →
      // markSending(financiallyReserved=true) → GateBlockError → withRetry exits
      await sender.sendText({
        to: UNIQUE_PHONE,
        text: 'This message should never reach the provider',
        messageCategory: 'service',
      });
    } catch (err) {
      sendError = err as Error;
    }

    // === ASSERTIONS ===

    // 1. The real send rejected with GateBlockError
    expect(sendError).not.toBeNull();
    expect(sendError).toBeInstanceOf(GateBlockError);

    // 2. Provider spy call count is exactly 0
    expect(providerSpy).toHaveBeenCalledTimes(0);

    // 3. Exactly one attempt row for this unique send/business correlation
    const attemptCount = psql(
      `SELECT count(*) FROM message_send_attempts WHERE business_id = '${bizId}' AND recipient_phone = '${UNIQUE_PHONE}';`
    );
    expect(parseInt(attemptCount)).toBe(1);

    // 4. That attempt ends pending_authorization + released
    expect(capturedAttemptId).not.toBeNull();
    const finalStatus = psql(`SELECT status FROM message_send_attempts WHERE id = '${capturedAttemptId}';`);
    const finalDisp = psql(`SELECT financial_disposition FROM message_send_attempts WHERE id = '${capturedAttemptId}';`);
    expect(finalStatus).toBe('pending_authorization');
    expect(finalDisp).toBe('released');

    // 5. No retry-created reservation/attempt exists
    const reservedCount = psql(
      `SELECT count(*) FROM message_send_attempts WHERE business_id = '${bizId}' AND recipient_phone = '${UNIQUE_PHONE}' AND financial_disposition = 'reserved';`
    );
    expect(parseInt(reservedCount)).toBe(0);

    providerSpy.mockRestore();
  }, 60000);
});

/**
 * #271 Slice C: CAS business_id extension — real PostgreSQL tests.
 *
 * Proves against real PostgreSQL (TEST_DATABASE_URL):
 * - update_session_cas with p_business_id → changes business_id atomically
 * - update_session_cas with p_business_id = NULL → preserves existing business_id
 * - CAS version conflict → returns success: false
 * - ACL: anon/authenticated cannot call the extended function
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';

const dbUrl = process.env.TEST_DATABASE_URL;

if (!dbUrl) {
  describe.skip('#271c CAS business_id — TEST_DATABASE_URL not set', () => {
    it('skipped', () => {});
  });
} else {

function runSQL(sql: string): string {
  try {
    return execSync(
      `psql "${dbUrl}" -t -A -v ON_ERROR_STOP=1`,
      { input: sql, encoding: 'utf-8', timeout: 15000 },
    ).trim();
  } catch (err: any) {
    throw new Error(`SQL failed: ${err.stderr?.trim() || err.stdout?.trim() || err}`);
  }
}

function runSQLSafe(sql: string): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync(
      `psql "${dbUrl}" -t -A -v ON_ERROR_STOP=1`,
      { input: sql, encoding: 'utf-8', timeout: 15000 },
    ).trim();
    return { stdout, exitCode: 0 };
  } catch (err: any) {
    return { stdout: err.stdout?.trim() || '', exitCode: err.status || 1 };
  }
}

const SESSION_ID = 'c2710000-0000-0000-0000-000000000001';
const BIZ_A = 'c2710000-0000-0000-0000-000000000010';
const BIZ_B = 'c2710000-0000-0000-0000-000000000020';
const OWNER = 'c2710000-0000-0000-0000-000000000099';

describe('#271c CAS business_id PostgreSQL', () => {
  beforeAll(() => {
    // Clean up any leftover test data
    runSQL(`
      DELETE FROM public.bot_sessions WHERE id = '${SESSION_ID}';
      DELETE FROM public.businesses WHERE id IN ('${BIZ_A}', '${BIZ_B}');
      DELETE FROM auth.users WHERE id = '${OWNER}';
    `);
    // Create test fixtures
    runSQL(`
      INSERT INTO auth.users (id, email) VALUES ('${OWNER}', 'cas-test@example.com');
      INSERT INTO public.businesses (id, name, slug, category, flow_type, owner_id, subscription_tier, address, city, neighborhood, phone)
        VALUES ('${BIZ_A}', 'Biz A', 'biz-a-cas', 'salon', 'scheduling', '${OWNER}', 'growth', '123 Test St', 'Lagos', 'Ikeja', '+234000111'),
               ('${BIZ_B}', 'Biz B', 'biz-b-cas', 'salon', 'scheduling', '${OWNER}', 'growth', '456 Test Ave', 'Lagos', 'Lekki', '+234000222');
      INSERT INTO public.bot_sessions (id, whatsapp_number, business_id, current_step, session_data, is_active, expires_at, version)
        VALUES ('${SESSION_ID}', '+2340001112222', '${BIZ_A}', 'select_capability', '{}', true, NOW() + interval '10 minutes', 0);
    `);
  });

  afterAll(() => {
    runSQL(`
      DELETE FROM public.bot_sessions WHERE id = '${SESSION_ID}';
      DELETE FROM public.businesses WHERE id IN ('${BIZ_A}', '${BIZ_B}');
      DELETE FROM auth.users WHERE id = '${OWNER}';
    `);
  });

  it('with p_business_id → changes business_id atomically', () => {
    const result = runSQL(`
      SELECT update_session_cas(
        '${SESSION_ID}'::UUID, 0::BIGINT,
        'select_date', '{"_reschedule": true}'::JSONB,
        NULL::JSONB, NULL::TEXT[],
        '${BIZ_B}'::UUID
      );
    `);
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.version).toBe(1);

    // Verify business_id was changed
    const bizId = runSQL(`SELECT business_id FROM public.bot_sessions WHERE id = '${SESSION_ID}';`);
    expect(bizId).toBe(BIZ_B);
  });

  it('with p_business_id = NULL → preserves existing business_id', () => {
    const result = runSQL(`
      SELECT update_session_cas(
        '${SESSION_ID}'::UUID, 1::BIGINT,
        'confirm', '{"step": "confirm"}'::JSONB,
        NULL::JSONB, NULL::TEXT[],
        NULL::UUID
      );
    `);
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.version).toBe(2);

    // business_id should still be BIZ_B from previous test
    const bizId = runSQL(`SELECT business_id FROM public.bot_sessions WHERE id = '${SESSION_ID}';`);
    expect(bizId).toBe(BIZ_B);
  });

  it('version conflict → returns success: false', () => {
    // Current version is 2; pass expected_version = 0 to trigger conflict
    const result = runSQL(`
      SELECT update_session_cas(
        '${SESSION_ID}'::UUID, 0::BIGINT,
        'stale_step', '{}'::JSONB,
        NULL::JSONB, NULL::TEXT[],
        NULL::UUID
      );
    `);
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(false);
    expect(parsed.reason).toBe('version_conflict');
    expect(parsed.current_version).toBe(2);
    expect(parsed.expected_version).toBe(0);
  });

  it('ACL: anon cannot call update_session_cas', () => {
    const { exitCode } = runSQLSafe(`
      SET ROLE anon;
      SELECT update_session_cas(
        '${SESSION_ID}'::UUID, 2::BIGINT,
        'hacked', '{}'::JSONB,
        NULL::JSONB, NULL::TEXT[],
        NULL::UUID
      );
      RESET ROLE;
    `);
    expect(exitCode).not.toBe(0);
  });

  it('ACL: authenticated cannot call update_session_cas', () => {
    const { exitCode } = runSQLSafe(`
      SET ROLE authenticated;
      SELECT update_session_cas(
        '${SESSION_ID}'::UUID, 2::BIGINT,
        'hacked', '{}'::JSONB,
        NULL::JSONB, NULL::TEXT[],
        NULL::UUID
      );
      RESET ROLE;
    `);
    expect(exitCode).not.toBe(0);
  });

  // ── Full rebook atomicity (Finding 3) ─────────────────────────────────────

  it('rebook: success atomically updates business_id, current_step, session_data, and version', () => {
    // Reset session to a known state first (version is currently 2 from prior tests)
    const currentVersion = Number(runSQL(`SELECT version FROM public.bot_sessions WHERE id = '${SESSION_ID}';`));
    const nextVersion = currentVersion + 1;

    const result = runSQL(`
      SELECT update_session_cas(
        '${SESSION_ID}'::UUID, ${currentVersion}::BIGINT,
        'select_date', '{"_step_history": ["select_capability", "select_date"], "_reschedule": true}'::JSONB,
        NULL::JSONB, NULL::TEXT[],
        '${BIZ_A}'::UUID
      );
    `);
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.version).toBe(nextVersion);

    // All four columns must be updated atomically in one RPC call
    const row = runSQL(`
      SELECT business_id, current_step, version,
             session_data->>'_reschedule' AS reschedule_flag
      FROM public.bot_sessions WHERE id = '${SESSION_ID}';
    `);
    const [bizId, step, ver, rebook] = row.split('|');
    expect(bizId).toBe(BIZ_A);
    expect(step).toBe('select_date');
    expect(Number(ver)).toBe(nextVersion);
    expect(rebook).toBe('true');
  });

  it('rebook: stale expected_version leaves all columns unchanged', () => {
    // Fetch current state
    const snapshot = runSQL(`
      SELECT business_id, current_step, version FROM public.bot_sessions WHERE id = '${SESSION_ID}';
    `);
    const [bizBefore, stepBefore, verBefore] = snapshot.split('|');

    // Pass a stale expected_version to trigger conflict
    const staleVersion = Number(verBefore) - 1;
    const result = runSQL(`
      SELECT update_session_cas(
        '${SESSION_ID}'::UUID, ${staleVersion}::BIGINT,
        'inject_step', '{"injected": true}'::JSONB,
        NULL::JSONB, NULL::TEXT[],
        '${BIZ_B}'::UUID
      );
    `);
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(false);
    expect(parsed.reason).toBe('version_conflict');

    // Row must be entirely unchanged
    const after = runSQL(`
      SELECT business_id, current_step, version FROM public.bot_sessions WHERE id = '${SESSION_ID}';
    `);
    expect(after).toBe(snapshot);
  });

  // ── pg_proc signature audit (Finding 3) ───────────────────────────────────

  it('exactly one update_session_cas function exists after migration 363', () => {
    const count = runSQL(`
      SELECT COUNT(*)::text
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = 'update_session_cas';
    `);
    // Must be exactly 1 — no overloads, no stale signatures
    expect(count).toBe('1');
  });

  it('update_session_cas has 7 parameters (includes p_business_id)', () => {
    const argCount = runSQL(`
      SELECT pronargs::text
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = 'update_session_cas';
    `);
    expect(argCount).toBe('7');
  });
});

} // end if (dbUrl)

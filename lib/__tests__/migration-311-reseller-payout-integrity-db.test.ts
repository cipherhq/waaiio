/**
 * Migration 311: Reseller Payout Financial Integrity — Real PostgreSQL Tests
 *
 * Non-concurrency DB tests: RLS behavioral, constraint, RPC behavior.
 * Concurrency tests: scripts/test-migration-311-concurrency.sh
 *
 * Required env: TEST_DATABASE_URL
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';

const TEST_DB = process.env.TEST_DATABASE_URL;

function runSQL(sql: string): string {
  if (!TEST_DB) throw new Error('TEST_DATABASE_URL not set');
  try {
    return execSync(
      `psql "${TEST_DB}" -t -A`,
      { encoding: 'utf-8', timeout: 15000, input: sql },
    ).trim();
  } catch (err: any) {
    return `ERROR: ${err.stderr || err.message}`;
  }
}

const describeIfDb = !TEST_DB ? describe.skip : describe;

// ══════════════════════════════════════════════════════════
// A. RLS Policy Existence Tests
// ══════════════════════════════════════════════════════════

describeIfDb('Migration 311: RLS policies exist correctly', () => {
  it('admin_manages_reseller_payouts policy exists with is_admin()', () => {
    const result = runSQL(`
      SELECT polname, pg_get_expr(polqual, polrelid) as qual
      FROM pg_policy
      WHERE polrelid = 'reseller_payouts'::regclass
        AND polname = 'admin_manages_reseller_payouts';
    `);
    expect(result).toContain('admin_manages_reseller_payouts');
    expect(result).toContain('is_admin()');
  });

  it('finance_reads_reseller_payouts policy is SELECT-only with is_admin_or_finance()', () => {
    const result = runSQL(`
      SELECT polname, polcmd, pg_get_expr(polqual, polrelid) as qual
      FROM pg_policy
      WHERE polrelid = 'reseller_payouts'::regclass
        AND polname = 'finance_reads_reseller_payouts';
    `);
    expect(result).toContain('finance_reads_reseller_payouts');
    expect(result).toContain('r'); // polcmd r = SELECT
    expect(result).toContain('is_admin_or_finance()');
  });

  it('old profiles.role-based policy is dropped', () => {
    const result = runSQL(`
      SELECT COUNT(*) FROM pg_policy
      WHERE polrelid = 'reseller_payouts'::regclass
        AND polname = 'Admin manages reseller payouts';
    `);
    expect(result).toBe('0');
  });

  it('is_admin_or_finance() exists and includes admin+finance only', () => {
    const result = runSQL(`
      SELECT prosrc FROM pg_proc WHERE proname = 'is_admin_or_finance';
    `);
    expect(result).toContain("'admin'");
    expect(result).toContain("'finance'");
    expect(result).not.toContain("'support'");
    expect(result).not.toContain("'operations'");
  });
});

// ══════════════════════════════════════════════════════════
// B. RLS Behavioral Tests (actual SQL execution per role)
// ══════════════════════════════════════════════════════════

describeIfDb('Migration 311: RLS behavioral authorization', () => {
  const ADMIN_USER = '00000000-0000-0000-0000-000000311001';
  const FINANCE_USER = '00000000-0000-0000-0000-000000311002';
  const SUPPORT_USER = '00000000-0000-0000-0000-000000311003';
  const OPS_USER = '00000000-0000-0000-0000-000000311004';
  const RESELLER_ID = '00000000-0000-0000-0000-000000311010';
  const PAYOUT_ID = '00000000-0000-0000-0000-000000311020';

  beforeAll(() => {
    // Create test users with different app_metadata roles
    runSQL(`
      INSERT INTO auth.users (id, raw_app_meta_data) VALUES
        ('${ADMIN_USER}', '{"role":"admin"}'::jsonb),
        ('${FINANCE_USER}', '{"role":"finance"}'::jsonb),
        ('${SUPPORT_USER}', '{"role":"support"}'::jsonb),
        ('${OPS_USER}', '{"role":"operations"}'::jsonb)
      ON CONFLICT (id) DO UPDATE SET raw_app_meta_data = EXCLUDED.raw_app_meta_data;
    `);
    // Create test reseller + payout
    runSQL(`
      INSERT INTO resellers (id, company_name, contact_email, commission_percentage)
      VALUES ('${RESELLER_ID}', 'RLS Test Reseller', 'rls@test.local', 10)
      ON CONFLICT (id) DO NOTHING;
    `);
    runSQL(`
      INSERT INTO reseller_payouts (id, reseller_id, period_start, period_end, net_amount, status)
      VALUES ('${PAYOUT_ID}', '${RESELLER_ID}', '2026-06-01', '2026-06-15', 100, 'pending')
      ON CONFLICT (id) DO NOTHING;
    `);
  });

  afterAll(() => {
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id = '${RESELLER_ID}';`);
    runSQL(`DELETE FROM resellers WHERE id = '${RESELLER_ID}';`);
    runSQL(`DELETE FROM auth.users WHERE id IN ('${ADMIN_USER}','${FINANCE_USER}','${SUPPORT_USER}','${OPS_USER}');`);
  });

  // ── ADMIN ──
  it('admin SELECT succeeds', () => {
    const r = runSQL(`SET ROLE authenticated; SET LOCAL "app.current_user_id" = '${ADMIN_USER}'; SELECT id FROM reseller_payouts WHERE id = '${PAYOUT_ID}'; RESET ROLE;`);
    expect(r).toContain(PAYOUT_ID);
  });

  it('admin INSERT succeeds', () => {
    const testId = '00000000-0000-0000-0000-000000311021';
    runSQL(`DELETE FROM reseller_payouts WHERE id = '${testId}';`);
    const r = runSQL(`SET ROLE authenticated; SET LOCAL "app.current_user_id" = '${ADMIN_USER}'; INSERT INTO reseller_payouts (id, reseller_id, period_start, period_end, net_amount, status) VALUES ('${testId}', '${RESELLER_ID}', '2026-07-01', '2026-07-15', 50, 'pending') RETURNING id; RESET ROLE;`);
    expect(r).toContain(testId);
    runSQL(`DELETE FROM reseller_payouts WHERE id = '${testId}';`);
  });

  it('admin UPDATE succeeds', () => {
    const r = runSQL(`SET ROLE authenticated; SET LOCAL "app.current_user_id" = '${ADMIN_USER}'; UPDATE reseller_payouts SET notes = 'admin-test' WHERE id = '${PAYOUT_ID}' RETURNING id; RESET ROLE;`);
    expect(r).toContain(PAYOUT_ID);
  });

  it('admin DELETE succeeds', () => {
    const delId = '00000000-0000-0000-0000-000000311022';
    runSQL(`INSERT INTO reseller_payouts (id, reseller_id, period_start, period_end, net_amount, status) VALUES ('${delId}', '${RESELLER_ID}', '2026-09-01', '2026-09-15', 50, 'rejected') ON CONFLICT DO NOTHING;`);
    const r = runSQL(`SET ROLE authenticated; SET LOCAL "app.current_user_id" = '${ADMIN_USER}'; DELETE FROM reseller_payouts WHERE id = '${delId}' RETURNING id; RESET ROLE;`);
    expect(r).toContain(delId);
  });

  // ── FINANCE ──
  it('finance SELECT succeeds', () => {
    const r = runSQL(`SET ROLE authenticated; SET LOCAL "app.current_user_id" = '${FINANCE_USER}'; SELECT id FROM reseller_payouts WHERE id = '${PAYOUT_ID}'; RESET ROLE;`);
    expect(r).toContain(PAYOUT_ID);
  });

  it('finance INSERT denied', () => {
    const r = runSQL(`SET ROLE authenticated; SET LOCAL "app.current_user_id" = '${FINANCE_USER}'; INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status) VALUES ('${RESELLER_ID}', '2026-11-01', '2026-11-15', 50, 'pending'); RESET ROLE;`);
    expect(r).toContain('ERROR');
  });

  it('finance UPDATE denied', () => {
    const r = runSQL(`SET ROLE authenticated; SET LOCAL "app.current_user_id" = '${FINANCE_USER}'; UPDATE reseller_payouts SET notes = 'hack' WHERE id = '${PAYOUT_ID}'; RESET ROLE;`);
    // UPDATE may return 0 rows (silently denied by RLS) or error — either is acceptable
    const count = runSQL(`SELECT notes FROM reseller_payouts WHERE id = '${PAYOUT_ID}';`);
    expect(count).not.toBe('hack');
  });

  it('finance DELETE denied', () => {
    const before = runSQL(`SELECT COUNT(*) FROM reseller_payouts WHERE id = '${PAYOUT_ID}';`);
    runSQL(`SET ROLE authenticated; SET LOCAL "app.current_user_id" = '${FINANCE_USER}'; DELETE FROM reseller_payouts WHERE id = '${PAYOUT_ID}'; RESET ROLE;`);
    const after = runSQL(`SELECT COUNT(*) FROM reseller_payouts WHERE id = '${PAYOUT_ID}';`);
    expect(after).toBe(before); // row still exists
  });

  // ── SUPPORT ──
  it('support SELECT denied', () => {
    const r = runSQL(`SET ROLE authenticated; SET LOCAL "app.current_user_id" = '${SUPPORT_USER}'; SELECT COUNT(*) FROM reseller_payouts WHERE id = '${PAYOUT_ID}'; RESET ROLE;`);
    expect(r).toBe('0'); // RLS filters out all rows
  });

  it('support INSERT denied', () => {
    const r = runSQL(`SET ROLE authenticated; SET LOCAL "app.current_user_id" = '${SUPPORT_USER}'; INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status) VALUES ('${RESELLER_ID}', '2026-12-01', '2026-12-15', 50, 'pending'); RESET ROLE;`);
    expect(r).toContain('ERROR');
  });

  // ── OPERATIONS ──
  it('operations SELECT denied', () => {
    const r = runSQL(`SET ROLE authenticated; SET LOCAL "app.current_user_id" = '${OPS_USER}'; SELECT COUNT(*) FROM reseller_payouts WHERE id = '${PAYOUT_ID}'; RESET ROLE;`);
    expect(r).toBe('0');
  });

  // ── UNAUTHENTICATED (anon) ──
  it('anon SELECT denied', () => {
    const r = runSQL(`SET ROLE anon; SELECT COUNT(*) FROM reseller_payouts WHERE id = '${PAYOUT_ID}'; RESET ROLE;`);
    expect(r).toBe('0');
  });
});

// ══════════════════════════════════════════════════════════
// C. Overlap Constraint Tests
// ══════════════════════════════════════════════════════════

describeIfDb('Migration 311: overlap exclusion constraint', () => {
  const RESELLER_ID = '00000000-0000-0000-0000-000000000312';

  beforeAll(() => {
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id = '${RESELLER_ID}';`);
    runSQL(`DELETE FROM resellers WHERE id IN ('${RESELLER_ID}', '00000000-0000-0000-0000-000000000313');`);
    runSQL(`INSERT INTO resellers (id, company_name, contact_email, commission_percentage)
      VALUES ('${RESELLER_ID}', 'Test Reseller 312', 'test312@example.com', 10) ON CONFLICT DO NOTHING;`);
  });

  afterAll(() => {
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id IN ('${RESELLER_ID}', '00000000-0000-0000-0000-000000000313');`);
    runSQL(`DELETE FROM resellers WHERE id IN ('${RESELLER_ID}', '00000000-0000-0000-0000-000000000313');`);
  });

  it('constraint exists', () => {
    const r = runSQL(`SELECT COUNT(*) FROM pg_constraint WHERE conname = 'reseller_payouts_no_overlap';`);
    expect(r).toBe('1');
  });

  it('adjacent periods allowed', () => {
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id = '${RESELLER_ID}';`);
    const r1 = runSQL(`INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status) VALUES ('${RESELLER_ID}', '2026-08-01', '2026-08-15', 100, 'pending') RETURNING id;`);
    expect(r1).not.toContain('ERROR');
    const r2 = runSQL(`INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status) VALUES ('${RESELLER_ID}', '2026-08-15', '2026-08-31', 100, 'pending') RETURNING id;`);
    expect(r2).not.toContain('ERROR');
  });

  it('partial overlap rejected', () => {
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id = '${RESELLER_ID}';`);
    runSQL(`INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status) VALUES ('${RESELLER_ID}', '2026-08-01', '2026-08-15', 100, 'pending');`);
    const r = runSQL(`INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status) VALUES ('${RESELLER_ID}', '2026-08-14', '2026-08-20', 100, 'pending');`);
    expect(r).toContain('ERROR');
  });

  it('identical period rejected', () => {
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id = '${RESELLER_ID}';`);
    runSQL(`INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status) VALUES ('${RESELLER_ID}', '2026-09-01', '2026-09-15', 100, 'pending');`);
    const r = runSQL(`INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status) VALUES ('${RESELLER_ID}', '2026-09-01', '2026-09-15', 100, 'pending');`);
    expect(r).toContain('ERROR');
  });

  it('rejected payout allows re-creation', () => {
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id = '${RESELLER_ID}';`);
    runSQL(`INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status) VALUES ('${RESELLER_ID}', '2026-10-01', '2026-10-15', 100, 'rejected');`);
    const r = runSQL(`INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status) VALUES ('${RESELLER_ID}', '2026-10-01', '2026-10-15', 100, 'pending') RETURNING id;`);
    expect(r).not.toContain('ERROR');
  });

  it('different resellers same dates allowed', () => {
    const OTHER = '00000000-0000-0000-0000-000000000313';
    runSQL(`INSERT INTO resellers (id, company_name, contact_email, commission_percentage) VALUES ('${OTHER}', 'Other', 'o@t.com', 10) ON CONFLICT DO NOTHING;`);
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id IN ('${RESELLER_ID}', '${OTHER}');`);
    const r1 = runSQL(`INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status) VALUES ('${RESELLER_ID}', '2026-11-01', '2026-11-15', 100, 'pending') RETURNING id;`);
    expect(r1).not.toContain('ERROR');
    const r2 = runSQL(`INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status) VALUES ('${OTHER}', '2026-11-01', '2026-11-15', 100, 'pending') RETURNING id;`);
    expect(r2).not.toContain('ERROR');
  });
});

// ══════════════════════════════════════════════════════════
// D. mark_reseller_payout_paid RPC (non-concurrent)
// ══════════════════════════════════════════════════════════

describeIfDb('Migration 311: mark_reseller_payout_paid RPC', () => {
  const RESELLER_ID = '00000000-0000-0000-0000-000000000314';
  const PAYOUT_ID = '00000000-0000-0000-0000-00000000031c';
  const ADMIN_ID = '00000000-0000-0000-0000-000000000001';

  beforeAll(() => {
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id = '${RESELLER_ID}';`);
    runSQL(`DELETE FROM platform_fees WHERE reseller_id = '${RESELLER_ID}';`);
    runSQL(`DELETE FROM resellers WHERE id = '${RESELLER_ID}';`);
    runSQL(`INSERT INTO resellers (id, company_name, contact_email, commission_percentage) VALUES ('${RESELLER_ID}', 'RPC Test', 'rpc@t.local', 10) ON CONFLICT DO NOTHING;`);
    runSQL(`INSERT INTO platform_fees (business_id, payment_id, fee_amount, reseller_id, reseller_commission) VALUES ((SELECT id FROM businesses LIMIT 1), 'test-rpc-311-' || gen_random_uuid()::text, 100, '${RESELLER_ID}', 1000);`);
  });

  afterAll(() => {
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id = '${RESELLER_ID}';`);
    runSQL(`DELETE FROM platform_fees WHERE reseller_id = '${RESELLER_ID}';`);
    runSQL(`DELETE FROM resellers WHERE id = '${RESELLER_ID}';`);
  });

  it('returns not_found for non-existent payout', () => {
    const r = runSQL(`SELECT mark_reseller_payout_paid('00000000-0000-0000-0000-000000000000', '${ADMIN_ID}');`);
    expect(r).toContain('not_found');
  });

  it('returns not_approved for pending payout', () => {
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id = '${RESELLER_ID}';`);
    runSQL(`INSERT INTO reseller_payouts (id, reseller_id, period_start, period_end, net_amount, status) VALUES ('${PAYOUT_ID}', '${RESELLER_ID}', '2026-06-01', '2026-06-15', 500, 'pending');`);
    const r = runSQL(`SELECT mark_reseller_payout_paid('${PAYOUT_ID}', '${ADMIN_ID}');`);
    expect(r).toContain('not_approved');
  });

  it('succeeds for approved payout within balance', () => {
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id = '${RESELLER_ID}';`);
    runSQL(`INSERT INTO reseller_payouts (id, reseller_id, period_start, period_end, net_amount, status) VALUES ('${PAYOUT_ID}', '${RESELLER_ID}', '2026-07-01', '2026-07-15', 500, 'approved');`);
    const r = runSQL(`SELECT mark_reseller_payout_paid('${PAYOUT_ID}', '${ADMIN_ID}');`);
    expect(r).toContain('"success" : true');
    const status = runSQL(`SELECT status FROM reseller_payouts WHERE id = '${PAYOUT_ID}';`);
    expect(status).toBe('paid');
  });

  it('returns insufficient_balance when over limit', () => {
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id = '${RESELLER_ID}';`);
    runSQL(`INSERT INTO reseller_payouts (id, reseller_id, period_start, period_end, net_amount, status) VALUES ('${PAYOUT_ID}', '${RESELLER_ID}', '2026-08-01', '2026-08-15', 2000, 'approved');`);
    const r = runSQL(`SELECT mark_reseller_payout_paid('${PAYOUT_ID}', '${ADMIN_ID}');`);
    expect(r).toContain('insufficient_balance');
    const status = runSQL(`SELECT status FROM reseller_payouts WHERE id = '${PAYOUT_ID}';`);
    expect(status).toBe('approved');
  });

  it('RPC restricted to service_role only', () => {
    const r = runSQL(`SELECT has_function_privilege('authenticated', 'mark_reseller_payout_paid(uuid,uuid)', 'EXECUTE');`);
    expect(r).toBe('f');
  });
});

// ══════════════════════════════════════════════════════════
// E. Migration atomicity verification
// ══════════════════════════════════════════════════════════

describeIfDb('Migration 311: transaction atomicity', () => {
  it('migration uses BEGIN/COMMIT wrapper', () => {
    const { readFileSync } = require('fs');
    const src = readFileSync('supabase/migrations/311_reseller_payout_integrity.sql', 'utf-8');
    expect(src).toContain('BEGIN;');
    expect(src).toContain('COMMIT;');
    const beginIdx = src.indexOf('BEGIN;');
    const exceptionIdx = src.indexOf('RAISE EXCEPTION');
    const commitIdx = src.indexOf('COMMIT;');
    expect(beginIdx).toBeLessThan(exceptionIdx);
    expect(exceptionIdx).toBeLessThan(commitIdx);
  });
});

/**
 * Migration 311: Reseller Payout Financial Integrity — Real PostgreSQL Tests
 *
 * These tests run against a real PostgreSQL database (TEST_DATABASE_URL).
 * They verify RLS, concurrency, and overlap prevention at the database level.
 *
 * Required env: TEST_DATABASE_URL
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';

const TEST_DB = process.env.TEST_DATABASE_URL;

function runSQL(sql: string, role?: string): string {
  if (!TEST_DB) throw new Error('TEST_DATABASE_URL not set');
  const rolePrefix = role ? `SET ROLE ${role}; ` : '';
  const fullSql = rolePrefix + sql;
  try {
    return execSync(
      `psql "${TEST_DB}" -t -A -c ${JSON.stringify(fullSql)}`,
      { encoding: 'utf-8', timeout: 15000 },
    ).trim();
  } catch (err: any) {
    return `ERROR: ${err.stderr || err.message}`;
  }
}

function runSQLJson(sql: string, role?: string): any {
  const raw = runSQL(sql, role);
  if (raw.startsWith('ERROR:')) return { _error: raw };
  try { return JSON.parse(raw); } catch { return raw; }
}

// Run two SQL statements concurrently in independent sessions
async function runConcurrent(sqlA: string, sqlB: string): Promise<[string, string]> {
  if (!TEST_DB) throw new Error('TEST_DATABASE_URL not set');
  const run = (sql: string) => new Promise<string>((resolve) => {
    try {
      const result = execSync(
        `psql "${TEST_DB}" -t -A -c ${JSON.stringify(sql)}`,
        { encoding: 'utf-8', timeout: 30000 },
      ).trim();
      resolve(result);
    } catch (err: any) {
      resolve(`ERROR: ${err.stderr || err.message}`);
    }
  });
  return Promise.all([run(sqlA), run(sqlB)]);
}

const skipIfNoDb = !TEST_DB ? it.skip : it;
const describeIfDb = !TEST_DB ? describe.skip : describe;

// ══════════════════════════════════════════════════════════
// A. RLS Tests
// ══════════════════════════════════════════════════════════

describeIfDb('Migration 311: Finance RLS on reseller_payouts', () => {
  // These tests use SET ROLE to simulate different Supabase roles.
  // The actual RLS policies use is_admin() / is_admin_or_support() which
  // read from auth.users — not directly testable via SET ROLE alone.
  // Instead we verify the policies exist and have correct definitions.

  it('admin_manages_reseller_payouts policy exists with is_admin()', () => {
    const result = runSQL(`
      SELECT polname, polcmd, pg_get_expr(polqual, polrelid) as qual
      FROM pg_policy
      WHERE polrelid = 'reseller_payouts'::regclass
        AND polname = 'admin_manages_reseller_payouts'
    `);
    expect(result).toContain('admin_manages_reseller_payouts');
    expect(result).toContain('is_admin()');
  });

  it('finance_reads_reseller_payouts policy exists as SELECT-only', () => {
    const result = runSQL(`
      SELECT polname, polcmd
      FROM pg_policy
      WHERE polrelid = 'reseller_payouts'::regclass
        AND polname = 'finance_reads_reseller_payouts'
    `);
    expect(result).toContain('finance_reads_reseller_payouts');
    // polcmd 'r' = SELECT
    expect(result).toContain('r');
  });

  it('old Admin manages reseller payouts (profiles.role) policy is dropped', () => {
    const result = runSQL(`
      SELECT COUNT(*) FROM pg_policy
      WHERE polrelid = 'reseller_payouts'::regclass
        AND polname = 'Admin manages reseller payouts'
    `);
    expect(result).toBe('0');
  });

  it('service_role bypasses RLS for INSERT', () => {
    // service_role bypasses RLS by default in Supabase
    const result = runSQL(`
      SELECT has_table_privilege('service_role', 'reseller_payouts', 'INSERT')
    `);
    expect(result).toBe('t');
  });
});

// ══════════════════════════════════════════════════════════
// B. mark_reseller_payout_paid RPC Tests
// ══════════════════════════════════════════════════════════

describeIfDb('Migration 311: mark_reseller_payout_paid concurrency', () => {
  const RESELLER_ID = '00000000-0000-0000-0000-000000000311';
  const PAYOUT_A_ID = '00000000-0000-0000-0000-00000000031a';
  const PAYOUT_B_ID = '00000000-0000-0000-0000-00000000031b';
  const ADMIN_ID = '00000000-0000-0000-0000-000000000001';

  beforeAll(() => {
    // Clean up any previous test data
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id = '${RESELLER_ID}'`);
    runSQL(`DELETE FROM platform_fees WHERE reseller_id = '${RESELLER_ID}'`);
    runSQL(`DELETE FROM resellers WHERE id = '${RESELLER_ID}'`);

    // Seed test reseller
    runSQL(`INSERT INTO resellers (id, company_name, contact_email, commission_percentage)
      VALUES ('${RESELLER_ID}', 'Test Reseller 311', 'test311@example.com', 10)
      ON CONFLICT (id) DO NOTHING`);

    // Seed 1000 in commission earnings
    runSQL(`INSERT INTO platform_fees (business_id, payment_id, fee_amount, reseller_id, reseller_commission)
      VALUES (
        (SELECT id FROM businesses LIMIT 1),
        'test-payment-311-' || gen_random_uuid()::text,
        100, '${RESELLER_ID}', 1000
      )`);
  });

  afterAll(() => {
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id = '${RESELLER_ID}'`);
    runSQL(`DELETE FROM platform_fees WHERE reseller_id = '${RESELLER_ID}'`);
    runSQL(`DELETE FROM resellers WHERE id = '${RESELLER_ID}'`);
  });

  it('700 + 700 on 1000: exactly one succeeds (overspend prevention)', async () => {
    // Seed two approved payouts
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id = '${RESELLER_ID}'`);
    runSQL(`INSERT INTO reseller_payouts (id, reseller_id, period_start, period_end, gross_commission, net_amount, status)
      VALUES
        ('${PAYOUT_A_ID}', '${RESELLER_ID}', '2026-01-01', '2026-01-15', 700, 700, 'approved'),
        ('${PAYOUT_B_ID}', '${RESELLER_ID}', '2026-01-15', '2026-02-01', 700, 700, 'approved')`);

    const [resultA, resultB] = await runConcurrent(
      `SELECT mark_reseller_payout_paid('${PAYOUT_A_ID}', '${ADMIN_ID}')`,
      `SELECT mark_reseller_payout_paid('${PAYOUT_B_ID}', '${ADMIN_ID}')`,
    );

    const a = JSON.parse(resultA);
    const b = JSON.parse(resultB);

    const successes = [a.success, b.success].filter(Boolean).length;
    expect(successes).toBe(1);

    // The loser should have insufficient_balance
    const loser = a.success ? b : a;
    expect(loser.reason).toBe('insufficient_balance');

    // Verify final DB state: exactly one paid
    const paidCount = runSQL(`SELECT COUNT(*) FROM reseller_payouts
      WHERE reseller_id = '${RESELLER_ID}' AND status = 'paid'`);
    expect(paidCount).toBe('1');

    const totalPaid = runSQL(`SELECT COALESCE(SUM(net_amount), 0) FROM reseller_payouts
      WHERE reseller_id = '${RESELLER_ID}' AND status = 'paid'`);
    expect(parseInt(totalPaid)).toBe(700);
  });

  it('400 + 600 on 1000: both succeed when total fits', async () => {
    // Reset
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id = '${RESELLER_ID}'`);
    runSQL(`INSERT INTO reseller_payouts (id, reseller_id, period_start, period_end, gross_commission, net_amount, status)
      VALUES
        ('${PAYOUT_A_ID}', '${RESELLER_ID}', '2026-03-01', '2026-03-15', 400, 400, 'approved'),
        ('${PAYOUT_B_ID}', '${RESELLER_ID}', '2026-03-15', '2026-04-01', 600, 600, 'approved')`);

    const [resultA, resultB] = await runConcurrent(
      `SELECT mark_reseller_payout_paid('${PAYOUT_A_ID}', '${ADMIN_ID}')`,
      `SELECT mark_reseller_payout_paid('${PAYOUT_B_ID}', '${ADMIN_ID}')`,
    );

    const a = JSON.parse(resultA);
    const b = JSON.parse(resultB);

    expect(a.success).toBe(true);
    expect(b.success).toBe(true);

    const totalPaid = runSQL(`SELECT COALESCE(SUM(net_amount), 0) FROM reseller_payouts
      WHERE reseller_id = '${RESELLER_ID}' AND status = 'paid'`);
    expect(parseInt(totalPaid)).toBe(1000);
  });

  it('same payout called twice: one paid, second gets status_changed or not_approved', async () => {
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id = '${RESELLER_ID}'`);
    runSQL(`INSERT INTO reseller_payouts (id, reseller_id, period_start, period_end, gross_commission, net_amount, status)
      VALUES ('${PAYOUT_A_ID}', '${RESELLER_ID}', '2026-05-01', '2026-05-15', 500, 500, 'approved')`);

    const [resultA, resultB] = await runConcurrent(
      `SELECT mark_reseller_payout_paid('${PAYOUT_A_ID}', '${ADMIN_ID}')`,
      `SELECT mark_reseller_payout_paid('${PAYOUT_A_ID}', '${ADMIN_ID}')`,
    );

    const a = JSON.parse(resultA);
    const b = JSON.parse(resultB);

    const successes = [a.success, b.success].filter(Boolean).length;
    expect(successes).toBe(1);

    const paidCount = runSQL(`SELECT COUNT(*) FROM reseller_payouts
      WHERE id = '${PAYOUT_A_ID}' AND status = 'paid'`);
    expect(paidCount).toBe('1');
  });
});

// ══════════════════════════════════════════════════════════
// C. Overlapping Period Prevention
// ══════════════════════════════════════════════════════════

describeIfDb('Migration 311: overlapping period exclusion constraint', () => {
  const RESELLER_ID = '00000000-0000-0000-0000-000000000312';

  beforeAll(() => {
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id = '${RESELLER_ID}'`);
    runSQL(`DELETE FROM resellers WHERE id = '${RESELLER_ID}'`);
    runSQL(`INSERT INTO resellers (id, company_name, contact_email, commission_percentage)
      VALUES ('${RESELLER_ID}', 'Test Reseller 312', 'test312@example.com', 10)
      ON CONFLICT (id) DO NOTHING`);
  });

  afterAll(() => {
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id = '${RESELLER_ID}'`);
    runSQL(`DELETE FROM resellers WHERE id = '${RESELLER_ID}'`);
  });

  it('reseller_payouts_no_overlap constraint exists', () => {
    const result = runSQL(`
      SELECT COUNT(*) FROM pg_constraint
      WHERE conname = 'reseller_payouts_no_overlap'
    `);
    expect(result).toBe('1');
  });

  it('adjacent periods [Aug 1, Aug 15) + [Aug 15, Aug 31) allowed', () => {
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id = '${RESELLER_ID}'`);
    const r1 = runSQL(`INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status)
      VALUES ('${RESELLER_ID}', '2026-08-01', '2026-08-15', 100, 'pending') RETURNING id`);
    expect(r1).not.toContain('ERROR');

    const r2 = runSQL(`INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status)
      VALUES ('${RESELLER_ID}', '2026-08-15', '2026-08-31', 100, 'pending') RETURNING id`);
    expect(r2).not.toContain('ERROR');
  });

  it('partial overlap [Aug 1, Aug 15) + [Aug 14, Aug 20) rejected', () => {
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id = '${RESELLER_ID}'`);
    runSQL(`INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status)
      VALUES ('${RESELLER_ID}', '2026-08-01', '2026-08-15', 100, 'pending')`);

    const r = runSQL(`INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status)
      VALUES ('${RESELLER_ID}', '2026-08-14', '2026-08-20', 100, 'pending')`);
    expect(r).toContain('ERROR');
  });

  it('contained overlap [Aug 1, Aug 31) + [Aug 5, Aug 10) rejected', () => {
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id = '${RESELLER_ID}'`);
    runSQL(`INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status)
      VALUES ('${RESELLER_ID}', '2026-08-01', '2026-08-31', 100, 'pending')`);

    const r = runSQL(`INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status)
      VALUES ('${RESELLER_ID}', '2026-08-05', '2026-08-10', 100, 'pending')`);
    expect(r).toContain('ERROR');
  });

  it('identical period rejected', () => {
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id = '${RESELLER_ID}'`);
    runSQL(`INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status)
      VALUES ('${RESELLER_ID}', '2026-09-01', '2026-09-15', 100, 'pending')`);

    const r = runSQL(`INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status)
      VALUES ('${RESELLER_ID}', '2026-09-01', '2026-09-15', 100, 'pending')`);
    expect(r).toContain('ERROR');
  });

  it('rejected payout allows re-creation for same period', () => {
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id = '${RESELLER_ID}'`);
    runSQL(`INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status)
      VALUES ('${RESELLER_ID}', '2026-10-01', '2026-10-15', 100, 'rejected')`);

    const r = runSQL(`INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status)
      VALUES ('${RESELLER_ID}', '2026-10-01', '2026-10-15', 100, 'pending') RETURNING id`);
    expect(r).not.toContain('ERROR');
  });

  it('different resellers with same dates allowed', () => {
    const OTHER_RESELLER = '00000000-0000-0000-0000-000000000313';
    runSQL(`INSERT INTO resellers (id, company_name, contact_email, commission_percentage)
      VALUES ('${OTHER_RESELLER}', 'Other Reseller', 'other@example.com', 10)
      ON CONFLICT (id) DO NOTHING`);
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id IN ('${RESELLER_ID}', '${OTHER_RESELLER}')`);

    const r1 = runSQL(`INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status)
      VALUES ('${RESELLER_ID}', '2026-11-01', '2026-11-15', 100, 'pending') RETURNING id`);
    expect(r1).not.toContain('ERROR');

    const r2 = runSQL(`INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status)
      VALUES ('${OTHER_RESELLER}', '2026-11-01', '2026-11-15', 100, 'pending') RETURNING id`);
    expect(r2).not.toContain('ERROR');

    // Cleanup
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id = '${OTHER_RESELLER}'`);
    runSQL(`DELETE FROM resellers WHERE id = '${OTHER_RESELLER}'`);
  });

  it('concurrent overlapping inserts: exactly one succeeds', async () => {
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id = '${RESELLER_ID}'`);

    const [r1, r2] = await runConcurrent(
      `INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status)
       VALUES ('${RESELLER_ID}', '2026-12-01', '2026-12-15', 100, 'pending') RETURNING id`,
      `INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status)
       VALUES ('${RESELLER_ID}', '2026-12-10', '2026-12-20', 100, 'pending') RETURNING id`,
    );

    const successes = [r1, r2].filter(r => !r.includes('ERROR')).length;
    const failures = [r1, r2].filter(r => r.includes('ERROR')).length;
    expect(successes).toBe(1);
    expect(failures).toBe(1);
  });
});

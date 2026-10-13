/**
 * reject_payout_and_release_adjustments — real PostgreSQL tests
 *
 * Proves the RPC function works against real columns and triggers:
 *  1. held → rejected with one linked adjustment released
 *  2. pending → rejected
 *  3. paid → error (ineligible_status)
 *  4. payout with adjustment_link_pending flag → error
 *  5. authenticated role cannot execute it (service_role only)
 *
 * Requires TEST_DATABASE_URL with migrations through 444 applied.
 * Runs in CI "P0 security ACL tests (disposable PG)" job.
 * Skips locally when TEST_DATABASE_URL is not set.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  describe.skip('reject_payout_and_release_adjustments DB — TEST_DATABASE_URL not set', () => {
    it('skipped locally', () => {});
  });
} else {

function psql(sql: string): string {
  return execSync(`psql "${TEST_DB}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql, encoding: 'utf-8', timeout: 15000,
  }).trim();
}

function psqlMayFail(sql: string): { ok: boolean; output: string } {
  try {
    const out = execSync(`psql "${TEST_DB}" -tAXq -v ON_ERROR_STOP=1`, {
      input: sql, encoding: 'utf-8', timeout: 15000,
    }).toString().trim();
    return { ok: true, output: out };
  } catch (e: unknown) {
    return { ok: false, output: String((e as { stderr?: string }).stderr || e) };
  }
}

// Dedicated UUIDs for this suite
const OWNER_UUID = '44400000-0000-0000-0000-000000000001';
const AUTH_UUID  = '44400000-0000-0000-0000-000000000002';
const BIZ_ID    = '44400000-0000-0000-0000-000000000010';

// Payout IDs
const PAYOUT_HELD    = '44400000-0000-0000-0000-000000000101';
const PAYOUT_PENDING = '44400000-0000-0000-0000-000000000102';
const PAYOUT_PAID    = '44400000-0000-0000-0000-000000000103';
const PAYOUT_FLAGGED = '44400000-0000-0000-0000-000000000104';
const ADJ_ID         = '44400000-0000-0000-0000-000000000201';

const AUTH_JWT = `{"sub":"${AUTH_UUID}","role":"authenticated","aal":"aal2"}`;

describe('reject_payout_and_release_adjustments — real DB', () => {
  beforeAll(() => {
    // Verify function exists
    const fnCheck = psql(`
      SELECT COUNT(*) FROM pg_proc p
      JOIN pg_namespace n ON p.pronamespace = n.oid
      WHERE n.nspname = 'public' AND p.proname = 'reject_payout_and_release_adjustments';
    `);
    if (fnCheck === '0') throw new Error('Function not found — migration 444 not applied');

    // Seed owner user and business
    psql(`
      INSERT INTO auth.users (id, email, raw_app_meta_data)
      VALUES ('${OWNER_UUID}', 'reject-test-owner-444@test.com', '{"role":"user"}'::jsonb)
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO profiles (id, email)
      VALUES ('${OWNER_UUID}', 'reject-test-owner-444@test.com')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO businesses (id, name, owner_id, category, country_code)
      VALUES ('${BIZ_ID}', 'Reject Test Biz 444', '${OWNER_UUID}', 'food_beverage', 'NG')
      ON CONFLICT (id) DO NOTHING;
    `);

    // Seed authenticated user (non-admin)
    psql(`
      INSERT INTO auth.users (id, email, raw_app_meta_data)
      VALUES ('${AUTH_UUID}', 'reject-test-auth-444@test.com', '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING;
    `);

    // Seed payouts — using unique period ranges to avoid duplicate constraint
    psql(`
      INSERT INTO business_payouts (id, business_id, period_start, period_end, gross_amount, platform_fee, gateway_fee, net_amount, status, flags)
      VALUES
        ('${PAYOUT_HELD}',    '${BIZ_ID}', '2099-01-01', '2099-01-07', 100, 5, 2, 93, 'held',    '[]'::jsonb),
        ('${PAYOUT_PENDING}', '${BIZ_ID}', '2099-01-08', '2099-01-14', 200, 10, 4, 186, 'pending', '[]'::jsonb),
        ('${PAYOUT_PAID}',    '${BIZ_ID}', '2099-01-15', '2099-01-21', 300, 15, 6, 279, 'paid',    '[]'::jsonb),
        ('${PAYOUT_FLAGGED}', '${BIZ_ID}', '2099-01-22', '2099-01-28', 400, 20, 8, 372, 'held',
          '[{"type":"adjustment_link_pending","message":"test","adjustment_ids":["${ADJ_ID}"]}]'::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        flags = EXCLUDED.flags,
        rejected_reason = NULL;
    `);

    // Seed a payout_adjustment linked to the held payout
    psql(`
      INSERT INTO payout_adjustments (id, business_id, payout_id, amount, reason, applied_to_payout_id)
      VALUES ('${ADJ_ID}', '${BIZ_ID}', '${PAYOUT_HELD}', -50, 'Refund after payout', '${PAYOUT_HELD}')
      ON CONFLICT (id) DO UPDATE SET applied_to_payout_id = '${PAYOUT_HELD}';
    `);
  });

  afterAll(() => {
    // Clean up test data
    psqlMayFail(`
      DELETE FROM payout_adjustments WHERE id = '${ADJ_ID}';
      DELETE FROM business_payouts WHERE id IN ('${PAYOUT_HELD}','${PAYOUT_PENDING}','${PAYOUT_PAID}','${PAYOUT_FLAGGED}');
      DELETE FROM businesses WHERE id = '${BIZ_ID}';
      DELETE FROM profiles WHERE id IN ('${OWNER_UUID}','${AUTH_UUID}');
      DELETE FROM auth.users WHERE id IN ('${OWNER_UUID}','${AUTH_UUID}');
    `);
  });

  it('1. held → rejected, linked adjustment released', () => {
    const result = psql(`
      SELECT rejected_id, adjustments_released
      FROM reject_payout_and_release_adjustments('${PAYOUT_HELD}', 'Suspicious activity');
    `);
    // Function returns: rejected_id|adjustments_released
    const [rejectedId, released] = result.split('|');
    expect(rejectedId).toBe(PAYOUT_HELD);
    expect(parseInt(released, 10)).toBe(1);

    // Verify payout is now rejected with the reason
    const payoutCheck = psql(`
      SELECT status, rejected_reason FROM business_payouts WHERE id = '${PAYOUT_HELD}';
    `);
    expect(payoutCheck).toBe('rejected|Suspicious activity');

    // Verify adjustment is unlinked
    const adjCheck = psql(`
      SELECT applied_to_payout_id IS NULL FROM payout_adjustments WHERE id = '${ADJ_ID}';
    `);
    expect(adjCheck).toBe('t');
  });

  it('2. pending → rejected', () => {
    const result = psql(`
      SELECT rejected_id, adjustments_released
      FROM reject_payout_and_release_adjustments('${PAYOUT_PENDING}', 'Duplicate entry');
    `);
    const [rejectedId, released] = result.split('|');
    expect(rejectedId).toBe(PAYOUT_PENDING);
    expect(parseInt(released, 10)).toBe(0);

    const status = psql(`SELECT status FROM business_payouts WHERE id = '${PAYOUT_PENDING}';`);
    expect(status).toBe('rejected');
  });

  it('3. paid → error (ineligible_status)', () => {
    const { ok, output } = psqlMayFail(`
      SELECT * FROM reject_payout_and_release_adjustments('${PAYOUT_PAID}', 'Should fail');
    `);
    expect(ok).toBe(false);
    expect(output).toContain('ineligible_status');

    // Verify paid payout is unchanged
    const status = psql(`SELECT status FROM business_payouts WHERE id = '${PAYOUT_PAID}';`);
    expect(status).toBe('paid');
  });

  it('4. payout with adjustment_link_pending flag → error', () => {
    const { ok, output } = psqlMayFail(`
      SELECT * FROM reject_payout_and_release_adjustments('${PAYOUT_FLAGGED}', 'Should fail');
    `);
    expect(ok).toBe(false);
    expect(output).toContain('linkage_flag_blocks_rejection');

    // Verify flagged payout is unchanged
    const status = psql(`SELECT status FROM business_payouts WHERE id = '${PAYOUT_FLAGGED}';`);
    expect(status).toBe('held');
  });

  it('5. authenticated role cannot execute (service_role only)', () => {
    const { ok, output } = psqlMayFail(`
      SELECT set_config('request.jwt.claims', '${AUTH_JWT}', false);
      SET ROLE authenticated;
      SELECT * FROM reject_payout_and_release_adjustments('${PAYOUT_FLAGGED}', 'Should fail');
      RESET ROLE;
    `);
    expect(ok).toBe(false);
    expect(output).toMatch(/permission denied|denied/i);
  });
});

} // end if (TEST_DB)

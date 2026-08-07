/**
 * P1-LOYAL-1 — Real PostgreSQL RLS tests for loyalty_transactions UPDATE policy
 * Requires TEST_DATABASE_URL.
 *
 * Proves:
 * 1. Service-role can UPDATE loyalty_transactions
 * 2. Business owner can UPDATE their own loyalty_transactions
 * 3. Different business owner cannot UPDATE another business's transactions
 * 4. Anonymous cannot UPDATE loyalty_transactions
 * 5. Existing SELECT behavior remains correct
 * 6. Owner UPDATE WITH CHECK prevents changing business_id to another tenant
 * 7. RLS remains enabled on loyalty_transactions
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';

const dbUrl = process.env.TEST_DATABASE_URL;

function psql(sql: string): string {
  const raw = execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, { input: sql, encoding: 'utf-8', timeout: 15000 });
  return raw.split('\n').filter(l => { const t = l.trim(); return t !== '' && !/^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|DO|SET|COMMENT)\b/.test(t); }).join('\n').trim();
}

const BIZ_A = '88aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BIZ_B = '88bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const OWNER_A = '88cccccc-cccc-cccc-cccc-aaaaaaaaaaaa';
const OWNER_B = '88cccccc-cccc-cccc-cccc-bbbbbbbbbbbb';

describe.skipIf(!dbUrl)('P1-LOYAL-1: loyalty_transactions UPDATE RLS', () => {
  beforeAll(() => {
    if (!dbUrl) return;
    psql(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";
      DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE TABLE IF NOT EXISTS auth.users (id UUID PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $$ SELECT current_setting('app.current_user_id', true)::UUID; $$;
      CREATE OR REPLACE FUNCTION auth.role() RETURNS TEXT LANGUAGE sql STABLE AS $$ SELECT current_setting('role', true); $$;

      CREATE TABLE IF NOT EXISTS businesses (id UUID PRIMARY KEY, owner_id UUID);
      INSERT INTO businesses VALUES ('${BIZ_A}', '${OWNER_A}') ON CONFLICT DO NOTHING;
      INSERT INTO businesses VALUES ('${BIZ_B}', '${OWNER_B}') ON CONFLICT DO NOTHING;

      CREATE TABLE IF NOT EXISTS loyalty_transactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL,
        customer_phone TEXT,
        points_change INTEGER DEFAULT 0,
        reason TEXT CHECK (reason IN ('visit','purchase','redemption','bonus','referral')),
        reference_id UUID,
        reference_type TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      ALTER TABLE loyalty_transactions ENABLE ROW LEVEL SECURITY;
      GRANT ALL ON loyalty_transactions TO authenticated, service_role;

      -- Existing policies from migration 020
      CREATE POLICY "loyalty_transactions_owner_select" ON loyalty_transactions
        FOR SELECT USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
      CREATE POLICY "loyalty_transactions_owner_insert" ON loyalty_transactions
        FOR INSERT WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
      CREATE POLICY "loyalty_transactions_service_insert" ON loyalty_transactions
        FOR INSERT WITH CHECK (auth.role() = 'service_role');

      -- NEW policies from migration 309
      CREATE POLICY "loyalty_transactions_service_update" ON loyalty_transactions
        FOR UPDATE USING (auth.role() = 'service_role');
      CREATE POLICY "loyalty_transactions_owner_update" ON loyalty_transactions
        FOR UPDATE
        USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()))
        WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
    `);
  });

  afterAll(() => {
    if (!dbUrl) return;
    psql(`DROP TABLE IF EXISTS loyalty_transactions, businesses CASCADE;`);
  });

  function resetTxns() {
    psql(`DELETE FROM loyalty_transactions;`);
    psql(`INSERT INTO loyalty_transactions (business_id, customer_phone, points_change, reason, reference_type) VALUES ('${BIZ_A}', '+234111', -10, 'redemption', 'loyalty_points');`);
    psql(`INSERT INTO loyalty_transactions (business_id, customer_phone, points_change, reason, reference_type) VALUES ('${BIZ_B}', '+234222', -5, 'redemption', 'loyalty_points');`);
  }

  it('1. service_role can UPDATE loyalty_transactions', () => {
    resetTxns();
    // service_role bypasses RLS, but the policy should still exist
    const count = psql(`
      SET ROLE service_role;
      SET app.current_user_id = '00000000-0000-0000-0000-000000000000';
      UPDATE loyalty_transactions SET reference_type = 'code:RW-TEST01' WHERE business_id = '${BIZ_A}' AND reason = 'redemption';
      SELECT COUNT(*) FROM loyalty_transactions WHERE reference_type = 'code:RW-TEST01';
    `);
    psql(`RESET ROLE;`);
    expect(count).toBe('1');
  });

  it('2. business owner can UPDATE their own loyalty_transactions', () => {
    resetTxns();
    const count = psql(`
      SET ROLE authenticated;
      SET app.current_user_id = '${OWNER_A}';
      UPDATE loyalty_transactions SET reference_type = 'code:RW-OWNRA' WHERE business_id = '${BIZ_A}';
      SELECT COUNT(*) FROM loyalty_transactions WHERE reference_type = 'code:RW-OWNRA';
    `);
    psql(`RESET ROLE;`);
    expect(count).toBe('1');
  });

  it('3. different business owner cannot UPDATE another business transactions', () => {
    resetTxns();
    // Owner B tries to update business A's transactions
    const count = psql(`
      SET ROLE authenticated;
      SET app.current_user_id = '${OWNER_B}';
      UPDATE loyalty_transactions SET reference_type = 'code:STOLEN' WHERE business_id = '${BIZ_A}';
      RESET ROLE;
      SELECT COUNT(*) FROM loyalty_transactions WHERE reference_type = 'code:STOLEN';
    `);
    expect(count).toBe('0');
  });

  it('4. anonymous cannot UPDATE loyalty_transactions', () => {
    resetTxns();
    const count = psql(`
      SET ROLE anon;
      UPDATE loyalty_transactions SET reference_type = 'code:ANON' WHERE business_id = '${BIZ_A}';
      RESET ROLE;
      SELECT COUNT(*) FROM loyalty_transactions WHERE reference_type = 'code:ANON';
    `);
    expect(count).toBe('0');
  });

  it('5. existing SELECT behavior: owner can read own transactions', () => {
    resetTxns();
    const count = psql(`
      SET ROLE authenticated;
      SET app.current_user_id = '${OWNER_A}';
      SELECT COUNT(*) FROM loyalty_transactions WHERE business_id = '${BIZ_A}';
    `);
    psql(`RESET ROLE;`);
    expect(count).toBe('1');
  });

  it('6. owner UPDATE WITH CHECK prevents changing business_id to another tenant', () => {
    resetTxns();
    // Owner A tries to move their transaction to business B
    const count = psql(`
      SET ROLE authenticated;
      SET app.current_user_id = '${OWNER_A}';
      UPDATE loyalty_transactions SET business_id = '${BIZ_B}' WHERE business_id = '${BIZ_A}';
      RESET ROLE;
      SELECT COUNT(*) FROM loyalty_transactions WHERE business_id = '${BIZ_B}';
    `);
    // Should still be 1 (the original BIZ_B row), not 2
    expect(count).toBe('1');
  });

  it('7. RLS remains enabled on loyalty_transactions', () => {
    const enabled = psql(`SELECT rowsecurity FROM pg_tables WHERE tablename = 'loyalty_transactions';`);
    expect(enabled).toBe('t');
  });
});

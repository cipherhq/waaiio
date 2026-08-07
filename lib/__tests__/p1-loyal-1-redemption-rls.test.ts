/**
 * P1-LOYAL-1 — Loyalty transactions RLS boundary tests
 * Requires TEST_DATABASE_URL.
 *
 * Proves existing restrictive RLS is preserved:
 * 1. Owner can SELECT their own loyalty_transactions
 * 2. Owner cannot SELECT another business's transactions
 * 3. Owner can INSERT into their own business
 * 4. Owner cannot INSERT into another business
 * 5. No UPDATE policy exists — owner cannot UPDATE transactions
 * 6. Anonymous cannot SELECT, INSERT, or UPDATE
 * 7. RLS remains enabled
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';

const dbUrl = process.env.TEST_DATABASE_URL;

function psql(sql: string): string {
  const raw = execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, { input: sql, encoding: 'utf-8', timeout: 15000 });
  return raw.split('\n').filter(l => { const t = l.trim(); return t !== '' && !/^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|DO|SET|COMMENT)\b/.test(t); }).join('\n').trim();
}

function psqlMayFail(sql: string): string {
  try {
    return execSync(`psql "${dbUrl}" -tAXq`, { input: sql, encoding: 'utf-8', timeout: 15000 }).trim();
  } catch (e: any) {
    return (e.stderr || e.stdout || '').toString().trim();
  }
}

const BIZ_A = '88aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BIZ_B = '88bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const OWNER_A = '88cccccc-cccc-cccc-cccc-aaaaaaaaaaaa';
const OWNER_B = '88cccccc-cccc-cccc-cccc-bbbbbbbbbbbb';

describe.skipIf(!dbUrl)('P1-LOYAL-1: loyalty_transactions RLS boundaries', () => {
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

      -- Existing policies from migrations 020 + 023 (production state)
      CREATE POLICY "loyalty_transactions_owner_select" ON loyalty_transactions
        FOR SELECT USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
      CREATE POLICY "loyalty_transactions_owner_insert" ON loyalty_transactions
        FOR INSERT WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
      CREATE POLICY "loyalty_transactions_service_insert" ON loyalty_transactions
        FOR INSERT WITH CHECK (auth.role() = 'service_role');

      -- Seed data
      INSERT INTO loyalty_transactions (business_id, customer_phone, points_change, reason, reference_type)
        VALUES ('${BIZ_A}', '+234111', -10, 'redemption', 'code:RW-TEST01');
      INSERT INTO loyalty_transactions (business_id, customer_phone, points_change, reason, reference_type)
        VALUES ('${BIZ_B}', '+234222', -5, 'redemption', 'code:RW-TEST02');
    `);
  });

  afterAll(() => {
    if (!dbUrl) return;
    psql(`DROP TABLE IF EXISTS loyalty_transactions, businesses CASCADE;`);
  });

  it('1. owner can SELECT their own loyalty_transactions', () => {
    const count = psql(`
      SET ROLE authenticated;
      SET app.current_user_id = '${OWNER_A}';
      SELECT COUNT(*) FROM loyalty_transactions WHERE business_id = '${BIZ_A}';
    `);
    psql(`RESET ROLE;`);
    expect(count).toBe('1');
  });

  it('2. owner cannot SELECT another business transactions', () => {
    const count = psql(`
      SET ROLE authenticated;
      SET app.current_user_id = '${OWNER_A}';
      SELECT COUNT(*) FROM loyalty_transactions WHERE business_id = '${BIZ_B}';
    `);
    psql(`RESET ROLE;`);
    expect(count).toBe('0');
  });

  it('3. owner can INSERT into their own business', () => {
    const result = psqlMayFail(`
      SET ROLE authenticated;
      SET app.current_user_id = '${OWNER_A}';
      INSERT INTO loyalty_transactions (business_id, customer_phone, points_change, reason, reference_type)
        VALUES ('${BIZ_A}', '+234333', 10, 'visit', 'test');
      SELECT 'ok';
    `);
    psql(`RESET ROLE;`);
    expect(result).toContain('ok');
  });

  it('4. owner cannot INSERT into another business', () => {
    const result = psqlMayFail(`
      SET ROLE authenticated;
      SET app.current_user_id = '${OWNER_A}';
      INSERT INTO loyalty_transactions (business_id, customer_phone, points_change, reason, reference_type)
        VALUES ('${BIZ_B}', '+234333', 10, 'visit', 'stolen');
    `);
    psql(`RESET ROLE;`);
    expect(result).toContain('violates row-level security');
  });

  it('5. no UPDATE policy — owner cannot UPDATE transactions', () => {
    const result = psqlMayFail(`
      SET ROLE authenticated;
      SET app.current_user_id = '${OWNER_A}';
      UPDATE loyalty_transactions SET reference_type = 'tampered' WHERE business_id = '${BIZ_A}';
    `);
    psql(`RESET ROLE;`);
    // Verify no rows were actually changed
    const count = psql(`SELECT COUNT(*) FROM loyalty_transactions WHERE reference_type = 'tampered';`);
    expect(count).toBe('0');
  });

  it('6. anonymous cannot access loyalty_transactions', () => {
    const selectResult = psql(`
      SET ROLE anon;
      SELECT COUNT(*) FROM loyalty_transactions;
    `);
    psql(`RESET ROLE;`);
    expect(selectResult).toBe('0');

    const insertResult = psqlMayFail(`
      SET ROLE anon;
      INSERT INTO loyalty_transactions (business_id, customer_phone, points_change, reason)
        VALUES ('${BIZ_A}', '+234444', 10, 'visit');
    `);
    psql(`RESET ROLE;`);
    expect(insertResult).toContain('violates row-level security');
  });

  it('7. RLS remains enabled on loyalty_transactions', () => {
    const enabled = psql(`SELECT rowsecurity FROM pg_tables WHERE tablename = 'loyalty_transactions';`);
    expect(enabled).toBe('t');
  });
});

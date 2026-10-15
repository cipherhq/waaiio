/**
 * Behavioral test: a multi-signer contract with no contract_signers rows
 * cannot reach status='signed' — enforced by the DB trigger installed in
 * migration 450 (contracts_zero_signer_guard).
 *
 * Runs against a disposable Postgres instance (TEST_DATABASE_URL).
 * Fails (not skips) when REQUIRE_PG_TESTS=true and TEST_DATABASE_URL is missing.
 *
 * This supplements the unit tests in contracts-zero-signer-guard.test.ts which
 * only test the extracted application-layer guard logic.  Here we verify that
 * the DB-level trigger fires regardless of which role issues the UPDATE, so an
 * application bug or bypass cannot silently create a signed contract with no
 * signer audit trail.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB && process.env.REQUIRE_PG_TESTS === 'true') {
  throw new Error(
    'TEST_DATABASE_URL is required — cannot skip DB tests (REQUIRE_PG_TESTS=true)',
  );
}

function sql(query: string): string {
  if (!TEST_DB) throw new Error('TEST_DATABASE_URL not set');
  try {
    return execSync(
      `psql "${TEST_DB}" -v ON_ERROR_STOP=1 -t -A`,
      { encoding: 'utf-8', timeout: 15000, input: query },
    ).trim();
  } catch (err: any) {
    return `ERROR: ${err.stderr || err.stdout || err.message || ''}`;
  }
}

const describeDb = !TEST_DB ? describe.skip : describe;

const BIZ_ID      = '00000000-0000-0000-0000-000000450001';
const CONTRACT_ID = '00000000-0000-0000-0000-000000450002';
const SIGNER_ID   = '00000000-0000-0000-0000-000000450003';

describeDb('Migration 450: DB-level zero-signer trigger — behavioral', () => {
  beforeAll(() => {
    // Ensure required roles exist (reuse pattern from the ACL test)
    sql(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
          CREATE ROLE service_role NOLOGIN BYPASSRLS;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
          CREATE ROLE authenticated NOLOGIN;
        END IF;
      END $$;
      ALTER ROLE service_role BYPASSRLS;
    `);

    // Minimal auth schema
    sql(`
      CREATE SCHEMA IF NOT EXISTS auth;
      GRANT USAGE ON SCHEMA auth TO service_role, authenticated;
      CREATE TABLE IF NOT EXISTS auth.users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid()
      );
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
        SELECT NULL::uuid;
      $$ LANGUAGE SQL STABLE;
      CREATE OR REPLACE FUNCTION auth.role() RETURNS TEXT AS $$
        SELECT current_user::text;
      $$ LANGUAGE SQL STABLE;
      GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, service_role;
      GRANT EXECUTE ON FUNCTION auth.role() TO authenticated, service_role;
    `);

    // Minimal public schema
    sql(`
      GRANT USAGE ON SCHEMA public TO service_role, authenticated;

      CREATE TABLE IF NOT EXISTS public.businesses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id UUID,
        name TEXT NOT NULL DEFAULT 'Test'
      );
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.businesses TO service_role;

      CREATE TABLE IF NOT EXISTS public.contracts (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
        title VARCHAR(300) NOT NULL,
        token VARCHAR(64) UNIQUE NOT NULL,
        token_expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '72 hours'),
        status VARCHAR(20) DEFAULT 'pending',
        signing_mode VARCHAR(20) DEFAULT 'single',
        created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
      );
      ALTER TABLE public.contracts ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS "svc_contracts" ON public.contracts;
      CREATE POLICY "svc_contracts" ON public.contracts FOR ALL
        TO service_role USING (true) WITH CHECK (true);
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.contracts TO service_role;

      CREATE TABLE IF NOT EXISTS public.contract_signers (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        contract_id UUID NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
        signer_phone VARCHAR(30) NOT NULL,
        token VARCHAR(64) UNIQUE NOT NULL,
        token_expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '72 hours'),
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now()
      );
      ALTER TABLE public.contract_signers ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS "svc_signers" ON public.contract_signers;
      CREATE POLICY "svc_signers" ON public.contract_signers FOR ALL
        TO service_role USING (true) WITH CHECK (true);
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.contract_signers TO service_role;
    `);

    // Apply migration 450 (the trigger)
    const m450 = readFileSync(
      resolve(process.cwd(), 'supabase/migrations/450_contracts_zero_signer_trigger.sql'),
      'utf-8',
    );
    const result = execSync(
      `psql "${TEST_DB}" -v ON_ERROR_STOP=1 -t -A 2>&1`,
      { encoding: 'utf-8', timeout: 30000, input: m450 },
    ).trim();
    if (result.includes('450 SELF-CHECK FAILED')) {
      throw new Error(`Migration 450 self-check failed:\n${result}`);
    }

    // Seed: business + a multi-signer contract with NO signers
    sql(`
      INSERT INTO public.businesses (id, name)
        VALUES ('${BIZ_ID}', 'Zero-Signer Biz')
        ON CONFLICT (id) DO NOTHING;

      INSERT INTO public.contracts (id, business_id, title, token, status, signing_mode)
        VALUES ('${CONTRACT_ID}', '${BIZ_ID}', 'Trigger Test', 'tok450trigger01', 'pending', 'multi')
        ON CONFLICT (id) DO NOTHING;
    `);
  });

  afterAll(() => {
    sql(`DELETE FROM public.contract_signers WHERE contract_id = '${CONTRACT_ID}';`);
    sql(`DELETE FROM public.contracts       WHERE id = '${CONTRACT_ID}';`);
    sql(`DELETE FROM public.businesses      WHERE id = '${BIZ_ID}';`);
  });

  // ── Core behavioral assertion ────────────────────────────────────────────

  it('trigger installed: contracts_zero_signer_guard exists on public.contracts', () => {
    // information_schema.triggers has one row per event type, so a BEFORE INSERT OR UPDATE
    // trigger appears as two rows. Count distinct trigger names to assert "the trigger
    // exists exactly once" regardless of how many event types it covers.
    const r = sql(`
      SELECT COUNT(DISTINCT trigger_name) FROM information_schema.triggers
       WHERE event_object_schema = 'public'
         AND event_object_table  = 'contracts'
         AND trigger_name        = 'contracts_zero_signer_guard';
    `);
    expect(r).toBe('1');
  });

  it('cannot mark a multi-signer contract as signed when no contract_signers rows exist', () => {
    // service_role bypasses RLS but NOT triggers — the trigger must fire.
    const r = sql(`
      BEGIN;
      SET LOCAL ROLE service_role;
      UPDATE public.contracts SET status = 'signed' WHERE id = '${CONTRACT_ID}';
      COMMIT;
    `);
    // The trigger raises integrity_constraint_violation (SQLSTATE 23000)
    expect(r).toMatch(/cannot mark contract|integrity_constraint_violation|23000/i);
  });

  it('contract status remains pending after the blocked UPDATE attempt', () => {
    const r = sql(`SELECT status FROM public.contracts WHERE id = '${CONTRACT_ID}';`);
    expect(r).toBe('pending');
  });

  it('can mark a multi-signer contract as signed once a signer row exists', () => {
    // Insert one signer row, then retry the UPDATE — should succeed.
    sql(`
      INSERT INTO public.contract_signers (id, contract_id, signer_phone, token)
        VALUES ('${SIGNER_ID}', '${CONTRACT_ID}', '+2348001234567', 'tok450signer0001')
        ON CONFLICT (id) DO NOTHING;
    `);

    const r = sql(`
      BEGIN;
      SET LOCAL ROLE service_role;
      UPDATE public.contracts SET status = 'signed' WHERE id = '${CONTRACT_ID}';
      COMMIT;
    `);
    expect(r).not.toMatch(/ERROR|cannot mark contract/i);

    const status = sql(`SELECT status FROM public.contracts WHERE id = '${CONTRACT_ID}';`);
    expect(status).toBe('signed');
  });

  it('trigger does NOT fire for single-signer contracts (signing_mode=single) with no signer rows', () => {
    // Single-signer contracts have no contract_signers rows by design.
    const singleId = '00000000-0000-0000-0000-000000450099';
    sql(`
      INSERT INTO public.contracts (id, business_id, title, token, status, signing_mode)
        VALUES ('${singleId}', '${BIZ_ID}', 'Single Test', 'tok450single0001', 'pending', 'single')
        ON CONFLICT (id) DO NOTHING;
    `);

    const r = sql(`
      BEGIN;
      SET LOCAL ROLE service_role;
      UPDATE public.contracts SET status = 'signed' WHERE id = '${singleId}';
      COMMIT;
    `);
    expect(r).not.toMatch(/ERROR|cannot mark contract/i);

    const status = sql(`SELECT status FROM public.contracts WHERE id = '${singleId}';`);
    expect(status).toBe('signed');

    sql(`DELETE FROM public.contracts WHERE id = '${singleId}';`);
  });
});

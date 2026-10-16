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
 *
 * Extended M450 assertions (ChatGPT review fixes):
 *   - All signers must have status='signed' before the contract can be signed
 *     (no unsigned signer may remain — mirrors the submit route ordering guarantee)
 *   - trigger installed check
 *   - function search_path hardened (pg_temp)
 *   - REVOKE ALL on function verified
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

  it('can mark a multi-signer contract as signed once ALL signers have signed', () => {
    // Insert one signer row with status='signed', then retry the UPDATE — should succeed.
    sql(`
      INSERT INTO public.contract_signers (id, contract_id, signer_phone, token, status)
        VALUES ('${SIGNER_ID}', '${CONTRACT_ID}', '+2348001234567', 'tok450signer0001', 'signed')
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

  // ── Extended M450: unsigned-signer guard ─────────────────────────────────
  //
  // A multi-signer contract cannot become 'signed' if any signer row is still
  // in a non-signed state.  This mirrors the submit route ordering guarantee.

  it('extended guard: cannot sign a multi-signer contract when a signer is still pending', () => {
    const cId  = '00000000-0000-0000-0000-000000450a01';
    const s1Id = '00000000-0000-0000-0000-000000450a02';
    const s2Id = '00000000-0000-0000-0000-000000450a03';

    sql(`
      BEGIN;
      SET LOCAL ROLE service_role;
      INSERT INTO public.contracts (id, business_id, title, token, status, signing_mode)
        VALUES ('${cId}', '${BIZ_ID}', 'Unsigned Guard', 'tok450guard0001', 'active', 'parallel');
      INSERT INTO public.contract_signers (id, contract_id, signer_phone, token, status)
        VALUES ('${s1Id}', '${cId}', '+2348000000001', 'tok450gs001', 'signed');
      INSERT INTO public.contract_signers (id, contract_id, signer_phone, token, status)
        VALUES ('${s2Id}', '${cId}', '+2348000000002', 'tok450gs002', 'pending');  -- not signed yet
      COMMIT;
    `);

    // Attempt to sign: s2 is still pending — trigger must block it
    const r = sql(`
      BEGIN;
      SET LOCAL ROLE service_role;
      UPDATE public.contracts SET status = 'signed' WHERE id = '${cId}';
      COMMIT;
    `);
    expect(r).toMatch(/cannot mark contract|integrity_constraint_violation|23000/i);

    const status = sql(`SELECT status FROM public.contracts WHERE id = '${cId}';`);
    expect(status).toBe('active');

    sql(`DELETE FROM public.contract_signers WHERE contract_id = '${cId}';`);
    sql(`DELETE FROM public.contracts WHERE id = '${cId}';`);
  });

  it('extended guard: multi-signer contract CAN be signed when ALL signers have status=signed', () => {
    const cId  = '00000000-0000-0000-0000-000000450b01';
    const s1Id = '00000000-0000-0000-0000-000000450b02';
    const s2Id = '00000000-0000-0000-0000-000000450b03';

    sql(`
      BEGIN;
      SET LOCAL ROLE service_role;
      INSERT INTO public.contracts (id, business_id, title, token, status, signing_mode)
        VALUES ('${cId}', '${BIZ_ID}', 'All Signed', 'tok450allsign01', 'active', 'parallel');
      INSERT INTO public.contract_signers (id, contract_id, signer_phone, token, status)
        VALUES ('${s1Id}', '${cId}', '+2348000000003', 'tok450as001', 'signed');
      INSERT INTO public.contract_signers (id, contract_id, signer_phone, token, status)
        VALUES ('${s2Id}', '${cId}', '+2348000000004', 'tok450as002', 'signed');
      COMMIT;
    `);

    // Both signers are signed — marking the contract signed should succeed
    const r = sql(`
      BEGIN;
      SET LOCAL ROLE service_role;
      UPDATE public.contracts SET status = 'signed' WHERE id = '${cId}';
      COMMIT;
    `);
    expect(r).not.toMatch(/ERROR|cannot mark contract/i);

    const status = sql(`SELECT status FROM public.contracts WHERE id = '${cId}';`);
    expect(status).toBe('signed');

    sql(`DELETE FROM public.contract_signers WHERE contract_id = '${cId}';`);
    sql(`DELETE FROM public.contracts WHERE id = '${cId}';`);
  });

  it('extended guard: sequential signing sequence — last signer signs, then contract can be signed', () => {
    const cId  = '00000000-0000-0000-0000-000000450c01';
    const s1Id = '00000000-0000-0000-0000-000000450c02';
    const s2Id = '00000000-0000-0000-0000-000000450c03';

    sql(`
      BEGIN;
      SET LOCAL ROLE service_role;
      INSERT INTO public.contracts (id, business_id, title, token, status, signing_mode)
        VALUES ('${cId}', '${BIZ_ID}', 'Sequential Test', 'tok450seq00001', 'active', 'sequential');
      INSERT INTO public.contract_signers (id, contract_id, signer_phone, token, status)
        VALUES ('${s1Id}', '${cId}', '+2348000000005', 'tok450seq001', 'pending');
      INSERT INTO public.contract_signers (id, contract_id, signer_phone, token, status)
        VALUES ('${s2Id}', '${cId}', '+2348000000006', 'tok450seq002', 'pending');
      COMMIT;
    `);

    // Step 1: first signer signs
    sql(`
      BEGIN;
      SET LOCAL ROLE service_role;
      UPDATE public.contract_signers SET status = 'signed' WHERE id = '${s1Id}';
      COMMIT;
    `);

    // Still cannot sign: s2 is pending
    const r1 = sql(`
      BEGIN;
      SET LOCAL ROLE service_role;
      UPDATE public.contracts SET status = 'signed' WHERE id = '${cId}';
      COMMIT;
    `);
    expect(r1).toMatch(/cannot mark contract|integrity_constraint_violation|23000/i);

    // Step 2: second signer signs
    sql(`
      BEGIN;
      SET LOCAL ROLE service_role;
      UPDATE public.contract_signers SET status = 'signed' WHERE id = '${s2Id}';
      COMMIT;
    `);

    // Now all signed — contract can be marked signed
    const r2 = sql(`
      BEGIN;
      SET LOCAL ROLE service_role;
      UPDATE public.contracts SET status = 'signed' WHERE id = '${cId}';
      COMMIT;
    `);
    expect(r2).not.toMatch(/ERROR|cannot mark contract/i);

    const status = sql(`SELECT status FROM public.contracts WHERE id = '${cId}';`);
    expect(status).toBe('signed');

    sql(`DELETE FROM public.contract_signers WHERE contract_id = '${cId}';`);
    sql(`DELETE FROM public.contracts WHERE id = '${cId}';`);
  });

  // ── M450 function security hardening ────────────────────────────────────

  it('M450 function search_path includes pg_temp (hardened against temp-table injection)', () => {
    // pg_get_functiondef normalizes SET clauses so the exact syntax may differ.
    // Query proconfig directly — PostgreSQL stores SET clauses as 'key=value' strings
    // in the proconfig array; the entry will be 'search_path=public, pg_temp'.
    const r = sql(`
      SELECT EXISTS(
        SELECT 1
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace,
               unnest(p.proconfig) AS cfg
         WHERE n.nspname = 'public'
           AND p.proname = 'contracts_enforce_signer_rows'
           AND cfg LIKE 'search_path=%'
           AND cfg LIKE '%pg_temp%'
      );
    `);
    expect(r).toBe('t');
  });

  it('M450 function: PUBLIC cannot directly invoke contracts_enforce_signer_rows', () => {
    // The function is SECURITY DEFINER; direct invocation by PUBLIC should be revoked.
    const r = sql(`
      SELECT has_function_privilege(
        'public',
        'public.contracts_enforce_signer_rows()',
        'EXECUTE'
      );
    `);
    // REVOKE ALL ON FUNCTION FROM PUBLIC removes direct-call privilege.
    // Triggers invoke the function as the trigger owner, not as the calling role.
    expect(r).toBe('f');
  });

  // ── Defense-in-depth: lock trigger + M450 guard ──────────────────────────
  //
  // M450 guards the TRANSITION: a contract cannot move to 'signed' unless all
  // signers have status='signed'.  The M449 lock trigger guards POST-SIGNING
  // MUTATIONS: once a contract is 'signed', no new signer rows can be inserted
  // (which would leave a signed contract with an unsigned signer).
  //
  // This test installs the M449 lock trigger locally, exercises both layers,
  // then removes the trigger so it does not interfere with afterAll cleanup.

  it('defense-in-depth: INSERT blocked after parent contract is signed (lock trigger guards post-signing mutations)', () => {
    const cId   = '00000000-0000-0000-0000-000000450d01';
    const s1Id  = '00000000-0000-0000-0000-000000450d02';
    const s2Id  = '00000000-0000-0000-0000-000000450d03';
    const newId = '00000000-0000-0000-0000-000000450d04';

    // Install the M449 lock trigger for this test only.
    // CREATE OR REPLACE + DROP IF EXISTS make this idempotent.
    sql(`
      CREATE OR REPLACE FUNCTION public.contract_signers_enforce_signed_lock()
      RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = public, pg_temp AS $$
      DECLARE v_contract_status TEXT;
      BEGIN
        SELECT status INTO v_contract_status FROM public.contracts
         WHERE id = COALESCE(OLD.contract_id, NEW.contract_id);
        IF v_contract_status = 'signed' THEN
          RAISE EXCEPTION
            'contract_signers: row % is locked — parent contract % is already signed',
            COALESCE(OLD.id, NEW.id), COALESCE(OLD.contract_id, NEW.contract_id)
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN COALESCE(NEW, OLD);
      END;
      $$;

      DROP TRIGGER IF EXISTS contract_signers_lock_on_signed ON public.contract_signers;
      CREATE TRIGGER contract_signers_lock_on_signed
        BEFORE INSERT OR UPDATE OR DELETE ON public.contract_signers
        FOR EACH ROW
        EXECUTE FUNCTION public.contract_signers_enforce_signed_lock();
    `);

    // Setup: multi-signer contract with two fully-signed signers
    sql(`
      BEGIN;
      SET LOCAL ROLE service_role;
      INSERT INTO public.contracts (id, business_id, title, token, status, signing_mode)
        VALUES ('${cId}', '${BIZ_ID}', 'DepthGuard', 'tok450dep00001', 'active', 'parallel')
        ON CONFLICT (id) DO NOTHING;
      INSERT INTO public.contract_signers (id, contract_id, signer_phone, token, status)
        VALUES ('${s1Id}', '${cId}', '+2348000000010', 'tok450depsgn01', 'signed')
        ON CONFLICT (id) DO NOTHING;
      INSERT INTO public.contract_signers (id, contract_id, signer_phone, token, status)
        VALUES ('${s2Id}', '${cId}', '+2348000000011', 'tok450depsgn02', 'signed')
        ON CONFLICT (id) DO NOTHING;
      COMMIT;
    `);

    // Transition contract to signed — M450 allows because all signers have status='signed'
    const signResult = sql(`
      BEGIN;
      SET LOCAL ROLE service_role;
      UPDATE public.contracts SET status = 'signed' WHERE id = '${cId}';
      COMMIT;
    `);
    expect(signResult).not.toMatch(/ERROR|cannot mark contract/i);

    const status = sql(`SELECT status FROM public.contracts WHERE id = '${cId}';`);
    expect(status).toBe('signed');

    // Defense-in-depth: attempt to INSERT a new signer into the now-signed contract.
    // M450 only fires on the contracts UPDATE transition — it does not guard post-signing
    // inserts into contract_signers.  The M449 lock trigger fills this gap.
    const r = sql(`
      BEGIN;
      SET LOCAL ROLE service_role;
      INSERT INTO public.contract_signers (id, contract_id, signer_phone, token, status)
        VALUES ('${newId}', '${cId}', '+2348000000012', 'tok450depsgn03', 'pending');
      COMMIT;
    `);
    expect(r).toMatch(/locked|integrity_constraint_violation|23000/i);

    // Verify the new signer was NOT inserted
    const count = sql(`SELECT COUNT(*) FROM public.contract_signers WHERE id = '${newId}';`);
    expect(count).toBe('0');

    // Cleanup: reset status so the lock trigger allows subsequent DELETEs
    sql(`UPDATE public.contracts SET status = 'pending' WHERE id = '${cId}';`);
    sql(`DELETE FROM public.contract_signers WHERE contract_id = '${cId}';`);
    sql(`DELETE FROM public.contracts WHERE id = '${cId}';`);

    // Remove lock trigger so it does not interfere with afterAll cleanup of the
    // main CONTRACT_ID contract (which is already 'signed').
    sql(`DROP TRIGGER IF EXISTS contract_signers_lock_on_signed ON public.contract_signers;`);
    sql(`DROP FUNCTION IF EXISTS public.contract_signers_enforce_signed_lock();`);
  });
});

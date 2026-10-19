/**
 * M451: FOR UPDATE concurrency test
 *
 * Proves that SELECT ... FOR UPDATE in contract_signers_enforce_signed_lock()
 * serializes concurrent signer mutations against contract finalization under
 * READ COMMITTED isolation.
 *
 * Two independent pg Client connections are used to exercise genuine concurrency.
 * Tests are gated on TEST_DATABASE_URL; they are skipped (not failed) when absent,
 * but throw when REQUIRE_PG_TESTS=true.
 *
 * Three scenarios:
 *  1. Tx A finalizes contract (holds row lock) → Tx B signer INSERT blocks, then fails.
 *  2. Tx B signer INSERT holds row lock → Tx A finalization blocks, then fails (M450).
 *  3. Tx A rolls back → Tx B signer INSERT unblocks and succeeds.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB && process.env.REQUIRE_PG_TESTS === 'true') {
  throw new Error(
    'TEST_DATABASE_URL is required — cannot skip DB tests (REQUIRE_PG_TESTS=true)',
  );
}

const describeDb = !TEST_DB ? describe.skip : describe;

/** Create and connect a new pg client. */
async function connect(): Promise<Client> {
  const client = new Client({ connectionString: TEST_DB });
  await client.connect();
  return client;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── Stable UUIDs (all valid hex, 451-series) ─────────────────────────────────
const BIZ_ID = '00000000-0000-0000-0000-000000451001';
const C1_ID  = '00000000-0000-0000-0000-000000451002'; // test 1 contract
const S1A    = '00000000-0000-0000-0000-000000451003'; // test 1 signer 1 (signed)
const S1B    = '00000000-0000-0000-0000-000000451004'; // test 1 signer 2 (signed)
const NS1    = '00000000-0000-0000-0000-000000451005'; // test 1 new signer (blocked)
const C2_ID  = '00000000-0000-0000-0000-000000451006'; // test 2 contract
const S2A    = '00000000-0000-0000-0000-000000451007'; // test 2 existing signer (signed)
const NS2    = '00000000-0000-0000-0000-000000451008'; // test 2 new signer (inserts before finalization)
const C3_ID  = '00000000-0000-0000-0000-000000451009'; // test 3 contract (rollback)
const NS3    = '00000000-0000-0000-0000-000000451010'; // test 3 new signer (succeeds after rollback)
const C4_SIGNED  = '00000000-0000-0000-0000-000000451011'; // test 4 signed contract (reassignment target)
const C4_DRAFT   = '00000000-0000-0000-0000-000000451012'; // test 4 draft contract (signer source)
const S4A        = '00000000-0000-0000-0000-000000451013'; // test 4 signer on signed contract
const S4_DRAFT   = '00000000-0000-0000-0000-000000451014'; // test 4 signer on draft (to be reassigned)

describeDb('M451: FOR UPDATE concurrency — signer mutations serialized against contract finalization', () => {
  let admin: Client;

  beforeAll(async () => {
    admin = await connect();

    // Ensure roles exist
    await admin.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
          CREATE ROLE service_role NOLOGIN BYPASSRLS;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
          CREATE ROLE authenticated NOLOGIN;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
          CREATE ROLE anon NOLOGIN;
        END IF;
      END $$;
    `);
    // Note: ALTER ROLE service_role BYPASSRLS was removed because it races
    // with parallel .pg.test.ts files on the shared pg_authid catalog.
    // The CREATE ROLE above already sets BYPASSRLS; CI setup does too.

    // Minimal schema — CREATE TABLE IF NOT EXISTS so this is idempotent
    await admin.query(`
      GRANT USAGE ON SCHEMA public TO service_role, authenticated, anon;

      CREATE TABLE IF NOT EXISTS public.businesses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL DEFAULT 'Test'
      );
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.businesses TO service_role;

      CREATE TABLE IF NOT EXISTS public.contracts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
        title VARCHAR(300) NOT NULL DEFAULT 'Test',
        token VARCHAR(64) UNIQUE NOT NULL,
        token_expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '72 hours'),
        status VARCHAR(20) DEFAULT 'pending',
        signing_mode VARCHAR(20) DEFAULT 'single',
        created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
      );
      ALTER TABLE public.contracts ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS "svc_contracts_c451" ON public.contracts;
      CREATE POLICY "svc_contracts_c451" ON public.contracts
        FOR ALL TO service_role USING (true) WITH CHECK (true);
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.contracts TO service_role;

      CREATE TABLE IF NOT EXISTS public.contract_signers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        contract_id UUID NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
        signer_phone VARCHAR(30) NOT NULL,
        token VARCHAR(64) UNIQUE NOT NULL DEFAULT gen_random_uuid()::text,
        token_expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '72 hours'),
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now()
      );
      ALTER TABLE public.contract_signers ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS "svc_signers_c451" ON public.contract_signers;
      CREATE POLICY "svc_signers_c451" ON public.contract_signers
        FOR ALL TO service_role USING (true) WITH CHECK (true);
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.contract_signers TO service_role;
    `);

    // Install M451 lock trigger function (FOR UPDATE version)
    const m451 = readFileSync(
      resolve(process.cwd(), 'supabase/migrations/451_contract_signers_lock_for_update.sql'),
      'utf-8',
    );
    await admin.query(m451);

    // Bind lock trigger (M449 creates this; ensure it exists here for self-containment)
    await admin.query(`
      DROP TRIGGER IF EXISTS contract_signers_lock_on_signed ON public.contract_signers;
      CREATE TRIGGER contract_signers_lock_on_signed
        BEFORE INSERT OR UPDATE OR DELETE ON public.contract_signers
        FOR EACH ROW
        EXECUTE FUNCTION public.contract_signers_enforce_signed_lock();
    `);

    // Install M450 zero-signer guard (required for test 2: M450 rejects finalization
    // once the unsigned signer committed by Tx B is visible to Tx A)
    await admin.query(`
      CREATE OR REPLACE FUNCTION public.contracts_enforce_signer_rows()
      RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = public, pg_temp AS $$
      DECLARE
        v_signer_count   INT;
        v_unsigned_count INT;
      BEGIN
        IF NEW.status = 'signed' AND NEW.signing_mode IS DISTINCT FROM 'single' THEN
          SELECT COUNT(*) INTO v_signer_count
            FROM public.contract_signers WHERE contract_id = NEW.id;
          IF v_signer_count = 0 THEN
            RAISE EXCEPTION
              'cannot mark contract % as signed: no contract_signers rows exist', NEW.id
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;
          SELECT COUNT(*) INTO v_unsigned_count
            FROM public.contract_signers
           WHERE contract_id = NEW.id AND status IS DISTINCT FROM 'signed';
          IF v_unsigned_count > 0 THEN
            RAISE EXCEPTION
              'cannot mark contract % as signed: % signer(s) have not yet signed',
              NEW.id, v_unsigned_count
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$;

      DROP TRIGGER IF EXISTS contracts_zero_signer_guard ON public.contracts;
      CREATE TRIGGER contracts_zero_signer_guard
        BEFORE UPDATE ON public.contracts
        FOR EACH ROW
        EXECUTE FUNCTION public.contracts_enforce_signer_rows();
    `);

    // Seed shared business
    await admin.query(`
      INSERT INTO public.businesses (id, name)
        VALUES ('${BIZ_ID}', 'Concurrency Biz')
        ON CONFLICT (id) DO NOTHING;
    `);
  });

  afterAll(async () => {
    // Reset status so lock trigger allows deletion, then CASCADE handles signers
    try {
      await admin.query(`
        UPDATE public.contracts SET status = 'pending'
         WHERE id IN ('${C1_ID}', '${C2_ID}', '${C3_ID}', '${C4_SIGNED}', '${C4_DRAFT}');
        DELETE FROM public.contracts
         WHERE id IN ('${C1_ID}', '${C2_ID}', '${C3_ID}', '${C4_SIGNED}', '${C4_DRAFT}');
        DELETE FROM public.businesses WHERE id = '${BIZ_ID}';
      `);
    } catch (_) { /* ignore */ }
    await admin.end();
  });

  // ── Test 1 ─────────────────────────────────────────────────────────────────
  //
  // Tx A finalizes the contract (holds row lock via UPDATE).
  // Tx B tries to INSERT a signer — M449 FOR UPDATE blocks on Tx A's lock.
  // After Tx A commits (status='signed'), Tx B unblocks and the trigger
  // re-reads status='signed', rejecting the INSERT.

  it('FOR UPDATE blocks concurrent signer INSERT during contract finalization', async () => {
    await admin.query(`
      INSERT INTO public.contracts (id, business_id, title, token, status, signing_mode)
        VALUES ('${C1_ID}','${BIZ_ID}','T1','tok451c1x001','active','parallel')
        ON CONFLICT (id) DO NOTHING;
      INSERT INTO public.contract_signers (id, contract_id, signer_phone, status)
        VALUES
          ('${S1A}','${C1_ID}','+2340000000001','signed'),
          ('${S1B}','${C1_ID}','+2340000000002','signed')
        ON CONFLICT (id) DO NOTHING;
    `);

    const connA = await connect();
    const connB = await connect();
    try {
      // Tx A: BEGIN + UPDATE contracts (row lock acquired; M450 allows — all signers signed)
      await connA.query('BEGIN');
      await connA.query(`UPDATE public.contracts SET status = 'signed' WHERE id = '${C1_ID}'`);

      // Tx B: BEGIN; then INSERT a signer.  The INSERT fires M449's BEFORE trigger
      // which calls SELECT ... FOR UPDATE on contracts — this blocks because Tx A
      // holds the ExclusiveLock on that row.
      let bSettled = false;
      let bError: Error | null = null;
      const bPromise = connB.query('BEGIN')
        .then(() => connB.query(`
          INSERT INTO public.contract_signers (id, contract_id, signer_phone, status)
            VALUES ('${NS1}', '${C1_ID}', '+2340000000003', 'pending')
        `))
        .catch(e => {
          bError = e as Error;
          // ROLLBACK cleans up the aborted transaction so the connection stays usable
          return connB.query('ROLLBACK').catch(() => {});
        })
        .finally(() => { bSettled = true; });

      // Wait — Tx B should be blocked, not yet settled
      await sleep(400);
      expect(bSettled).toBe(false);

      // Commit Tx A — contract is now 'signed', row lock released
      await connA.query('COMMIT');

      // B unblocks: FOR UPDATE succeeds, reads status='signed', trigger raises exception
      await bPromise;

      expect(bSettled).toBe(true);
      expect(bError).toBeTruthy();
      expect(bError!.message).toMatch(/locked.*already signed|already signed|locked/i);

      // NS1 must NOT have been inserted
      const { rows } = await admin.query(
        `SELECT COUNT(*)::int AS n FROM public.contract_signers WHERE id = '${NS1}'`,
      );
      expect(rows[0].n).toBe(0);
    } finally {
      try { await connA.query('ROLLBACK'); } catch (_) {}
      try { await connB.query('ROLLBACK'); } catch (_) {}
      await connA.end();
      await connB.end();
      // Reset C1 so afterAll cleanup can proceed (status='signed' → afterAll resets to pending)
    }
  }, 10_000);

  // ── Test 2 ─────────────────────────────────────────────────────────────────
  //
  // Tx B inserts a signer first — M449 FOR UPDATE acquires the contracts row lock.
  // Tx A tries to finalize the contract — it blocks because Tx B holds the lock.
  // After Tx B commits (unsigned signer now in DB), Tx A unblocks.
  // M450 fires for Tx A and sees the unsigned signer → rejects finalization.

  it('FOR UPDATE blocks concurrent contract finalization during signer INSERT', async () => {
    await admin.query(`
      INSERT INTO public.contracts (id, business_id, title, token, status, signing_mode)
        VALUES ('${C2_ID}','${BIZ_ID}','T2','tok451c2x001','active','parallel')
        ON CONFLICT (id) DO NOTHING;
      INSERT INTO public.contract_signers (id, contract_id, signer_phone, status)
        VALUES ('${S2A}','${C2_ID}','+2340000000004','signed')
        ON CONFLICT (id) DO NOTHING;
    `);

    const connA = await connect();
    const connB = await connect();
    try {
      // Tx B: BEGIN + INSERT (M449 FOR UPDATE acquires contracts row lock — status='active',
      // INSERT is allowed; Tx B holds the lock but has NOT committed)
      await connB.query('BEGIN');
      await connB.query(`
        INSERT INTO public.contract_signers (id, contract_id, signer_phone, status)
          VALUES ('${NS2}', '${C2_ID}', '+2340000000005', 'pending')
      `);

      // Tx A: BEGIN; then UPDATE contracts.  Tx A tries to acquire the same
      // ExclusiveLock on the contracts row — BLOCKS because Tx B holds FOR UPDATE.
      let aSettled = false;
      let aError: Error | null = null;
      const aPromise = connA.query('BEGIN')
        .then(() => connA.query(
          `UPDATE public.contracts SET status = 'signed' WHERE id = '${C2_ID}'`,
        ))
        .catch(e => {
          aError = e as Error;
          return connA.query('ROLLBACK').catch(() => {});
        })
        .finally(() => { aSettled = true; });

      // Wait — Tx A should be blocked
      await sleep(400);
      expect(aSettled).toBe(false);

      // Commit Tx B — unsigned signer NS2 is now in the DB; lock released
      await connB.query('COMMIT');

      // Tx A unblocks: UPDATE proceeds, M450 fires, sees NS2 (pending) → rejects
      await aPromise;

      expect(aSettled).toBe(true);
      expect(aError).toBeTruthy();
      expect(aError!.message).toMatch(/have not yet signed|cannot mark contract/i);

      // C2 must still be 'active' (Tx A's UPDATE was rejected)
      const { rows } = await admin.query(
        `SELECT status FROM public.contracts WHERE id = '${C2_ID}'`,
      );
      expect(rows[0].status).toBe('active');
    } finally {
      try { await connA.query('ROLLBACK'); } catch (_) {}
      try { await connB.query('ROLLBACK'); } catch (_) {}
      await connA.end();
      await connB.end();
      // Clean up NS2 so afterAll can delete C2 without the lock trigger blocking
      await admin.query(
        `DELETE FROM public.contract_signers WHERE id = '${NS2}'`,
      ).catch(() => {});
    }
  }, 10_000);

  // ── Test 3 ─────────────────────────────────────────────────────────────────
  //
  // Tx A holds the contracts row lock (UPDATE), then ROLLBACKS without committing.
  // Tx B's signer INSERT was blocked; after the rollback it unblocks and the
  // trigger reads status='active' (not 'signed') → INSERT succeeds.

  it('Rollback releases FOR UPDATE lock allowing signer INSERT to proceed', async () => {
    await admin.query(`
      INSERT INTO public.contracts (id, business_id, title, token, status, signing_mode)
        VALUES ('${C3_ID}','${BIZ_ID}','T3','tok451c3x001','active','single')
        ON CONFLICT (id) DO NOTHING;
    `);

    const connA = await connect();
    const connB = await connect();
    try {
      // Tx A: BEGIN + UPDATE (signing_mode='single' → M450 skips zero-signer guard;
      // Tx A holds ExclusiveLock but has NOT committed)
      await connA.query('BEGIN');
      await connA.query(`UPDATE public.contracts SET status = 'signed' WHERE id = '${C3_ID}'`);

      // Tx B: BEGIN; INSERT signer — blocks on M449's FOR UPDATE
      let bSettled = false;
      let bError: Error | null = null;
      let bSuccess = false;
      const bPromise = connB.query('BEGIN')
        .then(() => connB.query(`
          INSERT INTO public.contract_signers (id, contract_id, signer_phone, status)
            VALUES ('${NS3}', '${C3_ID}', '+2340000000006', 'pending')
        `))
        .then(() => connB.query('COMMIT'))
        .then(() => { bSuccess = true; })
        .catch(e => {
          bError = e as Error;
          return connB.query('ROLLBACK').catch(() => {});
        })
        .finally(() => { bSettled = true; });

      // Wait — Tx B should still be blocked
      await sleep(400);
      expect(bSettled).toBe(false);

      // Rollback Tx A — releases lock WITHOUT committing status='signed'
      await connA.query('ROLLBACK');

      // Tx B unblocks: FOR UPDATE reads status='active' → INSERT succeeds
      await bPromise;

      expect(bSettled).toBe(true);
      expect(bError).toBeNull();
      expect(bSuccess).toBe(true);

      // NS3 must be in the DB
      const { rows } = await admin.query(
        `SELECT COUNT(*)::int AS n FROM public.contract_signers WHERE id = '${NS3}'`,
      );
      expect(rows[0].n).toBe(1);

      // C3 must still be 'active' (Tx A rolled back)
      const { rows: cr } = await admin.query(
        `SELECT status FROM public.contracts WHERE id = '${C3_ID}'`,
      );
      expect(cr[0].status).toBe('active');
    } finally {
      try { await connA.query('ROLLBACK'); } catch (_) {}
      try { await connB.query('ROLLBACK'); } catch (_) {}
      await connA.end();
      await connB.end();
    }
  }, 10_000);

  // ── Test 4 ─────────────────────────────────────────────────────────────────
  //
  // Immutability guard (M451 round 4): contract_id reassignment must be rejected.
  //
  // A signer row on a draft contract is UPDATEd to point at a signed contract.
  // Before the fix, COALESCE(OLD.contract_id, NEW.contract_id) always picked
  // OLD (draft, status≠'signed') → trigger allowed the mutation.
  // After the fix, the immutability guard raises before the FOR UPDATE lookup.

  it('rejects contract_id reassignment on contract_signers', async () => {
    // Setup: C4_SIGNED (single-mode, signed) with one signed signer (S4A);
    //        C4_DRAFT  (single-mode, active)  with one pending signer (S4_DRAFT).
    await admin.query(`
      INSERT INTO public.contracts (id, business_id, title, token, status, signing_mode)
        VALUES
          ('${C4_SIGNED}', '${BIZ_ID}', 'T4-signed', 'tok451c4signed001', 'active', 'single'),
          ('${C4_DRAFT}',  '${BIZ_ID}', 'T4-draft',  'tok451c4draft001',  'active', 'single')
        ON CONFLICT (id) DO NOTHING;
      INSERT INTO public.contract_signers (id, contract_id, signer_phone, status)
        VALUES
          ('${S4A}',      '${C4_SIGNED}', '+2340000000010', 'signed'),
          ('${S4_DRAFT}', '${C4_DRAFT}',  '+2340000000011', 'pending')
        ON CONFLICT (id) DO NOTHING;
      -- Finalize C4_SIGNED (single-mode → M450 zero-signer guard does not apply)
      UPDATE public.contracts SET status = 'signed' WHERE id = '${C4_SIGNED}';
    `);

    // Attempt: reassign S4_DRAFT from C4_DRAFT (active) to C4_SIGNED (signed).
    // With the old COALESCE the trigger would look up OLD.contract_id = C4_DRAFT
    // (status='active') and allow the move.  With the immutability guard it must raise.
    let err: Error | null = null;
    try {
      await admin.query(`
        UPDATE public.contract_signers
           SET contract_id = '${C4_SIGNED}'
         WHERE id = '${S4_DRAFT}'
      `);
    } catch (e) {
      err = e as Error;
    }

    expect(err).toBeTruthy();
    expect(err!.message).toMatch(/contract_id reassignment is forbidden/i);
    expect((err as any).code).toBe('23514'); // check_violation

    // S4_DRAFT must still belong to C4_DRAFT
    const { rows } = await admin.query(
      `SELECT contract_id FROM public.contract_signers WHERE id = '${S4_DRAFT}'`,
    );
    expect(rows[0].contract_id).toBe(C4_DRAFT);

    // Inline cleanup (afterAll also covers these in the fallback path)
    await admin.query(`
      UPDATE public.contracts SET status = 'pending' WHERE id = '${C4_SIGNED}';
      DELETE FROM public.contract_signers WHERE id IN ('${S4A}', '${S4_DRAFT}');
      DELETE FROM public.contracts WHERE id IN ('${C4_SIGNED}', '${C4_DRAFT}');
    `).catch(() => {});
  });
});

/**
 * Payment confirmation RPC grants — source verification + real PostgreSQL tests
 *
 * Verifies that migration 324 correctly revokes EXECUTE from anon/authenticated
 * on the 4 payment confirmation lifecycle RPCs (SECURITY DEFINER functions that
 * modify payment state), and grants EXECUTE only to service_role.
 *
 * The lifecycle still works end-to-end when called as the DB superuser
 * (simulating service_role access via the service client).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';

// ══════════════════════════════════════════════════════════
// Source Verification
// ══════════════════════════════════════════════════════════

const FUNCTIONS = [
  { name: 'claim_payment_confirmation', sig: 'UUID' },
  { name: 'renew_payment_confirmation_claim', sig: 'UUID, UUID' },
  { name: 'finalize_payment_confirmation', sig: 'UUID, UUID' },
  { name: 'release_payment_confirmation', sig: 'UUID, UUID' },
];

describe('PRA: payment confirmation RPC grants source verification', () => {
  const migration324 = readFileSync('supabase/migrations/324_payment_confirmation_rpc_grants.sql', 'utf-8');

  for (const fn of FUNCTIONS) {
    it(`PRA-SRC-1: REVOKE ALL from PUBLIC for ${fn.name}`, () => {
      expect(migration324).toContain(
        `REVOKE ALL ON FUNCTION public.${fn.name}(${fn.sig}) FROM PUBLIC`
      );
    });

    it(`PRA-SRC-2: REVOKE ALL from anon for ${fn.name}`, () => {
      expect(migration324).toContain(
        `REVOKE ALL ON FUNCTION public.${fn.name}(${fn.sig}) FROM anon`
      );
    });

    it(`PRA-SRC-3: REVOKE ALL from authenticated for ${fn.name}`, () => {
      expect(migration324).toContain(
        `REVOKE ALL ON FUNCTION public.${fn.name}(${fn.sig}) FROM authenticated`
      );
    });

    it(`PRA-SRC-4: GRANT EXECUTE to service_role for ${fn.name}`, () => {
      expect(migration324).toContain(
        `GRANT EXECUTE ON FUNCTION public.${fn.name}(${fn.sig}) TO service_role`
      );
    });
  }

  it('PRA-SRC-5: does NOT alter function bodies (grant-only migration)', () => {
    expect(migration324).not.toMatch(/\bCREATE\s+(OR\s+REPLACE\s+)?FUNCTION\b/i);
    expect(migration324).not.toMatch(/\bBEGIN\b/);
    expect(migration324).not.toMatch(/\bEND;\s*\$\$/);
  });
});

// ══════════════════════════════════════════════════════════
// Real PostgreSQL Tests (require TEST_DATABASE_URL)
// ══════════════════════════════════════════════════════════

const TEST_DB = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DB)('PRA: payment confirmation RPC grants real PostgreSQL tests', () => {
  const PAY_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const BIZ_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

  function psql(sql: string): string {
    const raw = execSync(`psql "${TEST_DB}" -tAXq -v ON_ERROR_STOP=1`, {
      input: sql,
      encoding: 'utf-8',
      timeout: 15_000,
    });
    return raw
      .split('\n')
      .filter((l) => {
        const t = l.trim();
        return (
          t !== '' &&
          !/^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|DO|SET|COMMENT)\b/.test(t)
        );
      })
      .join('\n')
      .trim();
  }

  function psqlJson(sql: string): unknown {
    const raw = psql(sql);
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  beforeAll(() => {
    // Bootstrap minimal schema
    psql(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";
      DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;

      CREATE TABLE IF NOT EXISTS payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID,
        amount NUMERIC DEFAULT 0,
        status TEXT DEFAULT 'pending',
        booking_id UUID,
        invoice_id UUID,
        campaign_id UUID,
        reservation_id UUID,
        order_id UUID,
        confirmation_sent_at TIMESTAMPTZ,
        confirmation_processing_at TIMESTAMPTZ,
        confirmation_claim_token UUID
      );
    `);

    // Apply migration 307 (creates the 4 functions)
    const migration307 = readFileSync('supabase/migrations/307_confirmation_claim_lifecycle.sql', 'utf-8');
    psql(migration307);

    // Apply migration 324 (the grants fix)
    const migration324 = readFileSync('supabase/migrations/324_payment_confirmation_rpc_grants.sql', 'utf-8');
    psql(migration324);

    // Insert test payment
    psql(`
      DELETE FROM payments WHERE id = '${PAY_ID}';
      INSERT INTO payments (id, business_id, amount, status)
      VALUES ('${PAY_ID}', '${BIZ_ID}', 5000, 'success');
    `);
  });

  afterAll(() => {
    psql(`DELETE FROM payments WHERE id = '${PAY_ID}';`);
  });

  // ── Permission enforcement: anon cannot execute ──

  for (const fn of FUNCTIONS) {
    const qualifiedSig = `public.${fn.name}(${fn.sig.toLowerCase().replace(/uuid/g, 'uuid')})`;

    it(`PRA-PERM-anon: anon cannot execute ${fn.name}`, () => {
      const result = psql(`
        SELECT has_function_privilege('anon', '${qualifiedSig}', 'EXECUTE');
      `);
      expect(result).toBe('f');
    });

    it(`PRA-PERM-auth: authenticated cannot execute ${fn.name}`, () => {
      const result = psql(`
        SELECT has_function_privilege('authenticated', '${qualifiedSig}', 'EXECUTE');
      `);
      expect(result).toBe('f');
    });

    it(`PRA-PERM-svc: service_role CAN execute ${fn.name}`, () => {
      const result = psql(`
        SELECT has_function_privilege('service_role', '${qualifiedSig}', 'EXECUTE');
      `);
      expect(result).toBe('t');
    });
  }

  // ── Permission enforcement: anon direct call fails ──

  it('PRA-DENY-anon: anon direct call to claim_payment_confirmation fails', () => {
    let error = '';
    try {
      psql(`SET ROLE anon; SELECT claim_payment_confirmation('${PAY_ID}');`);
    } catch (e) {
      error = String(e);
    }
    expect(error).toContain('permission denied');
    psql('RESET ROLE;');
  });

  it('PRA-DENY-auth: authenticated direct call to claim_payment_confirmation fails', () => {
    let error = '';
    try {
      psql(`SET ROLE authenticated; SELECT claim_payment_confirmation('${PAY_ID}');`);
    } catch (e) {
      error = String(e);
    }
    expect(error).toContain('permission denied');
    psql('RESET ROLE;');
  });

  // ── End-to-end lifecycle (claim → renew → finalize) ──

  it('PRA-E2E: confirmation lifecycle works end-to-end (claim → renew → finalize)', () => {
    // Reset payment state
    psql(`
      UPDATE payments SET
        status = 'success',
        confirmation_sent_at = NULL,
        confirmation_processing_at = NULL,
        confirmation_claim_token = NULL
      WHERE id = '${PAY_ID}';
    `);

    // Step 1: Claim
    const claimResult = psqlJson(
      `SELECT claim_payment_confirmation('${PAY_ID}');`
    ) as Record<string, unknown>;
    expect(claimResult.claimed).toBe(true);
    expect(claimResult.claim_token).toBeDefined();
    const token = claimResult.claim_token as string;

    // Step 2: Renew
    const renewResult = psqlJson(
      `SELECT renew_payment_confirmation_claim('${PAY_ID}', '${token}');`
    ) as Record<string, unknown>;
    expect(renewResult.renewed).toBe(true);

    // Step 3: Finalize
    const finalizeResult = psqlJson(
      `SELECT finalize_payment_confirmation('${PAY_ID}', '${token}');`
    ) as Record<string, unknown>;
    expect(finalizeResult.finalized).toBe(true);
    expect(finalizeResult.already_finalized).toBe(false);

    // Verify: confirmation_sent_at is set, processing cleared
    const state = psql(`
      SELECT confirmation_sent_at IS NOT NULL AS sent,
             confirmation_processing_at IS NULL AS cleared,
             confirmation_claim_token IS NULL AS token_cleared
      FROM payments WHERE id = '${PAY_ID}';
    `);
    expect(state).toContain('t|t|t');
  });

  it('PRA-E2E-release: claim → release returns to unclaimed state', () => {
    // Reset payment state
    psql(`
      UPDATE payments SET
        status = 'success',
        confirmation_sent_at = NULL,
        confirmation_processing_at = NULL,
        confirmation_claim_token = NULL
      WHERE id = '${PAY_ID}';
    `);

    // Claim
    const claimResult = psqlJson(
      `SELECT claim_payment_confirmation('${PAY_ID}');`
    ) as Record<string, unknown>;
    expect(claimResult.claimed).toBe(true);
    const token = claimResult.claim_token as string;

    // Release
    const releaseResult = psqlJson(
      `SELECT release_payment_confirmation('${PAY_ID}', '${token}');`
    ) as Record<string, unknown>;
    expect(releaseResult.released).toBe(true);

    // Verify: back to unclaimed state
    const state = psql(`
      SELECT confirmation_processing_at IS NULL AS proc_null,
             confirmation_claim_token IS NULL AS token_null,
             confirmation_sent_at IS NULL AS sent_null
      FROM payments WHERE id = '${PAY_ID}';
    `);
    expect(state).toContain('t|t|t');
  });
});

/**
 * Migration 296 — Real PostgreSQL RPC Permission Tests
 *
 * Verifies that Migration 296 correctly restricts EXECUTE privileges on
 * 7 SECURITY DEFINER functions to service_role only, without modifying
 * function bodies, owners, or security settings.
 *
 * Works in two modes:
 *   CI:    TEST_DATABASE_URL points to the CI PostgreSQL where ALL migrations
 *          have been applied. Functions exist with full schema.
 *   Local: TEST_DATABASE_URL points to an isolated container. The test creates
 *          minimal stub functions and applies Migration 296 itself.
 *
 * Requires TEST_DATABASE_URL environment variable (NOT staging or production).
 *
 * Local:
 *   docker run --rm -d --name m296-test -p 54322:5432 -e POSTGRES_PASSWORD=test postgres:16
 *   TEST_DATABASE_URL=postgresql://postgres:test@localhost:54322/postgres npx vitest run lib/__tests__/migration-296-rpc-permissions-db.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const MIGRATION_PATH = path.resolve('supabase/migrations/296_restrict_sensitive_rpc_execution.sql');
const dbUrl = process.env.TEST_DATABASE_URL;

// Function specs: name, type-only signature for REVOKE/GRANT, identity args for pg_proc lookup
const FUNCTIONS = [
  {
    name: 'book_slot_atomic',
    typeSig: 'uuid, uuid, uuid, uuid, date, text, int, int, text, int, text, text, text, text, text, text, text, date, jsonb, uuid, int, text, uuid, uuid, integer, integer',
    identityArgs: 'p_business_id uuid, p_user_id uuid, p_service_id uuid, p_staff_id uuid, p_date date, p_time text, p_party_size integer, p_max_capacity integer, p_flow_type text, p_deposit_amount integer, p_deposit_status text, p_status text, p_guest_name text, p_guest_phone text, p_guest_email text, p_special_requests text, p_venue_address text, p_end_date date, p_addons_snapshot jsonb, p_promo_code_id uuid, p_total_amount integer, p_staff_name text, p_location_id uuid, p_appointment_id uuid, p_buffer_minutes integer, p_duration integer',
    stubReturnType: 'JSONB',
    stubBody: "RETURN '{}'::JSONB;",
    stubParams: `p_business_id uuid, p_user_id uuid, p_service_id uuid, p_staff_id uuid, p_date date, p_time text, p_party_size int, p_max_capacity int, p_flow_type text, p_deposit_amount int, p_deposit_status text, p_status text, p_guest_name text, p_guest_phone text, p_guest_email text, p_special_requests text, p_venue_address text, p_end_date date, p_addons_snapshot jsonb, p_promo_code_id uuid, p_total_amount int, p_staff_name text, p_location_id uuid, p_appointment_id uuid, p_buffer_minutes integer, p_duration integer`,
  },
  {
    name: 'restore_stock',
    typeSig: 'uuid, integer',
    identityArgs: 'p_product_id uuid, qty integer',
    stubReturnType: 'void',
    stubBody: 'RETURN;',
    stubParams: 'p_product_id uuid, qty integer',
  },
  {
    name: 'restore_variant_stock',
    typeSig: 'uuid, integer',
    identityArgs: 'p_variant_id uuid, qty integer',
    stubReturnType: 'void',
    stubBody: 'RETURN;',
    stubParams: 'p_variant_id uuid, qty integer',
  },
  {
    name: 'restore_tickets_sold',
    typeSig: 'uuid, integer',
    identityArgs: 'p_event_id uuid, qty integer',
    stubReturnType: 'void',
    stubBody: 'RETURN;',
    stubParams: 'p_event_id uuid, qty integer',
  },
  {
    name: 'redeem_loyalty_points',
    typeSig: 'uuid, integer',
    identityArgs: 'p_loyalty_id uuid, p_points integer',
    stubReturnType: 'boolean',
    stubBody: 'RETURN true;',
    stubParams: 'p_loyalty_id uuid, p_points integer',
  },
  {
    name: 'increment_campaign_donation',
    typeSig: 'uuid, numeric, integer',
    identityArgs: 'p_campaign_id uuid, p_amount numeric, p_donor_count integer',
    stubReturnType: 'void',
    stubBody: 'RETURN;',
    stubParams: 'p_campaign_id uuid, p_amount numeric, p_donor_count integer DEFAULT 1',
  },
  {
    name: 'upsert_customer_profile',
    typeSig: 'uuid, text, text, numeric, boolean, boolean',
    identityArgs: 'p_business_id uuid, p_phone text, p_name text, p_booking_amount numeric, p_is_booking boolean, p_is_order boolean',
    stubReturnType: 'uuid',
    stubBody: "RETURN gen_random_uuid();",
    stubParams: `p_business_id uuid, p_phone text, p_name text DEFAULT NULL, p_booking_amount numeric DEFAULT 0, p_is_booking boolean DEFAULT false, p_is_order boolean DEFAULT false`,
  },
];

if (!dbUrl) {
  describe.skip('Migration 296: Real PostgreSQL RPC permission tests (TEST_DATABASE_URL not set)', () => {
    it('skipped — set TEST_DATABASE_URL to enable', () => {});
  });
} else {

function runSQL(sql: string): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execSync(
      `psql "${dbUrl}" -t -A -v ON_ERROR_STOP=1`,
      { input: sql, encoding: 'utf-8', timeout: 15000 },
    );
    return { stdout: stdout.trim(), stderr: '', exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout?.trim() || '',
      stderr: err.stderr?.trim() || '',
      exitCode: err.status || 1,
    };
  }
}

describe('Migration 296: Real PostgreSQL RPC permission tests', () => {
  let isFullSchema = false;
  const beforeState: Record<string, { funcDef: string; owner: string; secDef: string; searchPath: string }> = {};

  beforeAll(() => {
    // Detect CI (full schema) vs local (empty DB)
    const check = runSQL(
      `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
       WHERE n.nspname = 'public' AND p.proname = 'book_slot_atomic';`
    );
    isFullSchema = check.stdout.includes('1');

    if (!isFullSchema) {
      // Local mode: create roles and stub functions
      runSQL(`
        DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
        DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
        DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
        GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
      `);

      for (const fn of FUNCTIONS) {
        runSQL(`
          CREATE OR REPLACE FUNCTION public.${fn.name}(${fn.stubParams})
          RETURNS ${fn.stubReturnType}
          LANGUAGE plpgsql
          SECURITY DEFINER
          SET search_path = public
          AS $fn$
          BEGIN
            ${fn.stubBody}
          END;
          $fn$;
        `);
      }
    }

    // Capture before-state for each function
    for (const fn of FUNCTIONS) {
      const funcDefResult = runSQL(
        `SELECT pg_get_functiondef(p.oid) FROM pg_proc p
         JOIN pg_namespace n ON p.pronamespace = n.oid
         WHERE n.nspname = 'public' AND p.proname = '${fn.name}'
         AND pg_get_function_identity_arguments(p.oid) = '${fn.identityArgs}';`
      );

      const ownerResult = runSQL(
        `SELECT r.rolname FROM pg_proc p
         JOIN pg_namespace n ON p.pronamespace = n.oid
         JOIN pg_roles r ON p.proowner = r.oid
         WHERE n.nspname = 'public' AND p.proname = '${fn.name}'
         AND pg_get_function_identity_arguments(p.oid) = '${fn.identityArgs}';`
      );

      const secDefResult = runSQL(
        `SELECT prosecdef FROM pg_proc p
         JOIN pg_namespace n ON p.pronamespace = n.oid
         WHERE n.nspname = 'public' AND p.proname = '${fn.name}'
         AND pg_get_function_identity_arguments(p.oid) = '${fn.identityArgs}';`
      );

      const searchPathResult = runSQL(
        `SELECT array_to_string(proconfig, ',') FROM pg_proc p
         JOIN pg_namespace n ON p.pronamespace = n.oid
         WHERE n.nspname = 'public' AND p.proname = '${fn.name}'
         AND pg_get_function_identity_arguments(p.oid) = '${fn.identityArgs}';`
      );

      beforeState[fn.name] = {
        funcDef: funcDefResult.stdout,
        owner: ownerResult.stdout,
        secDef: secDefResult.stdout,
        searchPath: searchPathResult.stdout,
      };
    }

    // Deliberately grant direct EXECUTE to anon and authenticated
    for (const fn of FUNCTIONS) {
      runSQL(`
        GRANT EXECUTE ON FUNCTION public.${fn.name}(${fn.typeSig}) TO anon;
        GRANT EXECUTE ON FUNCTION public.${fn.name}(${fn.typeSig}) TO authenticated;
        GRANT EXECUTE ON FUNCTION public.${fn.name}(${fn.typeSig}) TO service_role;
      `);
    }
  }, 30000);

  afterAll(() => {
    if (!isFullSchema) {
      for (const fn of FUNCTIONS) {
        runSQL(`DROP FUNCTION IF EXISTS public.${fn.name}(${fn.typeSig});`);
      }
    } else {
      // CI: undo test grants
      for (const fn of FUNCTIONS) {
        runSQL(`
          REVOKE EXECUTE ON FUNCTION public.${fn.name}(${fn.typeSig}) FROM anon;
          REVOKE EXECUTE ON FUNCTION public.${fn.name}(${fn.typeSig}) FROM authenticated;
        `);
      }
    }
  }, 10000);

  // ── Function existence ──

  for (const fn of FUNCTIONS) {
    it(`${fn.name}: function exists with exact signature`, () => {
      const result = runSQL(
        `SELECT proname FROM pg_proc p
         JOIN pg_namespace n ON p.pronamespace = n.oid
         WHERE n.nspname = 'public' AND p.proname = '${fn.name}'
         AND pg_get_function_identity_arguments(p.oid) = '${fn.identityArgs}';`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(fn.name);
    });
  }

  // ── Before-state captured ──

  for (const fn of FUNCTIONS) {
    it(`${fn.name}: before-state captured (non-empty definition)`, () => {
      expect(beforeState[fn.name].funcDef).toBeTruthy();
    });

    it(`${fn.name}: SECURITY DEFINER is true`, () => {
      expect(beforeState[fn.name].secDef).toBe('t');
    });
  }

  // ── Precondition: anon and authenticated have EXECUTE ──

  for (const fn of FUNCTIONS) {
    it(`${fn.name}: precondition — anon has EXECUTE`, () => {
      const result = runSQL(
        `SELECT has_function_privilege('anon', 'public.${fn.name}(${fn.typeSig})', 'EXECUTE');`
      );
      expect(result.stdout).toBe('t');
    });

    it(`${fn.name}: precondition — authenticated has EXECUTE`, () => {
      const result = runSQL(
        `SELECT has_function_privilege('authenticated', 'public.${fn.name}(${fn.typeSig})', 'EXECUTE');`
      );
      expect(result.stdout).toBe('t');
    });
  }

  // ── Apply Migration 296 ──

  it('Migration 296 applies without error', () => {
    const migrationSql = fs.readFileSync(MIGRATION_PATH, 'utf-8');
    const result = runSQL(migrationSql);
    expect(result.exitCode).toBe(0);
  });

  // ── Post-migration privilege verification ──

  for (const fn of FUNCTIONS) {
    it(`${fn.name}: post-migration — anon has no EXECUTE`, () => {
      const result = runSQL(
        `SELECT has_function_privilege('anon', 'public.${fn.name}(${fn.typeSig})', 'EXECUTE');`
      );
      expect(result.stdout).toBe('f');
    });

    it(`${fn.name}: post-migration — authenticated has no EXECUTE`, () => {
      const result = runSQL(
        `SELECT has_function_privilege('authenticated', 'public.${fn.name}(${fn.typeSig})', 'EXECUTE');`
      );
      expect(result.stdout).toBe('f');
    });

    it(`${fn.name}: post-migration — service_role has EXECUTE`, () => {
      const result = runSQL(
        `SELECT has_function_privilege('service_role', 'public.${fn.name}(${fn.typeSig})', 'EXECUTE');`
      );
      expect(result.stdout).toBe('t');
    });
  }

  // ── Function properties unchanged ──

  for (const fn of FUNCTIONS) {
    it(`${fn.name}: function definition unchanged`, () => {
      const result = runSQL(
        `SELECT pg_get_functiondef(p.oid) FROM pg_proc p
         JOIN pg_namespace n ON p.pronamespace = n.oid
         WHERE n.nspname = 'public' AND p.proname = '${fn.name}'
         AND pg_get_function_identity_arguments(p.oid) = '${fn.identityArgs}';`
      );
      expect(result.stdout).toBe(beforeState[fn.name].funcDef);
    });

    it(`${fn.name}: owner unchanged`, () => {
      const result = runSQL(
        `SELECT r.rolname FROM pg_proc p
         JOIN pg_namespace n ON p.pronamespace = n.oid
         JOIN pg_roles r ON p.proowner = r.oid
         WHERE n.nspname = 'public' AND p.proname = '${fn.name}'
         AND pg_get_function_identity_arguments(p.oid) = '${fn.identityArgs}';`
      );
      expect(result.stdout).toBe(beforeState[fn.name].owner);
    });

    it(`${fn.name}: SECURITY DEFINER unchanged`, () => {
      const result = runSQL(
        `SELECT prosecdef FROM pg_proc p
         JOIN pg_namespace n ON p.pronamespace = n.oid
         WHERE n.nspname = 'public' AND p.proname = '${fn.name}'
         AND pg_get_function_identity_arguments(p.oid) = '${fn.identityArgs}';`
      );
      expect(result.stdout).toBe('t');
    });

    it(`${fn.name}: search_path unchanged`, () => {
      const result = runSQL(
        `SELECT array_to_string(proconfig, ',') FROM pg_proc p
         JOIN pg_namespace n ON p.pronamespace = n.oid
         WHERE n.nspname = 'public' AND p.proname = '${fn.name}'
         AND pg_get_function_identity_arguments(p.oid) = '${fn.identityArgs}';`
      );
      expect(result.stdout).toBe(beforeState[fn.name].searchPath);
    });
  }

  // ── Idempotency: second application ──

  it('Migration 296 applies a second time without error', () => {
    const migrationSql = fs.readFileSync(MIGRATION_PATH, 'utf-8');
    const result = runSQL(migrationSql);
    expect(result.exitCode).toBe(0);
  });

  it('privileges remain correct after second application', () => {
    for (const fn of FUNCTIONS) {
      const anon = runSQL(`SELECT has_function_privilege('anon', 'public.${fn.name}(${fn.typeSig})', 'EXECUTE');`);
      expect(anon.stdout).toBe('f');

      const auth = runSQL(`SELECT has_function_privilege('authenticated', 'public.${fn.name}(${fn.typeSig})', 'EXECUTE');`);
      expect(auth.stdout).toBe('f');

      const sr = runSQL(`SELECT has_function_privilege('service_role', 'public.${fn.name}(${fn.typeSig})', 'EXECUTE');`);
      expect(sr.stdout).toBe('t');
    }
  });
});

} // end of if (dbUrl)

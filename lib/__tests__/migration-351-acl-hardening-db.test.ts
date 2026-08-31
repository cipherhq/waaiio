/**
 * Migration 351: SECURITY DEFINER ACL Hardening Tests
 *
 * Proves all targeted SECURITY DEFINER functions are denied to
 * anon/authenticated and allowed for service_role.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'child_process';

const dbUrl = process.env.TEST_DATABASE_URL;

if (!dbUrl) {
  describe.skip('Migration 351 ACL hardening — TEST_DATABASE_URL not set', () => {
    it('skipped', () => {});
  });
} else {

function runSQL(sql: string, role?: string): { stdout: string; stderr: string; exitCode: number } {
  const fullSql = role ? `SET ROLE ${role};\n${sql}` : sql;
  try {
    let stdout = execSync(
      `psql "${dbUrl}" -t -A -v ON_ERROR_STOP=1`,
      { input: fullSql, encoding: 'utf-8', timeout: 15000 },
    );
    stdout = stdout.trim();
    if (role && stdout.startsWith('SET\n')) stdout = stdout.slice(4).trim();
    else if (role && stdout === 'SET') stdout = '';
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: any) {
    return { stdout: err.stdout?.trim() || '', stderr: err.stderr?.trim() || '', exitCode: err.status || 1 };
  }
}

// All 22 exact signatures to test
const P0_FUNCTIONS = [
  { name: 'claim_payment_finalization', sig: 'claim_payment_finalization(uuid)' },
  { name: 'complete_payment_finalization', sig: 'complete_payment_finalization(uuid, uuid)' },
  { name: 'release_payment_finalization', sig: 'release_payment_finalization(uuid, uuid)' },
  { name: 'finalize_token_recurring_charge', sig: 'finalize_token_recurring_charge(text, uuid, numeric, text, text, text)' },
  { name: 'claim_recurring_billing_cycle', sig: 'claim_recurring_billing_cycle(uuid)' },
  { name: 'record_flutterwave_definitive_failure', sig: 'record_flutterwave_definitive_failure(uuid, text)' },
  { name: 'cancel_flutterwave_after_failures', sig: 'cancel_flutterwave_after_failures(uuid)' },
];

const P1_FUNCTIONS = [
  { name: 'admin_grant_capability', sig: 'admin_grant_capability(uuid, text, uuid, text)' },
  { name: 'admin_revoke_capability', sig: 'admin_revoke_capability(uuid, text, uuid, text)' },
  { name: 'configure_business_capabilities', sig: "configure_business_capabilities(uuid, text[], integer[], text, timestamptz, text, text[], text[])" },
  { name: 'decrement_stock', sig: 'decrement_stock(uuid, integer)' },
  { name: 'decrement_variant_stock', sig: 'decrement_variant_stock(uuid, integer)' },
  { name: 'reset_low_stock_alerts', sig: 'reset_low_stock_alerts()' },
  { name: 'purchase_tickets_atomic', sig: 'purchase_tickets_atomic(uuid, uuid, uuid, integer, uuid, text, text, text, integer, text)' },
  { name: 'reserve_booking_slot', sig: 'reserve_booking_slot(uuid, date, time, time, uuid, uuid, integer)' },
  { name: 'cancel_booking_with_release', sig: 'cancel_booking_with_release(uuid, text, uuid)' },
  { name: 'release_package_session', sig: 'release_package_session(uuid)' },
  { name: 'book_with_package_atomic', sig: 'book_with_package_atomic(uuid, uuid, uuid, uuid, date, text, integer, integer, text, integer, text, text, text, text, text, text, text, date, jsonb, uuid, integer, text, uuid, uuid, integer, integer, uuid, uuid)' },
  { name: 'release_booking_slot', sig: 'release_booking_slot(uuid, date, time, uuid, uuid)' },
];

// P3: _is_service_role — only exists on staging/production (not in repository migrations)
// Tests are conditional on function existence
const P3_FUNCTIONS: Array<{ name: string; sig: string }> = [];

const P2_FUNCTIONS = [
  { name: 'increment_customer_visit', sig: 'increment_customer_visit(uuid, text, numeric)' },
  { name: 'increment_ai_usage (2-arg)', sig: 'increment_ai_usage(uuid, text)' },
  { name: 'increment_ai_usage (3-arg)', sig: 'increment_ai_usage(uuid, text, text)' },
  { name: 'increment_broadcast_usage', sig: 'increment_broadcast_usage(uuid, integer)' },
  { name: 'increment_chat_forwards', sig: 'increment_chat_forwards(uuid)' },
  { name: 'increment_form_response_count', sig: 'increment_form_response_count(uuid)' },
  { name: 'increment_message_usage', sig: 'increment_message_usage(uuid, text, boolean)' },
  { name: 'increment_promo_usage', sig: 'increment_promo_usage(uuid)' },
];

const ALL_FUNCTIONS = [...P0_FUNCTIONS, ...P1_FUNCTIONS, ...P2_FUNCTIONS, ...P3_FUNCTIONS];

describe('Migration 351 ACL hardening', () => {

  // P0: Financial — anon denied
  for (const fn of P0_FUNCTIONS) {
    it(`P0: anon CANNOT execute ${fn.name}`, () => {
      const r = runSQL(`SELECT has_function_privilege('anon', '${fn.sig}', 'EXECUTE') AS p;`);
      expect(r.stdout).toBe('f');
    });
  }

  // P0: Financial — authenticated denied
  for (const fn of P0_FUNCTIONS) {
    it(`P0: authenticated CANNOT execute ${fn.name}`, () => {
      const r = runSQL(`SELECT has_function_privilege('authenticated', '${fn.sig}', 'EXECUTE') AS p;`);
      expect(r.stdout).toBe('f');
    });
  }

  // P0: Financial — service_role allowed
  for (const fn of P0_FUNCTIONS) {
    it(`P0: service_role CAN execute ${fn.name}`, () => {
      const r = runSQL(`SELECT has_function_privilege('service_role', '${fn.sig}', 'EXECUTE') AS p;`);
      expect(r.stdout).toBe('t');
    });
  }

  // P1: Admin/inventory — anon denied
  for (const fn of P1_FUNCTIONS) {
    it(`P1: anon CANNOT execute ${fn.name}`, () => {
      const r = runSQL(`SELECT has_function_privilege('anon', '${fn.sig}', 'EXECUTE') AS p;`);
      expect(r.stdout).toBe('f');
    });
  }

  // P1: Admin/inventory — service_role allowed
  for (const fn of P1_FUNCTIONS) {
    it(`P1: service_role CAN execute ${fn.name}`, () => {
      const r = runSQL(`SELECT has_function_privilege('service_role', '${fn.sig}', 'EXECUTE') AS p;`);
      expect(r.stdout).toBe('t');
    });
  }

  // P1: Admin/inventory — authenticated denied
  for (const fn of P1_FUNCTIONS) {
    it(`P1: authenticated CANNOT execute ${fn.name}`, () => {
      const r = runSQL(`SELECT has_function_privilege('authenticated', '${fn.sig}', 'EXECUTE') AS p;`);
      expect(r.stdout).toBe('f');
    });
  }

  // P2: Usage counters — anon denied
  for (const fn of P2_FUNCTIONS) {
    it(`P2: anon CANNOT execute ${fn.name}`, () => {
      const r = runSQL(`SELECT has_function_privilege('anon', '${fn.sig}', 'EXECUTE') AS p;`);
      expect(r.stdout).toBe('f');
    });
  }

  // P2: Usage counters — authenticated denied
  for (const fn of P2_FUNCTIONS) {
    it(`P2: authenticated CANNOT execute ${fn.name}`, () => {
      const r = runSQL(`SELECT has_function_privilege('authenticated', '${fn.sig}', 'EXECUTE') AS p;`);
      expect(r.stdout).toBe('f');
    });
  }

  // P2: Usage counters — service_role allowed
  for (const fn of P2_FUNCTIONS) {
    it(`P2: service_role CAN execute ${fn.name}`, () => {
      const r = runSQL(`SELECT has_function_privilege('service_role', '${fn.sig}', 'EXECUTE') AS p;`);
      expect(r.stdout).toBe('t');
    });
  }

  // P3: _is_service_role — conditional test (function only exists on staging/prod, not CI)
  it('P3: _is_service_role ACL hardened if function exists', () => {
    const exists = runSQL("SELECT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = 'public' AND p.proname = '_is_service_role') AS e;");
    if (exists.stdout === 't') {
      const anon = runSQL("SELECT has_function_privilege('anon', '_is_service_role()', 'EXECUTE') AS p;");
      expect(anon.stdout).toBe('f');
      const auth = runSQL("SELECT has_function_privilege('authenticated', '_is_service_role()', 'EXECUTE') AS p;");
      expect(auth.stdout).toBe('f');
      const svc = runSQL("SELECT has_function_privilege('service_role', '_is_service_role()', 'EXECUTE') AS p;");
      expect(svc.stdout).toBe('t');
    }
    // If function doesn't exist, test passes (correctly — it's not in repository migrations)
    expect(true).toBe(true);
  });

  // Runtime denial proofs
  it('runtime: anon cannot call claim_payment_finalization', () => {
    const r = runSQL(
      "SELECT claim_payment_finalization('00000000-0000-0000-0000-000000000000'::uuid);",
      'anon'
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('permission denied');
  });

  it('runtime: anon cannot call finalize_token_recurring_charge', () => {
    const r = runSQL(
      "SELECT finalize_token_recurring_charge('ref', '00000000-0000-0000-0000-000000000000'::uuid, 100.00, 'NGN', 'flutterwave', 'ref');",
      'anon'
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('permission denied');
  });

  it('runtime: anon cannot call admin_grant_capability', () => {
    const r = runSQL(
      "SELECT admin_grant_capability('00000000-0000-0000-0000-000000000000'::uuid, 'test', '00000000-0000-0000-0000-000000000000'::uuid, 'test');",
      'anon'
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('permission denied');
  });

  it('runtime: anon cannot call decrement_stock', () => {
    const r = runSQL(
      "SELECT decrement_stock('00000000-0000-0000-0000-000000000000'::uuid, 1);",
      'anon'
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('permission denied');
  });

  it('runtime: authenticated cannot call configure_business_capabilities', () => {
    const r = runSQL(
      "SELECT configure_business_capabilities('00000000-0000-0000-0000-000000000000'::uuid, ARRAY['test']::text[], ARRAY[0]::integer[], 'free', NOW(), 'active', ARRAY[]::text[], ARRAY[]::text[]);",
      'authenticated'
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('permission denied');
  });

  it('runtime: authenticated cannot call release_booking_slot', () => {
    const r = runSQL(
      "SELECT release_booking_slot('00000000-0000-0000-0000-000000000000'::uuid, '2026-01-01'::date, '10:00'::time, '00000000-0000-0000-0000-000000000000'::uuid, '00000000-0000-0000-0000-000000000000'::uuid);",
      'authenticated'
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('permission denied');
  });

  // mark_booking_no_show ACL tests (from migration 354)
  it('mark_booking_no_show: anon CANNOT execute', () => {
    const r = runSQL("SELECT has_function_privilege('anon', 'mark_booking_no_show(uuid, text)', 'EXECUTE') AS p;");
    expect(r.stdout).toBe('f');
  });

  it('mark_booking_no_show: authenticated CANNOT execute', () => {
    const r = runSQL("SELECT has_function_privilege('authenticated', 'mark_booking_no_show(uuid, text)', 'EXECUTE') AS p;");
    expect(r.stdout).toBe('f');
  });

  it('mark_booking_no_show: service_role CAN execute', () => {
    const r = runSQL("SELECT has_function_privilege('service_role', 'mark_booking_no_show(uuid, text)', 'EXECUTE') AS p;");
    expect(r.stdout).toBe('t');
  });

  it('runtime: anon cannot call mark_booking_no_show', () => {
    const r = runSQL(
      "SELECT mark_booking_no_show('00000000-0000-0000-0000-000000000000'::uuid, 'test');",
      'anon'
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('permission denied');
  });

  it('runtime: authenticated cannot call mark_booking_no_show', () => {
    const r = runSQL(
      "SELECT mark_booking_no_show('00000000-0000-0000-0000-000000000000'::uuid, 'test');",
      'authenticated'
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('permission denied');
  });
});

} // end if (dbUrl)

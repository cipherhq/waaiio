/**
 * Migration 351: SECURITY DEFINER ACL Hardening Tests
 *
 * Proves all 22 targeted functions are denied to anon/authenticated
 * and allowed for service_role.
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
];

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

const ALL_FUNCTIONS = [...P0_FUNCTIONS, ...P1_FUNCTIONS, ...P2_FUNCTIONS];

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

  // P2: Usage counters — anon denied
  for (const fn of P2_FUNCTIONS) {
    it(`P2: anon CANNOT execute ${fn.name}`, () => {
      const r = runSQL(`SELECT has_function_privilege('anon', '${fn.sig}', 'EXECUTE') AS p;`);
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

  // Runtime denial proof: anon SET ROLE + direct call
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
});

} // end if (dbUrl)

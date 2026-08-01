import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Static verification of migration SQL contracts.
 * Proves the correct GRANT/REVOKE/POLICY statements exist in the migration files.
 * These are deterministic, source-verified tests — not runtime PostgreSQL tests.
 */

function readMigration(name: string): string {
  return readFileSync(resolve('supabase/migrations', name), 'utf-8');
}

describe('Migration 299 — capability write restriction', () => {
  const sql = readMigration('299_restrict_capability_writes.sql');

  it('drops owner UPDATE policy', () => {
    expect(sql).toMatch(/DROP\s+POLICY\s+IF\s+EXISTS\s+business_capabilities_owner_update/i);
  });

  it('drops owner DELETE policy', () => {
    expect(sql).toMatch(/DROP\s+POLICY\s+IF\s+EXISTS\s+business_capabilities_owner_delete/i);
  });

  it('creates service-role-only UPDATE policy', () => {
    expect(sql).toMatch(/CREATE\s+POLICY\s+business_capabilities_server_only_update.*FOR\s+UPDATE\s+TO\s+service_role/is);
  });

  it('creates service-role-only DELETE policy', () => {
    expect(sql).toMatch(/CREATE\s+POLICY\s+business_capabilities_server_only_delete.*FOR\s+DELETE\s+TO\s+service_role/is);
  });

  it('does not modify SELECT policies', () => {
    expect(sql).not.toMatch(/DROP\s+POLICY.*owner_select/i);
    expect(sql).not.toMatch(/CREATE\s+POLICY.*FOR\s+SELECT/i);
  });

  it('contains documented rollback SQL', () => {
    expect(sql).toMatch(/Rollback:/i);
    expect(sql).toMatch(/CREATE\s+POLICY\s+business_capabilities_owner_update/i);
  });
});

describe('Migration 300 — atomic capability configuration RPC', () => {
  const sql = readMigration('300_atomic_capability_config.sql');

  it('creates configure_business_capabilities function', () => {
    expect(sql).toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+configure_business_capabilities/i);
  });

  it('is SECURITY DEFINER', () => {
    expect(sql).toMatch(/SECURITY\s+DEFINER/i);
  });

  it('sets search_path to public', () => {
    expect(sql).toMatch(/SET\s+search_path\s*=\s*public/i);
  });

  it('accepts required and snapshot parameters', () => {
    expect(sql).toMatch(/p_business_id\s+UUID/i);
    expect(sql).toMatch(/p_capabilities\s+TEXT\[\]/i);
    expect(sql).toMatch(/p_sort_orders\s+INT\[\]/i);
    expect(sql).toMatch(/p_expected_tier/i);
    expect(sql).toMatch(/p_expected_status/i);
  });

  it('validates array length match', () => {
    expect(sql).toMatch(/capabilities\s+and\s+sort_orders\s+arrays\s+must\s+have\s+equal\s+length/i);
  });

  it('rejects duplicates', () => {
    expect(sql).toMatch(/duplicate\s+capability\s+IDs/i);
  });

  it('requires at least one capability', () => {
    expect(sql).toMatch(/must\s+select\s+at\s+least\s+one/i);
  });

  it('rejects duplicate sort orders', () => {
    expect(sql).toMatch(/duplicate\s+sort\s+orders/i);
  });

  it('validates sort order bounds', () => {
    expect(sql).toMatch(/sort\s+orders\s+must\s+be\s+between/i);
  });

  it('verifies snapshot against stale reads', () => {
    expect(sql).toMatch(/configuration_conflict/i);
    expect(sql).toMatch(/p_expected_tier/i);
    expect(sql).toMatch(/p_expected_status/i);
  });

  it('locks business row with FOR UPDATE', () => {
    expect(sql).toMatch(/FOR\s+UPDATE/i);
  });

  it('preserves custom_label', () => {
    expect(sql).toMatch(/custom_label.*NOT\s+touched|custom_label.*preserved/i);
  });

  it('revokes access from PUBLIC and authenticated', () => {
    expect(sql).toMatch(/REVOKE\s+ALL\s+ON\s+FUNCTION\s+configure_business_capabilities.*FROM\s+PUBLIC/i);
    expect(sql).toMatch(/REVOKE\s+ALL\s+ON\s+FUNCTION\s+configure_business_capabilities.*FROM\s+authenticated/i);
  });

  it('grants access only to service_role', () => {
    expect(sql).toMatch(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+configure_business_capabilities.*TO\s+service_role/i);
  });

  it('contains documented rollback SQL', () => {
    expect(sql).toMatch(/Rollback:/i);
    expect(sql).toMatch(/DROP\s+FUNCTION/i);
  });
});

describe('Migration 301 — atomic admin capability RPCs', () => {
  const sql = readMigration('301_atomic_admin_capability.sql');

  it('creates admin_grant_capability function', () => {
    expect(sql).toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+admin_grant_capability/i);
  });

  it('creates admin_revoke_capability function', () => {
    expect(sql).toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+admin_revoke_capability/i);
  });

  it('both are SECURITY DEFINER', () => {
    const matches = sql.match(/SECURITY\s+DEFINER/gi);
    expect(matches?.length).toBeGreaterThanOrEqual(2);
  });

  it('both functions lock business row with FOR UPDATE', () => {
    const forUpdateMatches = sql.match(/FOR\s+UPDATE/gi);
    expect(forUpdateMatches?.length).toBeGreaterThanOrEqual(2);
  });

  it('grant creates override + enables capability + audit log', () => {
    expect(sql).toMatch(/INSERT\s+INTO\s+capability_overrides/i);
    expect(sql).toMatch(/INSERT\s+INTO\s+business_capabilities/i);
    expect(sql).toMatch(/INSERT\s+INTO\s+admin_audit_logs/i);
  });

  it('revoke deletes override + disables capability + audit log', () => {
    expect(sql).toMatch(/DELETE\s+FROM\s+capability_overrides/i);
    expect(sql).toMatch(/UPDATE\s+business_capabilities/i);
  });

  it('revokes access from PUBLIC and authenticated for both functions', () => {
    const grantRevokes = (sql.match(/REVOKE\s+ALL\s+ON\s+FUNCTION\s+admin_grant_capability.*FROM/gi) || []).length;
    const revokeRevokes = (sql.match(/REVOKE\s+ALL\s+ON\s+FUNCTION\s+admin_revoke_capability.*FROM/gi) || []).length;
    expect(grantRevokes).toBeGreaterThanOrEqual(2);
    expect(revokeRevokes).toBeGreaterThanOrEqual(2);
  });

  it('grants execute only to service_role for both functions', () => {
    expect(sql).toMatch(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+admin_grant_capability.*TO\s+service_role/i);
    expect(sql).toMatch(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+admin_revoke_capability.*TO\s+service_role/i);
  });

  it('contains documented rollback SQL', () => {
    expect(sql).toMatch(/Rollback:/i);
  });
});

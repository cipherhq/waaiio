/**
 * Migration 295 — RPC Permission Hardening Tests
 *
 * Verifies that Migration 295 correctly restricts EXECUTE privileges on
 * process_recurring_charge to service_role only, without modifying the
 * function body, owner, or security settings.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const migrationCode = readFileSync(
  'supabase/migrations/295_restrict_recurring_charge_rpc_execute.sql',
  'utf-8'
);

// ── Correct function signature ──

describe('Migration 295 targets correct function signature', () => {
  it('targets the exact overloaded signature (text, text, text, text, text, bigint, text, text, text, text)', () => {
    expect(migrationCode).toContain(
      'process_recurring_charge(text, text, text, text, text, bigint, text, text, text, text)'
    );
  });

  it('references the function in public schema', () => {
    expect(migrationCode).toContain('public.process_recurring_charge');
  });
});

// ── Required privilege changes ──

describe('Migration 295 privilege changes', () => {
  it('REVOKE EXECUTE FROM PUBLIC is present', () => {
    expect(migrationCode).toMatch(
      /REVOKE\s+EXECUTE\s+ON\s+FUNCTION\s+public\.process_recurring_charge\(.*?\)\s+FROM\s+PUBLIC/is
    );
  });

  it('REVOKE EXECUTE FROM anon is present', () => {
    expect(migrationCode).toMatch(
      /REVOKE\s+EXECUTE\s+ON\s+FUNCTION\s+public\.process_recurring_charge\(.*?\)\s+FROM\s+anon/is
    );
  });

  it('REVOKE EXECUTE FROM authenticated is present', () => {
    expect(migrationCode).toMatch(
      /REVOKE\s+EXECUTE\s+ON\s+FUNCTION\s+public\.process_recurring_charge\(.*?\)\s+FROM\s+authenticated/is
    );
  });

  it('GRANT EXECUTE TO service_role is present', () => {
    expect(migrationCode).toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.process_recurring_charge\(.*?\)\s+TO\s+service_role/is
    );
  });
});

// ── Safety: must NOT modify function or schema ──

describe('Migration 295 does not modify function or schema', () => {
  it('does NOT contain CREATE OR REPLACE FUNCTION', () => {
    expect(migrationCode.toUpperCase()).not.toContain('CREATE OR REPLACE FUNCTION');
  });

  it('does NOT contain ALTER FUNCTION ... OWNER', () => {
    expect(migrationCode.toUpperCase()).not.toMatch(/ALTER\s+FUNCTION.*OWNER/);
  });

  it('does NOT contain SECURITY INVOKER', () => {
    expect(migrationCode.toUpperCase()).not.toContain('SECURITY INVOKER');
  });

  it('does NOT contain CREATE TABLE', () => {
    expect(migrationCode.toUpperCase()).not.toContain('CREATE TABLE');
  });

  it('does NOT contain ALTER TABLE', () => {
    expect(migrationCode.toUpperCase()).not.toContain('ALTER TABLE');
  });

  it('does NOT contain DROP TABLE', () => {
    expect(migrationCode.toUpperCase()).not.toContain('DROP TABLE');
  });

  it('does NOT contain CREATE POLICY', () => {
    expect(migrationCode.toUpperCase()).not.toContain('CREATE POLICY');
  });

  it('does NOT contain ALTER POLICY', () => {
    expect(migrationCode.toUpperCase()).not.toContain('ALTER POLICY');
  });

  it('does NOT contain DROP POLICY', () => {
    expect(migrationCode.toUpperCase()).not.toContain('DROP POLICY');
  });
});

// ── Idempotency and role guards ──

describe('Migration 295 idempotency and role guards', () => {
  it('is idempotent (REVOKE is naturally idempotent in PostgreSQL)', () => {
    // REVOKE does not error if the privilege was already revoked
    // Just verify the migration uses REVOKE (which is inherently idempotent)
    const revokeCount = (migrationCode.match(/REVOKE\s+EXECUTE/gi) || []).length;
    expect(revokeCount).toBeGreaterThanOrEqual(3); // PUBLIC + anon + authenticated
  });

  it('role-specific operations are guarded by pg_roles checks', () => {
    // anon guard
    expect(migrationCode).toContain("SELECT 1 FROM pg_roles WHERE rolname = 'anon'");
    // authenticated guard
    expect(migrationCode).toContain("SELECT 1 FROM pg_roles WHERE rolname = 'authenticated'");
    // service_role guard
    expect(migrationCode).toContain("SELECT 1 FROM pg_roles WHERE rolname = 'service_role'");
  });

  it('uses DO $$ block for conditional logic', () => {
    expect(migrationCode).toContain('DO $$');
  });
});

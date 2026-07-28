/**
 * Migration 296 — Static RPC Permission Hardening Tests
 *
 * Verifies that Migration 296 correctly targets all 7 SECURITY DEFINER
 * functions with exact signatures, includes required REVOKE/GRANT statements,
 * and does not modify function bodies or schema.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const migrationCode = readFileSync(
  'supabase/migrations/296_restrict_sensitive_rpc_execution.sql',
  'utf-8'
);
const upper = migrationCode.toUpperCase();

// ── All 7 function signatures are targeted ──

const FUNCTIONS = [
  {
    name: 'book_slot_atomic',
    sigFragment: 'book_slot_atomic(\n    uuid, uuid, uuid, uuid, date, text, int, int,\n    text, int, text, text, text, text, text,\n    text, text, date, jsonb, uuid, int, text,\n    uuid, uuid, integer, integer\n  )',
  },
  { name: 'restore_stock', sigFragment: 'restore_stock(uuid, integer)' },
  { name: 'restore_variant_stock', sigFragment: 'restore_variant_stock(uuid, integer)' },
  { name: 'restore_tickets_sold', sigFragment: 'restore_tickets_sold(uuid, integer)' },
  { name: 'redeem_loyalty_points', sigFragment: 'redeem_loyalty_points(uuid, integer)' },
  { name: 'increment_campaign_donation', sigFragment: 'increment_campaign_donation(uuid, numeric, integer)' },
  { name: 'upsert_customer_profile', sigFragment: 'upsert_customer_profile(uuid, text, text, numeric, boolean, boolean)' },
];

describe('Migration 296 targets all 7 functions with exact signatures', () => {
  for (const fn of FUNCTIONS) {
    it(`targets ${fn.name}`, () => {
      expect(migrationCode).toContain(fn.sigFragment);
    });
  }
});

// ── Required privilege changes for each function ──

describe('Migration 296 privilege changes', () => {
  for (const fn of FUNCTIONS) {
    it(`REVOKE EXECUTE FROM PUBLIC for ${fn.name}`, () => {
      expect(migrationCode).toMatch(
        new RegExp(`REVOKE\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+public\\.${fn.name}\\(`, 'is')
      );
    });

    it(`REVOKE EXECUTE FROM anon for ${fn.name}`, () => {
      const revokeAnonPattern = new RegExp(
        `REVOKE\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+public\\.${fn.name}\\([^)]*\\)\\s+FROM\\s+anon`,
        'is'
      );
      expect(migrationCode).toMatch(revokeAnonPattern);
    });

    it(`REVOKE EXECUTE FROM authenticated for ${fn.name}`, () => {
      const revokeAuthPattern = new RegExp(
        `REVOKE\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+public\\.${fn.name}\\([^)]*\\)\\s+FROM\\s+authenticated`,
        'is'
      );
      expect(migrationCode).toMatch(revokeAuthPattern);
    });

    it(`GRANT EXECUTE TO service_role for ${fn.name}`, () => {
      const grantPattern = new RegExp(
        `GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+public\\.${fn.name}\\([^)]*\\)\\s+TO\\s+service_role`,
        'is'
      );
      expect(migrationCode).toMatch(grantPattern);
    });
  }
});

// ── Role existence guards ──

describe('Migration 296 role existence guards', () => {
  it('guards anon with pg_roles check', () => {
    expect(migrationCode).toContain("SELECT 1 FROM pg_roles WHERE rolname = 'anon'");
  });

  it('guards authenticated with pg_roles check', () => {
    expect(migrationCode).toContain("SELECT 1 FROM pg_roles WHERE rolname = 'authenticated'");
  });

  it('guards service_role with pg_roles check', () => {
    expect(migrationCode).toContain("SELECT 1 FROM pg_roles WHERE rolname = 'service_role'");
  });
});

// ── Safety: must NOT modify function or schema ──

describe('Migration 296 does not modify functions or schema', () => {
  it('does NOT contain CREATE OR REPLACE FUNCTION', () => {
    expect(upper).not.toContain('CREATE OR REPLACE FUNCTION');
  });

  it('does NOT contain ALTER FUNCTION ... OWNER', () => {
    expect(upper).not.toMatch(/ALTER\s+FUNCTION.*OWNER/);
  });

  it('does NOT contain SECURITY INVOKER', () => {
    expect(upper).not.toContain('SECURITY INVOKER');
  });

  it('does NOT contain CREATE TABLE', () => {
    expect(upper).not.toContain('CREATE TABLE');
  });

  it('does NOT contain ALTER TABLE', () => {
    expect(upper).not.toContain('ALTER TABLE');
  });

  it('does NOT contain DROP TABLE', () => {
    expect(upper).not.toContain('DROP TABLE');
  });

  it('does NOT contain CREATE POLICY', () => {
    expect(upper).not.toContain('CREATE POLICY');
  });

  it('does NOT contain INSERT, UPDATE or DELETE statements', () => {
    // Check for DML outside of function bodies (the migration itself shouldn't have DML)
    // The migration only has REVOKE/GRANT and DO block with IF EXISTS
    expect(upper).not.toMatch(/\bINSERT\s+INTO\b/);
    expect(upper).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/);
    expect(upper).not.toMatch(/\bDELETE\s+FROM\b/);
  });
});

// ── Idempotency ──

describe('Migration 296 idempotency', () => {
  it('uses DO $$ block for conditional logic', () => {
    expect(migrationCode).toContain('DO $$');
  });

  it('has at least 7 REVOKE EXECUTE FROM PUBLIC (one per function)', () => {
    const count = (migrationCode.match(/REVOKE\s+EXECUTE\s+ON\s+FUNCTION\s+public\.\w+\([^)]*\)\s+FROM\s+PUBLIC/gis) || []).length;
    expect(count).toBeGreaterThanOrEqual(7);
  });
});

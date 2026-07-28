/**
 * Migration 297 — Static Migration Source Tests
 *
 * Verifies that Migration 297 correctly creates only the missing
 * properties_updated_at trigger on public.properties, without modifying
 * any table, function, or data.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const migrationCode = readFileSync(
  'supabase/migrations/297_complete_migration_115_trigger.sql',
  'utf-8'
);

// ── Correct target ──

describe('Migration 297 targets public.properties', () => {
  it('references public.properties table', () => {
    expect(migrationCode).toContain('public.properties');
  });

  it('creates properties_updated_at trigger', () => {
    expect(migrationCode).toContain('properties_updated_at');
  });

  it('uses BEFORE UPDATE trigger timing', () => {
    expect(migrationCode).toMatch(/BEFORE\s+UPDATE\s+ON\s+public\.properties/i);
  });

  it('uses FOR EACH ROW', () => {
    expect(migrationCode).toMatch(/FOR\s+EACH\s+ROW/i);
  });

  it('calls public.update_updated_at()', () => {
    expect(migrationCode).toMatch(
      /EXECUTE\s+FUNCTION\s+public\.update_updated_at\(\)/i
    );
  });
});

// ── Idempotency: checks pg_trigger before creation ──

describe('Migration 297 idempotency', () => {
  it('checks pg_trigger before creating trigger', () => {
    expect(migrationCode).toContain('pg_trigger');
  });

  it('uses DO $$ block for conditional logic', () => {
    expect(migrationCode).toContain('DO $$');
  });
});

// ── Safety: must NOT modify schema or data ──

describe('Migration 297 does not modify schema or data', () => {
  it('does NOT contain CREATE TABLE', () => {
    expect(migrationCode.toUpperCase()).not.toContain('CREATE TABLE');
  });

  it('does NOT contain ALTER TABLE', () => {
    expect(migrationCode.toUpperCase()).not.toContain('ALTER TABLE');
  });

  it('does NOT contain INSERT (as DML)', () => {
    // The word INSERT only appears in trigger event context (not as DML statement)
    // Check that there's no INSERT INTO or INSERT followed by a table name
    expect(migrationCode.toUpperCase()).not.toMatch(/INSERT\s+INTO/);
  });

  it('does NOT contain UPDATE (as DML)', () => {
    // UPDATE appears in "BEFORE UPDATE ON" context (trigger event), not as DML
    // Check that there's no UPDATE ... SET pattern
    expect(migrationCode.toUpperCase()).not.toMatch(/UPDATE\s+public\.\w+\s+SET/);
  });

  it('does NOT contain DELETE (as DML)', () => {
    expect(migrationCode.toUpperCase()).not.toMatch(/DELETE\s+FROM/);
  });

  it('does NOT contain CREATE OR REPLACE FUNCTION', () => {
    expect(migrationCode.toUpperCase()).not.toContain('CREATE OR REPLACE FUNCTION');
  });

  it('does NOT modify Migration 115 (only references its own path)', () => {
    // The migration file should not reference any other migration file path
    expect(migrationCode).not.toContain('115_');
  });
});

// ── Prerequisite verification ──

describe('Migration 297 verifies prerequisites', () => {
  it('checks that properties table exists', () => {
    expect(migrationCode).toContain("c.relname = 'properties'");
  });

  it('checks that update_updated_at function exists', () => {
    expect(migrationCode).toContain("p.proname = 'update_updated_at'");
  });

  it('raises exception if table is missing', () => {
    expect(migrationCode).toMatch(/RAISE\s+EXCEPTION.*properties.*does not exist/i);
  });

  it('raises exception if function is missing', () => {
    expect(migrationCode).toMatch(/RAISE\s+EXCEPTION.*update_updated_at.*does not exist/i);
  });
});

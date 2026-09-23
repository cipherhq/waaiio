/**
 * Release Gate V2 — Migration Lint Tests (R2 corrections)
 *
 * Proves:
 * - M394-pattern caught by lint
 * - Protected function enforcement
 * - Historical M394 does NOT make the gate permanently unusable
 * - Candidate-only linting works
 */

import { describe, it, expect } from 'vitest';
import { lintMigration, lintMigrationDirectory, HISTORICAL_EXCEPTIONS } from '../release-gate/migration-lint';
import { resolve } from 'path';

describe('#365: M394-style regression detected by lint', () => {
  it('catches CREATE OR REPLACE that drops extensions from search_path', () => {
    const sql = `
      CREATE OR REPLACE FUNCTION initialize_terminal_effects(
        p_payment_id UUID, p_claim_token UUID, p_effect_keys TEXT[],
        p_categories TEXT[], p_execution_classes TEXT[],
        p_provider_channels TEXT[], p_manifest_version INTEGER DEFAULT 1
      ) RETURNS JSONB
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        RETURN encode(digest('test', 'sha256'), 'hex');
      END;
      $$;
    `;
    const violations = lintMigration('candidate.sql', sql);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some(v => v.severity === 'error' && v.message.includes('extensions'))).toBe(true);
  });

  it('passes when search_path includes extensions', () => {
    const sql = `
      CREATE OR REPLACE FUNCTION initialize_terminal_effects(
        p_payment_id UUID, p_claim_token UUID, p_effect_keys TEXT[],
        p_categories TEXT[], p_execution_classes TEXT[],
        p_provider_channels TEXT[], p_manifest_version INTEGER DEFAULT 1
      ) RETURNS JSONB
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
      BEGIN
        RETURN encode(digest('test', 'sha256'), 'hex');
      END;
      $$;
    `;
    const errors = lintMigration('correct.sql', sql).filter(v => v.severity === 'error');
    expect(errors).toHaveLength(0);
  });
});

describe('Historical M394 does not make the gate permanently unusable', () => {
  it('M394 is listed in HISTORICAL_EXCEPTIONS', () => {
    expect(HISTORICAL_EXCEPTIONS['394_direct_order_payment_authority.sql']).toBeDefined();
    expect(HISTORICAL_EXCEPTIONS['394_direct_order_payment_authority.sql']).toContain('#365');
  });

  it('linting the real migration directory with exceptions produces zero errors from M394', () => {
    const migrationsDir = resolve(process.cwd(), 'supabase/migrations');
    // Lint all non-excepted migrations
    const violations = lintMigrationDirectory(migrationsDir);
    // M394 should NOT appear in violations because it is historically excepted
    const m394Violations = violations.filter(v => v.file.includes('394'));
    expect(m394Violations).toHaveLength(0);
  });

  it('candidate-only linting skips historical migrations entirely', () => {
    const migrationsDir = resolve(process.cwd(), 'supabase/migrations');
    // Only lint a hypothetical new candidate migration
    const violations = lintMigrationDirectory(migrationsDir, ['999_hypothetical_new.sql']);
    // No file matches, so no violations
    expect(violations).toHaveLength(0);
  });
});

describe('Protected function attribute enforcement', () => {
  it('catches protected function recreated without SECURITY DEFINER', () => {
    const sql = `
      CREATE OR REPLACE FUNCTION finalize_payment_confirmation(
        p_payment_id UUID, p_claim_token UUID
      ) RETURNS JSONB
      LANGUAGE plpgsql SET search_path = public, extensions AS $$
      BEGIN RETURN '{}'; END;
      $$;
    `;
    const violations = lintMigration('test.sql', sql);
    expect(violations.some(v => v.rule === 'PROTECTED_FUNCTION_SECURITY')).toBe(true);
  });
});

describe('ALTER FUNCTION does not trigger lint', () => {
  it('ALTER is safe — only changes attributes, not the function definition', () => {
    const sql = `
      ALTER FUNCTION public.initialize_terminal_effects(
        uuid, uuid, text[], text[], text[], text[], integer
      ) SET search_path = public, extensions;
    `;
    expect(lintMigration('alter.sql', sql)).toHaveLength(0);
  });
});

describe('Non-protected functions', () => {
  it('does not flag functions without digest()', () => {
    const sql = `
      CREATE OR REPLACE FUNCTION count_records(p_table TEXT) RETURNS INTEGER
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN RETURN 0; END;
      $$;
    `;
    expect(lintMigration('simple.sql', sql)).toHaveLength(0);
  });
});

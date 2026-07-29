/**
 * Migration 298 — Complete Order Payment Backfill
 *
 * Static SQL analysis and logical structure tests.
 * Verifies the migration is transactional, idempotent, fail-closed,
 * and correctly scoped to payments.order_id only.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const sql = readFileSync(
  'supabase/migrations/298_complete_order_payment_backfill.sql',
  'utf-8',
);

// Normalise whitespace for pattern matching
const norm = sql.replace(/\s+/g, ' ').toLowerCase();

// ══════════════════════════════════════════════════════════════
// STRUCTURE
// ══════════════════════════════════════════════════════════════

describe('Migration 298 structure', () => {
  it('is wrapped in a DO $$ block (transactional)', () => {
    expect(sql).toContain('DO $$');
    expect(sql).toContain('$$;');
  });

  it('declares all required variables', () => {
    expect(sql).toContain('v_pending_count');
    expect(sql).toContain('v_null_created_at_count');
    expect(sql).toContain('v_post_boundary_count');
    expect(sql).toContain('v_invalid_uuid_count');
    expect(sql).toContain('v_missing_order_count');
    expect(sql).toContain('v_cross_business_count');
    expect(sql).toContain('v_target_ids');
    expect(sql).toContain('v_target_count');
    expect(sql).toContain('v_before_snapshot');
    expect(sql).toContain('v_after_snapshot');
    expect(sql).toContain('v_updated_count');
    expect(sql).toContain('v_remaining_count');
  });

  it('does not declare unused v_business_id_changed', () => {
    expect(sql).not.toContain('v_business_id_changed');
  });

  it('locks orders in SHARE MODE before payments in SHARE ROW EXCLUSIVE MODE', () => {
    const ordersLockPos = norm.indexOf(
      'lock table public.orders in share mode',
    );
    const paymentsLockPos = norm.indexOf(
      'lock table public.payments in share row exclusive mode',
    );
    expect(ordersLockPos).toBeGreaterThan(-1);
    expect(paymentsLockPos).toBeGreaterThan(-1);
    expect(ordersLockPos).toBeLessThan(paymentsLockPos);
  });

  it('declares a timestamp boundary variable', () => {
    expect(sql).toContain('v_verification_boundary TIMESTAMPTZ');
    expect(sql).toContain("'2026-07-29T04:21:48.741960+00:00'");
  });
});

// ══════════════════════════════════════════════════════════════
// ELIGIBLE ROW DEFINITION
// ══════════════════════════════════════════════════════════════

describe('Migration 298 eligible-row definition', () => {
  it('requires payments.order_id IS NULL', () => {
    expect(norm).toContain('order_id is null');
  });

  it('requires non-null metadata order_id', () => {
    expect(norm).toContain("metadata->>'order_id' is not null");
  });

  it('requires non-empty trimmed metadata order_id', () => {
    expect(norm).toContain("trim(metadata->>'order_id') != ''");
  });

  it('validates canonical UUID format with regex', () => {
    expect(sql).toContain(
      "'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'",
    );
  });

  it('joins to public.orders to verify existence', () => {
    expect(norm).toContain('public.orders');
  });
});

// ══════════════════════════════════════════════════════════════
// FAIL-CLOSED PREFLIGHT
// ══════════════════════════════════════════════════════════════

describe('Migration 298 fail-closed preflight', () => {
  it('idempotent: exits cleanly when pending count is 0', () => {
    expect(norm).toContain('if v_pending_count = 0 then');
    expect(sql).toContain('RETURN;');
  });

  it('aborts when pending count is not exactly 11', () => {
    expect(norm).toContain('if v_pending_count != 11 then');
    expect(norm).toContain('raise exception');
  });

  it('aborts on invalid UUID metadata', () => {
    expect(norm).toContain('v_invalid_uuid_count');
    expect(norm).toContain('if v_invalid_uuid_count > 0 then');
  });

  it('aborts when metadata order ID references non-existent order', () => {
    expect(norm).toContain('v_missing_order_count');
    expect(norm).toContain('not exists');
  });

  it('aborts on cross-business ownership conflict', () => {
    expect(norm).toContain('v_cross_business_count');
    expect(norm).toContain('p.business_id is not null');
    expect(norm).toContain('p.business_id is distinct from o.business_id');
  });

  it('aborts when pending rows have NULL created_at', () => {
    expect(norm).toContain('v_null_created_at_count');
    expect(norm).toContain('if v_null_created_at_count > 0 then');
  });

  it('aborts when pending rows were created after the verification boundary', () => {
    expect(norm).toContain('v_post_boundary_count');
    expect(norm).toContain('created_at > v_verification_boundary');
    expect(norm).toContain('if v_post_boundary_count > 0 then');
  });

  it('allows null payment business_id (missing, not conflicting)', () => {
    // The cross-business check only fires when business_id IS NOT NULL
    // A null business_id must not trigger the abort
    const crossBusinessBlock = sql.substring(
      sql.indexOf('v_cross_business_count'),
      sql.indexOf('IF v_cross_business_count > 0'),
    );
    expect(crossBusinessBlock).toContain('p.business_id IS NOT NULL');
  });

  it('declares v_null_order_business_count variable', () => {
    expect(norm).toContain('v_null_order_business_count integer');
  });

  it('checks for null order business_id before update', () => {
    expect(norm).toContain('o.business_id is null');
    expect(norm).toContain('if v_null_order_business_count > 0');
  });

  it('aborts with clear message when order has null business_id', () => {
    expect(sql).toContain('NULL business_id. Ownership cannot be verified');
  });

  it('requires o.business_id IS NOT NULL in target capture', () => {
    const start = norm.indexOf('array_agg(p.id order by p.id)');
    const end = norm.indexOf('v_target_count :=', start);
    const targetCapture = norm.substring(start, end);
    expect(targetCapture).toContain('o.business_id is not null');
  });

  it('requires o.business_id IS NOT NULL in UPDATE', () => {
    const start = norm.indexOf('update public.payments p');
    const end = norm.indexOf('get diagnostics');
    const updateBlock = norm.substring(start, end);
    expect(updateBlock).toContain('o.business_id is not null');
  });
});

// ══════════════════════════════════════════════════════════════
// IMMUTABILITY SNAPSHOT
// ══════════════════════════════════════════════════════════════

describe('Migration 298 immutability snapshot', () => {
  it('captures target IDs before update', () => {
    expect(norm).toContain('v_target_ids');
    expect(norm).toContain('array_agg(p.id order by p.id)');
  });

  it('asserts exactly 11 target IDs captured', () => {
    expect(norm).toContain('if v_target_count != 11 then');
  });

  it('captures before snapshot excluding order_id', () => {
    expect(norm).toContain("to_jsonb(p) - 'order_id'");
    expect(norm).toContain('v_before_snapshot');
  });

  it('captures after snapshot excluding order_id', () => {
    // v_after_snapshot is assigned after the UPDATE
    const updatePos = norm.indexOf('update public.payments');
    const afterSnapshotPos = norm.indexOf(
      'into v_after_snapshot',
      updatePos,
    );
    expect(afterSnapshotPos).toBeGreaterThan(updatePos);
  });

  it('compares snapshots using IS DISTINCT FROM', () => {
    expect(norm).toContain(
      'v_before_snapshot is distinct from v_after_snapshot',
    );
  });

  it('raises exception on immutability violation', () => {
    expect(norm).toContain('immutability violation');
  });
});

// ══════════════════════════════════════════════════════════════
// UPDATE SCOPE
// ══════════════════════════════════════════════════════════════

describe('Migration 298 update scope', () => {
  it('updates only payments.order_id', () => {
    // Find the UPDATE statement
    const updateMatch = sql.match(/UPDATE\s+public\.payments[\s\S]*?;/i);
    expect(updateMatch).not.toBeNull();
    const updateStmt = updateMatch![0];

    // SET clause should only set order_id
    expect(updateStmt).toMatch(/SET\s+order_id\s*=/i);

    // Must NOT set business_id or metadata
    expect(updateStmt.toLowerCase()).not.toContain('set business_id');
    expect(updateStmt.toLowerCase()).not.toContain('set metadata');
  });

  it('uses safe text comparison (no metadata UUID cast)', () => {
    expect(norm).toContain('from public.orders o');
    expect(norm).toContain("o.id::text = trim(p.metadata->>'order_id')");
  });

  it('contains NO ::uuid casts of metadata values', () => {
    // There must be no casting of metadata text to uuid anywhere
    expect(sql).not.toContain("metadata->>'order_id'))::uuid");
    expect(sql).not.toMatch(/metadata.*::uuid/);
  });

  it('includes ownership guard in UPDATE clause', () => {
    const updateSection = sql.substring(sql.indexOf('UPDATE public.payments'));
    const updateNorm = updateSection.replace(/\s+/g, ' ').toLowerCase();
    expect(updateNorm).toContain('p.business_id is null or p.business_id is not distinct from o.business_id');
  });

  it('includes timestamp boundary in UPDATE clause', () => {
    const updateSection = sql.substring(sql.indexOf('UPDATE public.payments'));
    const updateNorm = updateSection.replace(/\s+/g, ' ').toLowerCase();
    expect(updateNorm).toContain('p.created_at <= v_verification_boundary');
  });

  it('does not overwrite existing order_id', () => {
    // All WHERE clauses include order_id IS NULL
    const updateSection = sql.substring(sql.indexOf('UPDATE public.payments'));
    expect(updateSection.toLowerCase()).toContain('order_id is null');
  });
});

// ══════════════════════════════════════════════════════════════
// FIRST-RUN ASSERTIONS
// ══════════════════════════════════════════════════════════════

describe('Migration 298 first-run assertions', () => {
  it('asserts exactly 11 rows updated', () => {
    expect(sql).toContain('GET DIAGNOSTICS v_updated_count = ROW_COUNT');
    expect(norm).toContain('if v_updated_count != 11 then');
  });

  it('verifies all target IDs have non-null order_id', () => {
    expect(norm).toContain('v_verified_order_id_count');
    expect(norm).toContain("id = any(v_target_ids)");
  });

  it('verifies order_id matches trimmed metadata', () => {
    expect(norm).toContain(
      "p.order_id::text = trim(p.metadata->>'order_id')",
    );
  });

  it('verifies zero eligible rows remain after update', () => {
    expect(norm).toContain('v_remaining_count');
    expect(norm).toContain('if v_remaining_count > 0 then');
  });

  it('verifies before/after snapshots are identical', () => {
    expect(norm).toContain(
      'v_before_snapshot is distinct from v_after_snapshot',
    );
  });
});

// ══════════════════════════════════════════════════════════════
// SAFETY — does not modify forbidden targets
// ══════════════════════════════════════════════════════════════

describe('Migration 298 safety', () => {
  it('does NOT modify payments.business_id', () => {
    // business_id appears in WHERE clauses for checking, not in SET
    const setStatements = sql.match(/SET\s+\w+/gi) || [];
    const setsBusinessId = setStatements.some(s => s.toLowerCase().includes('business_id'));
    expect(setsBusinessId).toBe(false);
  });

  it('does NOT modify payments.metadata', () => {
    const setStatements = sql.match(/SET\s+\w+/gi) || [];
    const setsMetadata = setStatements.some(s => s.toLowerCase().includes('metadata'));
    expect(setsMetadata).toBe(false);
  });

  it('does NOT contain CREATE TABLE', () => {
    expect(norm).not.toContain('create table');
  });

  it('does NOT contain ALTER TABLE', () => {
    expect(norm).not.toContain('alter table');
  });

  it('does NOT contain DROP', () => {
    expect(norm).not.toContain('drop ');
  });

  it('does NOT contain DELETE', () => {
    expect(norm).not.toContain('delete from');
  });

  it('does NOT contain INSERT', () => {
    expect(norm).not.toContain('insert into');
  });

  it('does NOT directly UPDATE the orders table', () => {
    // UPDATE public.payments ... FROM public.orders is fine (reads orders, updates payments)
    // What we reject is UPDATE public.orders or UPDATE orders
    expect(norm).not.toMatch(/update\s+public\.orders/);
    expect(norm).not.toMatch(/update\s+orders\s+set/);
  });

  it('does NOT hardcode payment or order IDs', () => {
    // No UUID literals in the SQL (only the regex pattern)
    const uuidLiterals = sql.match(
      /['\s][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}['\s]/gi,
    );
    expect(uuidLiterals).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════
// DOCUMENTATION
// ══════════════════════════════════════════════════════════════

describe('Migration 298 SQL comments', () => {
  it('documents Migration 167 history', () => {
    expect(sql).toContain('Migration 167');
  });

  it('documents the 11 legacy rows', () => {
    expect(sql).toContain('11');
  });

  it('documents PR #72', () => {
    expect(sql).toContain('PR #72');
  });

  it('states it does not assign business_id', () => {
    expect(sql.toLowerCase()).toContain('does not infer or assign');
  });

  it('documents production smoke verification', () => {
    expect(sql.toLowerCase()).toContain('smoke');
  });
});

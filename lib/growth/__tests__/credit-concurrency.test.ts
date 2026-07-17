import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

/**
 * Credit system concurrency and integrity tests.
 *
 * These verify the DESIGN is correct by checking the RPCs use proper locking.
 * Real concurrent PostgreSQL tests require a live database — these are
 * architectural contract tests that verify the safety mechanisms exist.
 *
 * For live concurrency testing, use: npx tsx scripts/test-credit-concurrency.ts
 */

// Setup DDL in 243, functions split across 255-258 for single-statement compatibility
const setupMigration = readFileSync('supabase/migrations/243_growth_credit_hardening.sql', 'utf-8');
const migration = [255, 256, 257, 258].map(n => {
  const files = require('fs').readdirSync('supabase/migrations').filter((f: string) => f.startsWith(`${n}_`));
  return files.length > 0 ? readFileSync(`supabase/migrations/${files[0]}`, 'utf-8') : '';
}).join('\n');
const allMigrations = setupMigration + '\n' + migration;

describe('Credit system — database constraints', () => {
  it('amount must be positive', () => {
    expect(allMigrations).toContain('chk_credits_amount_positive');
    expect(allMigrations).toContain('amount > 0');
  });

  it('remaining cannot be negative', () => {
    expect(allMigrations).toContain('chk_credits_remaining_non_negative');
    expect(allMigrations).toContain('remaining >= 0');
  });

  it('remaining cannot exceed original amount', () => {
    expect(allMigrations).toContain('chk_credits_remaining_lte_amount');
    expect(allMigrations).toContain('remaining <= amount');
  });
});

describe('Credit reservation — atomicity', () => {
  it('locks campaign row with FOR UPDATE', () => {
    const reserveFn = migration.slice(
      migration.indexOf('FUNCTION reserve_credits_atomic'),
      migration.indexOf('$$;', migration.indexOf('FUNCTION reserve_credits_atomic')) + 3
    );
    expect(reserveFn).toContain('FOR UPDATE');
    // Must lock both campaigns AND credits
    const forUpdateCount = (reserveFn.match(/FOR UPDATE/g) || []).length;
    expect(forUpdateCount).toBeGreaterThanOrEqual(2);
  });

  it('prevents double reservation', () => {
    expect(allMigrations).toContain('already_reserved');
  });

  it('checks reservation_status before allowing', () => {
    expect(allMigrations).toContain("reservation_status NOT IN ('none', 'released', 'expired')");
  });

  it('sets reservation expiry (24 hours)', () => {
    expect(allMigrations).toContain("INTERVAL '24 hours'");
  });

  it('returns reservation_id', () => {
    expect(allMigrations).toContain("'reservation_id'");
  });

  it('excludes other campaigns active reservations from available', () => {
    expect(allMigrations).toContain('id != p_campaign_id');
    expect(allMigrations).toContain("'reserved', 'partially_consumed'");
  });
});

describe('Credit consumption — reservation verification', () => {
  it('locks campaign row before consuming', () => {
    const consumeFn = migration.slice(
      migration.indexOf('FUNCTION consume_credits_atomic'),
      migration.indexOf('$$;', migration.indexOf('FUNCTION consume_credits_atomic')) + 3
    );
    expect(consumeFn).toContain('FOR UPDATE');
  });

  it('requires active reservation', () => {
    expect(allMigrations).toContain('no_active_reservation');
  });

  it('prevents consuming more than reserved', () => {
    expect(allMigrations).toContain('exceeds_reservation');
    expect(allMigrations).toContain('credits_reserved - credits_consumed');
  });

  it('verifies business ownership', () => {
    expect(allMigrations).toContain("v_campaign.business_id != p_business_id");
  });

  it('tracks partially_consumed state', () => {
    expect(allMigrations).toContain("'partially_consumed'");
    expect(allMigrations).toContain("'consumed'");
  });
});

describe('Credit release — atomic and bounded', () => {
  it('has atomic release function', () => {
    expect(allMigrations).toContain('release_credits_atomic');
  });

  it('locks campaign row', () => {
    const releaseFn = migration.slice(
      migration.indexOf('FUNCTION release_credits_atomic'),
      migration.indexOf('$$;', migration.indexOf('FUNCTION release_credits_atomic')) + 3
    );
    expect(releaseFn).toContain('FOR UPDATE');
  });

  it('prevents release of non-reserved campaigns', () => {
    expect(allMigrations).toContain('not_releasable');
  });

  it('calculates releasable as reserved minus consumed', () => {
    expect(allMigrations).toContain('credits_reserved - credits_consumed');
  });

  it('caps restoration at original grant amount', () => {
    // remaining cannot exceed amount (CHECK constraint + logic)
    expect(allMigrations).toContain('v_credit.amount - v_credit.remaining');
  });

  it('marks campaign as released after', () => {
    expect(allMigrations).toContain("reservation_status = 'released'");
  });

  it('records release in ledger', () => {
    expect(allMigrations).toContain("'release'");
    expect(allMigrations).toContain('growth_credit_transactions');
  });
});

describe('Stuck reservation recovery', () => {
  it('has recovery function', () => {
    expect(allMigrations).toContain('recover_expired_reservations');
  });

  it('only recovers expired reservations', () => {
    expect(allMigrations).toContain('reservation_expires_at < NOW()');
  });

  it('uses SKIP LOCKED to avoid blocking', () => {
    expect(allMigrations).toContain('SKIP LOCKED');
  });

  it('marks recovered as expired', () => {
    expect(allMigrations).toContain("reservation_status = 'expired'");
  });

  it('returns count of recovered reservations', () => {
    expect(allMigrations).toContain("'recovered'");
    expect(allMigrations).toContain("'credits_released'");
  });
});

describe('Campaign idempotency', () => {
  it('has idempotency_key column', () => {
    expect(allMigrations).toContain('idempotency_key TEXT');
  });

  it('has unique index on business_id + idempotency_key', () => {
    expect(allMigrations).toContain('idx_campaign_idempotency');
    expect(allMigrations).toContain('business_id, idempotency_key');
  });

  it('dropped the old name-based unique constraint', () => {
    expect(allMigrations).toContain('DROP CONSTRAINT IF EXISTS uq_growth_campaign_dedup');
  });
});

describe('RPC access control', () => {
  it('all RPCs restricted to service_role', () => {
    const privileges = readFileSync('supabase/migrations/264_consolidated_function_privileges.sql', 'utf-8');
    const revokeCount = (privileges.match(/REVOKE ALL ON FUNCTION.*FROM PUBLIC/g) || []).length;
    expect(revokeCount).toBeGreaterThanOrEqual(4); // reserve, consume, release, recover + others

    const grantCount = (privileges.match(/GRANT EXECUTE.*TO service_role/g) || []).length;
    expect(grantCount).toBeGreaterThanOrEqual(4);
  });

  it('all RPCs use SECURITY DEFINER', () => {
    const definerCount = (migration.match(/SECURITY DEFINER/g) || []).length;
    expect(definerCount).toBeGreaterThanOrEqual(4);
  });

  it('all RPCs set search_path', () => {
    const searchPathCount = (allMigrations.match(/SET search_path\b/g) || []).length;
    expect(searchPathCount).toBeGreaterThanOrEqual(4);
  });
});

describe('Cross-business protection', () => {
  it('reserve verifies business ownership', () => {
    const reserveFn = migration.slice(
      migration.indexOf('FUNCTION reserve_credits_atomic'),
      migration.indexOf('$$;', migration.indexOf('FUNCTION reserve_credits_atomic')) + 3
    );
    expect(reserveFn).toContain('business_id != p_business_id');
    expect(reserveFn).toContain("'unauthorized'");
  });

  it('consume verifies business ownership', () => {
    const consumeFn = migration.slice(
      migration.indexOf('FUNCTION consume_credits_atomic'),
      migration.indexOf('$$;', migration.indexOf('FUNCTION consume_credits_atomic')) + 3
    );
    expect(consumeFn).toContain('business_id != p_business_id');
    expect(consumeFn).toContain("'unauthorized'");
  });

  it('release verifies business ownership', () => {
    const releaseFn = migration.slice(
      migration.indexOf('FUNCTION release_credits_atomic'),
      migration.indexOf('$$;', migration.indexOf('FUNCTION release_credits_atomic')) + 3
    );
    expect(releaseFn).toContain('business_id != p_business_id');
    expect(releaseFn).toContain("'unauthorized'");
  });
});

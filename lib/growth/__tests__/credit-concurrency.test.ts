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

const migration = readFileSync('supabase/migrations/243_growth_credit_hardening.sql', 'utf-8');

describe('Credit system — database constraints', () => {
  it('amount must be positive', () => {
    expect(migration).toContain('chk_credits_amount_positive');
    expect(migration).toContain('amount > 0');
  });

  it('remaining cannot be negative', () => {
    expect(migration).toContain('chk_credits_remaining_non_negative');
    expect(migration).toContain('remaining >= 0');
  });

  it('remaining cannot exceed original amount', () => {
    expect(migration).toContain('chk_credits_remaining_lte_amount');
    expect(migration).toContain('remaining <= amount');
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
    expect(migration).toContain('already_reserved');
  });

  it('checks reservation_status before allowing', () => {
    expect(migration).toContain("reservation_status NOT IN ('none', 'released', 'expired')");
  });

  it('sets reservation expiry (24 hours)', () => {
    expect(migration).toContain("INTERVAL '24 hours'");
  });

  it('returns reservation_id', () => {
    expect(migration).toContain("'reservation_id'");
  });

  it('excludes other campaigns active reservations from available', () => {
    expect(migration).toContain('id != p_campaign_id');
    expect(migration).toContain("'reserved', 'partially_consumed'");
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
    expect(migration).toContain('no_active_reservation');
  });

  it('prevents consuming more than reserved', () => {
    expect(migration).toContain('exceeds_reservation');
    expect(migration).toContain('credits_reserved - credits_consumed');
  });

  it('verifies business ownership', () => {
    expect(migration).toContain("v_campaign.business_id != p_business_id");
  });

  it('tracks partially_consumed state', () => {
    expect(migration).toContain("'partially_consumed'");
    expect(migration).toContain("'consumed'");
  });
});

describe('Credit release — atomic and bounded', () => {
  it('has atomic release function', () => {
    expect(migration).toContain('release_credits_atomic');
  });

  it('locks campaign row', () => {
    const releaseFn = migration.slice(
      migration.indexOf('FUNCTION release_credits_atomic'),
      migration.indexOf('$$;', migration.indexOf('FUNCTION release_credits_atomic')) + 3
    );
    expect(releaseFn).toContain('FOR UPDATE');
  });

  it('prevents release of non-reserved campaigns', () => {
    expect(migration).toContain('not_releasable');
  });

  it('calculates releasable as reserved minus consumed', () => {
    expect(migration).toContain('credits_reserved - credits_consumed');
  });

  it('caps restoration at original grant amount', () => {
    // remaining cannot exceed amount (CHECK constraint + logic)
    expect(migration).toContain('v_credit.amount - v_credit.remaining');
  });

  it('marks campaign as released after', () => {
    expect(migration).toContain("reservation_status = 'released'");
  });

  it('records release in ledger', () => {
    expect(migration).toContain("'release'");
    expect(migration).toContain('growth_credit_transactions');
  });
});

describe('Stuck reservation recovery', () => {
  it('has recovery function', () => {
    expect(migration).toContain('recover_expired_reservations');
  });

  it('only recovers expired reservations', () => {
    expect(migration).toContain('reservation_expires_at < NOW()');
  });

  it('uses SKIP LOCKED to avoid blocking', () => {
    expect(migration).toContain('SKIP LOCKED');
  });

  it('marks recovered as expired', () => {
    expect(migration).toContain("reservation_status = 'expired'");
  });

  it('returns count of recovered reservations', () => {
    expect(migration).toContain("'recovered'");
    expect(migration).toContain("'credits_released'");
  });
});

describe('Campaign idempotency', () => {
  it('has idempotency_key column', () => {
    expect(migration).toContain('idempotency_key TEXT');
  });

  it('has unique index on business_id + idempotency_key', () => {
    expect(migration).toContain('idx_campaign_idempotency');
    expect(migration).toContain('business_id, idempotency_key');
  });

  it('dropped the old name-based unique constraint', () => {
    expect(migration).toContain('DROP CONSTRAINT IF EXISTS uq_growth_campaign_dedup');
  });
});

describe('RPC access control', () => {
  it('all RPCs restricted to service_role', () => {
    const revokeCount = (migration.match(/REVOKE ALL ON FUNCTION.*FROM PUBLIC/g) || []).length;
    expect(revokeCount).toBeGreaterThanOrEqual(4); // reserve, consume, release, recover

    const grantCount = (migration.match(/GRANT EXECUTE.*TO service_role/g) || []).length;
    expect(grantCount).toBeGreaterThanOrEqual(4);
  });

  it('all RPCs use SECURITY DEFINER', () => {
    const definerCount = (migration.match(/SECURITY DEFINER/g) || []).length;
    expect(definerCount).toBeGreaterThanOrEqual(4);
  });

  it('all RPCs set search_path', () => {
    const searchPathCount = (migration.match(/SET search_path = public/g) || []).length;
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

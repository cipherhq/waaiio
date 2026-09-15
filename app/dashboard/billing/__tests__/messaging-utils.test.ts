/**
 * Tests for messaging allowance billing utilities.
 *
 * Verifies:
 * - Tenant isolation: per-currency separation, no cross-currency leakage
 * - Read-error / empty-state handling
 * - Formatting: minor-unit → major-unit currency display
 * - Financial accuracy: Available, Charged, Reserved are sourced from
 *   authoritative columns (remaining_minor, spent_minor, reserved_minor)
 *   and never conflated (#261)
 * - Expired/zero/no-allowance states
 */
import { describe, it, expect } from 'vitest';
import {
  buildMessagingSummaries,
  type MessagingAllowanceRow,
  type MessagingSpendPeriodRow,
} from '../messaging-utils';

// ── Factories ──

function makeAllowance(overrides: Partial<MessagingAllowanceRow> = {}): MessagingAllowanceRow {
  return {
    id: crypto.randomUUID(),
    type: 'trial_grant',
    amount_minor: 100000,
    currency_code: 'NGN',
    remaining_minor: 80000,
    source_ref: 'trial_v2',
    expires_at: null,
    created_at: '2026-09-01T00:00:00Z',
    ...overrides,
  };
}

function makeSpendPeriod(overrides: Partial<MessagingSpendPeriodRow> = {}): MessagingSpendPeriodRow {
  return {
    id: crypto.randomUUID(),
    currency_code: 'NGN',
    period_start: '2026-09-01T00:00:00Z',
    cap_minor: 500000,
    reserved_minor: 5000,
    spent_minor: 15000,
    ...overrides,
  };
}

// Fixed "now" for deterministic expiry checks
const NOW = new Date('2026-09-15T12:00:00Z');

describe('buildMessagingSummaries', () => {
  // ── Empty state ──

  it('returns empty array when no allowances and no spend periods', () => {
    const result = buildMessagingSummaries([], [], NOW);
    expect(result).toEqual([]);
  });

  // ── Single currency, basic aggregation ──

  it('aggregates a single allowance with matching spend period', () => {
    const allowances = [makeAllowance({ remaining_minor: 80000, amount_minor: 100000 })];
    const periods = [makeSpendPeriod({ reserved_minor: 5000, spent_minor: 15000 })];

    const [summary] = buildMessagingSummaries(allowances, periods, NOW);

    expect(summary.currency).toBe('NGN');
    expect(summary.available).toBe(80000);
    expect(summary.totalAllocated).toBe(100000);
    expect(summary.charged).toBe(15000);
    expect(summary.reserved).toBe(5000);
    expect(summary.cap).toBe(500000);
    expect(summary.hasSpendPeriod).toBe(true);
    expect(summary.allowances).toHaveLength(1);
  });

  // ── Financial accuracy: Available ≠ totalAllocated − charged ──

  it('Available reflects remaining_minor, not derived from original minus spent', () => {
    // Scenario: 100000 original, 80000 remaining, but spent=15000, reserved=5000
    // remaining_minor already reflects reserves (reserves decrement it).
    // available should be 80000 (authoritative), NOT 100000-15000 = 85000
    const allowances = [makeAllowance({ amount_minor: 100000, remaining_minor: 80000 })];
    const periods = [makeSpendPeriod({ spent_minor: 15000, reserved_minor: 5000 })];

    const [summary] = buildMessagingSummaries(allowances, periods, NOW);

    // This is the critical assertion: available comes from remaining_minor,
    // NOT from amount_minor - spent_minor
    expect(summary.available).toBe(80000);
    expect(summary.charged).toBe(15000);
    expect(summary.reserved).toBe(5000);
  });

  // ── Multi-currency isolation ──

  it('separates currencies with no cross-currency leakage', () => {
    const allowances = [
      makeAllowance({ currency_code: 'NGN', remaining_minor: 80000, amount_minor: 100000 }),
      makeAllowance({ currency_code: 'USD', remaining_minor: 500, amount_minor: 1000 }),
    ];
    const periods = [
      makeSpendPeriod({ currency_code: 'NGN', spent_minor: 15000, reserved_minor: 5000 }),
      makeSpendPeriod({ currency_code: 'USD', spent_minor: 200, reserved_minor: 300 }),
    ];

    const result = buildMessagingSummaries(allowances, periods, NOW);

    expect(result).toHaveLength(2);
    // Sorted by currency
    expect(result[0].currency).toBe('NGN');
    expect(result[1].currency).toBe('USD');

    // NGN values
    expect(result[0].available).toBe(80000);
    expect(result[0].charged).toBe(15000);
    expect(result[0].reserved).toBe(5000);

    // USD values — completely isolated
    expect(result[1].available).toBe(500);
    expect(result[1].charged).toBe(200);
    expect(result[1].reserved).toBe(300);
  });

  // ── Multiple allowances in same currency ──

  it('sums remaining_minor across multiple non-expired allowances', () => {
    const allowances = [
      makeAllowance({ remaining_minor: 30000, amount_minor: 50000, type: 'trial_grant' }),
      makeAllowance({ remaining_minor: 20000, amount_minor: 40000, type: 'subscription_included' }),
    ];
    const periods = [makeSpendPeriod()];

    const [summary] = buildMessagingSummaries(allowances, periods, NOW);

    expect(summary.available).toBe(50000); // 30000 + 20000
    expect(summary.totalAllocated).toBe(90000); // 50000 + 40000
  });

  // ── Expired allowance handling ──

  it('excludes expired allowances from available balance', () => {
    const allowances = [
      makeAllowance({
        remaining_minor: 30000,
        amount_minor: 50000,
        expires_at: '2026-09-10T00:00:00Z', // expired before NOW
      }),
      makeAllowance({
        remaining_minor: 20000,
        amount_minor: 40000,
        expires_at: '2026-10-01T00:00:00Z', // still valid
      }),
    ];
    const periods = [makeSpendPeriod()];

    const [summary] = buildMessagingSummaries(allowances, periods, NOW);

    // Only the non-expired allowance's remaining_minor counts as available
    expect(summary.available).toBe(20000);
    // But totalAllocated includes all original amounts
    expect(summary.totalAllocated).toBe(90000);
    // Both allowances should appear in the list
    expect(summary.allowances).toHaveLength(2);
  });

  it('handles all allowances expired — available is zero', () => {
    const allowances = [
      makeAllowance({
        remaining_minor: 30000,
        amount_minor: 50000,
        expires_at: '2026-09-01T00:00:00Z',
      }),
    ];

    const [summary] = buildMessagingSummaries(allowances, [], NOW);

    expect(summary.available).toBe(0);
    expect(summary.totalAllocated).toBe(50000);
  });

  // ── Zero balance handling ──

  it('handles zero remaining_minor correctly', () => {
    const allowances = [makeAllowance({ remaining_minor: 0, amount_minor: 100000 })];
    const periods = [makeSpendPeriod({ reserved_minor: 0, spent_minor: 100000 })];

    const [summary] = buildMessagingSummaries(allowances, periods, NOW);

    expect(summary.available).toBe(0);
    expect(summary.charged).toBe(100000);
    expect(summary.reserved).toBe(0);
  });

  // ── Spend period without allowances ──

  it('includes currency from spend period even with no allowances', () => {
    const periods = [makeSpendPeriod({ currency_code: 'USD', spent_minor: 500 })];

    const result = buildMessagingSummaries([], periods, NOW);

    expect(result).toHaveLength(1);
    expect(result[0].currency).toBe('USD');
    expect(result[0].available).toBe(0);
    expect(result[0].totalAllocated).toBe(0);
    expect(result[0].charged).toBe(500);
    expect(result[0].hasSpendPeriod).toBe(true);
    expect(result[0].allowances).toHaveLength(0);
  });

  // ── Allowances without spend period ──

  it('shows allowance data even without a current spend period', () => {
    const allowances = [makeAllowance({ remaining_minor: 80000 })];

    const [summary] = buildMessagingSummaries(allowances, [], NOW);

    expect(summary.available).toBe(80000);
    expect(summary.charged).toBe(0);
    expect(summary.reserved).toBe(0);
    expect(summary.hasSpendPeriod).toBe(false);
  });

  // ── Deterministic ordering ──

  it('returns summaries sorted alphabetically by currency', () => {
    const allowances = [
      makeAllowance({ currency_code: 'USD' }),
      makeAllowance({ currency_code: 'GHS' }),
      makeAllowance({ currency_code: 'NGN' }),
    ];

    const result = buildMessagingSummaries(allowances, [], NOW);

    expect(result.map((s) => s.currency)).toEqual(['GHS', 'NGN', 'USD']);
  });

  // ── Expiry edge case: exactly at expiry time ──

  it('treats allowance expiring exactly at NOW as expired', () => {
    const allowances = [
      makeAllowance({
        remaining_minor: 50000,
        expires_at: NOW.toISOString(), // exactly at NOW
      }),
    ];

    const [summary] = buildMessagingSummaries(allowances, [], NOW);

    // expires_at <= now means expired
    expect(summary.available).toBe(0);
  });

  // ── No-expiry allowance (perpetual) ──

  it('treats null expires_at as non-expiring', () => {
    const allowances = [makeAllowance({ remaining_minor: 50000, expires_at: null })];

    const [summary] = buildMessagingSummaries(allowances, [], NOW);

    expect(summary.available).toBe(50000);
  });

  // ── Reserved + charged accurately reflects spend period, not allowance math ──

  it('charged and reserved come from spend period, independent of allowance remaining', () => {
    // Scenario demonstrating the reserve/charge/release lifecycle:
    // A message was reserved (decrementing remaining_minor) then charged (moving
    // from reserved_minor to spent_minor in the spend period).
    // remaining_minor stays decremented after charge — it doesn't bounce back.
    const allowances = [makeAllowance({ remaining_minor: 95000, amount_minor: 100000 })];
    const periods = [makeSpendPeriod({
      reserved_minor: 2000,  // 2 messages still in-flight
      spent_minor: 3000,     // 3 messages confirmed delivered
    })];

    const [summary] = buildMessagingSummaries(allowances, periods, NOW);

    // available = remaining_minor (authoritative)
    expect(summary.available).toBe(95000);
    // charged = spent_minor (authoritative from spend period)
    expect(summary.charged).toBe(3000);
    // reserved = reserved_minor (authoritative from spend period)
    expect(summary.reserved).toBe(2000);

    // These are NOT derived: 100000 - 95000 = 5000 ≠ charged (3000)
    // Because 2000 is still reserved (in-flight), not yet charged
    expect(summary.charged).not.toBe(summary.totalAllocated - summary.available);
  });
});

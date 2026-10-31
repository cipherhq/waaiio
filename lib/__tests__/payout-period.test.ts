/**
 * Tests for the merchant-local preceding-completed-week period calculator.
 *
 * Covers: Monday/Sunday invocation, year boundary, DST spring-forward/fall-back,
 * dateline, two zones producing different local weeks at one instant,
 * invalid timezone, and local DATE label consistency.
 */

import { describe, it, expect } from 'vitest';
import { getPrecedingCompletedWeek } from '@/lib/payouts/period';

describe('getPrecedingCompletedWeek', () => {
  // ── Basic Monday invocation ──

  it('Monday invocation returns preceding Mon–Sun week (Africa/Lagos)', () => {
    // Monday 2026-10-26 07:00 WAT = 06:00 UTC
    const now = new Date('2026-10-26T06:00:00Z');
    const result = getPrecedingCompletedWeek(now, 'Africa/Lagos');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.period.periodStart).toBe('2026-10-19');
    expect(result.period.periodEnd).toBe('2026-10-25');
  });

  it('Tuesday invocation returns the same preceding week', () => {
    // Tuesday 2026-10-27 12:00 WAT = 11:00 UTC
    const now = new Date('2026-10-27T11:00:00Z');
    const result = getPrecedingCompletedWeek(now, 'Africa/Lagos');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.period.periodStart).toBe('2026-10-19');
    expect(result.period.periodEnd).toBe('2026-10-25');
  });

  // ── Sunday invocation: preceding completed week, NOT current unfinished Sunday ──

  it('Sunday invocation selects the preceding completed week', () => {
    // Sunday 2026-10-25 15:00 WAT = 14:00 UTC — this Sunday is NOT yet complete
    const now = new Date('2026-10-25T14:00:00Z');
    const result = getPrecedingCompletedWeek(now, 'Africa/Lagos');
    expect(result.success).toBe(true);
    if (!result.success) return;
    // Must return the PREVIOUS week (Oct 12–18), not Oct 19–25
    expect(result.period.periodStart).toBe('2026-10-12');
    expect(result.period.periodEnd).toBe('2026-10-18');
  });

  it('Sunday midnight (start of day) still selects preceding week', () => {
    // Sunday 2026-10-25 00:00:01 WAT = 2026-10-24T23:00:01Z
    const now = new Date('2026-10-24T23:00:01Z');
    const result = getPrecedingCompletedWeek(now, 'Africa/Lagos');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.period.periodStart).toBe('2026-10-12');
    expect(result.period.periodEnd).toBe('2026-10-18');
  });

  // ── Year boundary ──

  it('year boundary: Jan 1 Thursday returns preceding Mon–Sun crossing Dec/Jan', () => {
    // Thursday 2026-01-01 10:00 WAT = 09:00 UTC
    const now = new Date('2026-01-01T09:00:00Z');
    const result = getPrecedingCompletedWeek(now, 'Africa/Lagos');
    expect(result.success).toBe(true);
    if (!result.success) return;
    // Dec 22 (Mon) to Dec 28 (Sun) 2025
    expect(result.period.periodStart).toBe('2025-12-22');
    expect(result.period.periodEnd).toBe('2025-12-28');
  });

  // ── Half-open UTC bounds ──

  it('UTC bounds are half-open [monday, next monday)', () => {
    const now = new Date('2026-10-26T06:00:00Z');
    const result = getPrecedingCompletedWeek(now, 'Africa/Lagos');
    expect(result.success).toBe(true);
    if (!result.success) return;
    // Africa/Lagos is UTC+1, so Monday 00:00 WAT = Sunday 23:00 UTC
    expect(result.period.queryStart).toBe('2026-10-18T23:00:00.000Z');
    expect(result.period.queryEnd).toBe('2026-10-25T23:00:00.000Z');
    // Verify half-open: queryEnd should be > queryStart
    expect(new Date(result.period.queryEnd).getTime()).toBeGreaterThan(
      new Date(result.period.queryStart).getTime()
    );
  });

  it('UTC timezone: bounds equal local dates at midnight', () => {
    // Monday 2026-10-26 06:00 UTC
    const now = new Date('2026-10-26T06:00:00Z');
    const result = getPrecedingCompletedWeek(now, 'UTC');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.period.periodStart).toBe('2026-10-19');
    expect(result.period.periodEnd).toBe('2026-10-25');
    expect(result.period.queryStart).toBe('2026-10-19T00:00:00.000Z');
    expect(result.period.queryEnd).toBe('2026-10-26T00:00:00.000Z');
  });

  // ── DST transitions ──

  it('DST spring-forward (US): week still computed correctly', () => {
    // US spring forward: March 8 2026 (Sun) 2:00 AM → 3:00 AM
    // Monday March 9 2026, 10:00 AM EDT = 14:00 UTC
    const now = new Date('2026-03-09T14:00:00Z');
    const result = getPrecedingCompletedWeek(now, 'America/New_York');
    expect(result.success).toBe(true);
    if (!result.success) return;
    // Preceding completed week: Mar 2 (Mon) – Mar 8 (Sun)
    expect(result.period.periodStart).toBe('2026-03-02');
    expect(result.period.periodEnd).toBe('2026-03-08');
    // The week contains DST transition — bounds should still be correct
    // Mar 2 00:00 EST (UTC-5) = Mar 2 05:00 UTC
    expect(result.period.queryStart).toBe('2026-03-02T05:00:00.000Z');
    // Mar 9 00:00 EDT (UTC-4, post-transition) = Mar 9 04:00 UTC
    expect(result.period.queryEnd).toBe('2026-03-09T04:00:00.000Z');
  });

  it('DST fall-back (US): week still computed correctly', () => {
    // US fall back: Nov 1 2026 (Sun) 2:00 AM → 1:00 AM
    // Monday Nov 2 2026, 10:00 AM EST = 15:00 UTC
    const now = new Date('2026-11-02T15:00:00Z');
    const result = getPrecedingCompletedWeek(now, 'America/New_York');
    expect(result.success).toBe(true);
    if (!result.success) return;
    // Preceding completed week: Oct 26 (Mon) – Nov 1 (Sun)
    expect(result.period.periodStart).toBe('2026-10-26');
    expect(result.period.periodEnd).toBe('2026-11-01');
    // Oct 26 00:00 EDT (UTC-4) = Oct 26 04:00 UTC
    expect(result.period.queryStart).toBe('2026-10-26T04:00:00.000Z');
    // Nov 2 00:00 EST (UTC-5, post-transition) = Nov 2 05:00 UTC
    expect(result.period.queryEnd).toBe('2026-11-02T05:00:00.000Z');
  });

  // ── Two zones: different local weeks at one instant ──

  it('two businesses in different zones see different local weeks at one instant', () => {
    // Sunday 2026-10-25 23:30 UTC
    // In Africa/Lagos (UTC+1): Monday 2026-10-26 00:30 → preceding week is Oct 19–25
    // In America/New_York (UTC-4): Sunday 2026-10-25 19:30 → preceding week is Oct 12–18
    const now = new Date('2026-10-25T23:30:00Z');

    const lagos = getPrecedingCompletedWeek(now, 'Africa/Lagos');
    const nyc = getPrecedingCompletedWeek(now, 'America/New_York');

    expect(lagos.success).toBe(true);
    expect(nyc.success).toBe(true);
    if (!lagos.success || !nyc.success) return;

    // Lagos sees Monday → preceding week is last week
    expect(lagos.period.periodStart).toBe('2026-10-19');
    expect(lagos.period.periodEnd).toBe('2026-10-25');

    // NYC sees Sunday → preceding week is the week before
    expect(nyc.period.periodStart).toBe('2026-10-12');
    expect(nyc.period.periodEnd).toBe('2026-10-18');
  });

  // ── Dateline: near ±12 zones ──

  it('Pacific/Auckland (UTC+13 during NZDT) produces correct local dates', () => {
    // Monday 2026-10-26 06:00 UTC → local time is Tuesday Oct 27 19:00 NZDT
    const now = new Date('2026-10-26T06:00:00Z');
    const result = getPrecedingCompletedWeek(now, 'Pacific/Auckland');
    expect(result.success).toBe(true);
    if (!result.success) return;
    // Tuesday Oct 27 → preceding completed week is Oct 19 (Mon)–Oct 25 (Sun)
    expect(result.period.periodStart).toBe('2026-10-19');
    expect(result.period.periodEnd).toBe('2026-10-25');
  });

  it('Pacific/Pago_Pago (UTC-11) produces correct local dates', () => {
    // Monday 2026-10-26 06:00 UTC → local time is Sunday Oct 25 19:00 SST
    const now = new Date('2026-10-26T06:00:00Z');
    const result = getPrecedingCompletedWeek(now, 'Pacific/Pago_Pago');
    expect(result.success).toBe(true);
    if (!result.success) return;
    // Sunday Oct 25 → preceding completed week is Oct 12 (Mon)–Oct 18 (Sun)
    expect(result.period.periodStart).toBe('2026-10-12');
    expect(result.period.periodEnd).toBe('2026-10-18');
  });

  // ── Invalid timezone fail-closed ──

  it('invalid timezone returns error', () => {
    const now = new Date('2026-10-26T06:00:00Z');
    const result = getPrecedingCompletedWeek(now, 'Invalid/Timezone');
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('Invalid');
  });

  it('empty string timezone returns error', () => {
    const now = new Date('2026-10-26T06:00:00Z');
    const result = getPrecedingCompletedWeek(now, '');
    expect(result.success).toBe(false);
  });

  // ── DATE label consistency ──

  it('periodEnd is always 6 days after periodStart', () => {
    // Test across several dates
    const dates = [
      '2026-01-05T12:00:00Z', '2026-03-15T12:00:00Z', '2026-06-22T12:00:00Z',
      '2026-09-01T12:00:00Z', '2026-12-28T12:00:00Z',
    ];
    for (const d of dates) {
      const result = getPrecedingCompletedWeek(new Date(d), 'Africa/Lagos');
      expect(result.success).toBe(true);
      if (!result.success) continue;
      const start = new Date(result.period.periodStart + 'T00:00:00Z');
      const end = new Date(result.period.periodEnd + 'T00:00:00Z');
      const diff = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
      expect(diff).toBe(6);
      // Monday check (getUTCDay: 0=Sun, 1=Mon)
      expect(start.getUTCDay()).toBe(1);
      // Sunday check
      expect(end.getUTCDay()).toBe(0);
    }
  });
});

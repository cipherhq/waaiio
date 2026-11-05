/**
 * Tests for the merchant-local preceding-completed-week period calculator.
 *
 * Covers: Monday/Sunday invocation, year boundary, DST spring-forward/fall-back,
 * dateline, two zones producing different local weeks at one instant,
 * invalid timezone, and local DATE label consistency.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { getPrecedingCompletedWeek, createPrecedingWeekResolver, anchorCoveredRange, recentPayoutRowsFrom, type CoveredPayoutRow } from '@/lib/payouts/period';

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

// ── Weekly cron schedule (vercel.json) never skips or repeats a merchant week ──
// Owner decision 2026-11-05 (#796): the auto-payout cron runs Monday 12:00 UTC.
// At 06:00 UTC it was still Sunday in US/Canada Mountain time, so one local week
// was skipped every spring and one repeated every autumn.


// One zone per distinct offset/DST rule in Waaiio's five countries (NG, GH, GB, US, CA).
const SUPPORTED_COUNTRY_ZONES = [
  'Africa/Lagos', 'Africa/Accra', 'Europe/London', 'America/St_Johns', 'America/Halifax',
  'America/New_York', 'America/Chicago', 'America/Regina', 'America/Denver', 'America/Edmonton',
  'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu',
];

/** Weekly runs from `fromMonday` for `weeks` weeks at hh:mm UTC; returns local week starts. */
function weeklyRunStarts(tz: string, hourUtc: number, minuteUtc: number, fromMonday: string, weeks: number): string[] {
  const base = Date.parse(`${fromMonday}T00:00:00Z`) + (hourUtc * 60 + minuteUtc) * 60000;
  const starts: string[] = [];
  for (let i = 0; i < weeks; i++) {
    const r = getPrecedingCompletedWeek(new Date(base + i * 7 * 86400000), tz);
    if (!r.success) throw new Error(`${tz}: ${r.error}`);
    starts.push(r.period.periodStart);
  }
  return starts;
}

/** Problems where consecutive runs do not advance by exactly one local week. */
function weekProblems(tz: string, hourUtc: number, minuteUtc: number): string[] {
  const problems: string[] = [];
  // Runs spanning the 2027 clock changes: US/CA 14 Mar and 7 Nov, UK 28 Mar and 31 Oct.
  for (const [from, weeks] of [['2027-03-01', 5], ['2027-10-25', 3]] as const) {
    const starts = weeklyRunStarts(tz, hourUtc, minuteUtc, from, weeks);
    for (let i = 1; i < starts.length; i++) {
      const days = (Date.parse(starts[i]) - Date.parse(starts[i - 1])) / 86400000;
      if (days !== 7) problems.push(`${tz}: ${starts[i - 1]} -> ${starts[i]}`);
    }
  }
  return problems;
}

describe('auto-payout weekly schedule', () => {
  const vercel = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8'));
  const cron = (vercel.crons as { path: string; schedule: string }[]).find(c => c.path === '/api/cron/auto-payout');

  it('runs once a week on Monday at a fixed UTC time', () => {
    expect(cron?.schedule).toMatch(/^\d{1,2} \d{1,2} \* \* 1$/);
  });

  it('covers every merchant week exactly once in all supported-country zones', () => {
    const [minute, hour] = cron!.schedule.split(' ').map(Number);
    const problems = SUPPORTED_COUNTRY_ZONES.flatMap(tz => weekProblems(tz, hour, minute));
    expect(problems).toEqual([]);
  }, 180000);

  it('control: the old Monday 06:00 UTC time skipped a Mountain-time week', () => {
    expect(weekProblems('America/Denver', 6, 0).length).toBeGreaterThan(0);
    expect(weekProblems('America/Edmonton', 6, 0).length).toBeGreaterThan(0);
  }, 120000);
});

describe('createPrecedingWeekResolver', () => {
  it('returns the same result as getPrecedingCompletedWeek for each timezone, computed once', () => {
    const now = new Date('2027-03-15T12:00:00Z');
    const periodFor = createPrecedingWeekResolver(now);
    for (const tz of ['Africa/Lagos', 'America/Denver', 'Pacific/Auckland']) {
      const first = periodFor(tz);
      expect(first).toEqual(getPrecedingCompletedWeek(now, tz));
      expect(periodFor(tz)).toBe(first); // cached object, not recomputed
    }
    expect(periodFor('America/Denver')).not.toEqual(periodFor('Pacific/Auckland'));
  });

  it('keeps invalid timezones fail-closed', () => {
    const periodFor = createPrecedingWeekResolver(new Date('2027-03-15T12:00:00Z'));
    expect(periodFor('Not/AZone').success).toBe(false);
    expect(periodFor('').success).toBe(false);
    expect(periodFor(undefined as unknown as string).success).toBe(false);
  });
});

// ── M521 (#796 Option A): each payout starts where the previous week's payout ended ──
describe('anchorCoveredRange', () => {
  const week = (iso: string, tz: string) => {
    const r = getPrecedingCompletedWeek(new Date(iso), tz);
    if (!r.success) throw new Error(r.error);
    return r.period;
  };
  // Monday 2026-11-09 12:00 UTC run → Lagos week 2026-11-02..08
  const lagos = week('2026-11-09T12:00:00Z', 'Africa/Lagos');
  const row = (p: { periodStart: string; periodEnd: string }, from: string | null, to: string | null): CoveredPayoutRow =>
    ({ period_start: p.periodStart, period_end: p.periodEnd, covered_from: from, covered_to: to });
  const prevLabels = { periodStart: '2026-10-26', periodEnd: '2026-11-01' };

  it('reads payout history from 53 weeks before the week start', () => {
    expect(recentPayoutRowsFrom(lagos)).toBe('2025-10-27');
  });

  it('with no earlier payouts, covers the local week exactly', () => {
    expect(anchorCoveredRange(lagos, [])).toEqual({ success: true, coveredFrom: lagos.queryStart, coveredTo: lagos.queryEnd });
  });

  it('ignores rows written before M521 (no recorded range)', () => {
    expect(anchorCoveredRange(lagos, [row(prevLabels, null, null)])).toEqual({ success: true, coveredFrom: lagos.queryStart, coveredTo: lagos.queryEnd });
  });

  it('timezone unchanged: starts exactly where last week ended, which is local Monday 00:00', () => {
    const r = anchorCoveredRange(lagos, [row(prevLabels, '2026-10-25T23:00:00.000Z', lagos.queryStart)]);
    expect(r).toEqual({ success: true, coveredFrom: lagos.queryStart, coveredTo: lagos.queryEnd });
  });

  it('timezone moved east since last payout: starts at last week\'s end, so nothing is counted twice', () => {
    // Last week was counted in Pacific/Pago_Pago (UTC-11): it ended Mon 2026-11-02 11:00 UTC,
    // 12 hours after the Lagos week start.
    const r = anchorCoveredRange(lagos, [row(prevLabels, '2026-10-26T11:00:00.000Z', '2026-11-02T11:00:00.000Z')]);
    expect(r).toEqual({ success: true, coveredFrom: '2026-11-02T11:00:00.000Z', coveredTo: lagos.queryEnd });
  });

  it('timezone moved west since last payout: starts at last week\'s end, so nothing is skipped', () => {
    // Last week was counted in Pacific/Kiritimati (UTC+14): it ended Sun 2026-11-01 10:00 UTC.
    const r = anchorCoveredRange(lagos, [row(prevLabels, '2026-10-25T10:00:00.000Z', '2026-11-01T10:00:00.000Z')]);
    expect(r).toEqual({ success: true, coveredFrom: '2026-11-01T10:00:00.000Z', coveredTo: lagos.queryEnd });
  });

  it('after a week with no payout, starts at the last recorded end, so quiet weeks roll forward', () => {
    // Paid through Lagos week 2026-10-19..25 (ended Sun 2026-10-25 23:00 UTC); week 10-26..11-01
    // made no payout (e.g. below the minimum). This week's payout counts both weeks.
    const r = anchorCoveredRange(lagos, [row({ periodStart: '2026-10-19', periodEnd: '2026-10-25' }, '2026-10-18T23:00:00.000Z', '2026-10-25T23:00:00.000Z')]);
    expect(r).toEqual({ success: true, coveredFrom: '2026-10-25T23:00:00.000Z', coveredTo: lagos.queryEnd });
  });

  it('after a week with no payout and a move west, nothing is skipped (review r3/r4-796 P2-1)', () => {
    // Paid through a Lagos week ending Sun 2026-10-25 23:00 UTC; quiet week; now America/Los_Angeles.
    const la = week('2026-11-09T12:00:00Z', 'America/Los_Angeles');
    const r = anchorCoveredRange(la, [row({ periodStart: '2026-10-19', periodEnd: '2026-10-25' }, '2026-10-18T23:00:00.000Z', '2026-10-25T23:00:00.000Z')]);
    expect(r).toEqual({ success: true, coveredFrom: '2026-10-25T23:00:00.000Z', coveredTo: la.queryEnd });
  });

  it('uses the latest recorded end when there are several earlier payouts', () => {
    const r = anchorCoveredRange(lagos, [
      row({ periodStart: '2026-10-12', periodEnd: '2026-10-18' }, '2026-10-11T23:00:00.000Z', '2026-10-18T23:00:00.000Z'),
      row(prevLabels, '2026-10-18T23:00:00.000Z', lagos.queryStart),
      row({ periodStart: '2026-10-05', periodEnd: '2026-10-11' }, '2026-10-04T23:00:00.000Z', '2026-10-11T23:00:00.000Z'),
    ]);
    expect(r).toEqual({ success: true, coveredFrom: lagos.queryStart, coveredTo: lagos.queryEnd });
  });

  it('a second currency in the same week reuses that week\'s recorded range', () => {
    const r = anchorCoveredRange(lagos, [row(lagos, '2026-11-01T10:00:00.000Z', '2026-11-08T23:00:00.000Z')]);
    expect(r).toEqual({ success: true, coveredFrom: '2026-11-01T10:00:00.000Z', coveredTo: '2026-11-08T23:00:00.000Z' });
  });

  it('fails closed when one week has payout rows with different ranges', () => {
    const r = anchorCoveredRange(lagos, [
      row(lagos, lagos.queryStart, lagos.queryEnd),
      row(lagos, '2026-11-01T10:00:00.000Z', lagos.queryEnd),
    ]);
    expect(r.success).toBe(false);
  });

  it('fails closed when the range would overlap another recorded payout', () => {
    // A payout for the *next* week labels already recorded a range starting inside this week.
    const r = anchorCoveredRange(lagos, [row({ periodStart: '2026-11-09', periodEnd: '2026-11-15' }, '2026-11-08T10:00:00.000Z', '2026-11-15T10:00:00.000Z')]);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain('overlaps');
  });

  it('fails closed when the previous payout already reaches past this week\'s end', () => {
    const r = anchorCoveredRange(lagos, [row(prevLabels, '2026-10-26T00:00:00.000Z', '2026-11-09T00:00:00.000Z')]);
    expect(r.success).toBe(false);
  });

  it('a merchant switching between far-west and far-east timezones every week is never counted twice or skipped', () => {
    // The reviewers' scenario: Etc/GMT+12 one week, Pacific/Kiritimati the next, repeatedly,
    // with some quiet weeks that make no payout (null), including before a move west.
    const zones = ['Etc/GMT+12', 'Pacific/Kiritimati', null, 'Etc/GMT+12', 'Pacific/Kiritimati', null, null, 'Pacific/Pago_Pago', 'Africa/Lagos', null, 'America/Los_Angeles'];
    const rows: CoveredPayoutRow[] = [];
    let tz = 'Africa/Lagos';
    for (let i = 0; i < zones.length; i++) {
      const paid = zones[i] !== null;
      if (paid) tz = zones[i]!;
      const p = week(new Date(Date.parse('2026-11-09T12:00:00Z') + i * 7 * 86400000).toISOString(), tz);
      const r = anchorCoveredRange(p, rows.filter(x => x.period_end >= recentPayoutRowsFrom(p)));
      expect(r.success).toBe(true);
      if (!r.success) return;
      if (paid) rows.push(row(p, r.coveredFrom, r.coveredTo));
    }
    // Every range starts exactly where the previous one ended: no overlap, no gap.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].covered_from).toBe(rows[i - 1].covered_to);
      expect(Date.parse(rows[i].covered_from!)).toBeLessThan(Date.parse(rows[i].covered_to!));
    }
  });
});

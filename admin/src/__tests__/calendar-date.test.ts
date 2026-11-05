import { describe, expect, it } from 'vitest';
import { fmtCalendarDate } from '../lib/formatters';

describe('SQL calendar date display', () => {
  it.each([
    ['2026-11-01', '1 Nov 2026'],
    ['2026-01-01', '1 Jan 2026'],
    ['2028-02-29', '29 Feb 2028'],
  ])('preserves %s without a timezone shift', (date, expected) => {
    expect(fmtCalendarDate(date)).toBe(expected);
  });

  it.each(['2026-02-29', '2026-13-01', '', '2026-11-01T00:00:00Z'])('does not reinterpret invalid/date-time input %s', date => {
    expect(fmtCalendarDate(date)).toBe('—');
  });
});

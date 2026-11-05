import { expect, it } from 'vitest';
import { formatCalendarDate } from '@/lib/utils/calendar-date';

it('retains the year-boundary calendar day in both display styles', () => {
  expect(formatCalendarDate('2026-01-01')).toBe('1 Jan 2026');
  expect(formatCalendarDate('2026-01-01', false)).toBe('1 Jan');
});
it('accepts a valid leap day', () => {
  expect(formatCalendarDate('2028-02-29')).toBe('29 Feb 2028');
});
it.each(['2026-02-29', '2026-13-01', '', '2026-01-01T00:00:00Z'])('rejects non-calendar or impossible input %s', date => {
  expect(formatCalendarDate(date)).toBe('—');
});

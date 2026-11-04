import { describe, expect, it } from 'vitest';
import { calendarHourRange } from '../hour-range';

describe('calendarHourRange', () => {
  it('defaults to 08:00–20:00 without usable hours', () => {
    for (const oh of [null, undefined, {}, { monday: { closed: true } }, { monday: { open: 'x', close: '17:00' } }]) {
      expect(calendarHourRange(oh)).toMatchObject({ start: 8, end: 20 });
    }
  });

  it('runs from the earliest open to the latest close across days', () => {
    const r = calendarHourRange({ monday: { open: '09:00', close: '17:00' }, saturday: { open: '10:00', close: '19:00' } });
    expect(r).toMatchObject({ start: 9, end: 19 });
    expect(r.hours).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
  });

  it('keeps the row of a part-hour close (17:30 keeps 17:00)', () => {
    expect(calendarHourRange({ monday: { open: '09:00', close: '17:30' } }).hours.at(-1)).toBe(17);
  });

  it('shows the whole day when a day runs past midnight (18:00–02:00)', () => {
    const r = calendarHourRange({ friday: { open: '18:00', close: '02:00' } });
    expect(r).toMatchObject({ start: 0, end: 24 });
    expect(r.hours).toContain(19);
    expect(r.hours).toContain(23);
    expect(r.hours).toContain(1);
  });

  it('treats a 00:00 close as past midnight', () => {
    expect(calendarHourRange({ friday: { open: '16:00', close: '00:00' } })).toMatchObject({ start: 0, end: 24 });
  });

  it('mixed week: one overnight day widens the grid for all days', () => {
    expect(calendarHourRange({ monday: { open: '09:00', close: '17:00' }, friday: { open: '22:00', close: '06:00' } })).toMatchObject({ start: 0, end: 24 });
  });

  it('matches the two production shapes found on 2026-11-04 (events 16:00–00:00 / 18:00–04:00, restaurant 22:00–06:00)', () => {
    expect(calendarHourRange({ friday: { open: '16:00', close: '00:00' }, saturday: { open: '18:00', close: '04:00', closed: false } }).hours).toHaveLength(24);
    expect(calendarHourRange({ monday: { open: '22:00', close: '06:00', is_open: true } }).hours).toHaveLength(24);
  });
});

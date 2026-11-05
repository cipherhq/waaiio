import { describe, expect, it } from 'vitest';
import { calendarHourRange, hoursIncludingEntries } from '../hour-range';

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

describe('openHour and overnight', () => {
  it('reports the earliest opening hour and whether a day runs past midnight', () => {
    expect(calendarHourRange({ friday: { open: '18:00', close: '02:00' }, saturday: { open: '16:00', close: '00:00' } })).toMatchObject({ openHour: 16, overnight: true, start: 0, end: 24 });
    expect(calendarHourRange({ monday: { open: '09:00', close: '17:00' } })).toMatchObject({ openHour: 9, overnight: false });
    expect(calendarHourRange({})).toMatchObject({ openHour: null, overnight: false });
  });
});

describe('hoursIncludingEntries (show every booking, Owner decision 2026-11-04)', () => {
  const defaults = calendarHourRange({}); // 08:00–20:00 → rows 8..19

  it('keeps business-hour rows when every entry is inside them', () => {
    expect(hoursIncludingEntries(defaults, ['09:00', '19:30', undefined])).toEqual(defaults.hours);
  });

  it('stretches earlier and later so 06:00 and 20:00 bookings get a row', () => {
    const rows = hoursIncludingEntries(defaults, ['06:00', '20:00', '12:15']);
    expect(rows[0]).toBe(6);
    expect(rows.at(-1)).toBe(20);
    expect(rows).toEqual(Array.from({ length: 15 }, (_, i) => 6 + i));
  });

  it('shows a 02:00 entry and accepts HH:MM:SS', () => {
    expect(hoursIncludingEntries(defaults, ['02:00:00'])[0]).toBe(2);
  });

  it('ignores missing and malformed times', () => {
    expect(hoursIncludingEntries(defaults, [null, '', 'later', '25:00', '7pm'])).toEqual(defaults.hours);
  });

  it('a full-day grid stays 0..23', () => {
    expect(hoursIncludingEntries(calendarHourRange({ friday: { open: '18:00', close: '02:00' } }), ['01:00', '23:00'])).toHaveLength(24);
  });
});

describe('closed days are not opening hours', () => {
  it('a 22:00–06:00 restaurant with closed days stored as 00:00–00:00 opens at 22 (production shape, 2026-11-04)', () => {
    const r = calendarHourRange({
      monday: { open: '00:00', close: '00:00', closed: true },
      tuesday: { open: '00:00', close: '00:00', closed: true },
      wednesday: { open: '22:00', close: '06:00', closed: false },
      friday: { open: '22:00', close: '06:00' },
    });
    expect(r).toMatchObject({ openHour: 22, overnight: true, start: 0, end: 24 });
  });

  it('is_open: false days are skipped too', () => {
    expect(calendarHourRange({ monday: { open: '00:00', close: '00:00', is_open: false }, friday: { open: '09:00', close: '17:00', is_open: true } }))
      .toMatchObject({ openHour: 9, overnight: false, start: 9, end: 17 });
  });

  it('a daytime business with a closed day stored as 00:00–00:00 keeps its daytime grid', () => {
    expect(calendarHourRange({ sunday: { open: '00:00', close: '00:00', closed: true }, monday: { open: '09:00', close: '17:00' } }))
      .toMatchObject({ start: 9, end: 17, overnight: false });
  });

  it('all days closed falls back to the default grid', () => {
    expect(calendarHourRange({ monday: { open: '09:00', close: '17:00', closed: true } })).toMatchObject({ start: 8, end: 20, openHour: null });
  });
});

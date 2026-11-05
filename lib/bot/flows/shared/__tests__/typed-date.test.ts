/**
 * Typed dates for the booking date picker (#916): the pure reader.
 * The real select_date step is covered in lib/__tests__/date-picker-paging-typed.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { isCalendarDate, parseTypedDate } from '../typed-date';

const NG = { today: '2026-11-05', monthFirst: false };
const US = { today: '2026-11-05', monthFirst: true };
const date = (d: string) => ({ kind: 'date', date: d });
/** No year typed and this year's day had passed, so next year's */
const rolled = (d: string) => ({ kind: 'date', date: d, rolledOver: true });

describe('parseTypedDate — every requested format', () => {
  it.each([
    ['Dec 20', '2026-12-20'],
    ['dec 20', '2026-12-20'],
    ['Dec. 20', '2026-12-20'],
    ['December 20', '2026-12-20'],
    ['Dec 20th', '2026-12-20'],
    ['20 Dec', '2026-12-20'],
    ['20 December', '2026-12-20'],
    ['20th December', '2026-12-20'],
    ['20th of December', '2026-12-20'],
    ['1st Dec', '2026-12-01'],
    ['22nd Nov', '2026-11-22'],
    ['3rd December', '2026-12-03'],
    ['20/12', '2026-12-20'],
    ['20-12', '2026-12-20'],
    ['20.12.2026', '2026-12-20'],
    ['20/12/2026', '2026-12-20'],
    ['20/12/26', '2026-12-20'],
    ['2026/12/20', '2026-12-20'],
    ['Dec 20, 2026', '2026-12-20'],
    ['20 Dec 2026', '2026-12-20'],
    ['December 20th, 2027', '2027-12-20'],
    // The list labels look like "Sat, 20 Dec"; a copied label still works
    ['Sun, 20 Dec', '2026-12-20'],
    ['Sunday 20th December', '2026-12-20'],
    ['sat 20/12', '2026-12-20'],
    ['on 20/12', '2026-12-20'],
    // Surrounding words are fine for month-name dates
    ['Dec 20 at 6pm', '2026-12-20'],
    ['for 20th December please', '2026-12-20'],
  ])('%s → %s', (input, expected) => {
    expect(parseTypedDate(input, NG)).toEqual(date(expected));
  });
});

describe('parseTypedDate — year', () => {
  it('no year: today counts, an earlier day this year rolls to next year', () => {
    expect(parseTypedDate('5 Nov', NG)).toEqual(date('2026-11-05'));
    expect(parseTypedDate('4 Nov', NG)).toEqual(rolled('2027-11-04'));
    expect(parseTypedDate('Sept 3', NG)).toEqual(rolled('2027-09-03'));
  });

  it('December rollover: January dates go to next year', () => {
    const dec20 = { today: '2026-12-20', monthFirst: false };
    // Upcoming, not "passed": early January is nearer ahead than behind (review r3 P3-A)
    expect(parseTypedDate('5 Jan', dec20)).toEqual(date('2027-01-05'));
    expect(parseTypedDate('Jan 5', dec20)).toEqual(date('2027-01-05'));
    expect(parseTypedDate('05/01', dec20)).toEqual(date('2027-01-05'));
    expect(parseTypedDate('Feb 14', NG)).toEqual(date('2027-02-14'));
    expect(parseTypedDate('Dec 31', dec20)).toEqual(date('2026-12-31'));
    expect(parseTypedDate('Dec 19', dec20)).toEqual(rolled('2027-12-19'));
  });

  it('an explicit year is kept, even in the past (the step rejects it as passed)', () => {
    expect(parseTypedDate('20/12/2025', NG)).toEqual(date('2025-12-20'));
    expect(parseTypedDate('Dec 20 2025', NG)).toEqual(date('2025-12-20'));
  });

  it('29 February goes to the next leap year', () => {
    expect(parseTypedDate('29 Feb', NG)).toEqual(date('2028-02-29'));
    expect(parseTypedDate('29/02/2027', NG)).toEqual({ kind: 'invalid' });
  });
});

describe('parseTypedDate — day/month order', () => {
  it('day/month by default (NG, GB, GH)', () => {
    expect(parseTypedDate('20/12', NG)).toEqual(date('2026-12-20'));
    expect(parseTypedDate('06/12', NG)).toEqual(date('2026-12-06'));
    expect(parseTypedDate('12/20', NG)).toEqual({ kind: 'invalid' });
  });

  it('month/day for US businesses', () => {
    expect(parseTypedDate('12/20', US)).toEqual(date('2026-12-20'));
    expect(parseTypedDate('06/12', US)).toEqual(rolled('2027-06-12'));
    expect(parseTypedDate('12/20/2026', US)).toEqual(date('2026-12-20'));
    expect(parseTypedDate('20/12', US)).toEqual({ kind: 'invalid' });
  });

  it('month names read the same everywhere', () => {
    expect(parseTypedDate('Dec 20', US)).toEqual(date('2026-12-20'));
    expect(parseTypedDate('20 Dec', US)).toEqual(date('2026-12-20'));
  });
});

describe('parseTypedDate — not a date', () => {
  it.each(['31 Feb', 'Feb 30', '32/12', '0/12', '20/13', 'Dec 0'])('%s does not exist', input => {
    expect(parseTypedDate(input, NG)).toEqual({ kind: 'invalid' });
  });

  it.each(['', 'hello', 'saturday', 'tomorrow', 'next week', 'may i come', 'may 5pm', '20', '2 people', 'decent 20', 'pick_date', 'dates_page_1', 'date_2026-12-20', '1.5', '20.30', '20.12'])(
    '%s is left to the other rules',
    input => {
      expect(parseTypedDate(input, NG)).toBeNull();
    },
  );
});

describe('isCalendarDate', () => {
  it('accepts real dates only', () => {
    expect(isCalendarDate('2026-12-20')).toBe(true);
    expect(isCalendarDate('2028-02-29')).toBe(true);
    expect(isCalendarDate('2026-02-31')).toBe(false);
    expect(isCalendarDate('2026-13-01')).toBe(false);
    expect(isCalendarDate('Dec 20')).toBe(false);
  });
});

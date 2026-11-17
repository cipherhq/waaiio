import { describe, it, expect } from 'vitest';
import { ANOTHER_DATE_ID, MAX_UPCOMING_DAYS, formatFullDate, formatShortDate, isoDate, parseTypedDate, tappedDate, todayIn, upcomingDateOptions } from './dates';

const lagos = { timezone: 'Africa/Lagos', language: 'en', country: 'GB' };

describe('friendly dates', () => {
  it('formats the Owner examples exactly', () => {
    expect(formatShortDate('2026-11-21', lagos)).toBe('Sat 21 Nov');
    expect(formatFullDate('2026-11-21', lagos)).toBe('Saturday, 21 November 2026');
  });

  it('uses the existing language policy: certified Pidgin reads as English, uncertified falls back to English', () => {
    expect(formatFullDate('2026-11-21', { language: 'pcm', country: 'GB' })).toBe('Saturday, 21 November 2026');
    expect(formatFullDate('2026-11-21', { language: 'yo', country: 'GB' })).toBe('Saturday, 21 November 2026');
    expect(formatFullDate('2026-11-21', { language: 'en', country: 'US' })).toBe('Saturday, November 21, 2026');
  });

  it('lists upcoming days from today in the business timezone, plus Another date', () => {
    // 23:30 UTC on 20 Nov is already 21 Nov in Lagos (UTC+1).
    const now = new Date('2026-11-20T23:30:00Z');
    expect(todayIn('Africa/Lagos', now)).toBe('2026-11-21');
    expect(todayIn('America/Los_Angeles', now)).toBe('2026-11-20');
    const rows = upcomingDateOptions({ ...lagos, count: 3, now });
    expect(rows).toEqual([
      { id: 'date:2026-11-21', title: 'Sat 21 Nov' },
      { id: 'date:2026-11-22', title: 'Sun 22 Nov' },
      { id: 'date:2026-11-23', title: 'Mon 23 Nov' },
      { id: ANOTHER_DATE_ID, title: 'Another date' },
    ]);
  });

  it('crosses month and year ends, and never exceeds the WhatsApp list size', () => {
    const rows = upcomingDateOptions({ ...lagos, count: 50, now: new Date('2026-12-28T12:00:00Z') });
    expect(rows).toHaveLength(MAX_UPCOMING_DAYS + 1);
    expect(rows.map(r => r.id).slice(3, 6)).toEqual(['date:2026-12-31', 'date:2027-01-01', 'date:2027-01-02']);
    expect(rows.every(r => r.title.length <= 24)).toBe(true);
  });

  it('falls back to UTC for an unknown timezone instead of throwing', () => {
    expect(todayIn('Not/AZone', new Date('2026-11-21T10:00:00Z'))).toBe('2026-11-21');
  });

  it('reads tapped rows and rejects anything else', () => {
    expect(tappedDate('date:2026-11-21')).toBe('2026-11-21');
    expect(tappedDate(ANOTHER_DATE_ID)).toBeNull();
    expect(tappedDate('date:2026-02-30')).toBeNull();
    expect(tappedDate('2026-11-21')).toBeNull();
  });

  it('validates real calendar dates', () => {
    expect(isoDate(2028, 2, 29)).toBe('2028-02-29');
    expect(isoDate(2026, 2, 29)).toBeNull();
    expect(isoDate(2026, 13, 1)).toBeNull();
  });

  describe('typed dates', () => {
    const now = new Date('2026-11-16T10:00:00Z');
    const parse = (text: string, country = 'GB') => parseTypedDate(text, { ...lagos, country, now });

    it.each([
      ['21 Nov', '2026-11-21'],
      ['21st November 2026', '2026-11-21'],
      ['Sat 21 Nov', '2026-11-21'],
      ['Saturday, 21 November 2026', '2026-11-21'],
      ['Nov 21, 2026', '2026-11-21'],
      ['november 21', '2026-11-21'],
      ['21 sept 2027', '2027-09-21'],
      ['2026-11-21', '2026-11-21'],
      ['21/11/2026', '2026-11-21'],
      ['21-11-26', '2026-11-21'],
      ['21.11', '2026-11-21'],
      ['today', '2026-11-16'],
      ['Tomorrow', '2026-11-17'],
      // No year and already passed this year → next year.
      ['3 Jan', '2027-01-03'],
    ])('%s → %s', (text, iso) => expect(parse(text)).toBe(iso));

    it('reads numeric dates month-first only for the US', () => {
      expect(parse('11/21/2026', 'US')).toBe('2026-11-21');
      expect(parse('11/21/2026', 'NG')).toBeNull();
    });

    it.each(['31 Feb', '30/02/2026', '2026-13-01', 'next week', 'soon', '', '21 Noveber', 'x'.repeat(50)])('rejects %j', text => {
      expect(parse(text)).toBeNull();
    });
  });
});

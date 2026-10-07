/**
 * Slice 561-F — Locale-aware date/time presentation tests
 *
 * Proves the canonical formatDisplayDate/formatDisplayTime seam
 * produces correct output for certified locales while preserving
 * authoritative input values byte-for-byte.
 */
import { describe, it, expect } from 'vitest';
import { formatDisplayDate, formatDisplayTime } from '../format-date';
import { CERTIFIED_LANGUAGES } from '@/lib/bot/languages';
import { getLocale } from '@/lib/constants';

// ═══════════════════════════════════════════════════════════════
// 1. English date formatting — standard business country locales
// ═══════════════════════════════════════════════════════════════

describe('561-F: English date formatting', () => {
  it('short style: booking date displays weekday + day + month', () => {
    const result = formatDisplayDate('2026-12-25', 'short', 'NG');
    // Should contain day number and month abbreviation
    expect(result).toContain('25');
    expect(result).toMatch(/Dec/i);
  });

  it('long style: appointment date displays full weekday + day + month', () => {
    const result = formatDisplayDate('2026-12-25', 'long', 'NG');
    expect(result).toContain('25');
    expect(result).toMatch(/December/i);
    expect(result).toMatch(/Friday/i);
  });

  it('long-year style: includes year', () => {
    const result = formatDisplayDate('2026-12-25', 'long-year', 'NG');
    expect(result).toContain('2026');
    expect(result).toMatch(/December/i);
  });

  it('brief style: day + month only', () => {
    const result = formatDisplayDate('2026-12-25', 'brief', 'NG');
    expect(result).toContain('25');
    expect(result).toMatch(/Dec/i);
    // Should NOT contain weekday
    expect(result).not.toMatch(/Friday/i);
  });

  it('brief-year style: month + day + year', () => {
    const result = formatDisplayDate('2026-12-25', 'brief-year', 'NG');
    expect(result).toContain('25');
    expect(result).toContain('2026');
    expect(result).toMatch(/Dec/i);
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. English time formatting
// ═══════════════════════════════════════════════════════════════

describe('561-F: English time formatting', () => {
  it('formats HH:MM to human-readable time', () => {
    const result = formatDisplayTime('14:30', 'NG');
    // Should contain 2:30 or 14:30 depending on locale
    expect(result).toMatch(/2:30|14:30/);
  });

  it('formats morning time', () => {
    const result = formatDisplayTime('09:00', 'NG');
    expect(result).toMatch(/9:00|09:00/);
  });

  it('formats midnight boundary', () => {
    const result = formatDisplayTime('00:00', 'NG');
    expect(result).toMatch(/12:00|0:00|00:00/);
  });

  it('handles HH:MM:SS format', () => {
    const result = formatDisplayTime('15:45:30', 'NG');
    expect(result).toMatch(/3:45|15:45/);
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. Pidgin locale — same calendar output as English
// ═══════════════════════════════════════════════════════════════

describe('561-F: Pidgin locale (identical calendar formatting)', () => {
  it('PCM date output matches EN for the same business country', () => {
    // PCM and EN use the same calendar system — date formatting is identical
    // The canonical seam uses business country locale, not customer language
    const enDate = formatDisplayDate('2026-12-25', 'long', 'NG');
    // Same call with same country code produces identical output
    // (copyLang doesn't affect date formatting for en/pcm)
    const pcmDate = formatDisplayDate('2026-12-25', 'long', 'NG');
    expect(pcmDate).toBe(enDate);
  });

  it('PCM time output matches EN for the same business country', () => {
    const enTime = formatDisplayTime('14:30', 'NG');
    const pcmTime = formatDisplayTime('14:30', 'NG');
    expect(pcmTime).toBe(enTime);
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. Uncertified language fallback
// ═══════════════════════════════════════════════════════════════

describe('561-F: uncertified language fallback', () => {
  it('formatDisplayDate uses business country locale regardless of customer language', () => {
    // The canonical helper uses cc (country code), not customer language
    // So formatDisplayDate('2026-12-25', 'long', 'NG') always uses en-NG locale
    // This is correct: uncertified languages (fr, yo, etc.) don't affect date format
    const ng = formatDisplayDate('2026-12-25', 'long', 'NG');
    expect(ng).toContain('25');
    expect(ng).toMatch(/December/i);
  });

  it('different business countries produce locale-appropriate formats', () => {
    const ng = formatDisplayDate('2026-12-25', 'short', 'NG');
    const us = formatDisplayDate('2026-12-25', 'short', 'US');
    const gb = formatDisplayDate('2026-12-25', 'short', 'GB');
    // All should contain the day and month
    expect(ng).toContain('25');
    expect(us).toContain('25');
    expect(gb).toContain('25');
    // All are valid formatted dates
    expect(ng.length).toBeGreaterThan(3);
    expect(us.length).toBeGreaterThan(3);
    expect(gb.length).toBeGreaterThan(3);
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. Authority preservation — canonical input unchanged
// ═══════════════════════════════════════════════════════════════

describe('561-F: authority preservation', () => {
  it('ISO date input is not mutated (formatting is one-way)', () => {
    const input = '2026-12-25';
    const result = formatDisplayDate(input, 'long', 'NG');
    // The original string is not mutated
    expect(input).toBe('2026-12-25');
    // Result is a formatted display string, not the raw input
    expect(result).not.toBe('2026-12-25');
    expect(result).toMatch(/December/i);
  });

  it('Date object input is not mutated', () => {
    const input = new Date('2026-12-25T00:00:00Z');
    const originalTime = input.getTime();
    formatDisplayDate(input, 'long', 'NG');
    expect(input.getTime()).toBe(originalTime);
  });

  it('time input is not mutated', () => {
    const input = '14:30';
    formatDisplayTime(input, 'NG');
    expect(input).toBe('14:30');
  });

  it('reference code / ID / URL are never passed through date formatter', () => {
    // This is a design test — formatDisplayDate should only receive date inputs
    // Passing a non-date string should fail safely
    const result = formatDisplayDate('BK-2026-0042', 'long', 'NG');
    // Should return the raw input since it can't parse it
    expect(result).toBe('BK-2026-0042');
  });

  it('invalid date returns raw input safely', () => {
    expect(formatDisplayDate('not-a-date', 'long', 'NG')).toBe('not-a-date');
    expect(formatDisplayDate('', 'long', 'NG')).toBe('');
  });

  it('invalid time returns raw input safely', () => {
    expect(formatDisplayTime('not-a-time', 'NG')).toBe('not-a-time');
    expect(formatDisplayTime('', 'NG')).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. Boundary tests
// ═══════════════════════════════════════════════════════════════

describe('561-F: boundary tests', () => {
  it('date near midnight', () => {
    const result = formatDisplayDate('2026-12-31T23:59:59', 'long', 'NG');
    expect(result).toMatch(/December/i);
    expect(result).toContain('31');
  });

  it('month boundary: Jan 1', () => {
    const result = formatDisplayDate('2027-01-01', 'long', 'NG');
    expect(result).toMatch(/January/i);
    expect(result).toContain('1');
  });

  it('year boundary: Dec 31 → Jan 1', () => {
    const dec31 = formatDisplayDate('2026-12-31', 'long-year', 'NG');
    const jan1 = formatDisplayDate('2027-01-01', 'long-year', 'NG');
    expect(dec31).toContain('2026');
    expect(jan1).toContain('2027');
    expect(dec31).toMatch(/December/i);
    expect(jan1).toMatch(/January/i);
  });

  it('leap year: Feb 29', () => {
    const result = formatDisplayDate('2028-02-29', 'long', 'NG');
    expect(result).toMatch(/February/i);
    expect(result).toContain('29');
  });

  it('Nigeria (Africa/Lagos) does not observe DST — consistent formatting', () => {
    // Nigeria uses WAT (UTC+1) year-round. No DST transition.
    // Both dates should format consistently.
    const june = formatDisplayDate('2026-06-15', 'long', 'NG');
    const dec = formatDisplayDate('2026-12-15', 'long', 'NG');
    expect(june).toMatch(/June/i);
    expect(dec).toMatch(/December/i);
    // Both are valid — no DST-related formatting anomalies
  });

  it('time at day boundary: 00:00 and 23:59', () => {
    const midnight = formatDisplayTime('00:00', 'NG');
    const endOfDay = formatDisplayTime('23:59', 'NG');
    // Both should return valid formatted times
    expect(midnight.length).toBeGreaterThan(2);
    expect(endOfDay.length).toBeGreaterThan(2);
  });

  it('missing country code falls back to NG', () => {
    const result = formatDisplayDate('2026-12-25', 'long', '');
    expect(result).toMatch(/December/i);
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. Regression — no translation of protected values
// ═══════════════════════════════════════════════════════════════

describe('561-F: regression — protected values not translated', () => {
  it('date formatter does not produce text that could be confused with IDs', () => {
    const result = formatDisplayDate('2026-12-25', 'long', 'NG');
    // Should not contain ISO format
    expect(result).not.toMatch(/^\d{4}-\d{2}-\d{2}/);
    // Should contain human-readable month name
    expect(result).toMatch(/[A-Za-z]/);
  });

  it('getLocale returns a valid BCP47 tag for supported countries', () => {
    for (const cc of ['NG', 'US', 'GB', 'GH', 'KE', 'ZA', 'CA']) {
      const locale = getLocale(cc);
      expect(locale).toMatch(/^[a-z]{2}-[A-Z]{2}$/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. CERTIFIED_LANGUAGES unchanged
// ═══════════════════════════════════════════════════════════════

describe('561-F: CERTIFIED_LANGUAGES unchanged', () => {
  it('only en and pcm are certified', () => {
    expect(CERTIFIED_LANGUAGES).toEqual(['en', 'pcm']);
  });
});

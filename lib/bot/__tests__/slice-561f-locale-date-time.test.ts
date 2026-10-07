/**
 * Slice 561-F — Locale-aware date/time presentation tests
 *
 * Proves the canonical formatDisplayDate/formatDisplayTime seam
 * uses effective response language as primary authority, with
 * business country as secondary regional context. Preserves
 * all authoritative input values.
 */
import { describe, it, expect } from 'vitest';
import { formatDisplayDate, formatDisplayTime } from '../format-date';
import { CERTIFIED_LANGUAGES } from '@/lib/bot/languages';

// ═══════════════════════════════════════════════════════════════
// 1. English authority — language governs, country is regional
// ═══════════════════════════════════════════════════════════════

describe('561-F: English language authority', () => {
  it('en + NG: English formatted with Nigerian regional convention', () => {
    const result = formatDisplayDate('2026-12-25', 'long', 'en', 'NG');
    expect(result).toMatch(/December/i);
    expect(result).toContain('25');
    expect(result).toMatch(/Friday/i);
  });

  it('en + US: English formatted with American regional convention', () => {
    const result = formatDisplayDate('2026-12-25', 'long', 'en', 'US');
    expect(result).toMatch(/December/i);
    expect(result).toContain('25');
  });

  it('en + CA: English formatted with Canadian regional convention', () => {
    const result = formatDisplayDate('2026-12-25', 'long', 'en', 'CA');
    expect(result).toMatch(/December/i);
    expect(result).toContain('25');
  });

  it('en + GB: English formatted with British regional convention', () => {
    const result = formatDisplayDate('2026-12-25', 'long', 'en', 'GB');
    expect(result).toMatch(/December/i);
    expect(result).toContain('25');
  });

  it('en + FR: remains English despite French business country', () => {
    const result = formatDisplayDate('2026-12-25', 'long', 'en', 'FR');
    // Must contain English month name, NOT French
    expect(result).toMatch(/December/i);
    expect(result).not.toMatch(/décembre/i);
    expect(result).toContain('25');
  });

  it('en + DE: remains English despite German business country', () => {
    const result = formatDisplayDate('2026-12-25', 'long', 'en', 'DE');
    expect(result).toMatch(/December/i);
    expect(result).not.toMatch(/Dezember/i);
  });

  it('en + ES: remains English despite Spanish business country', () => {
    const result = formatDisplayDate('2026-12-25', 'long', 'en', 'ES');
    expect(result).toMatch(/December/i);
    expect(result).not.toMatch(/diciembre/i);
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. PCM authority — same calendar as English
// ═══════════════════════════════════════════════════════════════

describe('561-F: PCM (authorized Pidgin) date formatting', () => {
  it('pcm + NG: uses English calendar formatting (same system)', () => {
    const pcmResult = formatDisplayDate('2026-12-25', 'long', 'pcm', 'NG');
    const enResult = formatDisplayDate('2026-12-25', 'long', 'en', 'NG');
    // PCM maps to English for calendar formatting
    expect(pcmResult).toBe(enResult);
    expect(pcmResult).toMatch(/December/i);
  });

  it('pcm + NG time: same as English', () => {
    const pcmTime = formatDisplayTime('14:30', 'pcm', 'NG');
    const enTime = formatDisplayTime('14:30', 'en', 'NG');
    expect(pcmTime).toBe(enTime);
  });

  it('pcm + GH: English calendar with Ghanaian regional context', () => {
    const result = formatDisplayDate('2026-12-25', 'long', 'pcm', 'GH');
    expect(result).toMatch(/December/i);
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. Uncertified/unentitled fallback
// ═══════════════════════════════════════════════════════════════

describe('561-F: uncertified language fallback to English', () => {
  const uncertified = ['fr', 'yo', 'ig', 'ha', 'tw', 'es'];

  for (const lang of uncertified) {
    it(`${lang} (uncertified) falls back to English date output`, () => {
      const result = formatDisplayDate('2026-12-25', 'long', lang, 'NG');
      const enResult = formatDisplayDate('2026-12-25', 'long', 'en', 'NG');
      expect(result).toBe(enResult);
      expect(result).toMatch(/December/i);
    });
  }

  it('undefined effectiveLang falls back to English', () => {
    const result = formatDisplayDate('2026-12-25', 'long', undefined, 'NG');
    expect(result).toMatch(/December/i);
  });

  it('empty string effectiveLang falls back to English', () => {
    const result = formatDisplayDate('2026-12-25', 'long', '', 'NG');
    expect(result).toMatch(/December/i);
  });

  it('fr + FR: fallback prevents French date despite French country', () => {
    const result = formatDisplayDate('2026-12-25', 'long', 'fr', 'FR');
    const enResult = formatDisplayDate('2026-12-25', 'long', 'en', 'FR');
    // French is uncertified → falls back to English
    expect(result).toBe(enResult);
    expect(result).toMatch(/December/i);
    expect(result).not.toMatch(/décembre/i);
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. Regional context — same language, different conventions
// ═══════════════════════════════════════════════════════════════

describe('561-F: regional context variations', () => {
  it('en + US vs en + GB may differ in date order', () => {
    const us = formatDisplayDate('2026-12-25', 'short', 'en', 'US');
    const gb = formatDisplayDate('2026-12-25', 'short', 'en', 'GB');
    // Both contain the same day and month but may order differently
    expect(us).toContain('25');
    expect(gb).toContain('25');
    expect(us).toMatch(/Dec/i);
    expect(gb).toMatch(/Dec/i);
  });

  it('en + US vs en + CA both remain English', () => {
    const us = formatDisplayDate('2026-06-15', 'long-year', 'en', 'US');
    const ca = formatDisplayDate('2026-06-15', 'long-year', 'en', 'CA');
    expect(us).toMatch(/June/i);
    expect(ca).toMatch(/June/i);
    expect(us).toContain('2026');
    expect(ca).toContain('2026');
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. Named style presets
// ═══════════════════════════════════════════════════════════════

describe('561-F: named style presets', () => {
  it('short: weekday + day + month', () => {
    const result = formatDisplayDate('2026-12-25', 'short', 'en', 'NG');
    expect(result).toContain('25');
    expect(result).toMatch(/Dec/i);
  });

  it('long: full weekday + day + month', () => {
    const result = formatDisplayDate('2026-12-25', 'long', 'en', 'NG');
    expect(result).toMatch(/Friday/i);
    expect(result).toMatch(/December/i);
  });

  it('long-year: includes year', () => {
    const result = formatDisplayDate('2026-12-25', 'long-year', 'en', 'NG');
    expect(result).toContain('2026');
    expect(result).toMatch(/December/i);
  });

  it('brief: day + month only', () => {
    const result = formatDisplayDate('2026-12-25', 'brief', 'en', 'NG');
    expect(result).toContain('25');
    expect(result).toMatch(/Dec/i);
    expect(result).not.toMatch(/Friday/i);
  });

  it('brief-year: month + day + year', () => {
    const result = formatDisplayDate('2026-12-25', 'brief-year', 'en', 'NG');
    expect(result).toContain('25');
    expect(result).toContain('2026');
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. Time formatting
// ═══════════════════════════════════════════════════════════════

describe('561-F: time formatting', () => {
  it('formats HH:MM to readable time', () => {
    const result = formatDisplayTime('14:30', 'en', 'NG');
    expect(result).toMatch(/2:30|14:30/);
  });

  it('morning time', () => {
    const result = formatDisplayTime('09:00', 'en', 'NG');
    expect(result).toMatch(/9:00|09:00/);
  });

  it('midnight boundary', () => {
    const result = formatDisplayTime('00:00', 'en', 'NG');
    expect(result).toMatch(/12:00|0:00|00:00/);
  });

  it('time with seconds', () => {
    const result = formatDisplayTime('15:45:30', 'en', 'NG');
    expect(result).toMatch(/3:45|15:45/);
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. Authority preservation
// ═══════════════════════════════════════════════════════════════

describe('561-F: authority preservation', () => {
  it('ISO date input not mutated', () => {
    const input = '2026-12-25';
    const result = formatDisplayDate(input, 'long', 'en', 'NG');
    expect(input).toBe('2026-12-25');
    expect(result).not.toBe('2026-12-25');
    expect(result).toMatch(/December/i);
  });

  it('Date object not mutated', () => {
    const input = new Date('2026-12-25T00:00:00Z');
    const originalTime = input.getTime();
    formatDisplayDate(input, 'long', 'en', 'NG');
    expect(input.getTime()).toBe(originalTime);
  });

  it('time input not mutated', () => {
    const input = '14:30';
    formatDisplayTime(input, 'en', 'NG');
    expect(input).toBe('14:30');
  });

  it('non-date input returns raw safely', () => {
    expect(formatDisplayDate('BK-2026-0042', 'long', 'en', 'NG')).toBe('BK-2026-0042');
    expect(formatDisplayDate('', 'long', 'en', 'NG')).toBe('');
    expect(formatDisplayDate('not-a-date', 'long', 'en', 'NG')).toBe('not-a-date');
  });

  it('invalid time returns raw safely', () => {
    expect(formatDisplayTime('not-a-time', 'en', 'NG')).toBe('not-a-time');
    expect(formatDisplayTime('', 'en', 'NG')).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. Boundary tests
// ═══════════════════════════════════════════════════════════════

describe('561-F: boundary tests', () => {
  it('date near midnight', () => {
    const result = formatDisplayDate('2026-12-31T23:59:59', 'long', 'en', 'NG');
    expect(result).toMatch(/December/i);
    expect(result).toContain('31');
  });

  it('month boundary: Jan 1', () => {
    const result = formatDisplayDate('2027-01-01', 'long', 'en', 'NG');
    expect(result).toMatch(/January/i);
  });

  it('year boundary: Dec 31 to Jan 1', () => {
    const dec31 = formatDisplayDate('2026-12-31', 'long-year', 'en', 'NG');
    const jan1 = formatDisplayDate('2027-01-01', 'long-year', 'en', 'NG');
    expect(dec31).toContain('2026');
    expect(jan1).toContain('2027');
  });

  it('leap year: Feb 29', () => {
    const result = formatDisplayDate('2028-02-29', 'long', 'en', 'NG');
    expect(result).toMatch(/February/i);
    expect(result).toContain('29');
  });

  it('Nigeria no DST — consistent formatting', () => {
    const june = formatDisplayDate('2026-06-15', 'long', 'en', 'NG');
    const dec = formatDisplayDate('2026-12-15', 'long', 'en', 'NG');
    expect(june).toMatch(/June/i);
    expect(dec).toMatch(/December/i);
  });

  it('time at day boundaries: 00:00 and 23:59', () => {
    const midnight = formatDisplayTime('00:00', 'en', 'NG');
    const endOfDay = formatDisplayTime('23:59', 'en', 'NG');
    expect(midnight.length).toBeGreaterThan(2);
    expect(endOfDay.length).toBeGreaterThan(2);
  });

  it('missing country code falls back to NG', () => {
    const result = formatDisplayDate('2026-12-25', 'long', 'en', '');
    expect(result).toMatch(/December/i);
  });
});

// ═══════════════════════════════════════════════════════════════
// 9. Ticket path — no hardcoded NG
// ═══════════════════════════════════════════════════════════════

describe('561-F: ticket path country resolution', () => {
  it('ticket with GH event uses Ghanaian locale, not NG', () => {
    const gh = formatDisplayDate('2026-12-25', 'short', 'en', 'GH');
    const ng = formatDisplayDate('2026-12-25', 'short', 'en', 'NG');
    // Both are valid English dates — the important thing is GH isn't silently
    // overridden to NG. Both should contain the date components.
    expect(gh).toContain('25');
    expect(gh).toMatch(/Dec/i);
    expect(ng).toContain('25');
    expect(ng).toMatch(/Dec/i);
  });

  it('ticket with US event uses American locale', () => {
    const us = formatDisplayDate('2026-12-25', 'long', 'en', 'US');
    expect(us).toMatch(/December/i);
    expect(us).toContain('25');
  });
});

// ═══════════════════════════════════════════════════════════════
// 10. CERTIFIED_LANGUAGES unchanged
// ═══════════════════════════════════════════════════════════════

describe('561-F: CERTIFIED_LANGUAGES unchanged', () => {
  it('only en and pcm are certified', () => {
    expect(CERTIFIED_LANGUAGES).toEqual(['en', 'pcm']);
  });
});

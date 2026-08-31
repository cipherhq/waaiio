/**
 * Tests for F1 (timezone write-boundary correction) and F4 (claim-format guidance).
 *
 * F1: naiveToUtc converts naive datetime-local values to correct UTC TIMESTAMPTZ
 *     when a timezone is provided.
 * F4: renderPromoEntryMessage includes code_format hint when populated.
 */
import { describe, it, expect } from 'vitest';
import { naiveToUtc, isValidTimezone } from '@/lib/promotions/timezone';
import { renderPromoEntryMessage, type PromoEntryCampaign } from '@/lib/promotions/entry';

// ══════════════════════════════════════════════════════════
// F1: Timezone conversion
// ══════════════════════════════════════════════════════════

describe('naiveToUtc', () => {
  it('Africa/Lagos naive datetime → correct UTC (UTC+1)', () => {
    // Lagos is UTC+1 year-round (no DST)
    // "2024-10-30T23:59" in Lagos should become "2024-10-30T22:59:00.000Z"
    const result = naiveToUtc('2024-10-30T23:59', 'Africa/Lagos');
    expect(result.success).toBe(true);
    if (result.success) {
      const utc = new Date(result.utcIso);
      expect(utc.getUTCFullYear()).toBe(2024);
      expect(utc.getUTCMonth()).toBe(9); // October = 9
      expect(utc.getUTCDate()).toBe(30);
      expect(utc.getUTCHours()).toBe(22);
      expect(utc.getUTCMinutes()).toBe(59);
    }
  });

  it('America/New_York summer (EDT, UTC-4) → correct UTC', () => {
    // July = EDT = UTC-4
    // "2024-07-15T14:00" in NYC should become "2024-07-15T18:00:00.000Z"
    const result = naiveToUtc('2024-07-15T14:00', 'America/New_York');
    expect(result.success).toBe(true);
    if (result.success) {
      const utc = new Date(result.utcIso);
      expect(utc.getUTCHours()).toBe(18);
      expect(utc.getUTCDate()).toBe(15);
    }
  });

  it('America/New_York winter (EST, UTC-5) → correct UTC', () => {
    // January = EST = UTC-5
    // "2024-01-15T14:00" in NYC should become "2024-01-15T19:00:00.000Z"
    const result = naiveToUtc('2024-01-15T14:00', 'America/New_York');
    expect(result.success).toBe(true);
    if (result.success) {
      const utc = new Date(result.utcIso);
      expect(utc.getUTCHours()).toBe(19);
      expect(utc.getUTCDate()).toBe(15);
    }
  });

  it('boundary claim eligibility: Lagos end_at at local midnight', () => {
    // Campaign ends at midnight Lagos time (2024-10-31T00:00 Africa/Lagos)
    // That's 2024-10-30T23:00Z in UTC
    const endResult = naiveToUtc('2024-10-31T00:00', 'Africa/Lagos');
    expect(endResult.success).toBe(true);
    if (!endResult.success) return;

    const endUtc = new Date(endResult.utcIso);

    // A claim at 23:59 Lagos (= 22:59 UTC) should be before end_at
    const claimBefore = new Date('2024-10-30T22:59:00.000Z');
    expect(claimBefore.getTime()).toBeLessThan(endUtc.getTime());

    // A claim at 00:01 next day Lagos (= 23:01 UTC) should be after end_at
    const claimAfter = new Date('2024-10-30T23:01:00.000Z');
    expect(claimAfter.getTime()).toBeGreaterThan(endUtc.getTime());
  });

  it('invalid timezone rejected', () => {
    const result = naiveToUtc('2024-10-30T23:59', 'Invalid/Timezone');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Invalid timezone');
    }
  });

  it('no timezone provided → backward compatible (use UTC passthrough)', () => {
    // When timezone is UTC, the value should pass through unchanged
    const result = naiveToUtc('2024-10-30T23:59', 'UTC');
    expect(result.success).toBe(true);
    if (result.success) {
      const utc = new Date(result.utcIso);
      expect(utc.getUTCHours()).toBe(23);
      expect(utc.getUTCMinutes()).toBe(59);
      expect(utc.getUTCDate()).toBe(30);
    }
  });

  it('handles datetime with seconds', () => {
    const result = naiveToUtc('2024-10-30T23:59:30', 'Africa/Lagos');
    expect(result.success).toBe(true);
    if (result.success) {
      const utc = new Date(result.utcIso);
      expect(utc.getUTCHours()).toBe(22);
      expect(utc.getUTCMinutes()).toBe(59);
      expect(utc.getUTCSeconds()).toBe(30);
    }
  });

  it('rejects malformed datetime', () => {
    const result = naiveToUtc('not-a-date', 'Africa/Lagos');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Invalid datetime format');
    }
  });
});

describe('isValidTimezone', () => {
  it('accepts valid IANA zones', () => {
    expect(isValidTimezone('Africa/Lagos')).toBe(true);
    expect(isValidTimezone('America/New_York')).toBe(true);
    expect(isValidTimezone('Europe/London')).toBe(true);
    expect(isValidTimezone('Asia/Tokyo')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
  });

  it('rejects invalid zones', () => {
    expect(isValidTimezone('Invalid/Zone')).toBe(false);
    expect(isValidTimezone('WEST')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════
// F4: Claim format guidance
// ══════════════════════════════════════════════════════════

describe('renderPromoEntryMessage code_format', () => {
  it('includes code_format in single campaign message when populated', () => {
    const campaign: PromoEntryCampaign = {
      id: '1',
      name: 'Summer Promo',
      keyword: 'SUMMER',
      code_entry_mode: 'keyword',
      accept_bare_codes: false,
      code_format: 'XXXX-XXXX-XXXX',
    };
    const msg = renderPromoEntryMessage([campaign]);
    expect(msg).toContain('Summer Promo');
    expect(msg).toContain('SUMMER <your code>');
    expect(msg).toContain('XXXX-XXXX-XXXX');
    expect(msg).toContain('Code format');
  });

  it('omits code_format when not populated (null)', () => {
    const campaign: PromoEntryCampaign = {
      id: '1',
      name: 'Summer Promo',
      keyword: 'SUMMER',
      code_entry_mode: 'keyword',
      accept_bare_codes: false,
      code_format: null,
    };
    const msg = renderPromoEntryMessage([campaign]);
    expect(msg).toContain('Summer Promo');
    expect(msg).not.toContain('Code format');
  });

  it('includes code_format in multi-campaign listing', () => {
    const campaigns: PromoEntryCampaign[] = [
      { id: '1', name: 'Promo A', keyword: 'A', code_entry_mode: 'keyword', accept_bare_codes: false, code_format: 'AAAA-BBBB' },
      { id: '2', name: 'Promo B', keyword: null, code_entry_mode: 'bare_code', accept_bare_codes: true, code_format: null },
    ];
    const msg = renderPromoEntryMessage(campaigns);
    expect(msg).toContain('AAAA-BBBB');
    // Promo B has no code_format, so no format hint for it
    expect(msg).toContain('Promo B');
  });
});

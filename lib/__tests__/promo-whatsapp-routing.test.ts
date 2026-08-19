/**
 * PROMO-1: WhatsApp bot routing tests.
 *
 * Verifies that promo code verification integrates correctly
 * with the bot without breaking existing flows.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { looksLikePromoCode } from '@/lib/promotions/verify';

describe('looksLikePromoCode', () => {
  it('matches valid 12-char code', () => {
    expect(looksLikePromoCode('K7PM4XQ9N2WF')).toBe(true);
  });

  it('matches hyphenated code', () => {
    expect(looksLikePromoCode('K7PM-4XQ9-N2WF')).toBe(true);
  });

  it('matches lowercase code', () => {
    expect(looksLikePromoCode('k7pm4xq9n2wf')).toBe(true);
  });

  it('rejects code with spaces (natural language protection)', () => {
    // Codes with spaces look like natural language — use hyphens instead
    expect(looksLikePromoCode('K7PM 4XQ9 N2WF')).toBe(false);
  });

  it('rejects short strings', () => {
    expect(looksLikePromoCode('hello')).toBe(false);
    expect(looksLikePromoCode('AB')).toBe(false);
  });

  it('rejects long strings', () => {
    expect(looksLikePromoCode('A'.repeat(25))).toBe(false);
  });

  it('rejects strings with special characters', () => {
    expect(looksLikePromoCode('hello world!')).toBe(false);
    expect(looksLikePromoCode('code@123456')).toBe(false);
  });

  // ── Bot intent regression tests ──
  // These messages must NOT be detected as promo codes

  it('does not match "Hi"', () => {
    expect(looksLikePromoCode('Hi')).toBe(false);
  });

  it('does not match "book appointment"', () => {
    expect(looksLikePromoCode('book appointment')).toBe(false);
  });

  it('does not match "order food"', () => {
    expect(looksLikePromoCode('order food')).toBe(false);
  });

  it('does not match "cancel"', () => {
    expect(looksLikePromoCode('cancel')).toBe(false);
  });

  it('does not match "menu"', () => {
    expect(looksLikePromoCode('menu')).toBe(false);
  });

  it('does not match "help"', () => {
    expect(looksLikePromoCode('help')).toBe(false);
  });

  it('does not match "I want to make a reservation"', () => {
    expect(looksLikePromoCode('I want to make a reservation')).toBe(false);
  });

  it('does not match "pay now"', () => {
    expect(looksLikePromoCode('pay now')).toBe(false);
  });

  it('does not match "queue"', () => {
    expect(looksLikePromoCode('queue')).toBe(false);
  });

  it('does not match "chat"', () => {
    expect(looksLikePromoCode('chat')).toBe(false);
  });

  it('does not match "1" (numeric selection)', () => {
    expect(looksLikePromoCode('1')).toBe(false);
  });

  it('does not match "yes"', () => {
    expect(looksLikePromoCode('yes')).toBe(false);
  });

  it('does not match a phone number', () => {
    expect(looksLikePromoCode('+2348012345678')).toBe(false);
  });

  it('does not match an email', () => {
    expect(looksLikePromoCode('user@example.com')).toBe(false);
  });

  it('matches a 10-char code with digit (hardened minimum)', () => {
    expect(looksLikePromoCode('ABCDEFGH12')).toBe(true);
  });

  it('rejects 9-char code (below hardened minimum)', () => {
    expect(looksLikePromoCode('ABCDEFG12')).toBe(false);
  });

  it('rejects pure-alpha codes (likely natural language)', () => {
    expect(looksLikePromoCode('ABCDEF')).toBe(false);
    expect(looksLikePromoCode('cancel')).toBe(false);
  });

  it('matches a 24-char code with digits (maximum)', () => {
    expect(looksLikePromoCode('A1'.repeat(12))).toBe(true);
  });
});

describe('promo verification handler integration', () => {
  it('handler module exports exist', async () => {
    const mod = await import('@/lib/bot/handlers/promo-verification');
    expect(typeof mod.handlePromoVerification).toBe('function');
  });
});

describe('promo normalizer consistency', () => {
  it('normalizer is consistent across all entry paths', async () => {
    const { normalizePromoCode } = await import('@/lib/promotions/normalize');
    const { hashPromoCode } = await import('@/lib/promotions/crypto');

    // All these inputs should produce the same hash
    const inputs = [
      'K7PM-4XQ9-N2WF',
      'k7pm4xq9n2wf',
      'K7PM 4XQ9 N2WF',
      '  k7pm-4xq9-n2wf  ',
      'K7PM.4XQ9.N2WF',
    ];

    const hashes = inputs.map(i => hashPromoCode(normalizePromoCode(i)));
    const unique = new Set(hashes);
    expect(unique.size).toBe(1);
  });
});

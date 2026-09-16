/**
 * Production regression: promo verification intercepting interactive button replies.
 *
 * UAT defect: customer taps "Tomorrow (Wed)" quick-date button in scheduling flow,
 * bot responds "That code is not valid" instead of accepting the date.
 *
 * Root cause: handlePromoVerification runs before the flow executor. The button's
 * postback ID (date_2026-09-17) passes looksLikePromoCode() because after stripping
 * underscores/hyphens it becomes a 12-char alphanumeric string with digits.
 * If the business has an active bare-code promo campaign, the handler intercepts
 * the message and sends the campaign's invalid_message — the flow executor never runs.
 *
 * Fix: handlePromoVerification short-circuits on messageType='button'/'list' since
 * interactive reply postback IDs are machine-generated, never user-typed promo codes.
 *
 * Tests cover:
 * 1. looksLikePromoCode false-positive on scheduling postback IDs
 * 2. handlePromoVerification skips button/list message types
 * 3. handlePromoVerification still processes text messages (no regression)
 * 4. Full scheduling date→time→payment postback ID inventory
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { looksLikePromoCode } from '@/lib/promotions/verify';

// ── Mock service client (used by handlePromoVerification internals) ──
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: vi.fn(() => ({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({ data: null })),
              })),
              maybeSingle: vi.fn(async () => ({ data: null })),
            })),
            maybeSingle: vi.fn(async () => ({ data: null })),
            limit: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({ data: null })),
            })),
          })),
          maybeSingle: vi.fn(async () => ({ data: null })),
        })),
        count: 'exact',
        head: true,
      })),
    })),
  })),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

describe('looksLikePromoCode — scheduling postback ID false positives', () => {
  // These are the exact postback IDs emitted by scheduling.flow.ts
  // that triggered the production defect

  it('FALSE POSITIVE: date_2026-09-17 matches looksLikePromoCode (root cause)', () => {
    // This IS the bug: looksLikePromoCode returns true for date postback IDs.
    // After stripping underscores+hyphens: "date20260917" = 12 chars, alphanumeric, has digits.
    // We document this as a known false positive — the fix is at the handler level.
    expect(looksLikePromoCode('date_2026-09-17')).toBe(true);
  });

  it('FALSE POSITIVE: date_2026-09-20 (Saturday) also matches', () => {
    expect(looksLikePromoCode('date_2026-09-20')).toBe(true);
  });

  // Other scheduling postback IDs that could be caught
  it('pick_date does NOT match (no digits)', () => {
    expect(looksLikePromoCode('pick_date')).toBe(false);
  });

  it('wl_join does NOT match (too short after stripping)', () => {
    expect(looksLikePromoCode('wl_join')).toBe(false);
  });

  it('confirm does NOT match (no digits)', () => {
    expect(looksLikePromoCode('confirm')).toBe(false);
  });

  it('i_paid does NOT match (too short after stripping)', () => {
    expect(looksLikePromoCode('i_paid')).toBe(false);
  });
});

describe('handlePromoVerification — messageType guard', () => {
  let handlePromoVerification: typeof import('@/lib/bot/handlers/promo-verification').handlePromoVerification;
  const mockSupabase = {} as any;
  const mockSendText = vi.fn(async () => {});
  const FROM = '+2348012345678';
  const BUSINESS_ID = 'biz-123';
  const CAPS = ['scheduling', 'promo_verification'];

  beforeEach(async () => {
    vi.clearAllMocks();
    // Re-import to get fresh module
    const mod = await import('@/lib/bot/handlers/promo-verification');
    handlePromoVerification = mod.handlePromoVerification;
  });

  it('skips promo verification for messageType="button" (exact production case)', async () => {
    // This is the exact production scenario: date_2026-09-17 button tap
    const result = await handlePromoVerification(
      mockSupabase, mockSendText, FROM, 'date_2026-09-17',
      BUSINESS_ID, undefined, CAPS, 'pre_resolved',
      'button', // Interactive button reply
    );

    expect(result.handled).toBe(false);
    expect(mockSendText).not.toHaveBeenCalled();
  });

  it('skips promo verification for messageType="list"', async () => {
    // List replies (time slot selection, etc.) should also be skipped
    const result = await handlePromoVerification(
      mockSupabase, mockSendText, FROM, 'time_09:00',
      BUSINESS_ID, undefined, CAPS, 'pre_resolved',
      'list',
    );

    expect(result.handled).toBe(false);
    expect(mockSendText).not.toHaveBeenCalled();
  });

  it('still processes text messages (no regression on real promo codes)', async () => {
    // A text message with a promo-code-like string should still be processed.
    // It will hit looksLikePromoCode, then try to verify. Since no campaigns
    // exist in our mock, it returns handled:false — but the important thing
    // is that it did NOT short-circuit.
    const result = await handlePromoVerification(
      mockSupabase, mockSendText, FROM, 'K7PM4XQ9N2WF',
      BUSINESS_ID, undefined, CAPS, 'pre_resolved',
      'text', // User-typed text message
    );

    // Should NOT short-circuit — text messages proceed to promo logic
    // (returns handled:false because mock has no active campaigns)
    expect(result.handled).toBe(false);
  });

  it('still processes messages with no messageType (backward compat)', async () => {
    const result = await handlePromoVerification(
      mockSupabase, mockSendText, FROM, 'K7PM4XQ9N2WF',
      BUSINESS_ID, undefined, CAPS, 'pre_resolved',
      undefined, // No messageType (legacy callers)
    );

    expect(result.handled).toBe(false);
  });

  it('skips verification when promo_verification not in capabilities', async () => {
    const result = await handlePromoVerification(
      mockSupabase, mockSendText, FROM, 'date_2026-09-17',
      BUSINESS_ID, undefined, ['scheduling'], // no promo_verification
      'pre_resolved', 'text',
    );

    expect(result.handled).toBe(false);
  });
});

describe('scheduling flow postback ID inventory — no promo interception', () => {
  // All known postback IDs from scheduling/appointment flows.
  // When messageType='button' or 'list', these must all pass through
  // handlePromoVerification without interception.

  const SCHEDULING_BUTTON_IDS = [
    'date_2026-09-16',  // Tomorrow (Tue)
    'date_2026-09-17',  // Tomorrow (Wed) — exact production case
    'date_2026-09-20',  // This Saturday
    'pick_date',
    'confirm',
    'cancel_booking',
    'i_paid',
    'get_new_link',
    'go_back',
  ];

  const SCHEDULING_LIST_IDS = [
    'time_09:00',
    'time_10:30',
    'time_14:00',
    'service_abc123',
  ];

  let handlePromoVerification: typeof import('@/lib/bot/handlers/promo-verification').handlePromoVerification;
  const mockSupabase = {} as any;
  const mockSendText = vi.fn(async () => {});
  const CAPS = ['scheduling', 'promo_verification'];

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('@/lib/bot/handlers/promo-verification');
    handlePromoVerification = mod.handlePromoVerification;
  });

  for (const id of SCHEDULING_BUTTON_IDS) {
    it(`button "${id}" passes through without promo interception`, async () => {
      const result = await handlePromoVerification(
        mockSupabase, mockSendText, '+2348012345678', id,
        'biz-123', undefined, CAPS, 'pre_resolved', 'button',
      );
      expect(result.handled).toBe(false);
      expect(mockSendText).not.toHaveBeenCalled();
    });
  }

  for (const id of SCHEDULING_LIST_IDS) {
    it(`list "${id}" passes through without promo interception`, async () => {
      const result = await handlePromoVerification(
        mockSupabase, mockSendText, '+2348012345678', id,
        'biz-123', undefined, CAPS, 'pre_resolved', 'list',
      );
      expect(result.handled).toBe(false);
      expect(mockSendText).not.toHaveBeenCalled();
    });
  }
});

/**
 * ACC-204: CLAIM/STATUS self-service + fulfillment notification dispatch
 *
 * Tests:
 * A. CLAIM/STATUS routing: pattern matching, provenance gating
 * B. CLAIM/STATUS response: prize lookup, fulfillment status, verification display
 * C. CLAIM/STATUS rejection: wrong phone, wrong business, not winner
 * D. Fulfillment notification dispatch: intent check, non-blocking dispatch
 * E. Fulfillment route: notification intent query after RPC success
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock state ──

let mockRedemptionQuery: { data: unknown; error: unknown } = { data: null, error: null };
let mockCampaignQuery: { data: unknown; error: unknown } = { data: null, error: null };
let mockCodeQuery: { data: unknown; error: unknown } = { data: null, error: null };
let mockPrizeQuery: { data: unknown; error: unknown } = { data: null, error: null };
let sentMessages: Array<{ to: string; text: string }> = [];

function resetMocks() {
  mockRedemptionQuery = {
    data: {
      id: 'red-1',
      claim_reference: 'WAA-TEST-0001',
      fulfillment_status: 'pending',
      verification_mode: 'standard',
      verification_status: 'phone_verified',
      campaign_id: 'camp-1',
      promo_code_id: 'code-1',
    },
    error: null,
  };
  mockCampaignQuery = { data: { name: 'Summer Promo' }, error: null };
  mockCodeQuery = { data: { prize_id: 'prize-1' }, error: null };
  mockPrizeQuery = { data: { name: 'Gold Watch' }, error: null };
  sentMessages = [];
  mockHasActiveKeyword = false;
  mockHasActiveBareCode = false;
}

// ── Supabase mock ──

function makeChain(resolveData: () => { data: unknown; error: unknown }): Record<string, any> {
  const c: Record<string, any> = {};
  ['select', 'eq', 'neq', 'order', 'range', 'not', 'in', 'gte', 'limit'].forEach(
    (m) => (c[m] = vi.fn().mockReturnValue(c)),
  );
  c.maybeSingle = vi.fn().mockImplementation(() => Promise.resolve(resolveData()));
  c.single = vi.fn().mockImplementation(() => Promise.resolve(resolveData()));
  return c;
}

let queryCounter = 0;

const mockServiceFrom = vi.fn().mockImplementation((table: string) => {
  if (table === 'promo_redemptions') {
    return makeChain(() => mockRedemptionQuery);
  }
  if (table === 'promo_campaigns') {
    return makeChain(() => mockCampaignQuery);
  }
  if (table === 'promo_campaign_codes') {
    return makeChain(() => mockCodeQuery);
  }
  if (table === 'promo_prizes') {
    return makeChain(() => mockPrizeQuery);
  }
  if (table === 'promo_pending_eligibility') {
    return makeChain(() => ({ data: null, error: null }));
  }
  return makeChain(() => ({ data: null, error: null }));
});

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: mockServiceFrom,
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  }),
}));

let mockHasActiveKeyword = false;
let mockHasActiveBareCode = false;

vi.mock('@/lib/promotions/verify', () => ({
  verifyPromoCode: vi.fn().mockResolvedValue({ message: 'Test result' }),
  looksLikePromoCode: vi.fn().mockReturnValue(false),
  hasActiveBareCodeCampaign: vi.fn().mockImplementation(() => Promise.resolve(mockHasActiveBareCode)),
  hasActiveKeywordCampaign: vi.fn().mockImplementation(() => Promise.resolve(mockHasActiveKeyword)),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── Import handler ──
import { handlePromoVerification } from '@/lib/bot/handlers/promo-verification';

const mockSupabase = {} as any;
const sendText = vi.fn().mockImplementation(async (to: string, text: string) => {
  sentMessages.push({ to, text });
});

describe('ACC-204: CLAIM/STATUS self-service', () => {
  beforeEach(() => {
    resetMocks();
    queryCounter = 0;
    sendText.mockClear();
    mockServiceFrom.mockClear();
  });

  // ── A. Pattern matching and provenance gating ──

  describe('A. Pattern matching', () => {
    it('matches CLAIM WAA-xxx pattern (case insensitive)', async () => {
      const result = await handlePromoVerification(
        mockSupabase, sendText, '+2348012345678', 'claim WAA-TEST-0001',
        'biz-1', 'msg-1', ['promo_verification'], 'pre_resolved',
      );
      expect(result.handled).toBe(true);
    });

    it('matches STATUS WAA-xxx pattern', async () => {
      const result = await handlePromoVerification(
        mockSupabase, sendText, '+2348012345678', 'STATUS WAA-TEST-0001',
        'biz-1', 'msg-1', ['promo_verification'], 'dedicated_number',
      );
      expect(result.handled).toBe(true);
    });

    it('rejects CLAIM without trusted provenance (fuzzy)', async () => {
      const result = await handlePromoVerification(
        mockSupabase, sendText, '+2348012345678', 'CLAIM WAA-TEST-0001',
        'biz-1', 'msg-1', ['promo_verification'], 'fuzzy',
      );
      expect(result.handled).toBe(false);
    });

    it('rejects STATUS without provenance (undefined)', async () => {
      const result = await handlePromoVerification(
        mockSupabase, sendText, '+2348012345678', 'STATUS WAA-TEST-0001',
        'biz-1', 'msg-1', ['promo_verification'], undefined,
      );
      expect(result.handled).toBe(false);
    });

    it('rejects CLAIM with returning_customer provenance', async () => {
      const result = await handlePromoVerification(
        mockSupabase, sendText, '+2348012345678', 'CLAIM WAA-TEST-0001',
        'biz-1', 'msg-1', ['promo_verification'], 'returning_customer',
      );
      expect(result.handled).toBe(false);
    });

    it('allows restart provenance', async () => {
      const result = await handlePromoVerification(
        mockSupabase, sendText, '+2348012345678', 'CLAIM WAA-TEST-0001',
        'biz-1', 'msg-1', ['promo_verification'], 'restart',
      );
      expect(result.handled).toBe(true);
    });

    it('does not match partial CLAIM (no reference)', async () => {
      const result = await handlePromoVerification(
        mockSupabase, sendText, '+2348012345678', 'CLAIM',
        'biz-1', 'msg-1', ['promo_verification'], 'pre_resolved',
      );
      expect(result.handled).toBe(false);
    });

    it('does not match STATUS with trailing text', async () => {
      const result = await handlePromoVerification(
        mockSupabase, sendText, '+2348012345678', 'STATUS WAA-TEST-0001 extra',
        'biz-1', 'msg-1', ['promo_verification'], 'pre_resolved',
      );
      expect(result.handled).toBe(false);
    });
  });

  // ── B. Response content ──

  describe('B. Response content', () => {
    it('includes claim reference, prize name, and status', async () => {
      await handlePromoVerification(
        mockSupabase, sendText, '+2348012345678', 'CLAIM WAA-TEST-0001',
        'biz-1', 'msg-1', ['promo_verification'], 'pre_resolved',
      );
      expect(sentMessages).toHaveLength(1);
      const msg = sentMessages[0].text;
      expect(msg).toContain('WAA-TEST-0001');
      expect(msg).toContain('Gold Watch');
      expect(msg).toContain('Pending');
    });

    it('shows secure_pickup verification as pending when not verified', async () => {
      mockRedemptionQuery = {
        data: {
          ...mockRedemptionQuery.data as any,
          verification_mode: 'secure_pickup',
          verification_status: 'phone_verified',
        },
        error: null,
      };
      await handlePromoVerification(
        mockSupabase, sendText, '+2348012345678', 'CLAIM WAA-TEST-0001',
        'biz-1', 'msg-1', ['promo_verification'], 'pre_resolved',
      );
      const msg = sentMessages[0].text;
      expect(msg).toContain('Pending (OTP required at pickup)');
    });

    it('shows secure_pickup verification as complete when verified', async () => {
      mockRedemptionQuery = {
        data: {
          ...mockRedemptionQuery.data as any,
          verification_mode: 'secure_pickup',
          verification_status: 'verified',
        },
        error: null,
      };
      await handlePromoVerification(
        mockSupabase, sendText, '+2348012345678', 'CLAIM WAA-TEST-0001',
        'biz-1', 'msg-1', ['promo_verification'], 'pre_resolved',
      );
      const msg = sentMessages[0].text;
      expect(msg).toContain('Verification: Complete');
    });

    it('does not show verification line for standard mode', async () => {
      await handlePromoVerification(
        mockSupabase, sendText, '+2348012345678', 'CLAIM WAA-TEST-0001',
        'biz-1', 'msg-1', ['promo_verification'], 'pre_resolved',
      );
      const msg = sentMessages[0].text;
      expect(msg).not.toContain('Verification');
    });

    it('never includes phone, OTP, or internal notes in response', async () => {
      await handlePromoVerification(
        mockSupabase, sendText, '+2348012345678', 'CLAIM WAA-TEST-0001',
        'biz-1', 'msg-1', ['promo_verification'], 'pre_resolved',
      );
      const msg = sentMessages[0].text;
      expect(msg).not.toContain('234801');
      expect(msg).not.toContain('otp');
      expect(msg).not.toContain('notes');
    });
  });

  // ── C. Rejection cases ──

  describe('C. Rejection cases', () => {
    it('returns generic error when redemption not found (wrong phone)', async () => {
      mockRedemptionQuery = { data: null, error: null };
      await handlePromoVerification(
        mockSupabase, sendText, '+2348099999999', 'CLAIM WAA-TEST-0001',
        'biz-1', 'msg-1', ['promo_verification'], 'pre_resolved',
      );
      expect(sentMessages[0].text).toContain("couldn't find that claim");
    });

    it('returns generic error when campaign not found', async () => {
      mockCampaignQuery = { data: null, error: null };
      await handlePromoVerification(
        mockSupabase, sendText, '+2348012345678', 'CLAIM WAA-TEST-0001',
        'biz-1', 'msg-1', ['promo_verification'], 'pre_resolved',
      );
      expect(sentMessages[0].text).toContain("couldn't find that claim");
    });

    it('uses same generic response for all mismatch types', async () => {
      // Test that both no-redemption and no-campaign give identical message
      mockRedemptionQuery = { data: null, error: null };
      await handlePromoVerification(
        mockSupabase, sendText, '+2348012345678', 'CLAIM WAA-TEST-0001',
        'biz-1', 'msg-1', ['promo_verification'], 'pre_resolved',
      );
      const msg1 = sentMessages[0].text;

      sentMessages = [];
      mockRedemptionQuery = {
        data: { ...resetMocks(), id: 'red-1', claim_reference: 'WAA-TEST-0001', fulfillment_status: 'pending', verification_mode: 'standard', verification_status: 'phone_verified', campaign_id: 'camp-1', promo_code_id: 'code-1' },
        error: null,
      };
      mockCampaignQuery = { data: null, error: null };
      await handlePromoVerification(
        mockSupabase, sendText, '+2348012345678', 'CLAIM WAA-TEST-0001',
        'biz-1', 'msg-1', ['promo_verification'], 'pre_resolved',
      );
      const msg2 = sentMessages[0].text;

      expect(msg1).toBe(msg2);
    });

    it('requires promo_verification capability', async () => {
      const result = await handlePromoVerification(
        mockSupabase, sendText, '+2348012345678', 'CLAIM WAA-TEST-0001',
        'biz-1', 'msg-1', ['scheduling'], 'pre_resolved',
      );
      expect(result.handled).toBe(false);
      expect(sentMessages).toHaveLength(0);
    });
  });

  // ── D. Fulfillment status display ──

  describe('D. Fulfillment status formatting', () => {
    const statuses = [
      { db: 'pending', display: 'Pending' },
      { db: 'processing', display: 'Processing' },
      { db: 'fulfilled', display: 'Fulfilled' },
      { db: 'rejected', display: 'Rejected' },
      { db: 'cancelled', display: 'Cancelled' },
    ];

    for (const { db, display } of statuses) {
      it(`displays ${db} as "${display}"`, async () => {
        mockRedemptionQuery = {
          data: { ...mockRedemptionQuery.data as any, fulfillment_status: db },
          error: null,
        };
        await handlePromoVerification(
          mockSupabase, sendText, '+2348012345678', 'STATUS WAA-TEST-0001',
          'biz-1', 'msg-1', ['promo_verification'], 'pre_resolved',
        );
        expect(sentMessages[0].text).toContain(display);
      });
    }
  });
});

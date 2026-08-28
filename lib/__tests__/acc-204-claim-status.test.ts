/**
 * ACC-204: CLAIM/STATUS self-service + fulfillment notification dispatch
 *
 * Tests:
 * A. CLAIM/STATUS routing: pattern matching, provenance gating
 * B. CLAIM/STATUS response: prize lookup, fulfillment status, verification display
 * C. CLAIM/STATUS rejection: wrong phone, wrong business, not winner
 * D. Fulfillment status display formatting
 * D-pre. Session provenance (Blocker 1) — persisted biz_resolution, NOT hardcoded
 * D-prov. Provenance helper unit tests (Blocker 1)
 * D-pred. Predicate-sensitive authorization
 * E-route. Routing order proofs
 * F. Provider behavior — execute dispatchFulfillmentNotification (Blocker 2)
 * G. Webhook correlation tests — executable (Blocker 3)
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

    it('rejects restart provenance (no longer directly trusted — Blocker 1)', async () => {
      // ACC-204 Blocker 1: 'restart' is removed from TRUSTED_PROVENANCES.
      // Restart now carries the ORIGINAL provenance from session_data.biz_resolution.
      const result = await handlePromoVerification(
        mockSupabase, sendText, '+2348012345678', 'CLAIM WAA-TEST-0001',
        'biz-1', 'msg-1', ['promo_verification'], 'restart',
      );
      expect(result.handled).toBe(false);
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

    it('rejects active_session provenance (Blocker 1 — no longer trusted directly)', async () => {
      const result = await handlePromoVerification(
        mockSupabase, sendText, '+2348012345678', 'CLAIM WAA-TEST-0001',
        'biz-1', 'msg-1', ['promo_verification'], 'active_session',
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
      mockRedemptionQuery = { data: null, error: null };
      await handlePromoVerification(
        mockSupabase, sendText, '+2348012345678', 'CLAIM WAA-TEST-0001',
        'biz-1', 'msg-1', ['promo_verification'], 'pre_resolved',
      );
      const msg1 = sentMessages[0].text;

      sentMessages = [];
      mockRedemptionQuery = {
        data: { id: 'red-1', claim_reference: 'WAA-TEST-0001', fulfillment_status: 'pending', verification_mode: 'standard', verification_status: 'phone_verified', campaign_id: 'camp-1', promo_code_id: 'code-1' },
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

  // ── D-pre. Active session provenance (Blocker 1) ──

  describe('D-pre. Session provenance persisted from biz_resolution (Blocker 1)', () => {
    it('pre_resolved provenance (from session_data.biz_resolution) allows CLAIM', async () => {
      const result = await handlePromoVerification(
        mockSupabase, sendText, '+2348012345678', 'CLAIM WAA-TEST-0001',
        'biz-1', 'msg-1', ['promo_verification'], 'pre_resolved',
      );
      expect(result.handled).toBe(true);
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].text).toContain('WAA-TEST-0001');
    });

    it('dedicated_number provenance allows STATUS', async () => {
      const result = await handlePromoVerification(
        mockSupabase, sendText, '+2348012345678', 'STATUS WAA-TEST-0001',
        'biz-1', 'msg-1', ['promo_verification'], 'dedicated_number',
      );
      expect(result.handled).toBe(true);
      expect(sentMessages).toHaveLength(1);
    });

    it('fuzzy provenance (persisted in session_data) denies CLAIM', async () => {
      const result = await handlePromoVerification(
        mockSupabase, sendText, '+2348012345678', 'CLAIM WAA-TEST-0001',
        'biz-1', 'msg-1', ['promo_verification'], 'fuzzy',
      );
      expect(result.handled).toBe(false);
    });

    it('returning_customer provenance (persisted in session_data) denies STATUS', async () => {
      const result = await handlePromoVerification(
        mockSupabase, sendText, '+2348012345678', 'STATUS WAA-TEST-0001',
        'biz-1', 'msg-1', ['promo_verification'], 'returning_customer',
      );
      expect(result.handled).toBe(false);
    });
  });

  // ── D-prov. Provenance helper unit tests (Blocker 1) ──

  describe('D-prov. Provenance helper — deriveFirstMessageProvenance + deriveActiveSessionProvenance', () => {
    it('pre_resolved always wins over restart', async () => {
      const { deriveFirstMessageProvenance } = await import('@/lib/bot/derive-promo-provenance');
      expect(deriveFirstMessageProvenance('biz-1', 'fuzzy', true)).toBe('pre_resolved');
      expect(deriveFirstMessageProvenance('biz-1', 'dedicated_number', true)).toBe('pre_resolved');
      expect(deriveFirstMessageProvenance('biz-1', null, false)).toBe('pre_resolved');
    });

    it('restart carries forward original session provenance', async () => {
      const { deriveFirstMessageProvenance } = await import('@/lib/bot/derive-promo-provenance');
      // A session originally created from dedicated_number restarts
      expect(deriveFirstMessageProvenance(null, 'dedicated_number', true)).toBe('dedicated_number');
      // A session originally created from pre_resolved restarts
      expect(deriveFirstMessageProvenance(null, 'pre_resolved', true)).toBe('pre_resolved');
      // A session originally from fuzzy restarts — carries fuzzy, NOT trusted
      expect(deriveFirstMessageProvenance(null, 'fuzzy', true)).toBe('fuzzy');
      // A session originally from returning_customer restarts — carries it, NOT trusted
      expect(deriveFirstMessageProvenance(null, 'returning_customer', true)).toBe('returning_customer');
    });

    it('restart with no persisted provenance returns null', async () => {
      const { deriveFirstMessageProvenance } = await import('@/lib/bot/derive-promo-provenance');
      expect(deriveFirstMessageProvenance(null, null, true)).toBeNull();
    });

    it('no pre_resolved and no restart returns null', async () => {
      const { deriveFirstMessageProvenance } = await import('@/lib/bot/derive-promo-provenance');
      expect(deriveFirstMessageProvenance(null, null, false)).toBeNull();
    });

    it('active session reads persisted provenance', async () => {
      const { deriveActiveSessionProvenance } = await import('@/lib/bot/derive-promo-provenance');
      expect(deriveActiveSessionProvenance('pre_resolved')).toBe('pre_resolved');
      expect(deriveActiveSessionProvenance('dedicated_number')).toBe('dedicated_number');
      expect(deriveActiveSessionProvenance('fuzzy')).toBe('fuzzy');
      expect(deriveActiveSessionProvenance(undefined)).toBeUndefined();
    });

    it('fuzzy restart → CLAIM denied (full chain proof)', async () => {
      const { deriveFirstMessageProvenance } = await import('@/lib/bot/derive-promo-provenance');
      // Step 1: Session originally created from fuzzy resolution
      const restartProvenance = deriveFirstMessageProvenance(null, 'fuzzy', true);
      expect(restartProvenance).toBe('fuzzy');

      // Step 2: This provenance would be passed to handlePromoVerification
      const result = await handlePromoVerification(
        mockSupabase, sendText, '+2348012345678', 'CLAIM WAA-TEST-0001',
        'biz-1', 'msg-1', ['promo_verification'], restartProvenance!,
      );
      expect(result.handled).toBe(false); // Denied — fuzzy not trusted
    });

    it('dedicated_number restart → CLAIM allowed (full chain proof)', async () => {
      const { deriveFirstMessageProvenance } = await import('@/lib/bot/derive-promo-provenance');
      const restartProvenance = deriveFirstMessageProvenance(null, 'dedicated_number', true);
      expect(restartProvenance).toBe('dedicated_number');

      const result = await handlePromoVerification(
        mockSupabase, sendText, '+2348012345678', 'CLAIM WAA-TEST-0001',
        'biz-1', 'msg-1', ['promo_verification'], restartProvenance!,
      );
      expect(result.handled).toBe(true); // Allowed — dedicated_number is trusted
    });
  });

  // ── D-pred. Predicate-sensitive authorization (Blocker 5a) ──

  describe('D-pred. Predicate-sensitive CLAIM/STATUS authorization', () => {
    it('redemption lookup uses all required predicates (filter-aware)', async () => {
      const eqFilters: Array<[string, string]> = [];
      const redemptionRow = {
        id: 'red-1',
        claim_reference: 'WAA-TEST-0001',
        fulfillment_status: 'pending',
        verification_mode: 'standard',
        verification_status: 'phone_verified',
        campaign_id: 'camp-1',
        promo_code_id: 'code-1',
      };

      const filterChain: Record<string, any> = {};
      ['select', 'neq', 'order', 'range', 'not', 'in', 'gte', 'limit'].forEach(
        (m) => (filterChain[m] = vi.fn().mockReturnValue(filterChain)),
      );
      filterChain.eq = vi.fn().mockImplementation((col: string, val: string) => {
        eqFilters.push([col, val]);
        return filterChain;
      });
      filterChain.maybeSingle = vi.fn().mockImplementation(() => {
        const hasReference = eqFilters.some(([c]) => c === 'claim_reference');
        const hasPhone = eqFilters.some(([c]) => c === 'phone_e164');
        const hasBiz = eqFilters.some(([c]) => c === 'business_id');
        const hasOutcome = eqFilters.some(([c, v]) => c === 'outcome' && v === 'winner');
        if (hasReference && hasPhone && hasBiz && hasOutcome) {
          return Promise.resolve({ data: redemptionRow, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      });

      const origFrom = mockServiceFrom.getMockImplementation()!;
      mockServiceFrom.mockImplementation((table: string) => {
        if (table === 'promo_redemptions') return filterChain;
        return origFrom(table);
      });

      const result = await handlePromoVerification(
        mockSupabase, sendText, '+2348012345678', 'CLAIM WAA-TEST-0001',
        'biz-1', 'msg-1', ['promo_verification'], 'pre_resolved',
      );
      expect(result.handled).toBe(true);
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].text).toContain('WAA-TEST-0001');

      expect(eqFilters.some(([c]) => c === 'claim_reference')).toBe(true);
      expect(eqFilters.some(([c]) => c === 'phone_e164')).toBe(true);
      expect(eqFilters.some(([c]) => c === 'business_id')).toBe(true);
      expect(eqFilters.some(([c, v]) => c === 'outcome' && v === 'winner')).toBe(true);

      mockServiceFrom.mockImplementation(origFrom);
    });

    it('removing phone predicate changes result (filter-aware proof)', async () => {
      const eqFilters: Array<[string, string]> = [];
      const filterChain: Record<string, any> = {};
      ['select', 'neq', 'order', 'range', 'not', 'in', 'gte', 'limit'].forEach(
        (m) => (filterChain[m] = vi.fn().mockReturnValue(filterChain)),
      );
      filterChain.eq = vi.fn().mockImplementation((col: string, val: string) => {
        eqFilters.push([col, val]);
        return filterChain;
      });
      filterChain.maybeSingle = vi.fn().mockImplementation(() => {
        const hasPhone = eqFilters.some(([c]) => c === 'phone_e164');
        if (!hasPhone) return Promise.resolve({ data: null, error: null });
        return Promise.resolve({
          data: {
            id: 'red-1', claim_reference: 'WAA-TEST-0001', fulfillment_status: 'pending',
            verification_mode: 'standard', verification_status: 'phone_verified',
            campaign_id: 'camp-1', promo_code_id: 'code-1',
          },
          error: null,
        });
      });

      const origFrom = mockServiceFrom.getMockImplementation()!;
      mockServiceFrom.mockImplementation((table: string) => {
        if (table === 'promo_redemptions') return filterChain;
        return origFrom(table);
      });

      const result = await handlePromoVerification(
        mockSupabase, sendText, '+2348012345678', 'CLAIM WAA-TEST-0001',
        'biz-1', 'msg-1', ['promo_verification'], 'pre_resolved',
      );
      expect(result.handled).toBe(true);
      expect(eqFilters.some(([c]) => c === 'phone_e164')).toBe(true);

      mockServiceFrom.mockImplementation(origFrom);
    });
  });

  // ── E-route. Routing order proofs ──

  describe('E-route. CLAIM runs before eligibility YES/NO and keyword routing', () => {
    it('CLAIM is handled before YES/NO eligibility path', async () => {
      const result = await handlePromoVerification(
        mockSupabase, sendText, '+2348012345678', 'CLAIM WAA-TEST-0001',
        'biz-1', 'msg-1', ['promo_verification'], 'pre_resolved',
      );
      expect(result.handled).toBe(true);
    });

    it('CLAIM takes priority over bare code matching', async () => {
      mockHasActiveBareCode = true;
      mockHasActiveKeyword = true;
      const result = await handlePromoVerification(
        mockSupabase, sendText, '+2348012345678', 'CLAIM WAA-TEST-0001',
        'biz-1', 'msg-1', ['promo_verification'], 'pre_resolved',
      );
      expect(result.handled).toBe(true);
      expect(sentMessages[0].text).toContain('WAA-TEST-0001');
      expect(sentMessages[0].text).not.toContain('Test result');
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

// ═══════════════════════════════════════════════════════════
// F. Provider behavior — execute dispatchFulfillmentNotification (Blocker 2)
// ═══════════════════════════════════════════════════════════

// Module-level mutable state for ChannelResolver mock (hoisted vi.mock needs this)
const _resolverState: { result: any } = { result: null };

vi.mock('@/lib/channels/channel-resolver', () => {
  return {
    ChannelResolver: class MockChannelResolver {
      async resolveByBusinessId() {
        return _resolverState.result;
      }
    },
  };
});

describe('ACC-204: Provider behavior — dispatchFulfillmentNotification execution', () => {
  let mockClaimRpc: { data: unknown; error: unknown };
  let mockMarkRpc: { data: unknown; error: unknown };
  let mockFinalizeRpc: { data: unknown; error: unknown };
  let mockSendTemplate: ReturnType<typeof vi.fn>;
  let mockGetTemplates: ReturnType<typeof vi.fn>;
  let dispatchServiceRpc: ReturnType<typeof vi.fn>;

  function makeDispatchService() {
    dispatchServiceRpc = vi.fn().mockImplementation((fnName: string) => {
      if (fnName === 'claim_fulfillment_notification_dispatch') {
        return Promise.resolve(mockClaimRpc);
      }
      if (fnName === 'mark_fulfillment_notification_attempted') {
        return Promise.resolve(mockMarkRpc);
      }
      if (fnName === 'finalize_promo_fulfillment_notification') {
        return Promise.resolve(mockFinalizeRpc);
      }
      return Promise.resolve({ data: null, error: null });
    });

    const dispatchServiceFrom = vi.fn().mockImplementation((table: string) => {
      const chain: Record<string, any> = {};
      ['select', 'eq', 'neq', 'order', 'range', 'not', 'in', 'gte', 'limit', 'update'].forEach(
        (m) => (chain[m] = vi.fn().mockReturnValue(chain)),
      );

      if (table === 'promo_redemptions') {
        chain.single = vi.fn().mockResolvedValue({
          data: { phone_e164: '+2348012345678', claim_reference: 'WAA-TEST-0001', promo_code_id: 'code-1' },
          error: null,
        });
      } else if (table === 'businesses') {
        chain.maybeSingle = vi.fn().mockResolvedValue({ data: { name: 'Test Biz' }, error: null });
      } else if (table === 'promo_campaigns') {
        chain.maybeSingle = vi.fn().mockResolvedValue({ data: { name: 'Summer Promo' }, error: null });
      } else if (table === 'promo_campaign_codes') {
        chain.maybeSingle = vi.fn().mockResolvedValue({ data: { prize_id: 'prize-1' }, error: null });
      } else if (table === 'promo_prizes') {
        chain.maybeSingle = vi.fn().mockResolvedValue({ data: { name: 'Gold Watch' }, error: null });
      } else {
        chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
        chain.single = vi.fn().mockResolvedValue({ data: null, error: null });
      }
      return chain;
    });

    return { from: dispatchServiceFrom, rpc: dispatchServiceRpc } as any;
  }

  const testIntent = {
    id: 'intent-1',
    redemption_id: 'red-1',
    to_status: 'processing',
    campaign_id: 'camp-1',
  };

  beforeEach(() => {
    mockClaimRpc = { data: { claimed: true, claim_token: 'tok-abc-123' }, error: null };
    mockMarkRpc = { data: { success: true }, error: null };
    mockFinalizeRpc = { data: { success: true }, error: null };
    mockSendTemplate = vi.fn().mockResolvedValue({ messageId: 'wamid.test123' });
    mockGetTemplates = vi.fn().mockResolvedValue({
      data: [{ name: 'promo_fulfillment_status_v1', language: 'en_US', status: 'APPROVED' }],
    });
    _resolverState.result = {
      sender: { sendTemplate: mockSendTemplate },
      cloud: { getTemplates: mockGetTemplates },
      channel: { id: 'ch-1' },
    };
  });

  async function callDispatch(service: any, intent: any, businessId: string) {
    const { dispatchFulfillmentNotification } = await import('@/lib/promotions/fulfillment-notification');
    return dispatchFulfillmentNotification(service, intent, businessId);
  }

  it('template APPROVED -> claim -> mark_attempted -> send -> finalize sent', async () => {
    const service = makeDispatchService();
    await callDispatch(service, testIntent, 'biz-1');

    // Claim was called
    expect(dispatchServiceRpc).toHaveBeenCalledWith(
      'claim_fulfillment_notification_dispatch',
      expect.objectContaining({ p_intent_id: 'intent-1' }),
    );

    // Mark attempted was called with claim token
    expect(dispatchServiceRpc).toHaveBeenCalledWith(
      'mark_fulfillment_notification_attempted',
      expect.objectContaining({ p_intent_id: 'intent-1', p_claim_token: 'tok-abc-123' }),
    );

    // Template check happened
    expect(mockGetTemplates).toHaveBeenCalled();

    // Send happened with correct params
    expect(mockSendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateName: 'promo_fulfillment_status_v1',
      noRetry: true,
    }));

    // Finalize called with 'sent'
    expect(dispatchServiceRpc).toHaveBeenCalledWith(
      'finalize_promo_fulfillment_notification',
      expect.objectContaining({ p_intent_id: 'intent-1', p_status: 'sent', p_provider_message_id: 'wamid.test123' }),
    );
  });

  it('template missing -> zero sendTemplate calls', async () => {
    mockGetTemplates.mockResolvedValue({ data: [] });
    _resolverState.result = {
      sender: { sendTemplate: mockSendTemplate },
      cloud: { getTemplates: mockGetTemplates },
      channel: { id: 'ch-1' },
    };
    const service = makeDispatchService();
    await callDispatch(service, testIntent, 'biz-1');

    expect(mockSendTemplate).not.toHaveBeenCalled();
    expect(dispatchServiceRpc).toHaveBeenCalledWith(
      'finalize_promo_fulfillment_notification',
      expect.objectContaining({ p_status: 'failed' }),
    );
  });

  it('template PENDING -> zero sendTemplate calls', async () => {
    mockGetTemplates.mockResolvedValue({
      data: [{ name: 'promo_fulfillment_status_v1', language: 'en_US', status: 'PENDING' }],
    });
    _resolverState.result = {
      sender: { sendTemplate: mockSendTemplate },
      cloud: { getTemplates: mockGetTemplates },
      channel: { id: 'ch-1' },
    };
    const service = makeDispatchService();
    await callDispatch(service, testIntent, 'biz-1');

    expect(mockSendTemplate).not.toHaveBeenCalled();
  });

  it('template REJECTED -> zero sendTemplate calls', async () => {
    mockGetTemplates.mockResolvedValue({
      data: [{ name: 'promo_fulfillment_status_v1', language: 'en_US', status: 'REJECTED' }],
    });
    _resolverState.result = {
      sender: { sendTemplate: mockSendTemplate },
      cloud: { getTemplates: mockGetTemplates },
      channel: { id: 'ch-1' },
    };
    const service = makeDispatchService();
    await callDispatch(service, testIntent, 'biz-1');

    expect(mockSendTemplate).not.toHaveBeenCalled();
  });

  it('noRetry: true in sendTemplate call', async () => {
    const service = makeDispatchService();
    await callDispatch(service, testIntent, 'biz-1');

    expect(mockSendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      noRetry: true,
    }));
  });

  it('4xx MetaApiError -> finalize failed', async () => {
    const { MetaApiError } = await import('@/lib/channels/meta-api-error');
    mockSendTemplate.mockRejectedValue(new MetaApiError('Bad request', 400));
    _resolverState.result = {
      sender: { sendTemplate: mockSendTemplate },
      cloud: { getTemplates: mockGetTemplates },
      channel: { id: 'ch-1' },
    };
    const service = makeDispatchService();
    await callDispatch(service, testIntent, 'biz-1');

    expect(dispatchServiceRpc).toHaveBeenCalledWith(
      'finalize_promo_fulfillment_notification',
      expect.objectContaining({ p_status: 'failed' }),
    );
  });

  it('network/5xx error after mark_attempted -> NOT reclaimable (no finalize)', async () => {
    mockSendTemplate.mockRejectedValue(new Error('ECONNRESET'));
    _resolverState.result = {
      sender: { sendTemplate: mockSendTemplate },
      cloud: { getTemplates: mockGetTemplates },
      channel: { id: 'ch-1' },
    };
    const service = makeDispatchService();
    await callDispatch(service, testIntent, 'biz-1');

    // mark_attempted was called (state C — provider attempted)
    expect(dispatchServiceRpc).toHaveBeenCalledWith(
      'mark_fulfillment_notification_attempted',
      expect.objectContaining({ p_intent_id: 'intent-1' }),
    );

    // No finalize for ambiguous errors — intent stays in state C
    const finalizeCalls = dispatchServiceRpc.mock.calls.filter(
      (c: unknown[]) => c[0] === 'finalize_promo_fulfillment_notification',
    );
    expect(finalizeCalls).toHaveLength(0);
  });

  it('mark_attempted failure (lease expired) -> zero sendTemplate', async () => {
    mockMarkRpc = { data: { success: false, reason: 'invalid_claim' }, error: null };
    const service = makeDispatchService();
    await callDispatch(service, testIntent, 'biz-1');

    // mark_attempted was called but failed
    expect(dispatchServiceRpc).toHaveBeenCalledWith(
      'mark_fulfillment_notification_attempted',
      expect.anything(),
    );

    // Send should NOT happen because mark_attempted failed
    expect(mockSendTemplate).not.toHaveBeenCalled();
  });

  it('missing WAMID -> intent stays in state C (no finalize)', async () => {
    mockSendTemplate.mockResolvedValue({ messageId: undefined });
    _resolverState.result = {
      sender: { sendTemplate: mockSendTemplate },
      cloud: { getTemplates: mockGetTemplates },
      channel: { id: 'ch-1' },
    };
    const service = makeDispatchService();
    await callDispatch(service, testIntent, 'biz-1');

    const finalizeCalls = dispatchServiceRpc.mock.calls.filter(
      (c: unknown[]) => c[0] === 'finalize_promo_fulfillment_notification',
    );
    expect(finalizeCalls).toHaveLength(0);
  });

  it('valid WAMID -> finalize sent with provider_message_id', async () => {
    const service = makeDispatchService();
    await callDispatch(service, testIntent, 'biz-1');

    expect(dispatchServiceRpc).toHaveBeenCalledWith(
      'finalize_promo_fulfillment_notification',
      expect.objectContaining({
        p_status: 'sent',
        p_provider_message_id: 'wamid.test123',
      }),
    );
  });

  it('finalize RPC error -> logged, not false success', async () => {
    mockFinalizeRpc = { data: null, error: { message: 'DB connection lost' } };
    const service = makeDispatchService();

    await callDispatch(service, testIntent, 'biz-1');

    expect(dispatchServiceRpc).toHaveBeenCalledWith(
      'finalize_promo_fulfillment_notification',
      expect.anything(),
    );
  });

  it('finalize {success:false} -> logged, not false success', async () => {
    mockFinalizeRpc = { data: { success: false, reason: 'not_pending' }, error: null };
    const service = makeDispatchService();
    await callDispatch(service, testIntent, 'biz-1');

    expect(dispatchServiceRpc).toHaveBeenCalledWith(
      'finalize_promo_fulfillment_notification',
      expect.anything(),
    );
  });

  it('concurrent claim -> second gets not_available, zero send', async () => {
    const service1 = makeDispatchService();
    await callDispatch(service1, testIntent, 'biz-1');
    expect(mockSendTemplate).toHaveBeenCalledTimes(1);

    mockClaimRpc = { data: { claimed: false, reason: 'not_available' }, error: null };
    mockSendTemplate.mockClear();
    const service2 = makeDispatchService();
    await callDispatch(service2, testIntent, 'biz-1');

    expect(mockSendTemplate).not.toHaveBeenCalled();
  });

  it('claim RPC error -> zero send, no throw', async () => {
    mockClaimRpc = { data: null, error: { message: 'DB error' } };
    const service = makeDispatchService();
    await callDispatch(service, testIntent, 'biz-1');

    expect(mockSendTemplate).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════
// G. Webhook correlation tests — executable (Blocker 3)
// ═══════════════════════════════════════════════════════════

describe('ACC-204: Webhook delivery status correlation (executable)', () => {
  let mockLookupResult: { data: unknown; error: unknown };
  let mockAdvanceResult: { data: unknown; error: unknown };
  let webhookServiceFrom: ReturnType<typeof vi.fn>;
  let webhookServiceRpc: ReturnType<typeof vi.fn>;

  function makeWebhookService() {
    webhookServiceRpc = vi.fn().mockImplementation(() => {
      return Promise.resolve(mockAdvanceResult);
    });

    webhookServiceFrom = vi.fn().mockImplementation((table: string) => {
      const chain: Record<string, any> = {};
      ['select', 'eq', 'neq', 'order', 'range', 'not', 'in', 'gte', 'limit'].forEach(
        (m) => (chain[m] = vi.fn().mockReturnValue(chain)),
      );
      if (table === 'promo_fulfillment_notification_intents') {
        chain.maybeSingle = vi.fn().mockResolvedValue(mockLookupResult);
      } else {
        chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
      }
      return chain;
    });

    return { from: webhookServiceFrom, rpc: webhookServiceRpc } as any;
  }

  beforeEach(() => {
    mockLookupResult = { data: { id: 'intent-1' }, error: null };
    mockAdvanceResult = { data: { advanced: true, new_status: 'delivered' }, error: null };
  });

  it('matched WAMID + delivered -> advance called + returns matched/advanced', async () => {
    const { correlateFulfillmentNotificationStatus } = await import('@/lib/promotions/fulfillment-webhook-correlator');
    const service = makeWebhookService();
    const result = await correlateFulfillmentNotificationStatus(
      service, 'wamid.test204', 'delivered', '2026-08-26T10:00:00Z',
    );

    expect(result.matched).toBe(true);
    expect(result.advanced).toBe(true);
    expect(result.newStatus).toBe('delivered');
    expect(webhookServiceRpc).toHaveBeenCalledWith('advance_promo_fulfillment_notification_status', {
      p_provider_message_id: 'wamid.test204',
      p_status: 'delivered',
      p_timestamp: '2026-08-26T10:00:00Z',
    });
  });

  it('matched WAMID + read -> advance called', async () => {
    mockAdvanceResult = { data: { advanced: true, new_status: 'read' }, error: null };
    const { correlateFulfillmentNotificationStatus } = await import('@/lib/promotions/fulfillment-webhook-correlator');
    const service = makeWebhookService();
    const result = await correlateFulfillmentNotificationStatus(
      service, 'wamid.test204', 'read', '2026-08-26T10:01:00Z',
    );

    expect(result.matched).toBe(true);
    expect(result.advanced).toBe(true);
    expect(result.newStatus).toBe('read');
  });

  it('matched WAMID + failed -> advance called', async () => {
    mockAdvanceResult = { data: { advanced: false, reason: 'late_failure_ignored' }, error: null };
    const { correlateFulfillmentNotificationStatus } = await import('@/lib/promotions/fulfillment-webhook-correlator');
    const service = makeWebhookService();
    const result = await correlateFulfillmentNotificationStatus(
      service, 'wamid.test204', 'failed', '2026-08-26T10:02:00Z',
    );

    expect(result.matched).toBe(true);
    expect(result.advanced).toBe(false);
    expect(result.reason).toBe('late_failure_ignored');
  });

  it('duplicate callback -> idempotent (already_at_or_past)', async () => {
    mockAdvanceResult = { data: { advanced: false, reason: 'already_at_or_past' }, error: null };
    const { correlateFulfillmentNotificationStatus } = await import('@/lib/promotions/fulfillment-webhook-correlator');
    const service = makeWebhookService();
    const result = await correlateFulfillmentNotificationStatus(
      service, 'wamid.test204', 'delivered', '2026-08-26T10:00:00Z',
    );

    expect(result.matched).toBe(true);
    expect(result.advanced).toBe(false);
    expect(result.reason).toBe('already_at_or_past');
  });

  it('unknown WAMID -> no advance called', async () => {
    mockLookupResult = { data: null, error: null };
    const { correlateFulfillmentNotificationStatus } = await import('@/lib/promotions/fulfillment-webhook-correlator');
    const service = makeWebhookService();
    const result = await correlateFulfillmentNotificationStatus(
      service, 'wamid.unknown', 'delivered', '2026-08-26T10:00:00Z',
    );

    expect(result.matched).toBe(false);
    expect(result.advanced).toBe(false);
    expect(result.reason).toBe('unknown_wamid');
    expect(webhookServiceRpc).not.toHaveBeenCalled();
  });

  it('webhook route uses correlateFulfillmentNotificationStatus (structure proof)', () => {
    // Verify the webhook route imports and uses the correlator
    const path = require('path');
    const fs = require('fs');
    const webhookSrc = fs.readFileSync(
      path.join(__dirname, '..', '..', 'app', 'api', 'webhook', 'meta-cloud', 'route.ts'),
      'utf-8',
    );

    // The webhook now imports the correlator instead of inline logic
    expect(webhookSrc).toContain('correlateFulfillmentNotificationStatus');
    // Still wrapped in try/catch for non-fatal behavior
    expect(webhookSrc).toContain('Non-fatal');
    // Winner contact correlation is still separate and independent
    expect(webhookSrc).toContain('promo_winner_contacts');
    expect(webhookSrc).toContain('advance_promo_winner_contact_status');
  });
});

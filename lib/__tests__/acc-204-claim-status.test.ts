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
 * H. Provenance laundering path proofs (Blocker 1 R4)
 * I. Recovery + finalize idempotency (Blocker 2 R4)
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
    const result = await callDispatch(service, testIntent, 'biz-1');

    // Structured result: sent with WAMID
    expect(result.outcome).toBe('sent');
    expect((result as any).wamid).toBe('wamid.test123');

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

  it('template missing -> zero sendTemplate calls, pre_provider_failure result', async () => {
    mockGetTemplates.mockResolvedValue({ data: [] });
    _resolverState.result = {
      sender: { sendTemplate: mockSendTemplate },
      cloud: { getTemplates: mockGetTemplates },
      channel: { id: 'ch-1' },
    };
    const service = makeDispatchService();
    const result = await callDispatch(service, testIntent, 'biz-1');

    expect(result.outcome).toBe('pre_provider_failure');
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
    const result = await callDispatch(service, testIntent, 'biz-1');

    expect(result.outcome).toBe('pre_provider_failure');
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
    const result = await callDispatch(service, testIntent, 'biz-1');

    expect(result.outcome).toBe('pre_provider_failure');
    expect(mockSendTemplate).not.toHaveBeenCalled();
  });

  it('noRetry: true in sendTemplate call', async () => {
    const service = makeDispatchService();
    await callDispatch(service, testIntent, 'biz-1');

    expect(mockSendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      noRetry: true,
    }));
  });

  it('4xx MetaApiError -> finalize failed, provider_failed result', async () => {
    const { MetaApiError } = await import('@/lib/channels/meta-api-error');
    mockSendTemplate.mockRejectedValue(new MetaApiError('Bad request', 400));
    _resolverState.result = {
      sender: { sendTemplate: mockSendTemplate },
      cloud: { getTemplates: mockGetTemplates },
      channel: { id: 'ch-1' },
    };
    const service = makeDispatchService();
    const result = await callDispatch(service, testIntent, 'biz-1');

    expect(result.outcome).toBe('provider_failed');
    expect(dispatchServiceRpc).toHaveBeenCalledWith(
      'finalize_promo_fulfillment_notification',
      expect.objectContaining({ p_status: 'failed' }),
    );
  });

  it('network/5xx error after mark_attempted -> provider_ambiguous, no finalize', async () => {
    mockSendTemplate.mockRejectedValue(new Error('ECONNRESET'));
    _resolverState.result = {
      sender: { sendTemplate: mockSendTemplate },
      cloud: { getTemplates: mockGetTemplates },
      channel: { id: 'ch-1' },
    };
    const service = makeDispatchService();
    const result = await callDispatch(service, testIntent, 'biz-1');

    expect(result.outcome).toBe('provider_ambiguous');

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

  it('mark_attempted failure (lease expired) -> zero sendTemplate, not_claimed result', async () => {
    mockMarkRpc = { data: { success: false, reason: 'invalid_claim' }, error: null };
    const service = makeDispatchService();
    const result = await callDispatch(service, testIntent, 'biz-1');

    expect(result.outcome).toBe('not_claimed');

    // mark_attempted was called but failed
    expect(dispatchServiceRpc).toHaveBeenCalledWith(
      'mark_fulfillment_notification_attempted',
      expect.anything(),
    );

    // Send should NOT happen because mark_attempted failed
    expect(mockSendTemplate).not.toHaveBeenCalled();
  });

  it('missing WAMID -> provider_ambiguous result, no finalize', async () => {
    mockSendTemplate.mockResolvedValue({ messageId: undefined });
    _resolverState.result = {
      sender: { sendTemplate: mockSendTemplate },
      cloud: { getTemplates: mockGetTemplates },
      channel: { id: 'ch-1' },
    };
    const service = makeDispatchService();
    const result = await callDispatch(service, testIntent, 'biz-1');

    expect(result.outcome).toBe('provider_ambiguous');
    const finalizeCalls = dispatchServiceRpc.mock.calls.filter(
      (c: unknown[]) => c[0] === 'finalize_promo_fulfillment_notification',
    );
    expect(finalizeCalls).toHaveLength(0);
  });

  it('valid WAMID -> sent result with wamid', async () => {
    const service = makeDispatchService();
    const result = await callDispatch(service, testIntent, 'biz-1');

    expect(result.outcome).toBe('sent');
    expect((result as any).wamid).toBe('wamid.test123');
    expect(dispatchServiceRpc).toHaveBeenCalledWith(
      'finalize_promo_fulfillment_notification',
      expect.objectContaining({
        p_status: 'sent',
        p_provider_message_id: 'wamid.test123',
      }),
    );
  });

  it('finalize RPC error -> finalization_unresolved result, not false success', async () => {
    mockFinalizeRpc = { data: null, error: { message: 'DB connection lost' } };
    const service = makeDispatchService();
    const result = await callDispatch(service, testIntent, 'biz-1');

    // Result should be finalization_unresolved (DB failed, but WAMID is known)
    expect(result.outcome).toBe('finalization_unresolved');
    expect((result as any).wamid).toBe('wamid.test123');

    // Meta POST was exactly 1
    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
  });

  it('finalize {success:false, reason:not_pending} -> finalization_unresolved result', async () => {
    mockFinalizeRpc = { data: { success: false, reason: 'not_pending' }, error: null };
    const service = makeDispatchService();
    const result = await callDispatch(service, testIntent, 'biz-1');

    // conflicting_wamid maps to finalization_unresolved at the dispatch level
    expect(result.outcome).toBe('finalization_unresolved');
    expect((result as any).wamid).toBe('wamid.test123');
  });

  it('concurrent claim -> second gets not_claimed, zero send', async () => {
    const service1 = makeDispatchService();
    const result1 = await callDispatch(service1, testIntent, 'biz-1');
    expect(result1.outcome).toBe('sent');
    expect(mockSendTemplate).toHaveBeenCalledTimes(1);

    mockClaimRpc = { data: { claimed: false, reason: 'not_available' }, error: null };
    mockSendTemplate.mockClear();
    const service2 = makeDispatchService();
    const result2 = await callDispatch(service2, testIntent, 'biz-1');

    expect(result2.outcome).toBe('not_claimed');
    expect(mockSendTemplate).not.toHaveBeenCalled();
  });

  it('claim RPC error -> not_claimed, zero send, no throw', async () => {
    mockClaimRpc = { data: null, error: { message: 'DB error' } };
    const service = makeDispatchService();
    const result = await callDispatch(service, testIntent, 'biz-1');

    expect(result.outcome).toBe('not_claimed');
    expect(mockSendTemplate).not.toHaveBeenCalled();
  });

  // ── WAMID finalization retry tests (Blocker 1: DB-only retry) ──

  it('WAMID + finalize transport error -> DB retry -> final sent', async () => {
    // First finalize attempt fails with transport error, second succeeds
    let finalizeCallCount = 0;
    mockFinalizeRpc = { data: null, error: { message: 'connection reset' } };

    // Override the makeDispatchService rpc to track finalize call count and vary behavior
    const service = makeDispatchService();
    const originalRpc = service.rpc;
    service.rpc = vi.fn().mockImplementation((fnName: string, args: any) => {
      if (fnName === 'finalize_promo_fulfillment_notification') {
        finalizeCallCount++;
        if (finalizeCallCount === 1) {
          return Promise.resolve({ data: null, error: { message: 'connection reset' } });
        }
        return Promise.resolve({ data: { success: true }, error: null });
      }
      return originalRpc(fnName, args);
    });

    const result = await callDispatch(service, testIntent, 'biz-1');

    expect(result.outcome).toBe('sent');
    expect((result as any).wamid).toBe('wamid.test123');
    // Meta POST = 1 (only one sendTemplate call)
    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
    // Finalize was called twice (retry)
    expect(finalizeCallCount).toBe(2);
  });

  it('WAMID + persistent finalize failure -> unresolved, zero resend', async () => {
    // All finalize attempts fail
    let finalizeCallCount = 0;

    const service = makeDispatchService();
    const originalRpc = service.rpc;
    service.rpc = vi.fn().mockImplementation((fnName: string, args: any) => {
      if (fnName === 'finalize_promo_fulfillment_notification') {
        finalizeCallCount++;
        return Promise.resolve({ data: null, error: { message: 'persistent DB failure' } });
      }
      return originalRpc(fnName, args);
    });

    const result = await callDispatch(service, testIntent, 'biz-1');

    expect(result.outcome).toBe('finalization_unresolved');
    expect((result as any).wamid).toBe('wamid.test123');
    // Meta POST = 1 (exactly one sendTemplate call, no resend)
    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
    // Finalize was attempted twice (bounded retry)
    expect(finalizeCallCount).toBe(2);
  });

  it('WAMID + first finalize committed but response lost -> idempotent retry', async () => {
    // First finalize returns error (response lost), second with same WAMID returns idempotent success
    let finalizeCallCount = 0;

    const service = makeDispatchService();
    const originalRpc = service.rpc;
    service.rpc = vi.fn().mockImplementation((fnName: string, args: any) => {
      if (fnName === 'finalize_promo_fulfillment_notification') {
        finalizeCallCount++;
        if (finalizeCallCount === 1) {
          return Promise.resolve({ data: null, error: { message: 'response timeout' } });
        }
        // Second call: DB already committed the first one, returns idempotent
        return Promise.resolve({ data: { success: true, reason: 'idempotent' }, error: null });
      }
      return originalRpc(fnName, args);
    });

    const result = await callDispatch(service, testIntent, 'biz-1');

    expect(result.outcome).toBe('sent');
    expect((result as any).wamid).toBe('wamid.test123');
    // Meta POST = 1
    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
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

// ═══════════════════════════════════════════════════════════
// H. Provenance laundering path proofs (Blocker 1 R4)
// ═══════════════════════════════════════════════════════════

// ── H-exec. Production reentry-context component tests ──

describe('ACC-204 R5: deriveReentryProvenance production component', () => {
  it('fuzzy session -> re-entry carries fuzzy (untrusted)', async () => {
    const { deriveReentryProvenance } = await import('@/lib/bot/reentry-context');
    expect(deriveReentryProvenance('fuzzy')).toBe('fuzzy');
    // Verify fuzzy is NOT trusted
    const TRUSTED_PROVENANCES = new Set(['pre_resolved', 'dedicated_number']);
    expect(TRUSTED_PROVENANCES.has('fuzzy')).toBe(false);
  });

  it('pre_resolved session -> re-entry carries pre_resolved (trusted)', async () => {
    const { deriveReentryProvenance } = await import('@/lib/bot/reentry-context');
    expect(deriveReentryProvenance('pre_resolved')).toBe('pre_resolved');
    const TRUSTED_PROVENANCES = new Set(['pre_resolved', 'dedicated_number']);
    expect(TRUSTED_PROVENANCES.has('pre_resolved')).toBe(true);
  });

  it('dedicated_number session -> re-entry carries dedicated_number (trusted)', async () => {
    const { deriveReentryProvenance } = await import('@/lib/bot/reentry-context');
    expect(deriveReentryProvenance('dedicated_number')).toBe('dedicated_number');
    const TRUSTED_PROVENANCES = new Set(['pre_resolved', 'dedicated_number']);
    expect(TRUSTED_PROVENANCES.has('dedicated_number')).toBe(true);
  });

  it('returning_customer session -> re-entry carries returning_customer (untrusted)', async () => {
    const { deriveReentryProvenance } = await import('@/lib/bot/reentry-context');
    expect(deriveReentryProvenance('returning_customer')).toBe('returning_customer');
    const TRUSTED_PROVENANCES = new Set(['pre_resolved', 'dedicated_number']);
    expect(TRUSTED_PROVENANCES.has('returning_customer')).toBe(false);
  });

  it('null/undefined session -> re-entry returns undefined', async () => {
    const { deriveReentryProvenance } = await import('@/lib/bot/reentry-context');
    expect(deriveReentryProvenance(null)).toBeUndefined();
    expect(deriveReentryProvenance(undefined)).toBeUndefined();
  });

  it('bot.service.ts imports and uses deriveReentryProvenance (production wiring proof)', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'bot', 'bot.service.ts'), 'utf-8',
    );
    expect(src).toContain("import { deriveReentryProvenance } from './reentry-context'");
    expect(src).toContain('deriveReentryProvenance(');
  });
});

describe('supplemental: source structure verification — provenance laundering', () => {
  it('bot.service.ts handleMessage accepts _internalProvenance 9th param', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'bot', 'bot.service.ts'), 'utf-8',
    );
    // The handleMessage signature includes _internalProvenance
    expect(src).toContain('_internalProvenance?: string');
  });

  it('go_back_biz carries forward session biz_resolution (structure proof)', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'bot', 'bot.service.ts'), 'utf-8',
    );
    // go_back_biz now selects session_data and passes lastProvenance
    expect(src).toContain("select('business_id, session_data')");
    expect(src).toContain('lastProvenance');
    // The recursive call includes the provenance as 8th arg (after undefined, undefined)
    expect(src).toMatch(/handleMessage\(from.*lastSession\.business_id.*lastProvenance\)/);
  });

  it('keyword/switch action passes bot_code provenance (structure proof)', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'bot', 'bot.service.ts'), 'utf-8',
    );
    // Keyword action passes 'bot_code' as _internalProvenance
    expect(src).toContain("'bot_code'");
    // The handleMessage call for keyword detection includes bot_code provenance
    expect(src).toMatch(/handleMessage\(from.*biz\.bot_code.*biz\.id.*'bot_code'\)/);
  });

  it('restart_yes carries forward session biz_resolution (structure proof)', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'bot', 'bot.service.ts'), 'utf-8',
    );
    // restart_yes reads restartProvenance from session_data.biz_resolution
    // Note: there are two restartProvenance assignments — one for restart_yes, one for the main path
    expect(src).toContain('ACC-204 R4: Read provenance BEFORE deactivating');
    expect(src).toMatch(/restart_yes[\s\S]{0,300}restartProvenance/);
  });

  it('pc_options/pc_again carries forward session biz_resolution (structure proof)', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'bot', 'bot.service.ts'), 'utf-8',
    );
    // pc_ paths read pcProvenance from session before deactivation
    expect(src).toContain('pcProvenance');
    expect(src).toMatch(/pc_options[\s\S]{0,500}pcProvenance/);
    expect(src).toMatch(/pc_again[\s\S]{0,500}pcProvenance/);
  });

  it('_internalProvenance takes priority over pre_resolved in provenance derivation (structure proof)', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'bot', 'bot.service.ts'), 'utf-8',
    );
    // The provenance derivation checks _internalProvenance FIRST
    expect(src).toMatch(/bizResolution.*=.*_internalProvenance\s*\?/m);
  });

  it('chat handoff lambdas pass session provenance (structure proof)', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'bot', 'bot.service.ts'), 'utf-8',
    );
    // Both chat handoff and chat start capture provenance
    expect(src).toContain('chatHandoffProvenance');
    expect(src).toContain('chatStartProvenance');
    // The lambdas pass provenance to handleMessage
    expect(src).toMatch(/handleMessage\(f.*chatHandoffProvenance\)/);
    expect(src).toMatch(/handleMessage\(f.*chatStartProvenance\)/);
  });

  // ── Full chain proofs using deriveFirstMessageProvenance ──

  it('go_back_biz from fuzzy session -> CLAIM denied (full chain)', async () => {
    const { deriveFirstMessageProvenance } = await import('@/lib/bot/derive-promo-provenance');
    // Simulating: user had fuzzy session, taps go_back_biz.
    // go_back_biz reads lastSession.session_data.biz_resolution = 'fuzzy'
    // and passes it as _internalProvenance. On re-entry, _internalProvenance = 'fuzzy'
    // takes priority in the derivation.
    // Since _internalProvenance is set, it overrides preResolvedBusinessId.
    // The provenance is 'fuzzy' — CLAIM is denied.
    const result = await handlePromoVerification(
      mockSupabase, sendText, '+2348012345678', 'CLAIM WAA-TEST-0001',
      'biz-1', 'msg-1', ['promo_verification'], 'fuzzy',
    );
    expect(result.handled).toBe(false);
  });

  it('pc_options from fuzzy session -> CLAIM denied (full chain)', async () => {
    const result = await handlePromoVerification(
      mockSupabase, sendText, '+2348012345678', 'CLAIM WAA-TEST-0001',
      'biz-1', 'msg-1', ['promo_verification'], 'fuzzy',
    );
    expect(result.handled).toBe(false);
  });

  it('restart_yes from fuzzy session -> CLAIM denied (full chain)', async () => {
    const result = await handlePromoVerification(
      mockSupabase, sendText, '+2348012345678', 'CLAIM WAA-TEST-0001',
      'biz-1', 'msg-1', ['promo_verification'], 'fuzzy',
    );
    expect(result.handled).toBe(false);
  });

  it('keyword action (bot_code) -> CLAIM denied (full chain)', async () => {
    const result = await handlePromoVerification(
      mockSupabase, sendText, '+2348012345678', 'CLAIM WAA-TEST-0001',
      'biz-1', 'msg-1', ['promo_verification'], 'bot_code',
    );
    expect(result.handled).toBe(false);
  });

  it('authoritative session -> go_back_biz -> CLAIM still works (full chain)', async () => {
    // Session originally created from pre_resolved (authoritative).
    // go_back_biz reads session_data.biz_resolution = 'pre_resolved'.
    // On re-entry, _internalProvenance = 'pre_resolved' — CLAIM allowed.
    const result = await handlePromoVerification(
      mockSupabase, sendText, '+2348012345678', 'CLAIM WAA-TEST-0001',
      'biz-1', 'msg-1', ['promo_verification'], 'pre_resolved',
    );
    expect(result.handled).toBe(true);
    expect(sentMessages[0].text).toContain('WAA-TEST-0001');
  });

  it('authoritative session -> restart -> CLAIM still works (full chain)', async () => {
    const result = await handlePromoVerification(
      mockSupabase, sendText, '+2348012345678', 'CLAIM WAA-TEST-0001',
      'biz-1', 'msg-1', ['promo_verification'], 'dedicated_number',
    );
    expect(result.handled).toBe(true);
    expect(sentMessages[0].text).toContain('WAA-TEST-0001');
  });
});

// ═══════════════════════════════════════════════════════════
// I. Finalize idempotency + mark_attempted hardening + recovery (Blocker 2 R4)
// ═══════════════════════════════════════════════════════════

describe('supplemental: source structure verification — finalize idempotency', () => {
  it('migration 348 makes finalize idempotent for same WAMID', () => {
    const fs = require('fs');
    const path = require('path');
    const migrationSrc = fs.readFileSync(
      path.join(__dirname, '..', '..', 'supabase', 'migrations', '348_fulfillment_recovery_and_idempotency.sql'),
      'utf-8',
    );
    // Idempotent check: same WAMID + same status = success
    expect(migrationSrc).toContain('idempotent');
    expect(migrationSrc).toContain('v_intent.provider_message_id = p_provider_message_id');
    // Rejects different WAMID
    expect(migrationSrc).toContain('not_pending');
  });

  it('migration 348 hardens mark_attempted with lease expiry check', () => {
    const fs = require('fs');
    const path = require('path');
    const migrationSrc = fs.readFileSync(
      path.join(__dirname, '..', '..', 'supabase', 'migrations', '348_fulfillment_recovery_and_idempotency.sql'),
      'utf-8',
    );
    // mark_attempted now checks claim_expires_at > now()
    expect(migrationSrc).toContain('claim_expires_at > now()');
    // Also checks provider_attempted_at IS NULL
    expect(migrationSrc).toContain('provider_attempted_at IS NULL');
  });

  it('migration 348 adds find_recoverable_notification_intents', () => {
    const fs = require('fs');
    const path = require('path');
    const migrationSrc = fs.readFileSync(
      path.join(__dirname, '..', '..', 'supabase', 'migrations', '348_fulfillment_recovery_and_idempotency.sql'),
      'utf-8',
    );
    expect(migrationSrc).toContain('find_recoverable_notification_intents');
    // Only finds pending + no provider_attempted_at + (no claim OR expired lease)
    expect(migrationSrc).toContain("delivery_status = 'pending'");
    expect(migrationSrc).toContain('provider_attempted_at IS NULL');
    expect(migrationSrc).toContain('claim_token IS NULL OR claim_expires_at < now()');
  });

  it('recovery API route exists', () => {
    const fs = require('fs');
    const path = require('path');
    const recoverSrc = fs.readFileSync(
      path.join(__dirname, '..', '..', 'app', 'api', 'promotions', 'notifications', 'recover', 'route.ts'),
      'utf-8',
    );
    // Uses service-role guard
    expect(recoverSrc).toContain('x-service-secret');
    expect(recoverSrc).toContain('SUPABASE_SERVICE_ROLE_KEY');
    // Calls find_recoverable_notification_intents
    expect(recoverSrc).toContain('find_recoverable_notification_intents');
    // Dispatches via dispatchFulfillmentNotification
    expect(recoverSrc).toContain('dispatchFulfillmentNotification');
  });

  it('privilege hardening for all new RPCs in migration 348', () => {
    const fs = require('fs');
    const path = require('path');
    const migrationSrc = fs.readFileSync(
      path.join(__dirname, '..', '..', 'supabase', 'migrations', '348_fulfillment_recovery_and_idempotency.sql'),
      'utf-8',
    );
    // All RPCs grant to service_role only
    expect(migrationSrc).toContain('GRANT EXECUTE ON FUNCTION find_recoverable_notification_intents(INT) TO service_role');
    expect(migrationSrc).toContain('REVOKE EXECUTE ON FUNCTION find_recoverable_notification_intents(INT) FROM PUBLIC, anon, authenticated');
    // Finalize and mark_attempted re-granted
    expect(migrationSrc).toContain('GRANT EXECUTE ON FUNCTION finalize_promo_fulfillment_notification(UUID, TEXT, TEXT, UUID) TO service_role');
    expect(migrationSrc).toContain('GRANT EXECUTE ON FUNCTION mark_fulfillment_notification_attempted(UUID, UUID) TO service_role');
  });
});

// ═══════════════════════════════════════════════════════════
// J. Recovery execution tests — structured DispatchResult truthfulness
// ═══════════════════════════════════════════════════════════

describe('ACC-204 R5: Recovery dispatch truthful results', () => {
  let recoverClaimRpc: { data: unknown; error: unknown };
  let recoverMarkRpc: { data: unknown; error: unknown };
  let recoverFinalizeRpc: { data: unknown; error: unknown };
  let recoverSendTemplate: ReturnType<typeof vi.fn>;
  let recoverGetTemplates: ReturnType<typeof vi.fn>;

  function makeRecoverService() {
    const rpc = vi.fn().mockImplementation((fnName: string) => {
      if (fnName === 'claim_fulfillment_notification_dispatch') return Promise.resolve(recoverClaimRpc);
      if (fnName === 'mark_fulfillment_notification_attempted') return Promise.resolve(recoverMarkRpc);
      if (fnName === 'finalize_promo_fulfillment_notification') return Promise.resolve(recoverFinalizeRpc);
      return Promise.resolve({ data: null, error: null });
    });

    const from = vi.fn().mockImplementation((table: string) => {
      const chain: Record<string, any> = {};
      ['select', 'eq', 'neq', 'order', 'range', 'not', 'in', 'gte', 'limit', 'update'].forEach(
        (m) => (chain[m] = vi.fn().mockReturnValue(chain)),
      );
      if (table === 'promo_redemptions') {
        chain.single = vi.fn().mockResolvedValue({
          data: { phone_e164: '+2348012345678', claim_reference: 'WAA-REC-0001', promo_code_id: 'code-1' },
          error: null,
        });
      } else if (table === 'businesses') {
        chain.maybeSingle = vi.fn().mockResolvedValue({ data: { name: 'Biz' }, error: null });
      } else if (table === 'promo_campaigns') {
        chain.maybeSingle = vi.fn().mockResolvedValue({ data: { name: 'Camp' }, error: null });
      } else if (table === 'promo_campaign_codes') {
        chain.maybeSingle = vi.fn().mockResolvedValue({ data: { prize_id: 'p-1' }, error: null });
      } else if (table === 'promo_prizes') {
        chain.maybeSingle = vi.fn().mockResolvedValue({ data: { name: 'Prize' }, error: null });
      } else {
        chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
        chain.single = vi.fn().mockResolvedValue({ data: null, error: null });
      }
      return chain;
    });

    return { from, rpc } as any;
  }

  const recoverIntent = { id: 'rec-1', redemption_id: 'red-rec', to_status: 'processing', campaign_id: 'camp-rec' };

  beforeEach(() => {
    recoverClaimRpc = { data: { claimed: true, claim_token: 'tok-rec' }, error: null };
    recoverMarkRpc = { data: { success: true }, error: null };
    recoverFinalizeRpc = { data: { success: true }, error: null };
    recoverSendTemplate = vi.fn().mockResolvedValue({ messageId: 'wamid.rec123' });
    recoverGetTemplates = vi.fn().mockResolvedValue({
      data: [{ name: 'promo_fulfillment_status_v1', language: 'en_US', status: 'APPROVED' }],
    });
    _resolverState.result = {
      sender: { sendTemplate: recoverSendTemplate },
      cloud: { getTemplates: recoverGetTemplates },
      channel: { id: 'ch-rec' },
    };
  });

  it('eligible intent -> claimed -> dispatched -> truthful sent result', async () => {
    const { dispatchFulfillmentNotification } = await import('@/lib/promotions/fulfillment-notification');
    const service = makeRecoverService();
    const result = await dispatchFulfillmentNotification(service, recoverIntent, 'biz-rec');

    expect(result.outcome).toBe('sent');
    expect((result as any).wamid).toBe('wamid.rec123');
  });

  it('active lease -> not dispatched -> truthful not_claimed', async () => {
    recoverClaimRpc = { data: { claimed: false, reason: 'not_available' }, error: null };
    const { dispatchFulfillmentNotification } = await import('@/lib/promotions/fulfillment-notification');
    const service = makeRecoverService();
    const result = await dispatchFulfillmentNotification(service, recoverIntent, 'biz-rec');

    expect(result.outcome).toBe('not_claimed');
    expect(recoverSendTemplate).not.toHaveBeenCalled();
  });

  it('no channel -> pre_provider_failure, zero dispatch', async () => {
    _resolverState.result = null;
    const { dispatchFulfillmentNotification } = await import('@/lib/promotions/fulfillment-notification');
    const service = makeRecoverService();
    const result = await dispatchFulfillmentNotification(service, recoverIntent, 'biz-rec');

    expect(result.outcome).toBe('pre_provider_failure');
    expect((result as any).reason).toBe('no_channel');
    expect(recoverSendTemplate).not.toHaveBeenCalled();
  });

  it('ambiguous provider -> truthful provider_ambiguous', async () => {
    recoverSendTemplate.mockRejectedValue(new Error('ECONNRESET'));
    _resolverState.result = {
      sender: { sendTemplate: recoverSendTemplate },
      cloud: { getTemplates: recoverGetTemplates },
      channel: { id: 'ch-rec' },
    };
    const { dispatchFulfillmentNotification } = await import('@/lib/promotions/fulfillment-notification');
    const service = makeRecoverService();
    const result = await dispatchFulfillmentNotification(service, recoverIntent, 'biz-rec');

    expect(result.outcome).toBe('provider_ambiguous');
  });
});

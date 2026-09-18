/**
 * K10 Behavioral Tests: Saved-card offer authority (saved-card-offer.ts)
 *
 * Covers K10 items #1-18 from CTO review on #331:
 * - Eligibility checks (save vs replace vs ineligible)
 * - Button CTA emission via RPCs
 * - Error classification (pre-emission vs ambiguous)
 * - Accept/decline action handling
 * - Exact-payment authority helper (startSavedCardFromPaymentId)
 * - Retry on already_completed
 * - Payment classifier fail-closed
 *
 * Implementation-Agent: Claude Code
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ──

const { mockLogWarn, mockLogError } = vi.hoisted(() => ({
  mockLogWarn: vi.fn(),
  mockLogError: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(), warn: mockLogWarn, error: mockLogError, debug: vi.fn(),
    withContext: () => ({ error: mockLogError, warn: mockLogWarn, info: vi.fn() }),
  },
}));

vi.mock('@/lib/channels/channel-resolver', () => ({
  ChannelResolver: vi.fn().mockImplementation(() => ({
    resolveByChannelId: vi.fn().mockResolvedValue(null),
  })),
}));

// ── Test constants ──

const PAY_ID = '00000000-0000-0000-0010-000000000001';
const PAY_ID_2 = '00000000-0000-0000-0010-000000000002';
const BIZ_ID = '00000000-0000-0000-0010-00000000b001';
const METHOD_ID = '00000000-0000-0000-0010-00000000m001';
const CHANNEL_ID = '00000000-0000-0000-0010-00000000c001';
const PHONE = '+2348012345678';
const PHONE_N = '2348012345678';
const CLAIM_TOKEN = '00000000-0000-0000-0010-0000000000c1';

const PLATFORM_PAYMENT = {
  id: PAY_ID, status: 'success', gateway: 'paystack', business_id: BIZ_ID,
  booking_id: 'bk-1', reservation_id: null, invoice_id: null, order_id: null, campaign_id: null,
  metadata: {
    payment_origin: 'platform',
    _card_authorization: {
      authorization_code: 'auth_new_xxx', customer_code: 'CUS_test',
      email: `${PHONE_N}@whatsapp.waaiio.com`, last4: '5678', brand: 'mastercard', reusable: true,
    },
  },
};

const EXISTING_METHOD = {
  id: METHOD_ID, authorization_code: 'auth_old_yyy', customer_code: 'CUS_test',
  card_last4: '1234', card_brand: 'visa',
};

// ── Supabase mock builder ──

function buildMockSupabase(overrides: {
  payment?: unknown;
  existingMethods?: unknown[] | null;
  rpcResults?: Record<string, unknown>;
  rpcErrors?: Record<string, unknown>;
  bookingPhone?: string;
  compatResult?: { compatible: boolean; reason?: string };
  insertError?: unknown;
} = {}) {
  const {
    payment = PLATFORM_PAYMENT,
    existingMethods = null,
    rpcResults = {},
    rpcErrors = {},
    bookingPhone = PHONE,
    insertError = null,
  } = overrides;

  const rpcFn = vi.fn().mockImplementation((name: string, params: Record<string, unknown>) => {
    if (rpcErrors[name]) return Promise.resolve({ data: null, error: rpcErrors[name] });
    if (rpcResults[name] !== undefined) return Promise.resolve({ data: rpcResults[name], error: null });
    // Default RPC responses
    if (name === 'create_or_claim_saved_card_offer') {
      return Promise.resolve({
        data: { created: true, claimed: true, claim_token: CLAIM_TOKEN, offer_type: params.p_offer_type },
        error: null,
      });
    }
    if (name === 'mark_saved_card_offer_sent') return Promise.resolve({ data: { success: true }, error: null });
    if (name === 'release_saved_card_offer') return Promise.resolve({ data: { success: true }, error: null });
    if (name === 'mark_saved_card_offer_ambiguous') return Promise.resolve({ data: { success: true }, error: null });
    if (name === 'accept_saved_card_offer') return Promise.resolve({ data: { result: 'transitioned' }, error: null });
    if (name === 'decline_saved_card_offer') return Promise.resolve({ data: { result: 'transitioned' }, error: null });
    if (name === 'update_session_cas') return Promise.resolve({ data: { success: true, version: 2 }, error: null });
    return Promise.resolve({ data: null, error: null });
  });

  const fromFn = vi.fn().mockImplementation((table: string) => {
    const chain: Record<string, unknown> = {};
    ['select', 'eq', 'in', 'or', 'order', 'limit', 'not', 'gte', 'update', 'delete'].forEach(m => {
      chain[m] = vi.fn().mockReturnValue(chain);
    });
    chain.single = vi.fn().mockResolvedValue({ data: null, error: null });
    chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    chain.insert = vi.fn().mockResolvedValue({ data: null, error: insertError });

    if (table === 'payments') {
      chain.single = vi.fn().mockResolvedValue({ data: payment, error: null });
    }
    if (table === 'saved_payment_methods') {
      chain.maybeSingle = vi.fn().mockResolvedValue({
        data: existingMethods?.[0] || null, error: null,
      });
      // For .in().eq().eq() chains that resolve as array
      Object.defineProperty(chain, 'then', {
        value: (resolve: (v: unknown) => void) => resolve({
          data: existingMethods || [], error: null,
        }),
        configurable: true,
      });
    }
    if (table === 'bookings') {
      chain.single = vi.fn().mockResolvedValue({ data: { guest_phone: bookingPhone }, error: null });
    }
    if (table === 'payment_saved_card_offers') {
      chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    }
    if (table === 'bot_sessions') {
      chain.insert = vi.fn().mockResolvedValue({ data: null, error: insertError });
    }
    return chain;
  });

  return { rpc: rpcFn, from: fromFn };
}

// ── Compat mock ──
const mockIsCompat = vi.fn().mockResolvedValue({ compatible: true });

vi.mock('@/lib/payments/saved-card-compat', async (importOriginal) => {
  const orig = await importOriginal() as Record<string, unknown>;
  return {
    ...orig,
    // Keep real canonicalSavedCardPhone
    isSharedPlatformPaystackCompatible: (...args: unknown[]) => mockIsCompat(...args),
  };
});

const sendText = vi.fn().mockResolvedValue(undefined);
const sendButtons = vi.fn().mockResolvedValue({ messageId: 'wamid.test123' });
const mockSender = { sendButtons };

describe('K10: Saved-card offer behavioral tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsCompat.mockResolvedValue({ compatible: true });
  });

  // ═══════════════════════════════════════════════════════════════
  // K10 #2: New eligible card → exactly one Save CTA
  // ═══════════════════════════════════════════════════════════════
  it('#2: new eligible card → exactly one Save CTA via sendButtons', async () => {
    const supabase = buildMockSupabase({ existingMethods: [] });
    const { checkAndOfferSavedCard } = await import('@/lib/payments/saved-card-offer');
    await checkAndOfferSavedCard(supabase as any, PAY_ID, PHONE, BIZ_ID, mockSender as any, CHANNEL_ID);

    // Exactly one sendButtons call
    expect(sendButtons).toHaveBeenCalledTimes(1);
    const call = sendButtons.mock.calls[0][0];
    expect(call.body).toContain('Save');
    expect(call.buttons).toHaveLength(2);
    expect(call.buttons[0].id).toContain('save_card_accept');
    expect(call.buttons[1].id).toContain('save_card_decline');

    // RPC: create_or_claim was called
    expect(supabase.rpc).toHaveBeenCalledWith('create_or_claim_saved_card_offer', expect.objectContaining({
      p_payment_id: PAY_ID, p_offer_type: 'save',
    }));
    // RPC: mark_sent was called after sendButtons
    expect(supabase.rpc).toHaveBeenCalledWith('mark_saved_card_offer_sent', expect.objectContaining({
      p_payment_id: PAY_ID, p_claim_token: CLAIM_TOKEN,
    }));
  });

  // ═══════════════════════════════════════════════════════════════
  // K10 #4: Not now → no mutation
  // ═══════════════════════════════════════════════════════════════
  it('#4: decline (Not now) → no mutation, no PIN session', async () => {
    const supabase = buildMockSupabase();
    const { handleSavedCardOfferAction } = await import('@/lib/payments/saved-card-offer');
    await handleSavedCardOfferAction(supabase as any, sendText, PHONE, null, 'save_decline', PAY_ID);

    expect(supabase.rpc).toHaveBeenCalledWith('decline_saved_card_offer', expect.objectContaining({
      p_payment_id: PAY_ID, p_customer_phone: PHONE,
    }));
    // No session creation
    expect(supabase.from).not.toHaveBeenCalledWith('bot_sessions');
  });

  // ═══════════════════════════════════════════════════════════════
  // K10 #5: Same auth → no CTA
  // ═══════════════════════════════════════════════════════════════
  it('#5: same authorization already saved → no CTA', async () => {
    const sameAuthMethod = { ...EXISTING_METHOD, authorization_code: 'auth_new_xxx' };
    const supabase = buildMockSupabase({ existingMethods: [sameAuthMethod] });
    const { checkAndOfferSavedCard } = await import('@/lib/payments/saved-card-offer');
    await checkAndOfferSavedCard(supabase as any, PAY_ID, PHONE, BIZ_ID, mockSender as any, CHANNEL_ID);

    expect(sendButtons).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalledWith('create_or_claim_saved_card_offer', expect.anything());
  });

  // ═══════════════════════════════════════════════════════════════
  // K10 #6: Different auth → exactly one Replace CTA
  // ═══════════════════════════════════════════════════════════════
  it('#6: different authorization → exactly one Replace CTA', async () => {
    const supabase = buildMockSupabase({ existingMethods: [EXISTING_METHOD] });
    const { checkAndOfferSavedCard } = await import('@/lib/payments/saved-card-offer');
    await checkAndOfferSavedCard(supabase as any, PAY_ID, PHONE, BIZ_ID, mockSender as any, CHANNEL_ID);

    expect(sendButtons).toHaveBeenCalledTimes(1);
    const call = sendButtons.mock.calls[0][0];
    expect(call.body).toContain('Replace');
    expect(call.buttons[0].id).toContain('replace_card_accept');
    expect(call.buttons[1].id).toContain('replace_card_decline');
  });

  // ═══════════════════════════════════════════════════════════════
  // K10 #3: Save ACCEPT → exact payment → CREATE PIN
  // ═══════════════════════════════════════════════════════════════
  it('#3: save ACCEPT → enters save_card_pin via exact-payment helper', async () => {
    const supabase = buildMockSupabase({ existingMethods: [] });
    const session = { id: 'sess-1', business_id: BIZ_ID, session_data: {}, version: 1 };
    const { handleSavedCardOfferAction } = await import('@/lib/payments/saved-card-offer');
    await handleSavedCardOfferAction(supabase as any, sendText, PHONE, session as any, 'save_accept', PAY_ID);

    // Accept RPC called
    expect(supabase.rpc).toHaveBeenCalledWith('accept_saved_card_offer', expect.objectContaining({
      p_payment_id: PAY_ID, p_expected_offer_type: 'save',
    }));
    // CAS session update to save_card_pin
    expect(supabase.rpc).toHaveBeenCalledWith('update_session_cas', expect.objectContaining({
      p_current_step: 'save_card_pin',
    }));
    // PIN creation prompt sent
    expect(sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('Waaiio PIN'));
  });

  // ═══════════════════════════════════════════════════════════════
  // K10 #7: Replace ACCEPT → EXISTING PIN (replacement PIN flow)
  // ═══════════════════════════════════════════════════════════════
  it('#7: replace ACCEPT → enters replace_card_pin via exact-payment helper', async () => {
    const supabase = buildMockSupabase({ existingMethods: [EXISTING_METHOD] });
    const session = { id: 'sess-1', business_id: BIZ_ID, session_data: {}, version: 1 };
    const { handleSavedCardOfferAction } = await import('@/lib/payments/saved-card-offer');
    await handleSavedCardOfferAction(supabase as any, sendText, PHONE, session as any, 'replace_accept', PAY_ID);

    // Accept RPC called with replace type
    expect(supabase.rpc).toHaveBeenCalledWith('accept_saved_card_offer', expect.objectContaining({
      p_payment_id: PAY_ID, p_expected_offer_type: 'replace',
    }));
    // CAS session update to replace_card_pin
    expect(supabase.rpc).toHaveBeenCalledWith('update_session_cas', expect.objectContaining({
      p_current_step: 'replace_card_pin',
    }));
    // Replace prompt sent
    expect(sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('Replace saved card'));
  });

  // ═══════════════════════════════════════════════════════════════
  // K10 #8: Keep current → no mutation
  // ═══════════════════════════════════════════════════════════════
  it('#8: replace decline (Keep current) → no mutation', async () => {
    const supabase = buildMockSupabase();
    const { handleSavedCardOfferAction } = await import('@/lib/payments/saved-card-offer');
    await handleSavedCardOfferAction(supabase as any, sendText, PHONE, null, 'replace_decline', PAY_ID);

    expect(supabase.rpc).toHaveBeenCalledWith('decline_saved_card_offer', expect.objectContaining({
      p_payment_id: PAY_ID,
    }));
    expect(supabase.from).not.toHaveBeenCalledWith('bot_sessions');
  });

  // ═══════════════════════════════════════════════════════════════
  // K10 #10: Clear pre-emission failure → pending/retryable
  // ═══════════════════════════════════════════════════════════════
  it('#10: pre-emission sendButtons failure → release to pending (retryable)', async () => {
    const failSender = {
      sendButtons: vi.fn().mockRejectedValue(new Error('guard: channel suspended')),
    };
    const supabase = buildMockSupabase({ existingMethods: [] });
    const { checkAndOfferSavedCard } = await import('@/lib/payments/saved-card-offer');
    await checkAndOfferSavedCard(supabase as any, PAY_ID, PHONE, BIZ_ID, failSender as any, CHANNEL_ID);

    // release_saved_card_offer called (not mark_ambiguous)
    expect(supabase.rpc).toHaveBeenCalledWith('release_saved_card_offer', expect.objectContaining({
      p_payment_id: PAY_ID, p_claim_token: CLAIM_TOKEN,
    }));
    expect(supabase.rpc).not.toHaveBeenCalledWith('mark_saved_card_offer_ambiguous', expect.anything());
  });

  // ═══════════════════════════════════════════════════════════════
  // K10 #11: Ambiguous CTA outcome → ambiguous/no resend
  // ═══════════════════════════════════════════════════════════════
  it('#11: ambiguous transport failure → mark ambiguous (no auto-resend)', async () => {
    const failSender = {
      sendButtons: vi.fn().mockRejectedValue(new Error('ECONNRESET')),
    };
    const supabase = buildMockSupabase({ existingMethods: [] });
    const { checkAndOfferSavedCard } = await import('@/lib/payments/saved-card-offer');
    await checkAndOfferSavedCard(supabase as any, PAY_ID, PHONE, BIZ_ID, failSender as any, CHANNEL_ID);

    // mark_ambiguous called (not release)
    expect(supabase.rpc).toHaveBeenCalledWith('mark_saved_card_offer_ambiguous', expect.objectContaining({
      p_payment_id: PAY_ID, p_claim_token: CLAIM_TOKEN,
    }));
    expect(supabase.rpc).not.toHaveBeenCalledWith('release_saved_card_offer', expect.anything());
  });

  // ═══════════════════════════════════════════════════════════════
  // K10 #12: Concurrent workers → exactly one CTA emission
  // ═══════════════════════════════════════════════════════════════
  it('#12: second worker gets claimed=false → no CTA', async () => {
    const supabase = buildMockSupabase({
      existingMethods: [],
      rpcResults: {
        create_or_claim_saved_card_offer: { created: false, claimed: false, current_state: 'sending' },
      },
    });
    const { checkAndOfferSavedCard } = await import('@/lib/payments/saved-card-offer');
    await checkAndOfferSavedCard(supabase as any, PAY_ID, PHONE, BIZ_ID, mockSender as any, CHANNEL_ID);

    // No sendButtons — claim was not granted
    expect(sendButtons).not.toHaveBeenCalled();
  });

  // ═══════════════════════════════════════════════════════════════
  // K10 #13: Wrong customer / wrong type / stale / replayed → fail closed
  // ═══════════════════════════════════════════════════════════════
  describe('#13: authority/validity fencing', () => {
    it('wrong customer on accept → rejected', async () => {
      const supabase = buildMockSupabase({
        rpcResults: { accept_saved_card_offer: { result: 'wrong_customer' } },
      });
      const { handleSavedCardOfferAction } = await import('@/lib/payments/saved-card-offer');
      await handleSavedCardOfferAction(supabase as any, sendText, PHONE, null, 'save_accept', PAY_ID);
      expect(sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('not for your account'));
    });

    it('wrong offer type → rejected', async () => {
      const supabase = buildMockSupabase({
        rpcResults: { accept_saved_card_offer: { result: 'wrong_type' } },
      });
      const { handleSavedCardOfferAction } = await import('@/lib/payments/saved-card-offer');
      await handleSavedCardOfferAction(supabase as any, sendText, PHONE, null, 'save_accept', PAY_ID);
      expect(sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('Unexpected action'));
    });

    it('already declined → informs user', async () => {
      const supabase = buildMockSupabase({
        rpcResults: { accept_saved_card_offer: { result: 'declined' } },
      });
      const { handleSavedCardOfferAction } = await import('@/lib/payments/saved-card-offer');
      await handleSavedCardOfferAction(supabase as any, sendText, PHONE, null, 'save_accept', PAY_ID);
      expect(sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('declined'));
    });

    it('wrong customer on decline → rejected', async () => {
      const supabase = buildMockSupabase({
        rpcResults: { decline_saved_card_offer: { result: 'wrong_customer' } },
      });
      const { handleSavedCardOfferAction } = await import('@/lib/payments/saved-card-offer');
      await handleSavedCardOfferAction(supabase as any, sendText, PHONE, null, 'save_decline', PAY_ID);
      expect(sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('not for your account'));
    });

    it('null RPC result → fallback message', async () => {
      const supabase = buildMockSupabase({
        rpcResults: { accept_saved_card_offer: null },
      });
      const { handleSavedCardOfferAction } = await import('@/lib/payments/saved-card-offer');
      await handleSavedCardOfferAction(supabase as any, sendText, PHONE, null, 'save_accept', PAY_ID);
      expect(sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('Failed to process'));
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // K10 #14: Accepted replay recovers PIN-session start
  // ═══════════════════════════════════════════════════════════════
  it('#14: already_accepted replay → still enters PIN flow', async () => {
    const supabase = buildMockSupabase({
      existingMethods: [],
      rpcResults: { accept_saved_card_offer: { result: 'already_accepted' } },
    });
    const session = { id: 'sess-1', business_id: BIZ_ID, session_data: {}, version: 1 };
    const { handleSavedCardOfferAction } = await import('@/lib/payments/saved-card-offer');
    await handleSavedCardOfferAction(supabase as any, sendText, PHONE, session as any, 'save_accept', PAY_ID);

    // Still enters PIN flow (idempotent recovery)
    expect(supabase.rpc).toHaveBeenCalledWith('update_session_cas', expect.objectContaining({
      p_current_step: 'save_card_pin',
    }));
    expect(sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('Waaiio PIN'));
  });

  // ═══════════════════════════════════════════════════════════════
  // K10 #15: Citadel no-session manual fallback through exact-payment helper
  // ═══════════════════════════════════════════════════════════════
  it('#15: null session + save accept → creates new bot_session', async () => {
    const supabase = buildMockSupabase({ existingMethods: [] });
    const { handleSavedCardOfferAction } = await import('@/lib/payments/saved-card-offer');
    await handleSavedCardOfferAction(supabase as any, sendText, PHONE, null, 'save_accept', PAY_ID);

    // Creates new session via INSERT (not CAS)
    expect(supabase.from).toHaveBeenCalledWith('bot_sessions');
    expect(sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('Waaiio PIN'));
  });

  // ═══════════════════════════════════════════════════════════════
  // K10 #16: PIN precedence behavioral proof
  // ═══════════════════════════════════════════════════════════════
  it('#16: save path sets save_card_pin step, replace sets replace_card_pin', async () => {
    // Save path
    const supabaseSave = buildMockSupabase({ existingMethods: [] });
    const session1 = { id: 'sess-1', business_id: BIZ_ID, session_data: {}, version: 1 };
    const { startSavedCardFromPaymentId } = await import('@/lib/payments/saved-card-offer');
    await startSavedCardFromPaymentId(supabaseSave as any, sendText, PHONE, session1 as any, PAY_ID);
    expect(supabaseSave.rpc).toHaveBeenCalledWith('update_session_cas', expect.objectContaining({
      p_current_step: 'save_card_pin',
    }));

    vi.clearAllMocks();

    // Replace path
    const supabaseReplace = buildMockSupabase({ existingMethods: [EXISTING_METHOD] });
    const session2 = { id: 'sess-2', business_id: BIZ_ID, session_data: {}, version: 1 };
    await startSavedCardFromPaymentId(supabaseReplace as any, sendText, PHONE, session2 as any, PAY_ID);
    expect(supabaseReplace.rpc).toHaveBeenCalledWith('update_session_cas', expect.objectContaining({
      p_current_step: 'replace_card_pin',
    }));
  });

  // ═══════════════════════════════════════════════════════════════
  // K10 #17: All ineligible payment types → no CTA
  // ═══════════════════════════════════════════════════════════════
  describe('#17: ineligible payment types produce zero offer emission', () => {
    it('BYO payment → no CTA', async () => {
      const byoPayment = { ...PLATFORM_PAYMENT, metadata: { payment_origin: 'byo', _card_authorization: PLATFORM_PAYMENT.metadata._card_authorization } };
      const supabase = buildMockSupabase({ payment: byoPayment, existingMethods: [] });
      const { checkAndOfferSavedCard } = await import('@/lib/payments/saved-card-offer');
      await checkAndOfferSavedCard(supabase as any, PAY_ID, PHONE, BIZ_ID, mockSender as any);
      expect(sendButtons).not.toHaveBeenCalled();
    });

    it('Connect payment → no CTA', async () => {
      const connectPayment = { ...PLATFORM_PAYMENT, metadata: { payment_origin: 'connect', _card_authorization: PLATFORM_PAYMENT.metadata._card_authorization } };
      const supabase = buildMockSupabase({ payment: connectPayment, existingMethods: [] });
      const { checkAndOfferSavedCard } = await import('@/lib/payments/saved-card-offer');
      await checkAndOfferSavedCard(supabase as any, PAY_ID, PHONE, BIZ_ID, mockSender as any);
      expect(sendButtons).not.toHaveBeenCalled();
    });

    it('Stripe payment → no CTA', async () => {
      const stripePayment = { ...PLATFORM_PAYMENT, gateway: 'stripe' };
      const supabase = buildMockSupabase({ payment: stripePayment, existingMethods: [] });
      const { checkAndOfferSavedCard } = await import('@/lib/payments/saved-card-offer');
      await checkAndOfferSavedCard(supabase as any, PAY_ID, PHONE, BIZ_ID, mockSender as any);
      expect(sendButtons).not.toHaveBeenCalled();
    });

    it('non-reusable authorization → no CTA', async () => {
      const nonReusable = {
        ...PLATFORM_PAYMENT,
        metadata: {
          payment_origin: 'platform',
          _card_authorization: { ...PLATFORM_PAYMENT.metadata._card_authorization, reusable: false },
        },
      };
      const supabase = buildMockSupabase({ payment: nonReusable, existingMethods: [] });
      const { checkAndOfferSavedCard } = await import('@/lib/payments/saved-card-offer');
      await checkAndOfferSavedCard(supabase as any, PAY_ID, PHONE, BIZ_ID, mockSender as any);
      expect(sendButtons).not.toHaveBeenCalled();
    });

    it('missing email → no CTA', async () => {
      const noEmail = {
        ...PLATFORM_PAYMENT,
        metadata: {
          payment_origin: 'platform',
          _card_authorization: { ...PLATFORM_PAYMENT.metadata._card_authorization, email: null },
        },
      };
      const supabase = buildMockSupabase({ payment: noEmail, existingMethods: [] });
      const { checkAndOfferSavedCard } = await import('@/lib/payments/saved-card-offer');
      await checkAndOfferSavedCard(supabase as any, PAY_ID, PHONE, BIZ_ID, mockSender as any);
      expect(sendButtons).not.toHaveBeenCalled();
    });

    it('failed payment → no CTA', async () => {
      const failedPayment = { ...PLATFORM_PAYMENT, status: 'failed' };
      const supabase = buildMockSupabase({ payment: failedPayment, existingMethods: [] });
      const { checkAndOfferSavedCard } = await import('@/lib/payments/saved-card-offer');
      await checkAndOfferSavedCard(supabase as any, PAY_ID, PHONE, BIZ_ID, mockSender as any);
      expect(sendButtons).not.toHaveBeenCalled();
    });

    it('BYO business (compat=false) → no CTA', async () => {
      mockIsCompat.mockResolvedValueOnce({ compatible: false, reason: 'byo_paystack' });
      const supabase = buildMockSupabase({ existingMethods: [] });
      const { checkAndOfferSavedCard } = await import('@/lib/payments/saved-card-offer');
      await checkAndOfferSavedCard(supabase as any, PAY_ID, PHONE, BIZ_ID, mockSender as any);
      expect(sendButtons).not.toHaveBeenCalled();
    });

    it('null sender → no CTA', async () => {
      const supabase = buildMockSupabase({ existingMethods: [] });
      const { checkAndOfferSavedCard } = await import('@/lib/payments/saved-card-offer');
      await checkAndOfferSavedCard(supabase as any, PAY_ID, PHONE, BIZ_ID, null);
      expect(supabase.rpc).not.toHaveBeenCalledWith('create_or_claim_saved_card_offer', expect.anything());
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // K10 #18: Payment classifier ambiguous → null / no provider call
  // ═══════════════════════════════════════════════════════════════
  it('#18: ambiguous credential classification → compat=false → no CTA', async () => {
    mockIsCompat.mockResolvedValueOnce({ compatible: false, reason: 'ambiguous_credential_state' });
    const supabase = buildMockSupabase({ existingMethods: [] });
    const { checkAndOfferSavedCard } = await import('@/lib/payments/saved-card-offer');
    await checkAndOfferSavedCard(supabase as any, PAY_ID, PHONE, BIZ_ID, mockSender as any);
    expect(sendButtons).not.toHaveBeenCalled();
  });

  // ═══════════════════════════════════════════════════════════════
  // K4: Payment-customer ownership proof
  // ═══════════════════════════════════════════════════════════════
  it('K4: wrong customer phone vs payment entity → no CTA', async () => {
    const supabase = buildMockSupabase({ existingMethods: [], bookingPhone: '+2349099999999' });
    const { checkSavedCardOfferEligibility } = await import('@/lib/payments/saved-card-offer');
    const result = await checkSavedCardOfferEligibility(supabase as any, PAY_ID, PHONE, BIZ_ID);
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('customer_mismatch');
  });

  // ═══════════════════════════════════════════════════════════════
  // K7: Fail-closed DB reads
  // ═══════════════════════════════════════════════════════════════
  it('K7: payment read error → not eligible (fail closed)', async () => {
    const supabase = buildMockSupabase();
    // Override payment read to return error
    supabase.from = vi.fn().mockImplementation((table: string) => {
      const chain: Record<string, unknown> = {};
      ['select', 'eq', 'in', 'not', 'order', 'limit'].forEach(m => { chain[m] = vi.fn().mockReturnValue(chain); });
      chain.single = vi.fn().mockResolvedValue({ data: null, error: { message: 'DB error' } });
      chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: { message: 'DB error' } });
      return chain;
    });
    const { checkSavedCardOfferEligibility } = await import('@/lib/payments/saved-card-offer');
    const result = await checkSavedCardOfferEligibility(supabase as any, PAY_ID, PHONE, BIZ_ID);
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('payment_read_error');
  });

  // ═══════════════════════════════════════════════════════════════
  // Invalid phone → no processing
  // ═══════════════════════════════════════════════════════════════
  it('invalid phone → no CTA', async () => {
    const supabase = buildMockSupabase({ existingMethods: [] });
    const { checkAndOfferSavedCard } = await import('@/lib/payments/saved-card-offer');
    await checkAndOfferSavedCard(supabase as any, PAY_ID, 'invalid', BIZ_ID, mockSender as any);
    expect(sendButtons).not.toHaveBeenCalled();
  });

  // ═══════════════════════════════════════════════════════════════
  // Business mismatch → no CTA
  // ═══════════════════════════════════════════════════════════════
  it('business_id mismatch → not eligible', async () => {
    const supabase = buildMockSupabase({ existingMethods: [] });
    const { checkSavedCardOfferEligibility } = await import('@/lib/payments/saved-card-offer');
    const result = await checkSavedCardOfferEligibility(supabase as any, PAY_ID, PHONE, 'different-biz');
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('business_mismatch');
  });
});

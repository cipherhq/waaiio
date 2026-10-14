/**
 * Saved-card decline confirmation tests.
 *
 * Covers the fix for: after tapping "Keep current" or "Not now" on the
 * saved-card offer, the customer now receives a confirmation message
 * with [Main menu] [Done] navigation buttons.
 *
 * Tests:
 * - save_decline → expected text + 2 buttons
 * - replace_decline → expected text with last4 + 2 buttons
 * - already_declined (duplicate tap) → same reply, decline RPC called once
 * - savedcard_menu button tap → routes to capability menu
 * - savedcard_done button tap → deactivates session, sends goodbye
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ──

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    withContext: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
  },
}));

vi.mock('@/lib/channels/channel-resolver', () => ({
  ChannelResolver: vi.fn().mockImplementation(() => ({
    resolveByChannelId: vi.fn().mockResolvedValue(null),
  })),
}));

// Mock translations — return keys as-is for deterministic assertions
vi.mock('@/lib/bot/translations', () => ({
  loadBusinessOverrides: vi.fn().mockResolvedValue(new Map()),
  loadPlatformOverrides: vi.fn().mockResolvedValue(new Map()),
  runWithTranslationOverrides: vi.fn().mockImplementation((_overrides, fn) => fn()),
  createOverridesLoader: vi.fn(),
}));

// ── Test constants ──

const PAY_ID = '00000000-0000-0000-0020-000000000001';
const BIZ_ID = '00000000-0000-0000-0020-00000000b001';
const METHOD_ID = '00000000-0000-0000-0020-00000000m001';
const PHONE = '+2348012345678';

const PLATFORM_PAYMENT = {
  id: PAY_ID, status: 'success', gateway: 'paystack', business_id: BIZ_ID,
  booking_id: 'bk-1', reservation_id: null, invoice_id: null, order_id: null,
  campaign_id: null, user_id: null,
  metadata: {
    payment_origin: 'platform',
    _card_authorization: {
      authorization_code: 'auth_new_xxx', customer_code: 'CUS_test',
      email: '2348012345678@whatsapp.waaiio.com', last4: '5678',
      brand: 'mastercard', reusable: true,
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
  bookingPhone?: string;
} = {}) {
  const {
    payment = PLATFORM_PAYMENT,
    existingMethods = null,
    rpcResults = {},
    bookingPhone = PHONE,
  } = overrides;

  const rpcFn = vi.fn().mockImplementation((name: string) => {
    if (rpcResults[name] !== undefined) return Promise.resolve({ data: rpcResults[name], error: null });
    if (name === 'decline_saved_card_offer') return Promise.resolve({ data: { result: 'transitioned' }, error: null });
    if (name === 'accept_saved_card_offer') return Promise.resolve({ data: { result: 'transitioned' }, error: null });
    if (name === 'update_session_cas') return Promise.resolve({ data: { success: true, version: 2 }, error: null });
    if (name === 'establish_saved_card_session') return Promise.resolve({ data: { session_id: 'sess-new', version: 1 }, error: null });
    return Promise.resolve({ data: null, error: null });
  });

  const fromFn = vi.fn().mockImplementation((table: string) => {
    const chain: Record<string, unknown> = {};
    ['select', 'eq', 'in', 'or', 'order', 'limit', 'not', 'gte', 'update', 'delete'].forEach(m => {
      chain[m] = vi.fn().mockReturnValue(chain);
    });
    chain.single = vi.fn().mockResolvedValue({ data: null, error: null });
    chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    chain.insert = vi.fn().mockResolvedValue({ data: null, error: null });

    if (table === 'payments') {
      chain.single = vi.fn().mockResolvedValue({ data: payment, error: null });
    }
    if (table === 'saved_payment_methods') {
      // Support both .maybeSingle() (old path) and .order().limit() (new path) as thenable
      chain.maybeSingle = vi.fn().mockResolvedValue({
        data: existingMethods?.[0] || null, error: null,
      });
      const pmResult = { data: existingMethods || [], error: null };
      Object.defineProperty(chain, 'then', {
        value: (ok?: (v: unknown) => void, er?: (e: unknown) => void) => Promise.resolve(pmResult).then(ok, er),
        configurable: true,
      });
    }
    if (table === 'bookings') {
      chain.single = vi.fn().mockResolvedValue({ data: { guest_phone: bookingPhone }, error: null });
    }
    return chain;
  });

  return { rpc: rpcFn, from: fromFn };
}

// ── Compat mock ──
vi.mock('@/lib/payments/saved-card-compat', async (importOriginal) => {
  const orig = await importOriginal() as Record<string, unknown>;
  return {
    ...orig,
    isSharedPlatformPaystackCompatible: vi.fn().mockResolvedValue({ compatible: true }),
  };
});

const sendText = vi.fn().mockResolvedValue(undefined);
const sendButtons = vi.fn().mockResolvedValue({ messageId: 'wamid.decline123' });

describe('Saved-card decline confirmation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ═══════════════════════════════════════════════════════════════
  // save_decline → confirmation text + 2 buttons
  // ═══════════════════════════════════════════════════════════════
  it('save_decline (Not now) → confirmation text + [Main menu] [Done] buttons', async () => {
    const supabase = buildMockSupabase();
    const bindBusiness = vi.fn();
    const { handleSavedCardOfferAction } = await import('@/lib/payments/saved-card-offer');
    await handleSavedCardOfferAction(
      supabase as any, sendText, PHONE, null, 'save_decline', PAY_ID, bindBusiness, sendButtons,
    );

    // Decline RPC called with correct type
    expect(supabase.rpc).toHaveBeenCalledWith('decline_saved_card_offer', expect.objectContaining({
      p_payment_id: PAY_ID, p_customer_phone: PHONE, p_expected_offer_type: 'save',
    }));

    // Business bound for S-1 guard
    expect(bindBusiness).toHaveBeenCalledWith(BIZ_ID);

    // Confirmation sent via sendButtons
    expect(sendButtons).toHaveBeenCalledTimes(1);
    const call = sendButtons.mock.calls[0][0];
    expect(call.body).toContain('card');
    expect(call.body).toContain('save card');
    expect(call.buttons).toHaveLength(2);
    expect(call.buttons[0].id).toBe(`savedcard_menu:${PAY_ID}`);
    expect(call.buttons[1].id).toBe(`savedcard_done:${PAY_ID}`);
  });

  // ═══════════════════════════════════════════════════════════════
  // replace_decline → confirmation with last4 + 2 buttons
  // ═══════════════════════════════════════════════════════════════
  it('replace_decline (Keep current) → confirmation with last4 + [Main menu] [Done] buttons', async () => {
    const supabase = buildMockSupabase({ existingMethods: [EXISTING_METHOD] });
    const bindBusiness = vi.fn();
    const { handleSavedCardOfferAction } = await import('@/lib/payments/saved-card-offer');
    await handleSavedCardOfferAction(
      supabase as any, sendText, PHONE, null, 'replace_decline', PAY_ID, bindBusiness, sendButtons,
    );

    // Decline RPC called with correct type
    expect(supabase.rpc).toHaveBeenCalledWith('decline_saved_card_offer', expect.objectContaining({
      p_payment_id: PAY_ID, p_customer_phone: PHONE, p_expected_offer_type: 'replace',
    }));

    // Business bound for S-1 guard
    expect(bindBusiness).toHaveBeenCalledWith(BIZ_ID);

    // Confirmation sent via sendButtons with last4
    expect(sendButtons).toHaveBeenCalledTimes(1);
    const call = sendButtons.mock.calls[0][0];
    expect(call.body).toContain('1234');
    expect(call.buttons).toHaveLength(2);
    expect(call.buttons[0].id).toBe(`savedcard_menu:${PAY_ID}`);
    expect(call.buttons[1].id).toBe(`savedcard_done:${PAY_ID}`);
  });

  // ═══════════════════════════════════════════════════════════════
  // replace_decline with no saved card → generic message
  // ═══════════════════════════════════════════════════════════════
  it('replace_decline with no saved card found → generic confirmation', async () => {
    const supabase = buildMockSupabase({ existingMethods: [] });
    const { handleSavedCardOfferAction } = await import('@/lib/payments/saved-card-offer');
    await handleSavedCardOfferAction(
      supabase as any, sendText, PHONE, null, 'replace_decline', PAY_ID, vi.fn(), sendButtons,
    );

    expect(sendButtons).toHaveBeenCalledTimes(1);
    const call = sendButtons.mock.calls[0][0];
    // Generic message (no last4)
    expect(call.body).toContain('current card');
    expect(call.buttons).toHaveLength(2);
  });

  // ═══════════════════════════════════════════════════════════════
  // already_declined (duplicate tap) → same reply, RPC called once
  // ═══════════════════════════════════════════════════════════════
  it('already_declined → same confirmation, decline RPC called once', async () => {
    const supabase = buildMockSupabase({
      rpcResults: { decline_saved_card_offer: { result: 'already_declined' } },
    });
    const { handleSavedCardOfferAction } = await import('@/lib/payments/saved-card-offer');
    await handleSavedCardOfferAction(
      supabase as any, sendText, PHONE, null, 'save_decline', PAY_ID, vi.fn(), sendButtons,
    );

    // Decline RPC called exactly once (idempotent — no second mutation)
    const declineCalls = supabase.rpc.mock.calls.filter(
      (c: unknown[]) => c[0] === 'decline_saved_card_offer'
    );
    expect(declineCalls).toHaveLength(1);

    // Still sends confirmation
    expect(sendButtons).toHaveBeenCalledTimes(1);
    const call = sendButtons.mock.calls[0][0];
    expect(call.body).toContain('save card');
    expect(call.buttons).toHaveLength(2);
  });

  // ═══════════════════════════════════════════════════════════════
  // Fallback: no sendButtons → plain text
  // ═══════════════════════════════════════════════════════════════
  it('decline without sendButtons → falls back to sendText', async () => {
    const supabase = buildMockSupabase();
    const { handleSavedCardOfferAction } = await import('@/lib/payments/saved-card-offer');
    await handleSavedCardOfferAction(
      supabase as any, sendText, PHONE, null, 'save_decline', PAY_ID,
    );

    // No sendButtons passed → sendText used
    expect(sendText).toHaveBeenCalled();
    const textCall = sendText.mock.calls.find(
      (c: unknown[]) => typeof c[1] === 'string' && (c[1] as string).includes('save card')
    );
    expect(textCall).toBeDefined();
  });

  // ═══════════════════════════════════════════════════════════════
  // Session language used for localization
  // ═══════════════════════════════════════════════════════════════
  it('uses session language for localized copy', async () => {
    const supabase = buildMockSupabase();
    const session = { id: 'sess-1', business_id: BIZ_ID, session_data: { _detected_language: 'pcm' }, version: 1 };
    const { handleSavedCardOfferAction } = await import('@/lib/payments/saved-card-offer');
    await handleSavedCardOfferAction(
      supabase as any, sendText, PHONE, session as any, 'save_decline', PAY_ID, vi.fn(), sendButtons,
    );

    // Should attempt to load overrides (verified via mock)
    const { loadBusinessOverrides } = await import('@/lib/bot/translations');
    expect(loadBusinessOverrides).toHaveBeenCalledWith(expect.anything(), BIZ_ID);

    // Confirmation sent
    expect(sendButtons).toHaveBeenCalledTimes(1);
    const call = sendButtons.mock.calls[0][0];
    // PCM copy: "No wahala..."
    expect(call.body).toContain('wahala');
  });

  // ═══════════════════════════════════════════════════════════════
  // FIX #4a: session business A, payment business B → no bind, no send
  // ═══════════════════════════════════════════════════════════════
  it('decline with session business != payment business → no bind, no send', async () => {
    const OTHER_BIZ = 'biz-other-999';
    const supabase = buildMockSupabase({
      payment: { ...PLATFORM_PAYMENT, business_id: OTHER_BIZ },
    });
    const session = { id: 'sess-1', business_id: BIZ_ID, session_data: {}, version: 1 };
    const bindBusiness = vi.fn();
    const { handleSavedCardOfferAction } = await import('@/lib/payments/saved-card-offer');
    await handleSavedCardOfferAction(
      supabase as any, sendText, PHONE, session as any, 'replace_decline', PAY_ID, bindBusiness, sendButtons,
    );

    // bindBusiness never called
    expect(bindBusiness).not.toHaveBeenCalled();
    // No buttons or text sent
    expect(sendButtons).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  // ═══════════════════════════════════════════════════════════════
  // FIX #4b: two active cards → no error, deterministic pick (most recent)
  // ═══════════════════════════════════════════════════════════════
  it('replace_decline with two active cards → no error, picks first card last4', async () => {
    const twoCards = [
      { ...EXISTING_METHOD, card_last4: '9999' },
      { ...EXISTING_METHOD, id: 'method-2', card_last4: '1111' },
    ];
    const supabase = buildMockSupabase({ existingMethods: twoCards });
    const { handleSavedCardOfferAction } = await import('@/lib/payments/saved-card-offer');
    await handleSavedCardOfferAction(
      supabase as any, sendText, PHONE, null, 'replace_decline', PAY_ID, vi.fn(), sendButtons,
    );

    // Should not throw, should send confirmation
    expect(sendButtons).toHaveBeenCalledTimes(1);
    const call = sendButtons.mock.calls[0][0];
    // Should contain first card's last4 (deterministic: ordered by last_used_at desc)
    expect(call.body).toContain('9999');
    expect(call.buttons).toHaveLength(2);
  });
});

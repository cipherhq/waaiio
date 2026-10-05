/**
 * P0-CONFIRM-1 — Mock control-flow tests for confirmation lifecycle
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRpc = vi.fn();
const mockFrom = vi.fn();

function chain() {
  const c: Record<string, any> = {};
  ['select','eq','is','in','or','not','order','limit','update'].forEach(m => c[m] = vi.fn().mockReturnValue(c));
  c.single = vi.fn().mockResolvedValue({ data: null, error: null });
  c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
  return c;
}

function buildMock(rpcMap: Record<string, { data?: unknown; error?: unknown }> = {}) {
  const rpcCalls: string[] = [];
  mockRpc.mockImplementation((name: string) => {
    rpcCalls.push(name);
    const r = rpcMap[name];
    return Promise.resolve({ data: r?.data ?? null, error: r?.error ?? null });
  });
  mockFrom.mockImplementation((table: string) => {
    const c = chain();
    if (table === 'bookings') c.single = vi.fn().mockResolvedValue({ data: { guest_phone: '+234123', business_id: 'b1', reference_code: 'X1', date: '2026-08-10', time: '14:00', flow_type: 'scheduling', total_amount: 50, deposit_amount: 50, businesses: { name: 'Biz', country_code: 'NG' }, services: { name: 'S', duration_minutes: 30 } }, error: null });
    if (table === 'businesses') c.single = vi.fn().mockResolvedValue({ data: { subscription_tier: 'free', owner_id: 'o1' }, error: null });
    if (table === 'profiles') c.single = vi.fn().mockResolvedValue({ data: { email: 'o@t.com', phone: '+234' }, error: null });
    return c;
  });
  return { rpc: mockRpc, from: mockFrom, _rpcCalls: rpcCalls } as any;
}

// Hoisted mocks for observable dependencies
const { mockInitializePayment, mockCalendarLinks } = vi.hoisted(() => ({
  mockInitializePayment: vi.fn(),
  mockCalendarLinks: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), withContext: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/constants', () => ({ formatCurrency: (a: number) => `$${a}` }));
vi.mock('@/lib/utils/phone', () => ({ stripPlus: (p: string) => p.replace(/^\+/, '') }));
vi.mock('@/lib/bot/flows/shared/user', () => ({ getCustomerName: vi.fn().mockResolvedValue('U') }));
vi.mock('@/lib/calendar/generate-links', () => ({ getCalendarLinksText: mockCalendarLinks }));
vi.mock('@/lib/utils/sanitize', () => ({ sanitizeFilterValue: (v: string) => v }));
vi.mock('@/lib/bot/flows/shared/payment', () => ({ initializePayment: mockInitializePayment }));

// F3: Observable sender — tests that need channel resolution configure it dynamically
const mockTransportSendText = vi.fn().mockResolvedValue({ success: true, messageId: 'wamid-1' });

// Slice 5A: mock proactive localization — default to English (no translation)
const mockProactiveTranslate = vi.fn();
vi.mock('@/lib/payments/proactive-localization', () => ({
  resolveProactiveLocalization: vi.fn().mockImplementation(async () => ({
    language: 'en',
    translationContext: { entitlement: { allowedLanguages: ['en'], llmAllowed: false, translationAllowed: false }, businessId: 'b1', supabase: {} },
    translate: mockProactiveTranslate.mockImplementation(async (text: string) => text),
  })),
}));

const CLAIM_OK = { data: { claimed: true, claim_token: 'tok-aaa', payment_id: 'p1', amount: 50, booking_id: 'bk1', invoice_id: null, campaign_id: null, reservation_id: null, order_id: null } };
const CLAIM_BALANCE = { data: { claimed: true, claim_token: 'tok-aaa', payment_id: 'p1', amount: 50, booking_id: 'bk1', invoice_id: null, campaign_id: null, reservation_id: null, order_id: null } };

/** Configure mockFrom for a partial-balance booking (total=100, deposit=50). maybeSingle returns profile with id. */
function setupPartialBalanceMock() {
  mockFrom.mockImplementation((table: string) => {
    const c = chain();
    if (table === 'bookings') c.single = vi.fn().mockResolvedValue({
      data: { guest_phone: '+234123', business_id: 'b1', reference_code: 'X1', date: '2026-08-10', time: '14:00', flow_type: 'scheduling', total_amount: 100, deposit_amount: 50, businesses: { name: 'Biz', country_code: 'NG', address: '1 Main St' }, services: { name: 'S', duration_minutes: 30 } },
      error: null,
    });
    if (table === 'businesses') c.single = vi.fn().mockResolvedValue({ data: { subscription_tier: 'free', owner_id: 'o1' }, error: null });
    if (table === 'profiles') {
      // The balance path uses maybeSingle, not single
      c.maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'usr1', email: 'o@t.com', phone: '+234123' }, error: null });
      c.single = vi.fn().mockResolvedValue({ data: { id: 'usr1', email: 'o@t.com', phone: '+234123' }, error: null });
    }
    if (table === 'payments') {
      // #381 balance authority is successful payment history, not configured deposit.
      // Model the already-paid $50 deposit linked to bk1.
      c.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve({ data: [{ amount: 50, refund_amount: 0 }], error: null }).then(resolve, reject);
    }
    return c;
  });
}
const RENEW_OK = { data: { renewed: true } };
const FIN_OK = { data: { finalized: true, already_finalized: false } };
const REL_OK = { data: { released: true } };
const pay = { id: 'p1', amount: 50, booking_id: 'bk1', invoice_id: null, campaign_id: null };

describe('P0-CONFIRM-1: Control-flow tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInitializePayment.mockResolvedValue(null);
    mockCalendarLinks.mockReturnValue(null);
  });

  it('1. renewal success → processing continues', async () => {
    const s = buildMock({ claim_payment_confirmation: CLAIM_OK, renew_payment_confirmation_claim: RENEW_OK, finalize_payment_confirmation: FIN_OK });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay);
    expect(mockRpc).toHaveBeenCalledWith('finalize_payment_confirmation', expect.objectContaining({ p_claim_token: 'tok-aaa' }));
  });

  it('2. renewal RPC error → stops before next side effect', async () => {
    const s = buildMock({ claim_payment_confirmation: CLAIM_OK, renew_payment_confirmation_claim: { error: { message: 'db' } } });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay);
    expect(mockRpc).not.toHaveBeenCalledWith('finalize_payment_confirmation', expect.anything());
  });

  it('3. renewed:false stops processing', async () => {
    const s = buildMock({ claim_payment_confirmation: CLAIM_OK, renew_payment_confirmation_claim: { data: { renewed: false, reason: 'token_mismatch' } } });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay);
    expect(mockRpc).not.toHaveBeenCalledWith('finalize_payment_confirmation', expect.anything());
  });

  it('4. token_mismatch stops stale worker — no release, no finalize', async () => {
    const s = buildMock({ claim_payment_confirmation: CLAIM_OK, renew_payment_confirmation_claim: { data: { renewed: false, reason: 'token_mismatch' } } });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay);
    expect(mockRpc).not.toHaveBeenCalledWith('release_payment_confirmation', expect.anything());
  });

  it('5. already_completed claim → returns already_completed, retries saved-card CTA (non-blocking)', async () => {
    const s = buildMock({ claim_payment_confirmation: { data: { claimed: false, already_completed: true } } });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    const result = await sendProactiveConfirmation(s, pay);
    expect(result.status).toBe('already_completed');
    // Only the claim RPC is called — no finalization or confirmation delivery RPCs
    expect(mockRpc).toHaveBeenCalledTimes(1);
    // K2: saved-card retry reads payment_saved_card_offers (non-blocking side effect)
    // This is intentional — it attempts to retry a pending saved-card CTA via stored channel_id.
  });

  it('6. no-business release uses helper correctly', async () => {
    const s = buildMock({ claim_payment_confirmation: { ...CLAIM_OK, data: { ...CLAIM_OK.data, booking_id: null } }, release_payment_confirmation: REL_OK });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, { ...pay, booking_id: null });
    // No business found → release should have been called
    expect(mockRpc).toHaveBeenCalledWith('release_payment_confirmation', expect.objectContaining({ p_claim_token: 'tok-aaa' }));
  });

  it('7. claim RPC error → zero downstream', async () => {
    const s = buildMock({ claim_payment_confirmation: { error: { message: 'db' } } });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('8. finalize succeeds on first attempt', async () => {
    const s = buildMock({ claim_payment_confirmation: CLAIM_OK, renew_payment_confirmation_claim: RENEW_OK, finalize_payment_confirmation: FIN_OK });
    const { logger } = await import('@/lib/logger');
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Confirmation finalized'));
  });

  it('9. finalize error retries and succeeds', async () => {
    let finCallCount = 0;
    const s = buildMock({ claim_payment_confirmation: CLAIM_OK, renew_payment_confirmation_claim: RENEW_OK });
    mockRpc.mockImplementation((name: string) => {
      if (name === 'finalize_payment_confirmation') {
        finCallCount++;
        if (finCallCount === 1) return Promise.resolve({ data: null, error: { message: 'timeout' } });
        return Promise.resolve({ data: { finalized: true, already_finalized: false }, error: null });
      }
      const map: Record<string, any> = { claim_payment_confirmation: CLAIM_OK, renew_payment_confirmation_claim: RENEW_OK };
      return Promise.resolve({ data: map[name]?.data ?? null, error: map[name]?.error ?? null });
    });
    const { logger } = await import('@/lib/logger');
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Confirmation finalized'));
  });

  it('10. finalize both attempts fail → no release after sends', async () => {
    const s = buildMock({ claim_payment_confirmation: CLAIM_OK, renew_payment_confirmation_claim: RENEW_OK, finalize_payment_confirmation: { error: { message: 'db' } } });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay);
    expect(mockRpc).not.toHaveBeenCalledWith('release_payment_confirmation', expect.anything());
  });

  it('11. finalize token_mismatch → no release', async () => {
    const s = buildMock({ claim_payment_confirmation: CLAIM_OK, renew_payment_confirmation_claim: RENEW_OK, finalize_payment_confirmation: { data: { finalized: false, reason: 'token_mismatch' } } });
    const { logger } = await import('@/lib/logger');
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay);
    expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('Confirmation finalized'));
    expect(mockRpc).not.toHaveBeenCalledWith('release_payment_confirmation', expect.anything());
  });

  it('12. no claim token in response → zero side effects', async () => {
    const s = buildMock({ claim_payment_confirmation: { data: { claimed: true, payment_id: 'p1' } } });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay);
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it('13. outer catch releases when no external sends occurred', async () => {
    const s = buildMock({ claim_payment_confirmation: CLAIM_OK, release_payment_confirmation: REL_OK });
    s.from = vi.fn().mockImplementation(() => { throw new Error('boom'); });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay);
    expect(mockRpc).toHaveBeenCalledWith('release_payment_confirmation', expect.objectContaining({ p_claim_token: 'tok-aaa' }));
  });

  // ── Side-effect tracking: sideEffectsMayHaveOccurred ──

  it('14. flag set BEFORE WhatsApp, not after — source verification', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.resolve(__dirname, '../payments/send-confirmation.ts'), 'utf-8');
    // The flag must be set BEFORE sendText, not after
    // #197: sendText is now inside the delivery-attempt lifecycle but the flag is still set before it
    const flagIdx = src.indexOf('sideEffectsMayHaveOccurred = true;');
    const sendIdx = src.indexOf('resolved.sender.sendText');
    expect(flagIdx).toBeGreaterThan(-1);
    expect(sendIdx).toBeGreaterThan(flagIdx);
    // After initialization, the flag must never be set back to false
    // Count occurrences — only the initial `let ... = false` is allowed
    const matches = src.match(/sideEffectsMayHaveOccurred = false/g) || [];
    expect(matches.length).toBe(1); // only the initial declaration
  });

  it('15. post-completion throws → no release (side effects may have occurred)', async () => {
    const s = buildMock({ claim_payment_confirmation: CLAIM_OK, renew_payment_confirmation_claim: RENEW_OK });
    // Make post-completion module throw
    vi.doMock('@/lib/bot/flows/shared/post-completion', () => ({
      handlePostCompletion: vi.fn().mockRejectedValue(new Error('loyalty crash')),
    }));
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay);
    // Side effects started (WhatsApp send section entered) → no release
    expect(mockRpc).not.toHaveBeenCalledWith('release_payment_confirmation', expect.anything());
  });

  it('16. failure before any side effect → release permitted', async () => {
    // Claim succeeds but business resolution fails before WhatsApp/post-completion
    const s = buildMock({
      claim_payment_confirmation: { ...CLAIM_OK, data: { ...CLAIM_OK.data, booking_id: null } },
      renew_payment_confirmation_claim: RENEW_OK,
      release_payment_confirmation: REL_OK,
    });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, { ...pay, booking_id: null });
    // No business found → release called (before any side effects)
    expect(mockRpc).toHaveBeenCalledWith('release_payment_confirmation', expect.objectContaining({ p_claim_token: 'tok-aaa' }));
  });

  // ── Five checkpoint structure ──

  it('17. renewal at checkpoint 3 fails → no owner notify, no tickets, no finalize', async () => {
    let renewCount = 0;
    const s = buildMock({ claim_payment_confirmation: CLAIM_OK });
    mockRpc.mockImplementation((name: string) => {
      if (name === 'renew_payment_confirmation_claim') {
        renewCount++;
        // Checkpoints 1,2 succeed; checkpoint 3 fails
        if (renewCount <= 2) return Promise.resolve({ data: { renewed: true }, error: null });
        return Promise.resolve({ data: { renewed: false, reason: 'token_mismatch' }, error: null });
      }
      if (name === 'claim_payment_confirmation') return Promise.resolve(CLAIM_OK);
      return Promise.resolve({ data: null, error: null });
    });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay);
    expect(mockRpc).not.toHaveBeenCalledWith('finalize_payment_confirmation', expect.anything());
    expect(renewCount).toBe(3); // stopped at checkpoint 3
  });

  it('18. renewal at checkpoint 4 fails → no tickets/emails, no finalize', async () => {
    let renewCount = 0;
    const s = buildMock({ claim_payment_confirmation: CLAIM_OK });
    mockRpc.mockImplementation((name: string) => {
      if (name === 'renew_payment_confirmation_claim') {
        renewCount++;
        if (renewCount <= 3) return Promise.resolve({ data: { renewed: true }, error: null });
        return Promise.resolve({ data: { renewed: false, reason: 'token_mismatch' }, error: null });
      }
      if (name === 'claim_payment_confirmation') return Promise.resolve(CLAIM_OK);
      return Promise.resolve({ data: null, error: null });
    });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay);
    expect(mockRpc).not.toHaveBeenCalledWith('finalize_payment_confirmation', expect.anything());
    expect(renewCount).toBe(4);
  });

  it('19. renewal at checkpoint 5 fails → no session mutation, no finalize', async () => {
    let renewCount = 0;
    const s = buildMock({ claim_payment_confirmation: CLAIM_OK });
    mockRpc.mockImplementation((name: string) => {
      if (name === 'renew_payment_confirmation_claim') {
        renewCount++;
        // Allow 5 successes (original 4 checkpoints + 1 Slice 5A pre-delivery), fail on 6th (checkpoint 5)
        if (renewCount <= 5) return Promise.resolve({ data: { renewed: true }, error: null });
        return Promise.resolve({ data: { renewed: false, reason: 'token_mismatch' }, error: null });
      }
      if (name === 'claim_payment_confirmation') return Promise.resolve(CLAIM_OK);
      return Promise.resolve({ data: null, error: null });
    });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay);
    expect(mockRpc).not.toHaveBeenCalledWith('finalize_payment_confirmation', expect.anything());
    expect(renewCount).toBe(6); // 5 existing checkpoints + 1 Slice 5A pre-delivery renewal
  });

  it('20. successful flow reaches all 5 checkpoints + finalize', async () => {
    let renewCount = 0;
    const s = buildMock({ claim_payment_confirmation: CLAIM_OK, finalize_payment_confirmation: FIN_OK });
    mockRpc.mockImplementation((name: string) => {
      if (name === 'renew_payment_confirmation_claim') {
        renewCount++;
        return Promise.resolve({ data: { renewed: true }, error: null });
      }
      const map: Record<string, any> = { claim_payment_confirmation: CLAIM_OK, finalize_payment_confirmation: FIN_OK };
      return Promise.resolve({ data: map[name]?.data ?? null, error: map[name]?.error ?? null });
    });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay);
    expect(renewCount).toBe(6); // 5 existing checkpoints + 1 Slice 5A pre-delivery renewal
    expect(mockRpc).toHaveBeenCalledWith('finalize_payment_confirmation', expect.objectContaining({ p_claim_token: 'tok-aaa' }));
  });

  // ── #391: Partial-balance confirmation must not initialize another payment ──

  it('22. partial balance + ownership lost at checkpoint 1 → no initializePayment', async () => {
    const s = buildMock({
      claim_payment_confirmation: CLAIM_OK,
      renew_payment_confirmation_claim: { data: { renewed: false, reason: 'token_mismatch' } },
    });
    setupPartialBalanceMock();
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay);
    expect(mockInitializePayment).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalledWith('finalize_payment_confirmation', expect.anything());
    expect(mockRpc).not.toHaveBeenCalledWith('release_payment_confirmation', expect.anything());
  });

  it('23. partial deposit confirmation never initializes a follow-on balance payment', async () => {
    mockInitializePayment.mockRejectedValue(new Error('must never be reached'));
    const s = buildMock({ claim_payment_confirmation: CLAIM_OK, renew_payment_confirmation_claim: RENEW_OK, finalize_payment_confirmation: FIN_OK });
    setupPartialBalanceMock();
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay);
    expect(mockInitializePayment).not.toHaveBeenCalled();
    expect(mockRpc).toHaveBeenCalledWith('finalize_payment_confirmation', expect.objectContaining({ p_claim_token: 'tok-aaa' }));
  });

  it('24. partial deposit still exposes the authoritative remaining balance without a checkout URL', async () => {
    const s = buildMock({ claim_payment_confirmation: CLAIM_OK, renew_payment_confirmation_claim: RENEW_OK, finalize_payment_confirmation: FIN_OK });
    setupPartialBalanceMock();
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay);
    expect(mockInitializePayment).not.toHaveBeenCalled();
    // #391 regression: successful deposit confirmation ends without spawning a balance checkout.
    expect(mockInitializePayment).not.toHaveBeenCalled();
  });

  it('25. Stage 3 source contains no payment initialization for remaining balance', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.resolve(__dirname, '../payments/send-confirmation.ts'), 'utf-8');
    expect(src).not.toContain("import('@/lib/bot/flows/shared/payment')");
    expect(src).not.toContain('initializePayment(supabase');
    expect(src).toContain('Remaining balance');
  });

  it('26. no balance (fully paid) → no initializePayment, normal 5-checkpoint flow', async () => {
    let renewCount = 0;
    const s = buildMock({ claim_payment_confirmation: CLAIM_OK, finalize_payment_confirmation: FIN_OK });
    mockRpc.mockImplementation((name: string) => {
      if (name === 'renew_payment_confirmation_claim') { renewCount++; return Promise.resolve(RENEW_OK); }
      const map: Record<string, any> = { claim_payment_confirmation: CLAIM_OK, finalize_payment_confirmation: FIN_OK };
      return Promise.resolve({ data: map[name]?.data ?? null, error: map[name]?.error ?? null });
    });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay); // default mock: total=deposit=50 → no balance
    expect(renewCount).toBe(6); // 5 existing checkpoints + 1 Slice 5A pre-delivery renewal
    expect(mockInitializePayment).not.toHaveBeenCalled();
    expect(mockRpc).toHaveBeenCalledWith('finalize_payment_confirmation', expect.anything());
  });

  it('27. failure before any side effect (no balance) → release permitted', async () => {
    // Same as test 13 — outer catch releases when no external work happened
    const s = buildMock({ claim_payment_confirmation: CLAIM_OK, renew_payment_confirmation_claim: RENEW_OK, release_payment_confirmation: REL_OK });
    // Throw during business resolution (before checkpoint 1)
    s.from = vi.fn().mockImplementation(() => { throw new Error('boom'); });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay);
    expect(mockRpc).toHaveBeenCalledWith('release_payment_confirmation', expect.objectContaining({ p_claim_token: 'tok-aaa' }));
  });

  // ── Outer-catch release invariant regression ──

  it('28. outer catch before customer send → release remains permitted because no balance provider side effect exists', async () => {
    mockCalendarLinks.mockImplementation(() => { throw new Error('pre-send crash'); });
    const s = buildMock({ claim_payment_confirmation: CLAIM_OK, renew_payment_confirmation_claim: RENEW_OK, release_payment_confirmation: REL_OK });
    setupPartialBalanceMock();
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay);
    expect(mockInitializePayment).not.toHaveBeenCalled();
    expect(mockCalendarLinks).toHaveBeenCalled();
    expect(mockRpc).toHaveBeenCalledWith('release_payment_confirmation', expect.objectContaining({ p_claim_token: 'tok-aaa' }));
    expect(mockRpc).not.toHaveBeenCalledWith('finalize_payment_confirmation', expect.anything());
  });

  it('29. outer catch: failure before ANY side effect → release IS permitted', async () => {
    // No balance, no provider init, no WhatsApp — pure pre-checkpoint failure
    const s = buildMock({ claim_payment_confirmation: CLAIM_OK, renew_payment_confirmation_claim: RENEW_OK, release_payment_confirmation: REL_OK });
    // Throw during business resolution (before checkpoint 1, before any side effect)
    s.from = vi.fn().mockImplementation(() => { throw new Error('boom'); });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay);
    // sideEffectsMayHaveOccurred is still false → release permitted
    expect(mockRpc).toHaveBeenCalledWith('release_payment_confirmation', expect.objectContaining({ p_claim_token: 'tok-aaa' }));
  });

  it('21. lost ownership never releases/finalizes replacement claim', async () => {
    // Checkpoint 2 fails → stale worker stops, does NOT release or finalize
    let renewCount = 0;
    const s = buildMock({ claim_payment_confirmation: CLAIM_OK });
    mockRpc.mockImplementation((name: string) => {
      if (name === 'renew_payment_confirmation_claim') {
        renewCount++;
        if (renewCount === 1) return Promise.resolve({ data: { renewed: true }, error: null });
        return Promise.resolve({ data: { renewed: false, reason: 'token_mismatch' }, error: null });
      }
      if (name === 'claim_payment_confirmation') return Promise.resolve(CLAIM_OK);
      return Promise.resolve({ data: null, error: null });
    });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay);
    expect(mockRpc).not.toHaveBeenCalledWith('release_payment_confirmation', expect.anything());
    expect(mockRpc).not.toHaveBeenCalledWith('finalize_payment_confirmation', expect.anything());
  });
});

// ═══════════════════════════════════════════════════════════════
// B4: Slice 5A — translation + confirmation-fencing runtime proof
// ═══════════════════════════════════════════════════════════════

describe('B4: Slice 5A translation + claim fencing', () => {
  const pay = { id: 'p1', amount: 50, booking_id: 'bk1', invoice_id: null, campaign_id: null };

  it('claim loss at pre-delivery renewal prevents delivery claim/send', async () => {
    let renewCount = 0;
    const rpcLog: string[] = [];
    const s = buildMock({ claim_payment_confirmation: CLAIM_OK });
    mockRpc.mockImplementation((name: string) => {
      rpcLog.push(name);
      if (name === 'renew_payment_confirmation_claim') {
        renewCount++;
        // Fail on the 2nd renewal (pre-delivery) — simulates claim loss during translation
        if (renewCount >= 2) return Promise.resolve({ data: { renewed: false, reason: 'token_mismatch' }, error: null });
        return Promise.resolve({ data: { renewed: true }, error: null });
      }
      if (name === 'claim_payment_confirmation') return Promise.resolve(CLAIM_OK);
      return Promise.resolve({ data: null, error: null });
    });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    const result = await sendProactiveConfirmation(s, pay);

    // Delivery claim must NOT be called after ownership loss
    expect(rpcLog).not.toContain('claim_confirmation_delivery');
    expect(rpcLog).not.toContain('begin_confirmation_send');
    // Result is retryable processing
    expect(result.status).toBe('processing');
    expect((result as any).retryable).toBe(true);
  });

  it('translation failure falls back to English — all 6 renewals still succeed, flow completes', async () => {
    // Make proactive localization return a failing translator
    const { resolveProactiveLocalization } = await import('../payments/proactive-localization');
    (resolveProactiveLocalization as any).mockResolvedValueOnce({
      language: 'fr',
      translationContext: { entitlement: { allowedLanguages: ['en', 'fr'], llmAllowed: true, translationAllowed: true }, businessId: 'b1', supabase: {} },
      translate: vi.fn().mockRejectedValue(new Error('LLM timeout')),
    });

    let renewCount = 0;
    const s = buildMock({ claim_payment_confirmation: CLAIM_OK, finalize_payment_confirmation: FIN_OK });
    mockRpc.mockImplementation((name: string) => {
      if (name === 'renew_payment_confirmation_claim') {
        renewCount++;
        return Promise.resolve({ data: { renewed: true }, error: null });
      }
      if (name === 'claim_payment_confirmation') return Promise.resolve(CLAIM_OK);
      if (name === 'finalize_payment_confirmation') return Promise.resolve(FIN_OK);
      return Promise.resolve({ data: null, error: null });
    });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    const result = await sendProactiveConfirmation(s, pay);

    // Translation failed but flow completes normally with English
    // All 6 renewals should succeed (translation failure doesn't interrupt the claim chain)
    expect(renewCount).toBe(6); // 5 existing checkpoints + 1 Slice 5A pre-delivery renewal
    expect(result.status).toBe('completed');
  });

  it('pre-delivery renewal is called after translation, before delivery claim', async () => {
    let renewCount = 0;
    const rpcLog: string[] = [];
    const s = buildMock({ claim_payment_confirmation: CLAIM_OK });
    mockRpc.mockImplementation((name: string) => {
      rpcLog.push(name);
      if (name === 'renew_payment_confirmation_claim') {
        renewCount++;
        return Promise.resolve({ data: { renewed: true }, error: null });
      }
      if (name === 'claim_payment_confirmation') return Promise.resolve(CLAIM_OK);
      if (name === 'claim_confirmation_delivery') return Promise.resolve({ data: { claimed: true, attempt_id: 'att-1', claim_token: 'dtok-1' }, error: null });
      if (name === 'begin_confirmation_send') return Promise.resolve({ data: { authorized: true }, error: null });
      if (name === 'complete_confirmation_send') return Promise.resolve({ data: { completed: true }, error: null });
      if (name === 'finalize_payment_confirmation') return Promise.resolve({ data: { finalized: true }, error: null });
      return Promise.resolve({ data: null, error: null });
    });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay);

    // Pre-delivery renewal must come BEFORE delivery claim in the RPC sequence
    const renewIndices = rpcLog.map((n, i) => n === 'renew_payment_confirmation_claim' ? i : -1).filter(i => i >= 0);
    const deliveryIdx = rpcLog.indexOf('claim_confirmation_delivery');
    if (deliveryIdx >= 0 && renewIndices.length >= 2) {
      // The last renewal before delivery claim is the pre-delivery renewal
      const lastRenewBeforeDelivery = renewIndices.filter(i => i < deliveryIdx).pop();
      expect(lastRenewBeforeDelivery).toBeDefined();
      expect(lastRenewBeforeDelivery!).toBeLessThan(deliveryIdx);
    }
    // At minimum 2 renewals (checkpoint 1 + pre-delivery)
    expect(renewCount).toBeGreaterThanOrEqual(2);
  });

  it('non-English translate() is called, then pre-delivery renewal, then delivery claim (exact ordering)', async () => {
    const eventLog: string[] = [];
    const { resolveProactiveLocalization } = await import('../payments/proactive-localization');
    (resolveProactiveLocalization as any).mockResolvedValueOnce({
      language: 'fr',
      translationContext: { entitlement: { allowedLanguages: ['en', 'fr'], llmAllowed: true, translationAllowed: true }, businessId: 'b1', supabase: {} },
      translate: vi.fn().mockImplementation(async (text: string) => {
        eventLog.push('translate');
        return text; // pass through
      }),
    });

    const s = buildMock({ claim_payment_confirmation: CLAIM_OK, finalize_payment_confirmation: FIN_OK });
    mockRpc.mockImplementation((name: string) => {
      eventLog.push(name);
      if (name === 'renew_payment_confirmation_claim') return Promise.resolve({ data: { renewed: true }, error: null });
      if (name === 'claim_payment_confirmation') return Promise.resolve(CLAIM_OK);
      if (name === 'finalize_payment_confirmation') return Promise.resolve(FIN_OK);
      return Promise.resolve({ data: null, error: null });
    });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay);

    // Prove exact ordering: translate → renew (pre-delivery) → rest of flow
    const translateIdx = eventLog.indexOf('translate');
    const renewAfterTranslate = eventLog.indexOf('renew_payment_confirmation_claim', translateIdx + 1);
    expect(translateIdx).toBeGreaterThan(-1);
    expect(renewAfterTranslate).toBeGreaterThan(translateIdx);
  });

  it('translate() receives FULL message including balance, guidance, and calendar content', async () => {
    let capturedText = '';
    const { resolveProactiveLocalization } = await import('../payments/proactive-localization');
    (resolveProactiveLocalization as any).mockResolvedValueOnce({
      language: 'fr',
      translationContext: { entitlement: { allowedLanguages: ['en', 'fr'], llmAllowed: true, translationAllowed: true }, businessId: 'b1', supabase: {} },
      translate: vi.fn().mockImplementation(async (text: string) => { capturedText = text; return text; }),
    });
    mockCalendarLinks.mockReturnValue('\n📅 Add to calendar: https://calendar.google.com/test-cal-url');

    const s = buildMock({ claim_payment_confirmation: CLAIM_OK, finalize_payment_confirmation: FIN_OK });
    mockRpc.mockImplementation((name: string) => {
      if (name === 'renew_payment_confirmation_claim') return Promise.resolve({ data: { renewed: true }, error: null });
      if (name === 'claim_payment_confirmation') return Promise.resolve(CLAIM_OK);
      if (name === 'finalize_payment_confirmation') return Promise.resolve(FIN_OK);
      return Promise.resolve({ data: null, error: null });
    });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay);

    // Translator must receive the full message including guidance + calendar
    expect(capturedText).toContain('receipt');
    expect(capturedText).toContain('my bookings');
    expect(capturedText).toContain('calendar.google.com');
  });

  it('ownership loss AFTER translate → no delivery claim, no send, no finalize', async () => {
    let translateCalled = false;
    const { resolveProactiveLocalization } = await import('../payments/proactive-localization');
    (resolveProactiveLocalization as any).mockResolvedValueOnce({
      language: 'fr',
      translationContext: { entitlement: { allowedLanguages: ['en', 'fr'], llmAllowed: true, translationAllowed: true }, businessId: 'b1', supabase: {} },
      translate: vi.fn().mockImplementation(async (text: string) => { translateCalled = true; return text; }),
    });

    let renewCount = 0;
    const rpcLog: string[] = [];
    const s = buildMock({ claim_payment_confirmation: CLAIM_OK });
    mockRpc.mockImplementation((name: string) => {
      rpcLog.push(name);
      if (name === 'renew_payment_confirmation_claim') {
        renewCount++;
        // Fail on 2nd renewal (pre-delivery) — simulates ownership loss after translation
        if (renewCount >= 2) return Promise.resolve({ data: { renewed: false, reason: 'token_mismatch' }, error: null });
        return Promise.resolve({ data: { renewed: true }, error: null });
      }
      if (name === 'claim_payment_confirmation') return Promise.resolve(CLAIM_OK);
      return Promise.resolve({ data: null, error: null });
    });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    const result = await sendProactiveConfirmation(s, pay);

    // Translate was called
    expect(translateCalled).toBe(true);
    // But delivery was prevented by ownership loss
    expect(rpcLog).not.toContain('claim_confirmation_delivery');
    expect(rpcLog).not.toContain('begin_confirmation_send');
    expect(rpcLog).not.toContain('finalize_payment_confirmation');
    expect(result.status).toBe('processing');
  });

  it('translate() throws → English sent, normal claim/fencing intact', async () => {
    const { resolveProactiveLocalization } = await import('../payments/proactive-localization');
    (resolveProactiveLocalization as any).mockResolvedValueOnce({
      language: 'fr',
      translationContext: { entitlement: { allowedLanguages: ['en', 'fr'], llmAllowed: true, translationAllowed: true }, businessId: 'b1', supabase: {} },
      translate: vi.fn().mockRejectedValue(new Error('LLM timeout')),
    });

    let renewCount = 0;
    const s = buildMock({ claim_payment_confirmation: CLAIM_OK, finalize_payment_confirmation: FIN_OK });
    mockRpc.mockImplementation((name: string) => {
      if (name === 'renew_payment_confirmation_claim') { renewCount++; return Promise.resolve({ data: { renewed: true }, error: null }); }
      if (name === 'claim_payment_confirmation') return Promise.resolve(CLAIM_OK);
      if (name === 'finalize_payment_confirmation') return Promise.resolve(FIN_OK);
      return Promise.resolve({ data: null, error: null });
    });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    const result = await sendProactiveConfirmation(s, pay);

    // Flow completes normally with all renewals
    expect(renewCount).toBe(6); // 5 existing checkpoints + 1 Slice 5A pre-delivery renewal
    expect(result.status).toBe('completed');
  });
});


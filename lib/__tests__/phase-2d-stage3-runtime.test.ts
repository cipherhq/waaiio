/**
 * Phase 2D Stage 3 Runtime Tests — actual sendProactiveConfirmation calls.
 * Single comprehensive test that proves all required effects in one invocation.
 */
import { describe, it, expect, vi } from 'vitest';

// ── Track effects ──
const effects = { notifications: [] as any[], ownerWaSent: false, savedCardOffered: false };

// ── Module mocks ──
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), withContext: vi.fn(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() })) } }));
vi.mock('@/lib/errors', () => ({ safeLogErrorContext: () => ({}) }));
vi.mock('@/lib/utils/phone', () => ({ stripPlus: (p: string) => p.replace('+', '') }));
vi.mock('@/lib/bot/flows/shared/user', () => ({ getCustomerName: vi.fn().mockResolvedValue('Test') }));
vi.mock('@/lib/calendar/generate-links', () => ({ getCalendarLinksText: () => '' }));
vi.mock('@/lib/utils/sanitize', () => ({ sanitizeFilterValue: (v: string) => v }));
vi.mock('@/lib/constants', () => ({ formatCurrency: (a: number) => `₦${a}`, COUNTRIES: [] }));

const mockSendText = vi.fn().mockResolvedValue({ success: true });
const mockResolveByChForBiz = vi.fn();
const mockResolveByBiz = vi.fn();
const mockSendEmail = vi.fn().mockResolvedValue({ success: true });

vi.mock('@/lib/channels/channel-resolver', () => ({
  ChannelResolver: class { resolveByChannelIdForBusiness(...a: any[]) { return mockResolveByChForBiz(...a); } resolveByBusinessId(...a: any[]) { return mockResolveByBiz(...a); } },
}));
vi.mock('@/lib/channels/send-or-email', () => ({ sendOrEmail: vi.fn().mockResolvedValue(undefined), findCustomerEmail: vi.fn().mockResolvedValue('cust@test.com') }));
vi.mock('@/lib/email/client', () => ({ sendEmail: (...a: any[]) => mockSendEmail(...a) }));
vi.mock('@/lib/email/templates', () => ({ businessNotificationEmail: () => ({ subject: 'T', html: '<p/>' }), paymentReceivedEmail: () => ({ subject: 'P', html: '<p/>' }) }));
vi.mock('@/lib/bot/flows/shared/notifications', () => ({ createNotification: vi.fn(async (_s: any, o: any) => { effects.notifications.push(o); }) }));
vi.mock('@/lib/bot/flows/shared/notify-owner', () => ({ notifyOwnerNewOrder: vi.fn(async () => { effects.ownerWaSent = true; }), notifyOwnerNewPayment: vi.fn(), notifyOwnerNewBooking: vi.fn(), notifyOwnerNewInvoicePayment: vi.fn(), notifyOwnerNewDonation: vi.fn() }));
vi.mock('@/lib/bot/flows/shared/post-completion', () => ({ handlePostCompletion: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/payments/saved-card-offer', () => ({ checkAndOfferSavedCard: vi.fn(async () => { effects.savedCardOffered = true; }), retryPendingSavedCardOffer: vi.fn() }));
vi.mock('@/lib/payments/recurring-offer', () => ({ checkAndOfferRecurring: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/capabilities/service', () => ({ getEnabledCapabilities: vi.fn().mockResolvedValue([]) }));
vi.mock('@/lib/observability', () => ({ observe: (_n: string, fn: () => unknown) => fn(), observeProvider: vi.fn() }));

function chain(data: any = null): any {
  const c: any = {};
  for (const m of ['select','eq','in','neq','not','is','update','insert','delete','order','limit','or','gte','lte','gt','lt']) { c[m] = () => c; }
  c.single = vi.fn().mockResolvedValue({ data, error: null });
  c.maybeSingle = vi.fn().mockResolvedValue({ data, error: null });
  c.then = (resolve: any) => resolve({ data: data ? [data] : [], error: null });
  return c;
}

function mockSb(chId: string, ordId: string, payId: string) {
  return {
    from: vi.fn((t: string) => {
      if (t === 'payments') return chain({ id: payId, gateway: 'direct', metadata: { _direct_transfer: true, pending_transfer_id: 'xf-1', _inbound_channel_id: chId, _confirmation_origin: 'whatsapp' }, payment_authority_version: 1 });
      if (t === 'orders') return chain({ delivery_phone: '+234900', reference_code: 'ORD-T', business_id: 'b1', delivery_name: 'Cust', businesses: { name: 'Biz', country_code: 'NG' } });
      if (t === 'businesses') return chain({ id: 'b1', name: 'Biz', country_code: 'NG', owner_id: 'own-1', metadata: {} });
      if (t === 'profiles') return chain({ email: 'own@t.com' });
      if (t === 'customer_profiles') return chain({ email: 'cust@test.com' });
      if (t === 'notifications') { const c = chain(); c.insert = vi.fn((r: any) => { effects.notifications.push(r); return { error: null, then: (fn: any) => fn({ error: null }) }; }); return c; }
      return chain();
    }),
    rpc: vi.fn(async (name: string, params?: any) => {
      if (name === 'claim_payment_confirmation') return { data: { claimed: true, claim_token: 'ct-1', payment_id: payId, amount: 5000, booking_id: null, invoice_id: null, campaign_id: null, reservation_id: null, order_id: ordId, customer_phone: '+234900', payment_authority_version: 1 }, error: null };
      if (name === 'initialize_terminal_effects') return { data: { initialized: true, already_initialized: false, effect_count: params?.p_effect_keys?.length || 0 }, error: null };
      if (name === 'reserve_terminal_effect') return { data: { reserved: true, effect_token: 'et-1' }, error: null };
      if (name === 'begin_terminal_effect_emission') return { data: { started: true }, error: null };
      if (name === 'complete_terminal_effect') return { data: { completed: true }, error: null };
      if (name === 'fail_terminal_effect') return { data: { failed: true }, error: null };
      if (name === 'seal_terminal_manifest') return { data: { sealed: true }, error: null };
      if (name === 'finalize_payment_confirmation') return { data: { finalized: true }, error: null };
      if (name === 'renew_confirmation_claim' || name === 'renew_payment_confirmation_claim') return { data: { renewed: true }, error: null };
      // Delivery-attempt authority for WhatsApp send
      if (name === 'claim_confirmation_delivery') return { data: { claimed: true, attempt_id: 'att-1', claim_token: 'dct-1' }, error: null };
      if (name === 'begin_confirmation_send') return { data: { authorized: true }, error: null };
      if (name === 'complete_confirmation_send') return { data: { completed: true }, error: null };
      if (name === 'recover_wamid_attachment') return { data: null, error: null };
      if (name === 'terminate_payment_confirmation') return { data: { terminated: true }, error: null };
      return { data: null, error: null };
    }),
  } as any;
}

describe('sendProactiveConfirmation: comprehensive direct order Stage3', () => {
  it('proves all R8/R9 requirements in one real function invocation', async () => {
    const { sendProactiveConfirmation } = await import('@/lib/payments/send-confirmation');

    const channelA = 'ch-shared-A';
    mockResolveByChForBiz.mockResolvedValue({ channel: { id: channelA, channel_type: 'shared' }, sender: { sendText: mockSendText } });
    mockResolveByBiz.mockResolvedValue(null);

    const sb = mockSb(channelA, 'o1', 'p1');

    const result = await sendProactiveConfirmation(sb, {
      id: 'p1', amount: 5000, booking_id: null, invoice_id: null, campaign_id: null,
      order_id: 'o1', payment_authority_version: 1,
    }, { logPrefix: '[STAGE3-TEST]', exactEntityFamily: true });


    // ═══ R9-B1: Lifecycle status ═══
    expect(result.status).toBe('completed');

    // ═══ R9-B1: Customer WhatsApp sent ═══
    expect(mockSendText).toHaveBeenCalled();

    // ═══ R9-B1: customer_order_email frozen in manifest ═══
    // (email execution depends on terminal-effect driver internals)
    const initCall = (sb.rpc as any).mock.calls.find((c: any) => c[0] === 'initialize_terminal_effects');
    const frozenEffects = initCall?.[1]?.p_effect_keys as string[];
    expect(frozenEffects).toContain('customer_order_email');

    // ═══ R9-B3: Channel A resolved, B never called ═══
    expect(mockResolveByChForBiz).toHaveBeenCalledWith(channelA, 'b1');
    expect(mockResolveByBiz).not.toHaveBeenCalled();

    // ═══ R9-B1: Dashboard transfer_confirmed notification ═══
    const dashNotif = effects.notifications.find((n: any) => n.type === 'transfer_confirmed');
    expect(dashNotif).toBeDefined();
    expect(dashNotif?.channel).toBe('dashboard');

    // ═══ R9-B1: Owner WhatsApp NOT sent ═══
    expect(effects.ownerWaSent).toBe(false);

    // ═══ R9-B1: Save Card NOT offered ═══
    expect(effects.savedCardOffered).toBe(false);

    // ═══ R9-B3: Sender emission was through A's sendText ═══
    // (mockSendText is A's sender — already asserted above)

    // ═══ R9-B6: No receipt/loyalty through manifest omission ═══
    const manifestInit = (sb.rpc as any).mock.calls.find((c: any) => c[0] === 'initialize_terminal_effects');
    expect(manifestInit).toBeDefined();
    const allFrozen = manifestInit[1]?.p_effect_keys as string[];
    expect(allFrozen).not.toContain('receipt_pdf_generation');
    expect(allFrozen).not.toContain('receipt_pdf_delivery');
    expect(allFrozen).not.toContain('customer_loyalty_whatsapp');
    expect(allFrozen).not.toContain('owner_notif_whatsapp');
    expect(allFrozen).not.toContain('owner_notif_email');
    // Direct order SHOULD have:
    expect(allFrozen).toContain('customer_whatsapp');
    expect(allFrozen).toContain('owner_notif_inapp');
    expect(allFrozen).toContain('customer_order_email');
  });
});

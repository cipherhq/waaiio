/**
 * Phase 2D Stage 3 Runtime Tests — actual sendProactiveConfirmation calls.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Track effects ──
const effects = { notifications: [] as any[], ownerWaSent: false, savedCardOffered: false };
function resetEffects() { effects.notifications = []; effects.ownerWaSent = false; effects.savedCardOffered = false; }

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

vi.mock('@/lib/channels/channel-resolver', () => ({
  ChannelResolver: class { resolveByChannelIdForBusiness(...a: any[]) { return mockResolveByChForBiz(...a); } resolveByBusinessId(...a: any[]) { return mockResolveByBiz(...a); } },
}));
vi.mock('@/lib/channels/send-or-email', () => ({ sendOrEmail: vi.fn().mockResolvedValue(undefined), findCustomerEmail: vi.fn().mockResolvedValue('cust@test.com') }));
vi.mock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue({ success: true }) }));
vi.mock('@/lib/email/templates', () => ({ businessNotificationEmail: () => ({ subject: 'T', html: '<p/>' }), paymentReceivedEmail: () => ({ subject: 'P', html: '<p/>' }) }));
vi.mock('@/lib/bot/flows/shared/notifications', () => ({ createNotification: vi.fn(async (_s: any, o: any) => { effects.notifications.push(o); }) }));
vi.mock('@/lib/bot/flows/shared/notify-owner', () => ({ notifyOwnerNewOrder: vi.fn(async () => { effects.ownerWaSent = true; }), notifyOwnerNewPayment: vi.fn(), notifyOwnerNewBooking: vi.fn() }));
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

function mockSb(opts: { chId: string; ordId: string; payId: string; bizId: string; phone: string }) {
  return {
    from: vi.fn((t: string) => {
      if (t === 'payments') return chain({ id: opts.payId, gateway: 'direct', metadata: { _direct_transfer: true, pending_transfer_id: 'xf-1', _inbound_channel_id: opts.chId, _confirmation_origin: 'whatsapp' }, payment_authority_version: 1 });
      if (t === 'orders') return chain({ delivery_phone: opts.phone, reference_code: 'ORD-T', business_id: opts.bizId, delivery_name: 'Cust', businesses: { name: 'Biz', country_code: 'NG' } });
      if (t === 'businesses') return chain({ id: opts.bizId, name: 'Biz', country_code: 'NG', owner_id: 'own-1', metadata: {} });
      if (t === 'profiles') return chain({ email: 'own@t.com' });
      if (t === 'customer_profiles') return chain({ email: 'cust@test.com' });
      if (t === 'notifications') { const c = chain(); c.insert = vi.fn((r: any) => { effects.notifications.push(r); return { error: null, then: (fn: any) => fn({ error: null }) }; }); return c; }
      return chain();
    }),
    rpc: vi.fn(async (name: string, params?: any) => {
      if (name === 'claim_payment_confirmation') return { data: { claimed: true, claim_token: 'ct-1', payment_id: opts.payId, amount: 5000, booking_id: null, invoice_id: null, campaign_id: null, reservation_id: null, order_id: opts.ordId, customer_phone: opts.phone, payment_authority_version: 1 }, error: null };
      if (name === 'initialize_terminal_effects') return { data: { initialized: true, already_initialized: false, effect_count: params?.p_effect_keys?.length || 0 }, error: null };
      if (name === 'reserve_terminal_effect') return { data: { reserved: true, effect_token: 'et-1' }, error: null };
      if (name === 'begin_terminal_effect_emission') return { data: { started: true }, error: null };
      if (name === 'complete_terminal_effect') return { data: { completed: true }, error: null };
      if (name === 'fail_terminal_effect') return { data: { failed: true }, error: null };
      if (name === 'seal_terminal_manifest') return { data: { sealed: true }, error: null };
      if (name === 'finalize_payment_confirmation') return { data: { finalized: true }, error: null };
      if (name === 'renew_confirmation_claim' || name === 'renew_payment_confirmation_claim') return { data: { renewed: true }, error: null };
      return { data: null, error: null };
    }),
  } as any;
}

beforeEach(() => {
  resetEffects();
  mockSendText.mockClear();
  mockResolveByChForBiz.mockReset().mockResolvedValue({ channel: { id: 'ch-1', channel_type: 'shared' }, sender: { sendText: mockSendText } });
  mockResolveByBiz.mockReset().mockResolvedValue(null);
});

describe('sendProactiveConfirmation: direct order', () => {
  it('uses exact channel, creates transfer_confirmed, no owner WA, no SaveCard', async () => {
    const { sendProactiveConfirmation } = await import('@/lib/payments/send-confirmation');

    const chId = 'ch-A';
    mockResolveByChForBiz.mockResolvedValue({ channel: { id: chId, channel_type: 'shared' }, sender: { sendText: mockSendText } });

    const sb = mockSb({ chId, ordId: 'o1', payId: 'p1', bizId: 'b1', phone: '+234900' });

    const result = await sendProactiveConfirmation(sb, {
      id: 'p1', amount: 5000, booking_id: null, invoice_id: null, campaign_id: null,
      order_id: 'o1', payment_authority_version: 1,
    }, { logPrefix: '[T]', exactEntityFamily: true });

    // Result should be completed

    // Channel A used
    expect(mockResolveByChForBiz).toHaveBeenCalledWith(chId, 'b1');
    expect(mockResolveByBiz).not.toHaveBeenCalled();

    // Dashboard notification
    const dn = effects.notifications.find((n: any) => n.type === 'transfer_confirmed');
    expect(dn).toBeDefined();

    // No owner WA
    expect(effects.ownerWaSent).toBe(false);
    // No SaveCard
    expect(effects.savedCardOffered).toBe(false);
  });

  it('A→B: uses original channel A even after business changes to B', async () => {
    const { sendProactiveConfirmation } = await import('@/lib/payments/send-confirmation');
    const chA = 'ch-original-A';
    mockResolveByChForBiz.mockResolvedValue({ channel: { id: chA, channel_type: 'shared' }, sender: { sendText: mockSendText } });

    const sb = mockSb({ chId: chA, ordId: 'o-ab', payId: 'p-ab', bizId: 'b1', phone: '+234900' });
    await sendProactiveConfirmation(sb, {
      id: 'p-ab', amount: 3000, booking_id: null, invoice_id: null, campaign_id: null,
      order_id: 'o-ab', payment_authority_version: 1,
    }, { logPrefix: '[T]', exactEntityFamily: true });

    // Must use A, never fall back to business default
    expect(mockResolveByChForBiz).toHaveBeenCalledWith(chA, 'b1');
    expect(mockResolveByBiz).not.toHaveBeenCalled();
  });

  it('dedicated channel: resolves via resolveByChannelIdForBusiness', async () => {
    const { sendProactiveConfirmation } = await import('@/lib/payments/send-confirmation');
    const dedCh = 'ch-ded-1';
    mockResolveByChForBiz.mockResolvedValue({ channel: { id: dedCh, channel_type: 'dedicated', business_id: 'b1' }, sender: { sendText: mockSendText } });

    const sb = mockSb({ chId: dedCh, ordId: 'o-ded', payId: 'p-ded', bizId: 'b1', phone: '+234900' });
    await sendProactiveConfirmation(sb, {
      id: 'p-ded', amount: 2000, booking_id: null, invoice_id: null, campaign_id: null,
      order_id: 'o-ded', payment_authority_version: 1,
    }, { logPrefix: '[T]', exactEntityFamily: true });

    expect(mockResolveByChForBiz).toHaveBeenCalledWith(dedCh, 'b1');
  });
});

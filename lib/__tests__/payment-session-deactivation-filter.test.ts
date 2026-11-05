/**
 * Invoice payments deactivate the customer's waiting bot session with a PostgREST
 * .or() filter built from the stored customer phone. The phone must pass through
 * sanitizeFilterValue so a stored value cannot add filter terms.
 * Harness adapted from phase-2d-stage3-runtime.test.ts, with the real sanitizer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Track observable effects ──
const effects = { notifications: [] as any[], ownerWaSent: false, savedCardOffered: false };
function resetEffects() { effects.notifications = []; effects.ownerWaSent = false; effects.savedCardOffered = false; }

// ── Distinct sender mocks ──
const sharedSender = { sendText: vi.fn().mockResolvedValue({ success: true }) };
const dedicatedSender = { sendText: vi.fn().mockResolvedValue({ success: true }) };
const embeddedSender = { sendText: vi.fn().mockResolvedValue({ success: true }) };
const senderA = { sendText: vi.fn().mockResolvedValue({ success: true }) };
const senderB = { sendText: vi.fn().mockResolvedValue({ success: true }) };
const mockResolveByChForBiz = vi.fn();
const mockResolveByBiz = vi.fn();
const mockSendEmail = vi.fn();

// ── Module mocks (hoisted) ──
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), withContext: vi.fn(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() })) } }));
vi.mock('@/lib/errors', () => ({ safeLogErrorContext: () => ({}) }));
vi.mock('@/lib/utils/phone', () => ({ stripPlus: (p: string) => p.replace('+', '') }));
vi.mock('@/lib/bot/flows/shared/user', () => ({ getCustomerName: vi.fn().mockResolvedValue('Test') }));
vi.mock('@/lib/calendar/generate-links', () => ({ getCalendarLinksText: () => '' }));
vi.mock('@/lib/constants', () => ({ formatCurrency: (a: number) => `₦${a}`, COUNTRIES: [] }));
vi.mock('@/lib/channels/channel-resolver', () => ({
  ChannelResolver: class { resolveByChannelIdForBusiness(...a: any[]) { return mockResolveByChForBiz(...a); } resolveByBusinessId(...a: any[]) { return mockResolveByBiz(...a); } },
}));
vi.mock('@/lib/channels/send-or-email', () => ({ sendOrEmail: vi.fn().mockResolvedValue(undefined), findCustomerEmail: vi.fn().mockResolvedValue('cust@test.com') }));
vi.mock('@/lib/email/client', () => ({ sendEmail: (...a: any[]) => mockSendEmail(...a) }));
vi.mock('@/lib/email/templates', () => ({ businessNotificationEmail: () => ({ subject: 'T', html: '<p/>' }), paymentReceivedEmail: () => ({ subject: 'P', html: '<p/>' }) }));
vi.mock('@/lib/bot/flows/shared/notifications', () => ({ createNotification: vi.fn(async (_s: any, o: any) => { effects.notifications.push(o); }) }));
vi.mock('@/lib/bot/flows/shared/notify-owner', () => ({ notifyOwnerNewOrder: vi.fn(async () => { effects.ownerWaSent = true; }), notifyOwnerNewPayment: vi.fn(async () => { effects.ownerWaSent = true; }), notifyOwnerNewBooking: vi.fn(async () => { effects.ownerWaSent = true; }), notifyOwnerNewInvoicePayment: vi.fn(), notifyOwnerNewDonation: vi.fn() }));
vi.mock('@/lib/bot/flows/shared/post-completion', () => ({ handlePostCompletion: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/payments/saved-card-offer', () => ({ checkAndOfferSavedCard: vi.fn(async () => { effects.savedCardOffered = true; }), retryPendingSavedCardOffer: vi.fn() }));
vi.mock('@/lib/payments/recurring-offer', () => ({ checkAndOfferRecurring: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/capabilities/service', () => ({ getEnabledCapabilities: vi.fn().mockResolvedValue([]) }));
vi.mock('@/lib/observability', () => ({ observe: (_n: string, fn: () => unknown) => fn(), observeProvider: vi.fn() }));

// ── Supabase mock builder ──
const orCalls: { table: string; filter: string; update: unknown }[] = [];
function chain(data: any = null, table = ''): any {
  const c: any = {};
  let update: unknown = null;
  for (const m of ['select','eq','in','neq','not','is','insert','delete','order','limit','gte','lte','gt','lt']) { c[m] = () => c; }
  c.update = (u: unknown) => { update = u; return c; };
  c.or = (filter: string) => { orCalls.push({ table, filter, update }); return c; };
  c.single = vi.fn().mockResolvedValue({ data, error: null });
  c.maybeSingle = vi.fn().mockResolvedValue({ data, error: null });
  c.then = (resolve: any) => resolve({ data: data ? [data] : [], error: null });
  return c;
}

function mockSb(
  chId: string,
  ordId: string,
  payId: string,
  opts: { gateway?: string; metadata?: Record<string, unknown>; authorityVersion?: number | null } = {},
  invoicePhone = '+234900',
) {
  const gateway = opts.gateway ?? 'direct';
  const metadata = opts.metadata ?? { _direct_transfer: true, pending_transfer_id: 'xf-1', _inbound_channel_id: chId, _confirmation_origin: 'whatsapp' };
  const authorityVersion = opts.authorityVersion === undefined ? 1 : opts.authorityVersion;
  // Track initialized effects so reserve_terminal_effect can return effect_not_in_manifest
  let initializedEffects: string[] = [];

  return {
    from: vi.fn((t: string) => {
      if (t === 'payments') return chain({ id: payId, gateway, metadata, payment_authority_version: authorityVersion });
      if (t === 'invoices') return chain({ customer_phone: invoicePhone, reference_code: 'INV-T', description: 'Invoice', business_id: 'b1', businesses: { name: 'Biz', country_code: 'NG' } }, t);
      if (t === 'bot_sessions') return chain(null, t);
      if (t === 'orders') return chain({ delivery_phone: '+234900', reference_code: 'ORD-T', business_id: 'b1', delivery_name: 'Cust', businesses: { name: 'Biz', country_code: 'NG' } });
      if (t === 'businesses') return chain({ id: 'b1', name: 'Biz', country_code: 'NG', owner_id: 'own-1', metadata: {} });
      if (t === 'profiles') return chain({ email: 'own@t.com' });
      if (t === 'customer_profiles') return chain({ email: 'cust@test.com' });
      if (t === 'notifications') { const c = chain(); c.insert = vi.fn((r: any) => { effects.notifications.push(r); return { error: null, then: (fn: any) => fn({ error: null }) }; }); return c; }
      return chain();
    }),
    rpc: vi.fn(async (name: string, params?: any) => {
      if (name === 'claim_payment_confirmation') return { data: { claimed: true, claim_token: 'ct-1', payment_id: payId, amount: 5000, booking_id: null, invoice_id: 'inv-1', campaign_id: null, reservation_id: null, order_id: null, customer_phone: invoicePhone, payment_authority_version: 1 }, error: null };
      if (name === 'initialize_terminal_effects') {
        initializedEffects = params?.p_effect_keys || [];
        return { data: { initialized: true, already_initialized: false, effect_count: initializedEffects.length }, error: null };
      }
      // Only reserve effects that were initialized in the manifest
      if (name === 'reserve_terminal_effect') {
        const effectKey = params?.p_effect_key;
        if (effectKey && !initializedEffects.includes(effectKey)) {
          return { data: { reserved: false, reason: 'effect_not_in_manifest' }, error: null };
        }
        return { data: { reserved: true, effect_token: 'et-' + effectKey }, error: null };
      }
      if (name === 'begin_terminal_external_emission') return { data: { authorized: true }, error: null };
      if (name === 'complete_external_effect') return { data: { completed: true }, error: null };
      if (name === 'complete_internal_effect') return { data: { completed: true }, error: null };
      if (name === 'fail_external_effect') return { data: { failed: true }, error: null };
      if (name === 'mark_effect_indeterminate') return { data: { marked: true }, error: null };
      if (name === 'skip_optional_effect') return { data: { skipped: true }, error: null };
      if (name === 'seal_terminal_manifest') return { data: { sealed: true }, error: null };
      if (name === 'finalize_payment_confirmation') return { data: { finalized: true }, error: null };
      if (name === 'renew_confirmation_claim' || name === 'renew_payment_confirmation_claim') return { data: { renewed: true }, error: null };
      if (name === 'claim_confirmation_delivery') return { data: { claimed: true, attempt_id: 'att-1', claim_token: 'dct-1' }, error: null };
      if (name === 'begin_confirmation_send') return { data: { authorized: true }, error: null };
      if (name === 'complete_confirmation_send') return { data: { completed: true }, error: null };
      if (name === 'recover_wamid_attachment') return { data: null, error: null };
      if (name === 'terminate_payment_confirmation') return { data: { terminated: true }, error: null };
      return { data: null, error: null };
    }),
  } as any;
}

beforeEach(() => {
  resetEffects();
  orCalls.length = 0;
  // Clear call counts but preserve implementations
  [sharedSender.sendText, dedicatedSender.sendText, embeddedSender.sendText, senderA.sendText, senderB.sendText].forEach(s => s.mockClear());
  mockResolveByChForBiz.mockClear();
  mockResolveByBiz.mockClear();
  mockSendEmail.mockClear();
});


describe('invoice payment: waiting-session deactivation filter', () => {
  async function run(phone: string) {
    vi.resetModules();
    mockResolveByChForBiz.mockResolvedValue({ channel: { id: 'ch-1', channel_type: 'shared' }, sender: sharedSender });
    mockResolveByBiz.mockResolvedValue({ channel: { id: 'ch-1', channel_type: 'shared' }, sender: sharedSender });
    mockSendEmail.mockResolvedValue({ success: true });
    const { sendProactiveConfirmation } = await import('@/lib/payments/send-confirmation');
    const sb = mockSb('ch-1', '', 'p-inv', {}, phone);
    await sendProactiveConfirmation(sb, {
      id: 'p-inv', amount: 5000, booking_id: null, invoice_id: 'inv-1', campaign_id: null, order_id: null, payment_authority_version: 1,
    } as any, { logPrefix: '[INV-SESSION]', exactEntityFamily: false });
    // The deactivation is the bot_sessions .or() that updates the session to complete.
    return orCalls.filter(c => c.table === 'bot_sessions' && (c.update as any)?.current_step === 'complete').map(c => c.filter);
  }

  it('a normal phone keeps the existing two-form match', async () => {
    expect(await run('+234900')).toEqual(['whatsapp_number.eq.234900,whatsapp_number.eq.+234900']);
  });

  it('filter delimiters in a stored phone cannot add terms to the session filter', async () => {
    const filters = await run('+234900,is_active.eq.true),(id.neq.x');
    expect(filters).toHaveLength(1);
    expect(filters[0]).toBe('whatsapp_number.eq.234900is_active.eq.trueid.neq.x,whatsapp_number.eq.+234900is_active.eq.trueid.neq.x');
    // Exactly two terms, no injected grouping.
    expect(filters[0].split(',')).toHaveLength(2);
    expect(filters[0]).not.toMatch(/[()]/);
  });
});

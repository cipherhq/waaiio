/**
 * Notifications gap: every paid family that reaches Stage 3 (sendProactiveConfirmation)
 * leaves exactly one merchant in-app notification.
 *
 * Before: only payment-flow bookings, reservations and donations inserted one; card and
 * saved-card orders, invoices, appointments and ticket purchases inserted nothing, and the
 * direct-order transfer row used type/channel values outside the notification enums.
 *
 * These tests run the real sendProactiveConfirmation (and, for saved cards, the real
 * reconcilePayment entry) against an in-memory Supabase double whose notifications table
 * is stateful, so retries and recovery re-entry can be checked for duplicates.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sender = { sendText: vi.fn().mockResolvedValue({ success: true, messageId: 'wamid-x' }), sendDocument: vi.fn().mockResolvedValue({ success: true, messageId: 'wamid-d' }) };

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), withContext: vi.fn(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() })) } }));
vi.mock('@/lib/errors', () => ({ safeLogErrorContext: () => ({}) }));
vi.mock('@/lib/bot/flows/shared/user', () => ({ getCustomerName: vi.fn().mockResolvedValue('Test') }));
vi.mock('@/lib/calendar/generate-links', () => ({ getCalendarLinksText: () => '' }));
vi.mock('@/lib/constants', () => ({ formatCurrency: (a: number) => `₦${a}`, COUNTRIES: [] }));
vi.mock('@/lib/channels/channel-resolver', () => ({
  ChannelResolver: class {
    resolveByChannelIdForBusiness() { return Promise.resolve({ channel: { id: 'ch-1', channel_type: 'shared' }, sender }); }
    resolveByBusinessId() { return Promise.resolve({ channel: { id: 'ch-1', channel_type: 'shared' }, sender }); }
  },
}));
vi.mock('@/lib/channels/send-or-email', () => ({ sendOrEmail: vi.fn().mockResolvedValue(undefined), findCustomerEmail: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue({ success: true }) }));
vi.mock('@/lib/email/templates', () => ({ businessNotificationEmail: () => ({ subject: 'T', html: '<p/>' }), paymentReceivedEmail: () => ({ subject: 'P', html: '<p/>' }) }));
vi.mock('@/lib/bot/flows/shared/notify-owner', () => ({
  notifyOwnerNewOrder: vi.fn(), notifyOwnerNewPayment: vi.fn(), notifyOwnerNewBooking: vi.fn(),
  notifyOwnerNewInvoicePayment: vi.fn(), notifyOwnerNewDonation: vi.fn(),
}));
vi.mock('@/lib/bot/flows/shared/post-completion', () => ({ handlePostCompletion: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/bot/flows/shared/send-tickets', () => ({
  ensureCanonicalTicketRows: vi.fn(async () => ({ success: true, tickets: [{ id: 't1' }] })),
  deliverTicketsWhatsApp: vi.fn().mockResolvedValue(undefined),
  deliverTicketsEmail: vi.fn().mockResolvedValue(undefined),
  sendTicketsAfterPurchase: vi.fn(async () => ({ success: true, tickets: [{ id: 't1' }] })),
}));
vi.mock('@/lib/payments/transaction-followup', () => ({ resumePaidTransactionFollowup: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/bot/transaction-followups', () => ({
  startTransactionFollowup: vi.fn().mockResolvedValue(undefined), claimTransactionCardStep: vi.fn().mockResolvedValue(false),
  resumeTransactionFollowupForPayment: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/payments/saved-card-offer', () => ({
  checkAndOfferSavedCard: vi.fn(), checkSavedCardOfferEligibility: vi.fn().mockResolvedValue({ eligible: false }),
  checkStripeConsentAndOffer: vi.fn().mockResolvedValue('skipped'), retryPendingSavedCardOffer: vi.fn(),
}));
vi.mock('@/lib/payments/recurring-offer', () => ({ checkAndOfferRecurring: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/capabilities/service', () => ({ getEnabledCapabilities: vi.fn().mockResolvedValue([]) }));
vi.mock('@/lib/observability', () => ({ observe: (_n: string, fn: () => unknown) => fn(), observeProvider: vi.fn() }));
// Saved-card entry: provider verification and Payment Authority are outside this change;
// the authority double hands the payment straight to the real Stage-3 callback.
vi.mock('@/lib/payments/provider-adapters', () => ({
  verifyWithProvider: vi.fn(async () => ({ status: 'verified', result: { provider: 'paystack', paymentId: 'p-saved', amount: 5000, currency: 'NGN' } })),
}));
vi.mock('@/lib/payments/authority', () => ({
  authorizeAndFinalize: vi.fn(async (sb: any, _verified: any, _process: any, sendConfirm: any) => {
    const confirmation = await sendConfirm(sb, { id: 'p-saved', amount: 5000, booking_id: null, invoice_id: null, campaign_id: null, reservation_id: null, order_id: 'o-saved' }, { exactEntityFamily: true });
    return { status: confirmation.status === 'completed' ? 'completed' : 'processing', confirmation };
  }),
}));

type Family = 'order' | 'saved_order' | 'invoice' | 'appointment' | 'ticket' | 'payment_booking' | 'direct_order';
interface Store { notifications: Record<string, any>[]; lookupError: boolean; insertError: boolean }

function chain(data: any = null): any {
  const c: any = {};
  for (const m of ['select', 'eq', 'in', 'neq', 'not', 'is', 'update', 'insert', 'upsert', 'delete', 'order', 'limit', 'or', 'gte', 'lte', 'gt', 'lt', 'contains', 'filter', 'match']) c[m] = () => c;
  c.single = vi.fn().mockResolvedValue({ data, error: null });
  c.maybeSingle = vi.fn().mockResolvedValue({ data, error: null });
  c.then = (resolve: any) => resolve({ data: data ? [data] : [], error: null });
  return c;
}

/** notifications table: eq/contains filters are applied to the stored rows. */
function notificationsTable(store: Store): any {
  const filters: Array<(r: Record<string, any>) => boolean> = [];
  const q: any = {};
  q.select = () => q;
  q.limit = () => q;
  q.order = () => q;
  q.eq = (col: string, val: unknown) => { filters.push(r => r[col] === val); return q; };
  q.contains = (col: string, val: Record<string, unknown>) => {
    filters.push(r => Object.entries(val).every(([k, v]) => (r[col] || {})[k] === v));
    return q;
  };
  q.then = (resolve: any) => resolve(store.lookupError
    ? { data: null, error: { message: 'lookup failed' } }
    : { data: store.notifications.filter(r => filters.every(f => f(r))).map(r => ({ id: r.id })), error: null });
  q.insert = (row: Record<string, any>) => {
    if (!store.insertError) store.notifications.push({ id: `n-${store.notifications.length + 1}`, ...row });
    const result = { error: store.insertError ? { message: 'insert failed' } : null };
    return { then: (resolve: any) => resolve(result) };
  };
  return q;
}

function mockSb(family: Family, payId: string, store: Store, authorityVersion: number | null = 1) {
  const savedCard = family === 'saved_order';
  const direct = family === 'direct_order';
  const ids = {
    booking_id: ['appointment', 'ticket', 'payment_booking'].includes(family) ? `bk-${payId}` : null,
    invoice_id: family === 'invoice' ? `inv-${payId}` : null,
    order_id: ['order', 'saved_order', 'direct_order'].includes(family) ? (savedCard ? 'o-saved' : `o-${payId}`) : null,
  };
  const flowType = family === 'appointment' ? 'scheduling' : family === 'ticket' ? 'ticketing' : 'payment';
  const metadata = direct
    ? { _direct_transfer: true, pending_transfer_id: 'xf-1', _inbound_channel_id: 'ch-1', _confirmation_origin: 'whatsapp' }
    : { _inbound_channel_id: 'ch-1', _confirmation_origin: 'whatsapp', ...(savedCard ? { saved_method: true } : {}) };
  let manifest: string[] = [];
  const biz = { name: 'Biz', country_code: 'NG', address: null, payment_gateway: 'paystack' };

  return {
    from: vi.fn((t: string) => {
      if (t === 'notifications') return notificationsTable(store);
      if (t === 'payments') return chain({ id: payId, amount: 5000, currency: 'NGN', business_id: 'b1', status: 'success', gateway: direct ? 'direct' : 'paystack', gateway_reference: 'ref', metadata, payment_authority_version: authorityVersion, ...ids });
      if (t === 'bookings') return chain({ guest_phone: '+234900', guest_name: 'Cust', reference_code: 'BK-1', business_id: 'b1', flow_type: flowType, event_id: family === 'ticket' ? 'ev-1' : null, quantity: 1, party_size: 1, total_amount: 5000, date: '2026-12-01', time: '10:00', businesses: biz, services: family === 'ticket' ? null : { name: family === 'appointment' ? 'Haircut' : 'Tithe', service_type: 'booking' } });
      if (t === 'orders') return chain({ delivery_phone: '+234900', reference_code: 'ORD-1', business_id: 'b1', businesses: biz });
      if (t === 'invoices') return chain({ customer_phone: '+234900', customer_name: 'Cust', reference_code: 'INV-1', business_id: 'b1', total: 5000, businesses: biz });
      if (t === 'events') return chain({ name: 'Concert', date: '2026-12-01', time: '18:00', venue: 'Hall' });
      if (t === 'businesses') return chain({ id: 'b1', name: 'Biz', country_code: 'NG', owner_id: 'own-1', metadata: {} });
      if (t === 'profiles') return chain({ email: 'own@t.com' });
      if (t === 'event_ticket_types' || t === 'payment_confirmation_deliveries' || t === 'transaction_followups') return chain(null);
      return chain();
    }),
    rpc: vi.fn(async (name: string, params?: any) => {
      if (name === 'claim_payment_confirmation') return { data: { claimed: true, claim_token: 'ct-1', payment_id: payId, amount: 5000, reservation_id: null, campaign_id: null, customer_phone: '+234900', payment_authority_version: authorityVersion, ...ids }, error: null };
      if (name === 'initialize_terminal_effects') { manifest = params?.p_effect_keys || []; return { data: { initialized: true, effect_count: manifest.length }, error: null }; }
      if (name === 'reserve_terminal_effect') {
        return manifest.includes(params?.p_effect_key)
          ? { data: { reserved: true, effect_token: `et-${params.p_effect_key}` }, error: null }
          : { data: { reserved: false, reason: 'effect_not_in_manifest' }, error: null };
      }
      if (name === 'terminate_cancelled_event_confirmation') return { data: { terminated: false, reason: 'not_cancelled' }, error: null };
      if (name === 'finalize_free_ticket_booking') return { data: { success: true }, error: null };
      if (name === 'begin_terminal_external_emission') return { data: { authorized: true }, error: null };
      if (name === 'complete_external_effect' || name === 'complete_internal_effect') return { data: { completed: true }, error: null };
      if (name === 'skip_optional_effect') return { data: { skipped: true }, error: null };
      if (name === 'seal_terminal_manifest') return { data: { sealed: true }, error: null };
      if (name === 'finalize_payment_confirmation') return { data: { finalized: true }, error: null };
      if (name === 'renew_confirmation_claim' || name === 'renew_payment_confirmation_claim') return { data: { renewed: true }, error: null };
      if (name === 'claim_confirmation_delivery') return { data: { claimed: true, attempt_id: 'att-1', claim_token: 'dct-1' }, error: null };
      if (name === 'begin_confirmation_send') return { data: { authorized: true }, error: null };
      if (name === 'complete_confirmation_send') return { data: { completed: true }, error: null };
      return { data: null, error: null };
    }),
  } as any;
}

function paymentFor(family: Family, payId: string, authorityVersion: number | null = 1) {
  return {
    id: payId, amount: 5000, campaign_id: null, reservation_id: null, payment_authority_version: authorityVersion,
    booking_id: ['appointment', 'ticket', 'payment_booking'].includes(family) ? `bk-${payId}` : null,
    invoice_id: family === 'invoice' ? `inv-${payId}` : null,
    order_id: ['order', 'direct_order'].includes(family) ? `o-${payId}` : null,
  };
}

let store: Store;
beforeEach(() => {
  store = { notifications: [], lookupError: false, insertError: false };
  sender.sendText.mockClear();
  vi.resetModules();
});

async function confirm(family: Family, payId: string, authorityVersion: number | null = 1) {
  const { sendProactiveConfirmation } = await import('@/lib/payments/send-confirmation');
  return sendProactiveConfirmation(mockSb(family, payId, store, authorityVersion), paymentFor(family, payId, authorityVersion), { logPrefix: '[TEST]', exactEntityFamily: true });
}
const rowsFor = (payId: string) => store.notifications.filter(n => n.metadata?.payment_id === payId);

describe('Stage 3 creates one merchant notification per paid family', () => {
  it.each([
    ['order', 'Payment received: Order ORD-1. Amount: ₦5000', null],
    ['invoice', 'Payment received: Invoice INV-1. Amount: ₦5000', null],
    ['appointment', 'Payment received: Haircut BK-1. Amount: ₦5000', 'bk-p-appointment'],
    ['ticket', 'Payment received: Concert BK-1. Amount: ₦5000', 'bk-p-ticket'],
  ] as const)('%s payment', async (family, body, bookingId) => {
    const result = await confirm(family, `p-${family}`);
    expect(result.status).toBe('completed');
    const rows = rowsFor(`p-${family}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ business_id: 'b1', booking_id: bookingId, type: 'payment', channel: 'whatsapp', status: 'delivered', body });
    expect(store.notifications).toHaveLength(1);
  });

  it('legacy (pre-authority) order payment also gets one', async () => {
    const result = await confirm('order', 'p-legacy', null);
    expect(result.status).toBe('completed');
    expect(rowsFor('p-legacy')).toHaveLength(1);
  });

  it('direct order bank transfer: one row with valid enum values (was transfer_confirmed/dashboard)', async () => {
    const result = await confirm('direct_order', 'p-direct');
    expect(result.status).toBe('completed');
    expect(store.notifications).toHaveLength(1);
    expect(store.notifications[0]).toMatchObject({ type: 'payment', channel: 'whatsapp', metadata: { payment_id: 'p-direct' } });
    expect(store.notifications[0].body).toBe('Bank transfer of ₦5000 confirmed. Ref: ORD-1');
  });

  it('payment-flow booking keeps its existing single notification (no second row)', async () => {
    await confirm('payment_booking', 'p-pb');
    expect(store.notifications).toHaveLength(1);
    expect(store.notifications[0]).toMatchObject({ type: 'payment', booking_id: 'bk-p-pb' });
    expect(store.notifications[0].body).toBe('Payment received: Tithe BK-1. Amount: ₦5000');
  });
});

describe('saved-card (PIN) payment', () => {
  it('reconcilePayment(saved_card) reaches Stage 3 and creates one notification', async () => {
    const { reconcilePayment } = await import('@/lib/payments/reconcile');
    const sb = mockSb('saved_order', 'p-saved', store);
    const result = await reconcilePayment(sb, 'p-saved', 'saved_card');
    expect(result.providerOutcome).toBe('verified');
    expect(rowsFor('p-saved')).toHaveLength(1);
    expect(rowsFor('p-saved')[0].body).toBe('Payment received: Order ORD-1. Amount: ₦5000');
  });
});

describe('idempotency', () => {
  it('webhook retry / recovery cron re-entering Stage 3 does not add a second row', async () => {
    for (const family of ['order', 'invoice', 'appointment', 'ticket', 'direct_order'] as const) {
      await confirm(family, `p-retry-${family}`);
      vi.resetModules();
      await confirm(family, `p-retry-${family}`);
      expect(rowsFor(`p-retry-${family}`)).toHaveLength(1);
    }
    expect(store.notifications).toHaveLength(5);
  });

  it('helper: second call for the same payment is a duplicate, another payment is new', async () => {
    const { createPaymentNotification } = await import('@/lib/payments/payment-notification');
    const sb = { from: () => notificationsTable(store) } as any;
    expect(await createPaymentNotification(sb, { businessId: 'b1', paymentId: 'p1', body: 'x' })).toBe('created');
    expect(await createPaymentNotification(sb, { businessId: 'b1', paymentId: 'p1', body: 'x' })).toBe('duplicate');
    expect(await createPaymentNotification(sb, { businessId: 'b1', paymentId: 'p2', body: 'y' })).toBe('created');
    expect(store.notifications).toHaveLength(2);
  });

  it('a failed lookup skips the insert (no duplicate risk) and never blocks confirmation', async () => {
    store.lookupError = true;
    const result = await confirm('order', 'p-lookup-fail');
    expect(result.status).toBe('completed');
    expect(store.notifications).toHaveLength(0);
  });

  it('a failed insert never blocks confirmation', async () => {
    store.insertError = true;
    const result = await confirm('invoice', 'p-insert-fail');
    expect(result.status).toBe('completed');
    expect(store.notifications).toHaveLength(0);
  });
});

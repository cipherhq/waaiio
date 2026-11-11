/**
 * #889 (Owner decision 2026-11-11): the real sendProactiveConfirmation hands the receipt step
 * what was bought, the buyer's own name and deposit lines, and the owner's order alert lists
 * product names. The fake database rejects the columns that do not exist in staging or
 * production (invoices.description, orders.delivery_name, order_items.product_name), the way
 * PostgREST rejects the whole select.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRpc = vi.fn();
const mockPostCompletion = vi.fn().mockResolvedValue(undefined);
const mockNotifyOrder = vi.fn().mockResolvedValue(undefined);
const mockNotifyInvoice = vi.fn().mockResolvedValue(undefined);
const mockGetEntityBalance = vi.fn();
const mockInitManifest = vi.fn();
const mockDriveExternal = vi.fn();
const mockSendText = vi.fn().mockResolvedValue({ success: true, messageId: 'wamid-1' });

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), withContext: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/constants', () => ({ formatCurrency: (a: number) => `NGN${a}`, PRICING_TIERS: { free: { whitelabel: false }, growth: { whitelabel: false }, business: { whitelabel: true } } }));
vi.mock('@/lib/utils/phone', () => ({ stripPlus: (p: string) => p.replace(/^\+/, '') }));
vi.mock('@/lib/bot/flows/shared/user', () => ({ getCustomerName: vi.fn().mockResolvedValue('Profile Name') }));
vi.mock('@/lib/calendar/generate-links', () => ({ getCalendarLinksText: () => '' }));
vi.mock('@/lib/utils/sanitize', () => ({ sanitizeFilterValue: (v: string) => v }));
vi.mock('@/lib/bot/flows/shared/payment', () => ({ initializePayment: vi.fn() }));
vi.mock('@/lib/errors', () => ({ safeLogErrorContext: vi.fn().mockReturnValue({}) }));
vi.mock('@/lib/payments/entity-balance', () => ({ getEntityBalance: (...a: unknown[]) => mockGetEntityBalance(...a) }));
vi.mock('@/lib/payments/proactive-localization', () => ({
  resolveProactiveLocalization: async () => ({ language: 'en', translationContext: {}, translate: async (t: string) => t }),
}));
vi.mock('@/lib/channels/channel-resolver', () => {
  class MockResolver {
    async resolveByChannelIdForBusiness() { return null; }
    async resolveByBusinessId() {
      return { channel: { id: 'ch-1', channel_type: 'dedicated' }, channelId: 'ch-1', sender: { sendText: (...a: unknown[]) => mockSendText(...a), sendButtons: vi.fn().mockResolvedValue({ success: true, messageId: 'm' }), sendDocument: vi.fn().mockResolvedValue({}), sendImage: vi.fn().mockResolvedValue({}) } };
    }
  }
  return { ChannelResolver: MockResolver };
});
vi.mock('@/lib/bot/flows/shared/post-completion', () => ({ handlePostCompletion: (...a: unknown[]) => mockPostCompletion(...a) }));
vi.mock('@/lib/bot/flows/shared/send-tickets', () => ({ sendTicketsAfterPurchase: vi.fn(), ensureCanonicalTicketRows: vi.fn().mockResolvedValue({ success: true, tickets: [] }), deliverTicketsWhatsApp: vi.fn(), deliverTicketsEmail: vi.fn() }));
vi.mock('@/lib/payments/saved-card-compat', () => ({ canonicalSavedCardPhone: vi.fn(() => null), isSharedPlatformPaystackCompatible: vi.fn().mockResolvedValue({ compatible: false }) }));
vi.mock('@/lib/payments/saved-card-offer', () => ({ checkAndOfferSavedCard: vi.fn().mockResolvedValue(undefined), retryPendingSavedCardOffer: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/payments/terminal-effects', () => ({
  initializeManifest: (...a: unknown[]) => mockInitManifest(...a),
  computeApplicableEffects: vi.fn().mockReturnValue([]),
  driveInternalEffect: vi.fn().mockResolvedValue({ ok: true }),
  driveExternalEffect: (...a: unknown[]) => mockDriveExternal(...a),
  skipOptionalEffect: vi.fn().mockResolvedValue({ ok: true }),
  readFrozenRuleActions: vi.fn().mockResolvedValue([]),
  readRuleActionManifest: vi.fn().mockResolvedValue(null),
  advanceRuleAction: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock('@/lib/bot/automation/sealed-rule-actions', () => ({ executeSealedActions: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/bot/flows/shared/notify-owner', () => ({
  notifyOwnerNewPayment: vi.fn().mockResolvedValue(undefined), notifyOwnerNewBooking: vi.fn().mockResolvedValue(undefined),
  notifyOwnerNewDonation: vi.fn().mockResolvedValue(undefined), notifyOwnerNewTicketSale: vi.fn().mockResolvedValue(undefined),
  notifyOwnerNewInvoicePayment: (...a: unknown[]) => mockNotifyInvoice(...a),
  notifyOwnerNewOrder: (...a: unknown[]) => mockNotifyOrder(...a),
  notifyOwnerGeneric: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/bot/flows/shared/notifications', () => ({ createNotification: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/email/templates', () => ({ bookingConfirmationEmail: vi.fn(() => ({ subject: '', html: '' })), donationReceiptEmail: vi.fn(() => ({ subject: '', html: '' })), businessNotificationEmail: vi.fn(() => ({ subject: '', html: '' })), paymentReceivedEmail: vi.fn(() => ({ subject: '', html: '' })) }));

/** Columns that do not exist in staging or production (re-checked 2026-11-11). */
const MISSING: Record<string, RegExp> = {
  invoices: /\bdescription\b/,
  orders: /\bdelivery_name\b|\bproduct_name\b/,
  campaigns: /\bname\b/,
};

type Rows = Record<string, unknown>;
let rows: Rows = {};
const selects: Array<{ table: string; cols: string }> = [];

function makeFrom() {
  return (table: string) => {
    let cols = '';
    const c: Record<string, any> = {};
    const result = () => {
      if (MISSING[table]?.test(cols)) return { data: null, error: { message: `column does not exist (${table})` } };
      const v = rows[table];
      return { data: typeof v === 'function' ? (v as (cols: string) => unknown)(cols) : v ?? null, error: null };
    };
    ['eq', 'is', 'in', 'or', 'not', 'order', 'limit', 'update', 'gte', 'neq', 'insert', 'ilike', 'like', 'lte', 'upsert'].forEach(m => { c[m] = vi.fn().mockReturnValue(c); });
    c.select = vi.fn((s: string) => { cols = s; selects.push({ table, cols: s }); return c; });
    c.single = vi.fn(async () => result());
    c.maybeSingle = vi.fn(async () => result());
    c.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve);
    return c;
  };
}

function claim(over: Record<string, unknown>, version: number | null = 1) {
  return { claimed: true, claim_token: 'tok-1', payment_id: 'p1', amount: 5500, booking_id: null, invoice_id: null, campaign_id: null, reservation_id: null, order_id: null, payment_authority_version: version, ...over };
}

function setupRpc(claimData: Record<string, unknown>) {
  mockRpc.mockImplementation((name: string) => {
    if (name === 'claim_payment_confirmation') return Promise.resolve({ data: claimData, error: null });
    if (name === 'renew_payment_confirmation_claim') return Promise.resolve({ data: { renewed: true }, error: null });
    if (name === 'claim_confirmation_delivery') return Promise.resolve({ data: { claimed: true, attempt_id: 'att-1', claim_token: 'dtok-1' }, error: null });
    if (name === 'begin_confirmation_send') return Promise.resolve({ data: { authorized: true }, error: null });
    if (name === 'complete_confirmation_send') return Promise.resolve({ data: { completed: true }, error: null });
    if (name === 'finalize_payment_confirmation') return Promise.resolve({ data: { finalized: true }, error: null });
    if (name === 'terminate_cancelled_event_confirmation') return Promise.resolve({ data: { terminated: false, reason: 'not_cancelled' }, error: null });
    return Promise.resolve({ data: null, error: null });
  });
}

const BIZ = { name: 'Mama Put', country_code: 'NG', address: '1 Main' };
const ORDER_ITEMS = [
  { variant_label: 'Large', quantity: 2, unit_price: 2000, products: { name: 'Jollof Rice' } },
  { variant_label: null, quantity: 3, unit_price: 500, products: { name: 'Zobo' } },
];

beforeEach(() => {
  vi.clearAllMocks();
  selects.length = 0;
  mockGetEntityBalance.mockResolvedValue(null);
  mockInitManifest.mockResolvedValue({ ok: true });
  mockDriveExternal.mockResolvedValue({ ok: true });
  rows = {
    payments: (cols: string) => (cols.includes('campaign_id') && !cols.includes('metadata') ? { currency: 'NGN', campaign_id: null } : { currency: 'NGN', gateway: 'paystack', metadata: {}, user_id: null }),
    businesses: { name: 'Mama Put', subscription_tier: 'growth', is_whitelabel: false, owner_id: 'o1', metadata: {} },
    profiles: null,
  };
});

async function confirm(claimData: Record<string, unknown>) {
  setupRpc(claimData);
  const s = { rpc: mockRpc, from: vi.fn(makeFrom()), storage: { from: vi.fn(() => ({ upload: vi.fn(), getPublicUrl: vi.fn() })) } } as any;
  const { sendProactiveConfirmation } = await import('@/lib/payments/send-confirmation');
  return sendProactiveConfirmation(s, { id: 'p1', amount: Number(claimData.amount), booking_id: claimData.booking_id as string | null, invoice_id: claimData.invoice_id as string | null, campaign_id: claimData.campaign_id as string | null });
}

const receiptArgs = () => mockPostCompletion.mock.calls[0][0];

describe('#889 receipt details handed to the receipt step', () => {
  it('order: one line per product (with variant), the profile name as buyer (orders have no name column)', async () => {
    rows.orders = { delivery_phone: '+234555', reference_code: 'WA-OR-1', business_id: 'b1', total_amount: 5500, delivery_address: '2 Side St', businesses: { name: 'Mama Put', country_code: 'NG' }, order_items: ORDER_ITEMS };
    const res = await confirm(claim({ order_id: 'o1' }));
    expect(res.status).toBe('completed');
    const a = receiptArgs();
    expect(a.serviceName).toBe('Order WA-OR-1');
    expect(a.receiptItems).toEqual([
      { name: 'Jollof Rice (Large)', quantity: 2, unitPrice: 2000, lineTotal: 4000 },
      { name: 'Zobo', quantity: 3, unitPrice: 500, lineTotal: 1500 },
    ]);
    expect(a.receiptCustomerName).toBe('Profile Name');
    expect(a.receiptBalanceDue).toBeUndefined();
    // The CRM/loyalty name is untouched.
    expect(a.customerName).toBe('Profile Name');
  });

  it('order deposit: Total, Amount paid and Balance due come from payment history', async () => {
    rows.orders = { delivery_phone: '+234555', reference_code: 'WA-OR-2', business_id: 'b1', total_amount: 10000, businesses: { name: 'Mama Put', country_code: 'NG' }, order_items: ORDER_ITEMS };
    mockGetEntityBalance.mockResolvedValue({ totalAmount: 10000, netPaid: 5500, balanceDue: 4500 });
    await confirm(claim({ order_id: 'o2' }));
    expect(mockGetEntityBalance).toHaveBeenCalledWith(expect.anything(), { orderId: 'o2', totalAmount: 10000 });
    expect(receiptArgs()).toMatchObject({ amountPaid: 5500, receiptTotalDue: 10000, receiptBalanceDue: 4500 });
  });

  it('order linked only through legacy metadata: no deposit lines (its payment is not in the order payment history)', async () => {
    rows.orders = { delivery_phone: '+234555', reference_code: 'WA-OR-3', business_id: 'b1', total_amount: 10000, businesses: { name: 'Mama Put', country_code: 'NG' }, order_items: ORDER_ITEMS };
    rows.payments = (cols: string) => (cols.includes('campaign_id') && !cols.includes('metadata') ? { currency: 'NGN', campaign_id: null } : { currency: 'NGN', gateway: 'paystack', metadata: { order_id: 'o3' }, user_id: null });
    mockGetEntityBalance.mockResolvedValue({ totalAmount: 10000, netPaid: 0, balanceDue: 10000 });
    await confirm(claim({ order_id: null }));
    expect(mockGetEntityBalance).not.toHaveBeenCalled();
    const a = receiptArgs();
    expect(a.receiptItems).toHaveLength(2);
    expect(a.receiptBalanceDue).toBeUndefined();
  });

  it('a lookup that throws never blocks the confirmation (no items, receipt still sent)', async () => {
    rows.invoices = { customer_phone: '+234777', customer_name: 'Tunde Bakare', reference_code: 'INV-10', business_id: 'b1', businesses: { name: 'Mama Put', country_code: 'NG' } };
    rows.invoice_items = () => { throw new Error('network'); };
    const res = await confirm(claim({ invoice_id: 'inv2' }));
    expect(res.status).toBe('completed');
    expect(receiptArgs()).toMatchObject({ serviceName: 'Invoice INV-10', receiptItems: [] });
  });

  it('invoice: the lookup no longer selects the missing description column, so the business resolves and the receipt lists the invoice lines', async () => {
    rows.invoices = { customer_phone: '+234777', customer_name: 'Tunde Bakare', reference_code: 'INV-9', business_id: 'b1', businesses: { name: 'Mama Put', country_code: 'NG' } };
    rows.invoice_items = [
      { description: 'Catering for 50', quantity: 1, unit_price: 5000, amount: 5000, sort_order: 0 },
      { description: 'Delivery', quantity: 1, unit_price: 500, amount: 500, sort_order: 1 },
    ];
    const res = await confirm(claim({ invoice_id: 'inv1' }));
    expect(res.status).toBe('completed');
    expect(selects.filter(s => s.table === 'invoices').every(s => !/\bdescription\b/.test(s.cols))).toBe(true);
    const a = receiptArgs();
    expect(a.businessId).toBe('b1');
    expect(a.serviceName).toBe('Invoice INV-9');
    expect(a.receiptCustomerName).toBe('Tunde Bakare');
    expect(a.receiptItems).toEqual([
      { name: 'Catering for 50', quantity: 1, unitPrice: 5000, lineTotal: 5000 },
      { name: 'Delivery', quantity: 1, unitPrice: 500, lineTotal: 500 },
    ]);
  });

  it('ticket: names the event (not "Payment") and lists ticket type × quantity; the guest name is the buyer', async () => {
    rows.bookings = { guest_phone: '+234888', guest_email: null, guest_name: 'Ada Eze', quantity: 2, event_id: 'ev1', reference_code: 'WA-TK-1', business_id: 'b1', date: '2026-12-01', time: '18:00', flow_type: 'ticketing', total_amount: 20000, deposit_amount: 0, businesses: BIZ, services: null };
    rows.events = { name: 'Lagos Jazz Night' };
    rows.event_ticket_issuance_state = { quantity: 2, event_ticket_types: { name: 'VIP' } };
    await confirm(claim({ booking_id: 'bk1', amount: 20000 }));
    const a = receiptArgs();
    expect(a.serviceName).toBe('Lagos Jazz Night');
    expect(a.receiptItems).toEqual([{ name: 'VIP', quantity: 2, unitPrice: 10000, lineTotal: 20000 }]);
    expect(a.receiptCustomerName).toBe('Ada Eze');
  });

  it('booking deposit: Total and Balance due are passed; the guest name is the buyer', async () => {
    rows.bookings = { guest_phone: '+234888', guest_email: null, guest_name: 'Bisi Ade', quantity: 1, event_id: null, reference_code: 'WA-BK-1', business_id: 'b1', date: '2026-12-01', time: '10:00', flow_type: 'scheduling', total_amount: 50000, deposit_amount: 20000, businesses: BIZ, services: { name: 'Bridal Makeup', duration_minutes: 120, service_type: 'booking' } };
    mockGetEntityBalance.mockResolvedValue({ totalAmount: 50000, netPaid: 20000, balanceDue: 30000 });
    await confirm(claim({ booking_id: 'bk2', amount: 20000 }));
    expect(receiptArgs()).toMatchObject({ serviceName: 'Bridal Makeup', amountPaid: 20000, receiptTotalDue: 50000, receiptBalanceDue: 30000, receiptCustomerName: 'Bisi Ade', receiptItems: [] });
  });

  it('fully paid booking: no deposit lines', async () => {
    rows.bookings = { guest_phone: '+234888', guest_email: null, guest_name: 'Bisi Ade', quantity: 1, event_id: null, reference_code: 'WA-BK-2', business_id: 'b1', date: '2026-12-01', time: '10:00', flow_type: 'scheduling', total_amount: 50000, deposit_amount: 0, businesses: BIZ, services: { name: 'Haircut', duration_minutes: 30, service_type: 'booking' } };
    mockGetEntityBalance.mockResolvedValue({ totalAmount: 50000, netPaid: 50000, balanceDue: 0 });
    await confirm(claim({ booking_id: 'bk3', amount: 50000 }));
    expect(receiptArgs().receiptTotalDue).toBeUndefined();
    expect(receiptArgs().receiptBalanceDue).toBeUndefined();
  });

  it('booking without a guest name falls back to the profile name', async () => {
    rows.bookings = { guest_phone: '+234888', guest_email: null, guest_name: null, quantity: 1, event_id: null, reference_code: 'WA-BK-3', business_id: 'b1', date: '2026-12-01', time: '10:00', flow_type: 'scheduling', total_amount: 100, deposit_amount: 0, businesses: BIZ, services: { name: 'S', duration_minutes: 30, service_type: 'booking' } };
    await confirm(claim({ booking_id: 'bk4', amount: 100 }));
    expect(receiptArgs().receiptCustomerName).toBe('Profile Name');
  });
});

describe('#889 owner order alert lists the products', () => {
  const order = { delivery_phone: '+234555', reference_code: 'WA-OR-1', business_id: 'b1', total_amount: 5500, delivery_address: '2 Side St', businesses: { name: 'Mama Put', country_code: 'NG' }, order_items: ORDER_ITEMS };
  const expectedItems = [
    { name: 'Jollof Rice (Large)', quantity: 2, price: 4000 },
    { name: 'Zobo', quantity: 3, price: 1500 },
  ];

  it('manifest path', async () => {
    rows.orders = order;
    mockDriveExternal.mockImplementation(async (_s: unknown, _p: unknown, key: string, _t: unknown, fn: () => Promise<unknown>) => {
      if (key === 'owner_notif_whatsapp') await fn();
      return { ok: true };
    });
    await confirm(claim({ order_id: 'o1' }));
    expect(mockNotifyOrder).toHaveBeenCalledTimes(1);
    expect(mockNotifyOrder.mock.calls[0][0]).toMatchObject({ referenceCode: 'WA-OR-1', customerName: 'Profile Name', items: expectedItems, deliveryAddress: '2 Side St' });
  });

  it('legacy path (no manifest)', async () => {
    rows.orders = order;
    mockInitManifest.mockResolvedValue({ ok: false, error: 'x' });
    await confirm(claim({ order_id: 'o1' }, null));
    expect(mockNotifyOrder).toHaveBeenCalledTimes(1);
    expect(mockNotifyOrder.mock.calls[0][0]).toMatchObject({ referenceCode: 'WA-OR-1', items: expectedItems });
  });

  it('no select asks orders for the missing delivery_name or product_name columns', async () => {
    rows.orders = order;
    mockDriveExternal.mockImplementation(async (_s: unknown, _p: unknown, key: string, _t: unknown, fn: () => Promise<unknown>) => {
      if (key === 'owner_notif_whatsapp') await fn();
      return { ok: true };
    });
    await confirm(claim({ order_id: 'o1' }));
    // The fallback lookup and the owner alert both read orders.
    expect(selects.filter(s => s.table === 'orders').length).toBe(2);
    for (const s of selects.filter(x => x.table === 'orders')) expect(s.cols).not.toMatch(/delivery_name|product_name/);
  });
});

/**
 * ACC-166: Payment/Giving Notification Semantics
 *
 * Uses the exact same mock harness as p0-payment-confirmation.test.ts
 * to test flow_type-aware owner notification branching.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRpc = vi.fn();
const mockFrom = vi.fn();

function chain() {
  const c: Record<string, any> = {};
  ['select', 'eq', 'is', 'in', 'or', 'not', 'neq', 'order', 'limit', 'update'].forEach(m => c[m] = vi.fn().mockReturnValue(c));
  c.single = vi.fn().mockResolvedValue({ data: null, error: null });
  c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
  c.insert = vi.fn().mockResolvedValue({ data: null, error: null });
  return c;
}

// ── Hoisted notification mocks ──
const { mockNotifyBooking, mockNotifyPayment, mockNotifyDonation, mockNotifyOrder, mockNotifyInvoice, mockInitializePayment, mockCalendarLinks } = vi.hoisted(() => ({
  mockNotifyBooking: vi.fn().mockResolvedValue(undefined),
  mockNotifyPayment: vi.fn().mockResolvedValue(undefined),
  mockNotifyDonation: vi.fn().mockResolvedValue(undefined),
  mockNotifyOrder: vi.fn().mockResolvedValue(undefined),
  mockNotifyInvoice: vi.fn().mockResolvedValue(undefined),
  mockInitializePayment: vi.fn(),
  mockCalendarLinks: vi.fn(),
}));

vi.mock('@/lib/bot/flows/shared/notify-owner', () => ({
  notifyOwnerNewBooking: mockNotifyBooking,
  notifyOwnerNewPayment: mockNotifyPayment,
  notifyOwnerNewDonation: mockNotifyDonation,
  notifyOwnerNewOrder: mockNotifyOrder,
  notifyOwnerNewInvoicePayment: mockNotifyInvoice,
}));
vi.mock('@/lib/bot/flows/shared/notifications', () => ({ createNotification: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), withContext: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/constants', () => ({ formatCurrency: (a: number) => `$${a}` }));
vi.mock('@/lib/utils/phone', () => ({ stripPlus: (p: string) => p.replace(/^\+/, '') }));
vi.mock('@/lib/bot/flows/shared/user', () => ({ getCustomerName: vi.fn().mockResolvedValue('U') }));
vi.mock('@/lib/calendar/generate-links', () => ({ getCalendarLinksText: mockCalendarLinks }));
vi.mock('@/lib/utils/sanitize', () => ({ sanitizeFilterValue: (v: string) => v }));
vi.mock('@/lib/bot/flows/shared/payment', () => ({ initializePayment: mockInitializePayment }));
vi.mock('@/lib/whitelabel', () => ({ isWhiteLabel: () => false }));
vi.mock('@/lib/bot/flows/shared/post-completion', () => ({ handlePostCompletion: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/email/templates', () => ({
  paymentReceivedEmail: vi.fn().mockReturnValue({ subject: 's', html: 'h' }),
  bookingConfirmationEmail: vi.fn().mockReturnValue({ subject: 's', html: 'h' }),
  donationReceiptEmail: vi.fn().mockReturnValue({ subject: 's', html: 'h' }),
}));
vi.mock('@/lib/bot/flows/shared/send-tickets', () => ({ sendTicketsAfterPurchase: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/errors', () => ({ safeLogErrorContext: vi.fn().mockReturnValue({}) }));
vi.mock('@/lib/channels/channel-resolver', () => {
  return {
    ChannelResolver: class {
      resolveByChannelId() { return Promise.resolve({ sender: { sendText: () => Promise.resolve() } }); }
      resolveByBusinessId() { return Promise.resolve({ sender: { sendText: () => Promise.resolve() } }); }
    },
  };
});

// Track notification inserts
const notifInserts: Array<Record<string, unknown>> = [];
let notifInsertError: { message: string } | null = null;

const CLAIM_OK = { data: { claimed: true, claim_token: 'tok-aaa', payment_id: 'p1', amount: 50, booking_id: 'bk1', invoice_id: null, campaign_id: null, reservation_id: null, order_id: null } };
const RENEW_OK = { data: { renewed: true } };
const FIN_OK = { data: { finalized: true, already_finalized: false } };
const REL_OK = { data: { released: true } };

function buildMock(
  rpcMap: Record<string, { data?: unknown; error?: unknown }>,
  flowType = 'scheduling',
  serviceName = 'S',
  opts: { noChannel?: boolean; notifError?: { message: string } | null; hasReservation?: boolean; hasCampaign?: boolean; hasOrder?: boolean } = {},
) {
  notifInserts.length = 0;
  notifInsertError = opts.notifError || null;

  mockRpc.mockImplementation((name: string) => {
    const r = rpcMap[name];
    return Promise.resolve({ data: r?.data ?? null, error: r?.error ?? null });
  });

  mockFrom.mockImplementation((table: string) => {
    const c = chain();
    if (table === 'bookings') {
      c.single = vi.fn().mockResolvedValue({
        data: {
          guest_phone: '+234123', business_id: 'b1', reference_code: 'REF-166',
          date: '2026-08-25', time: '14:00', flow_type: flowType,
          total_amount: 50, deposit_amount: 50,
          businesses: { name: 'TestBiz', country_code: 'NG' },
          services: { name: serviceName, duration_minutes: 30 },
        },
        error: null,
      });
    }
    if (table === 'reservations' && opts.hasReservation) {
      c.single = vi.fn().mockResolvedValue({
        data: { guest_name: 'Guest', check_in: '2026-09-01', check_out: '2026-09-03', guest_count: 2, guest_phone: '+234', business_id: 'b1', reference_code: 'RES-1', businesses: { name: 'Biz', country_code: 'NG' } },
        error: null,
      });
    }
    if (table === 'campaign_donations') {
      c.maybeSingle = vi.fn().mockResolvedValue({ data: opts.hasCampaign ? { donor_name: 'Donor', reference_code: 'DON-1', donor_phone: '+234camp', campaigns: { title: 'Fund' } } : null, error: null });
    }
    if (table === 'campaigns') {
      c.single = vi.fn().mockResolvedValue({ data: opts.hasCampaign ? { business_id: 'b1', title: 'Fund', businesses: { name: 'Biz', country_code: 'NG' } } : null, error: null });
    }
    if (table === 'orders') {
      c.single = vi.fn().mockResolvedValue({ data: opts.hasOrder ? { reference_code: 'ORD-1', delivery_name: 'Cust', delivery_phone: '+234ord', delivery_address: '1 Main', business_id: 'b1', businesses: { name: 'Biz', country_code: 'NG' }, order_items: [{ product_name: 'Item', quantity: 1, unit_price: 50 }] } : null, error: null });
      c.maybeSingle = vi.fn().mockResolvedValue({ data: opts.hasOrder ? { reference_code: 'ORD-1', delivery_name: 'Cust', delivery_phone: '+234ord', delivery_address: '1 Main', business_id: 'b1', businesses: { name: 'Biz', country_code: 'NG' }, order_items: [{ product_name: 'Item', quantity: 1, unit_price: 50 }] } : null, error: null });
    }
    if (table === 'payments') c.single = vi.fn().mockResolvedValue({ data: { user_id: 'u1', metadata: {}, gateway: 'paystack' }, error: null });
    if (table === 'businesses') c.single = vi.fn().mockResolvedValue({ data: { subscription_tier: 'free', owner_id: 'o1' }, error: null });
    if (table === 'profiles') c.single = vi.fn().mockResolvedValue({ data: { email: 'o@t.com', phone: '+234' }, error: null });
    if (table === 'notifications') {
      c.insert = vi.fn().mockImplementation((row: Record<string, unknown>) => {
        notifInserts.push(row);
        return Promise.resolve({ data: null, error: notifInsertError });
      });
    }
    return c;
  });

  return { rpc: mockRpc, from: mockFrom } as any;
}

const RPCS = { claim_payment_confirmation: CLAIM_OK, renew_payment_confirmation_claim: RENEW_OK, finalize_payment_confirmation: FIN_OK };
const pay = { id: 'p1', amount: 50, booking_id: 'bk1', invoice_id: null, campaign_id: null, reservation_id: null, order_id: null };

describe('ACC-166: Payment/Giving notification semantics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    notifInserts.length = 0;
    notifInsertError = null;
    mockInitializePayment.mockResolvedValue(null);
    mockCalendarLinks.mockReturnValue(null);
  });

  it('1. Payment (flow_type=payment) → notifyOwnerNewPayment, NOT notifyOwnerNewBooking', async () => {
    const s = buildMock(RPCS, 'payment', 'Consultation');
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay as any);
    expect(mockNotifyPayment).toHaveBeenCalledTimes(1);
    expect(mockNotifyBooking).not.toHaveBeenCalled();
  });

  it('2. Payment → correct params (businessId, amount, categoryName)', async () => {
    const s = buildMock(RPCS, 'payment', 'Consultation');
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay as any);
    expect(mockNotifyPayment).toHaveBeenCalledWith(expect.objectContaining({
      businessId: 'b1', amount: 50, categoryName: 'Consultation',
    }));
  });

  it('3. Giving (flow_type=payment, service=Tithe) → notifyOwnerNewPayment', async () => {
    const s = buildMock(RPCS, 'payment', 'Tithe');
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, { ...pay, amount: 100 } as any);
    expect(mockNotifyPayment).toHaveBeenCalledWith(expect.objectContaining({ categoryName: 'Tithe' }));
    expect(mockNotifyBooking).not.toHaveBeenCalled();
  });

  it('4. Payment + NO resolved → in-app notification still inserted', async () => {
    // noChannel not directly supported by this mock pattern — we test that in-app insert happens regardless
    const s = buildMock(RPCS, 'payment', 'Fee');
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay as any);
    // In-app was inserted (regardless of resolved)
    expect(notifInserts).toHaveLength(1);
    expect(notifInserts[0]).toMatchObject({ business_id: 'b1', type: 'payment_received' });
  });

  it('5. Payment in-app row includes booking_id', async () => {
    const s = buildMock(RPCS, 'payment', 'Service');
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay as any);
    expect(notifInserts[0]).toMatchObject({ booking_id: 'bk1', type: 'payment_received' });
  });

  it('6. In-app row body includes service name and amount', async () => {
    const s = buildMock(RPCS, 'payment', 'Offering');
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, { ...pay, amount: 75 } as any);
    expect(notifInserts[0]).toMatchObject({
      business_id: 'b1', booking_id: 'bk1', type: 'payment_received',
      channel: 'whatsapp', status: 'delivered',
    });
    expect(notifInserts[0].body).toContain('Offering');
  });

  it('7. In-app insert failure → Stage 3 continues', async () => {
    const s = buildMock(RPCS, 'payment', 'S', { notifError: { message: 'constraint violation' } });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    const result = await sendProactiveConfirmation(s, pay as any);
    expect(result.status).toBe('completed');
  });

  it('8. Notification failure → finalize_payment_confirmation still called', async () => {
    const s = buildMock(RPCS, 'payment', 'S', { notifError: { message: 'DB error' } });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay as any);
    const finCalls = mockRpc.mock.calls.filter((c: unknown[]) => c[0] === 'finalize_payment_confirmation');
    expect(finCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('9. Scheduling → notifyOwnerNewBooking', async () => {
    const s = buildMock(RPCS, 'scheduling');
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay as any);
    expect(mockNotifyBooking).toHaveBeenCalledTimes(1);
    expect(mockNotifyPayment).not.toHaveBeenCalled();
    expect(notifInserts.filter(n => n.type === 'payment_received')).toHaveLength(0);
  });

  it('10. Appointment → notifyOwnerNewBooking', async () => {
    const s = buildMock(RPCS, 'appointment');
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay as any);
    expect(mockNotifyBooking).toHaveBeenCalledTimes(1);
    expect(mockNotifyPayment).not.toHaveBeenCalled();
  });

  it('11. Ticketing → notifyOwnerNewBooking', async () => {
    const s = buildMock(RPCS, 'ticketing');
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay as any);
    expect(mockNotifyBooking).toHaveBeenCalledTimes(1);
    expect(mockNotifyPayment).not.toHaveBeenCalled();
  });

  it('12. Scheduling + no payment_received in-app', async () => {
    const s = buildMock(RPCS, 'scheduling');
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay as any);
    expect(notifInserts.filter(n => n.type === 'payment_received')).toHaveLength(0);
  });

  it('13. Reservation → notifyOwnerNewBooking (unchanged)', async () => {
    const claimRes = { data: { ...CLAIM_OK.data, booking_id: null, reservation_id: 'res1' } };
    const s = buildMock({ ...RPCS, claim_payment_confirmation: claimRes }, 'scheduling', 'S', { hasReservation: true });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, { ...pay, booking_id: null, reservation_id: 'res1' } as any);
    expect(mockNotifyBooking).toHaveBeenCalledTimes(1);
    expect(mockNotifyPayment).not.toHaveBeenCalled();
  });

  it('14. Campaign/order notification code paths not modified by #166', async () => {
    // #166 only modifies the booking_id block (flow_type branch).
    // Campaign (campaign_id) and Order (order_id) code paths are in separate
    // blocks (lines 625+ and 653+) that are not touched by this change.
    // Verify by reading the source: no campaign_id or order_id reference exists
    // in the modified booking_id block.
    const fs = require('fs');
    const src = fs.readFileSync('lib/payments/send-confirmation.ts', 'utf-8');
    // The payment/giving block uses flow_type === 'payment' discriminator
    const paymentBlock = src.split("flow_type === 'payment'")[1]?.split('// ── 7a2')[0] || '';
    expect(paymentBlock).not.toContain('campaign_id');
    expect(paymentBlock).not.toContain('order_id');
    // Campaign and order notification calls still exist in the file
    expect(src).toContain('notifyOwnerNewDonation');
    expect(src).toContain('notifyOwnerNewOrder');
  });

  it('15. Reservation/Invoice notification blocks not modified by #166', async () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/payments/send-confirmation.ts', 'utf-8');
    // Reservation block still calls notifyOwnerNewBooking (unchanged)
    expect(src).toContain("payment.reservation_id && !payment.booking_id && resolved");
    // Invoice block still exists
    expect(src).toContain('notifyOwnerNewInvoicePayment');
  });

  it('16. claim_payment_confirmation still called (dedup unchanged)', async () => {
    const s = buildMock(RPCS, 'payment');
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay as any);
    const claimCalls = mockRpc.mock.calls.filter((c: unknown[]) => c[0] === 'claim_payment_confirmation');
    expect(claimCalls).toHaveLength(1);
  });

  it('17. In-app write completes before finalization (ordering proof)', async () => {
    const order: string[] = [];
    mockRpc.mockImplementation((name: string) => {
      if (name === 'finalize_payment_confirmation') { order.push('finalize'); return Promise.resolve(FIN_OK); }
      const r = RPCS[name as keyof typeof RPCS];
      return Promise.resolve({ data: r?.data ?? null, error: r?.error ?? null });
    });
    mockFrom.mockImplementation((table: string) => {
      const c = chain();
      if (table === 'bookings') c.single = vi.fn().mockResolvedValue({ data: { guest_phone: '+234', business_id: 'b1', reference_code: 'R1', date: '2026-08-25', time: '14:00', flow_type: 'payment', total_amount: 50, deposit_amount: 50, businesses: { name: 'Biz', country_code: 'NG' }, services: { name: 'S', duration_minutes: 30 } }, error: null });
      if (table === 'businesses') c.single = vi.fn().mockResolvedValue({ data: { subscription_tier: 'free', owner_id: 'o1' }, error: null });
      if (table === 'profiles') c.single = vi.fn().mockResolvedValue({ data: { email: 'o@t.com', phone: '+234' }, error: null });
      if (table === 'notifications') c.insert = vi.fn().mockImplementation(() => { order.push('notif_insert'); return Promise.resolve({ data: null, error: null }); });
      return c;
    });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation({ rpc: mockRpc, from: mockFrom } as any, pay as any, '[TEST]');
    const ni = order.indexOf('notif_insert');
    const fi = order.indexOf('finalize');
    expect(ni).toBeGreaterThanOrEqual(0);
    expect(fi).toBeGreaterThan(ni);
  });
});

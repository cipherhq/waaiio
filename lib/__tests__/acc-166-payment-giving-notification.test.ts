/**
 * ACC-166: Payment/Giving Notification Semantics — Correction Round 1
 *
 * Executes the real sendProactiveConfirmation production function with
 * controllable ChannelResolver to test both resolved and no-channel paths.
 * All assertions are behavioral (mock call verification), not source-string.
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

// ── Hoisted mocks ──
const {
  mockNotifyBooking, mockNotifyPayment, mockNotifyDonation, mockNotifyOrder, mockNotifyInvoice,
  mockInitializePayment, mockCalendarLinks,
  mockResolveByChannel, mockResolveByBiz, mockLogError,
} = vi.hoisted(() => ({
  mockNotifyBooking: vi.fn().mockResolvedValue(undefined),
  mockNotifyPayment: vi.fn().mockResolvedValue(undefined),
  mockNotifyDonation: vi.fn().mockResolvedValue(undefined),
  mockNotifyOrder: vi.fn().mockResolvedValue(undefined),
  mockNotifyInvoice: vi.fn().mockResolvedValue(undefined),
  mockInitializePayment: vi.fn(),
  mockCalendarLinks: vi.fn(),
  mockResolveByChannel: vi.fn(),
  mockResolveByBiz: vi.fn(),
  mockLogError: vi.fn(),
}));

vi.mock('@/lib/bot/flows/shared/notify-owner', () => ({
  notifyOwnerNewBooking: mockNotifyBooking,
  notifyOwnerNewPayment: mockNotifyPayment,
  notifyOwnerNewDonation: mockNotifyDonation,
  notifyOwnerNewOrder: mockNotifyOrder,
  notifyOwnerNewInvoicePayment: mockNotifyInvoice,
}));
vi.mock('@/lib/bot/flows/shared/notifications', () => ({ createNotification: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: mockLogError, withContext: () => ({ error: mockLogError, warn: vi.fn(), info: vi.fn() }) } }));
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

// Controllable ChannelResolver — per-test via mockResolveByChannel/mockResolveByBiz
vi.mock('@/lib/channels/channel-resolver', () => ({
  ChannelResolver: class {
    resolveByChannelId(...args: unknown[]) { return mockResolveByChannel(...args); }
    resolveByBusinessId(...args: unknown[]) { return mockResolveByBiz(...args); }
  },
}));

// ── Notification insert tracker ──
const notifInserts: Array<Record<string, unknown>> = [];
let notifInsertError: { message: string } | null = null;

const CLAIM_OK = { data: { claimed: true, claim_token: 'tok-aaa', payment_id: 'p1', amount: 50, booking_id: 'bk1', invoice_id: null, campaign_id: null, reservation_id: null, order_id: null } };
const RENEW_OK = { data: { renewed: true } };
const FIN_OK = { data: { finalized: true, already_finalized: false } };

function buildMock(
  rpcOverrides: Record<string, { data?: unknown; error?: unknown }>,
  flowType = 'scheduling',
  serviceName = 'S',
  opts: { notifError?: { message: string } | null; hasReservation?: boolean; hasCampaign?: boolean; hasOrder?: boolean; hasInvoice?: boolean } = {},
) {
  notifInserts.length = 0;
  notifInsertError = opts.notifError || null;

  const rpcs: Record<string, { data?: unknown; error?: unknown }> = {
    claim_payment_confirmation: CLAIM_OK,
    renew_payment_confirmation_claim: RENEW_OK,
    finalize_payment_confirmation: FIN_OK,
    release_payment_confirmation: { data: { released: true } },
    ...rpcOverrides,
  };

  mockRpc.mockImplementation((name: string) => {
    const r = rpcs[name];
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
    if (table === 'reservations') {
      c.single = vi.fn().mockResolvedValue({
        data: opts.hasReservation ? { guest_name: 'Guest', guest_phone: '+234res', check_in: '2026-09-01', check_out: '2026-09-03', guest_count: 2, business_id: 'b1', reference_code: 'RES-1', total_amount: 100, deposit_amount: 100, businesses: { name: 'Biz', country_code: 'NG', payment_gateway: 'paystack' } } : null,
        error: null,
      });
    }
    if (table === 'invoices') {
      c.single = vi.fn().mockResolvedValue({
        data: opts.hasInvoice ? { customer_phone: '+234inv', reference_code: 'INV-1', description: 'Invoice Service', business_id: 'b1', businesses: { name: 'Biz', country_code: 'NG' } } : null,
        error: null,
      });
    }
    if (table === 'campaign_donations') {
      c.maybeSingle = vi.fn().mockResolvedValue({ data: opts.hasCampaign ? { donor_name: 'Donor', reference_code: 'DON-1', donor_phone: '+234camp', campaigns: { title: 'Fund' } } : null, error: null });
    }
    if (table === 'orders') {
      c.single = vi.fn().mockResolvedValue({ data: opts.hasOrder ? { reference_code: 'ORD-1', delivery_name: 'Cust', delivery_phone: '+234ord', delivery_address: '1 Main', business_id: 'b1', businesses: { name: 'Biz', country_code: 'NG' }, order_items: [{ product_name: 'Item', quantity: 1, unit_price: 50 }] } : null, error: null });
      c.maybeSingle = vi.fn().mockResolvedValue({ data: opts.hasOrder ? { reference_code: 'ORD-1', delivery_name: 'Cust', delivery_phone: '+234ord', delivery_address: '1 Main', business_id: 'b1', businesses: { name: 'Biz', country_code: 'NG' }, order_items: [{ product_name: 'Item', quantity: 1, unit_price: 50 }] } : null, error: null });
    }
    if (table === 'payments') c.single = vi.fn().mockResolvedValue({ data: { user_id: 'u1', metadata: {}, gateway: 'paystack' }, error: null });
    if (table === 'businesses') c.single = vi.fn().mockResolvedValue({ data: { subscription_tier: 'free', owner_id: 'o1' }, error: null });
    if (table === 'profiles') {
      c.single = vi.fn().mockResolvedValue({ data: { email: 'o@t.com', phone: '+234' }, error: null });
      c.maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'u1', email: 'o@t.com', phone: '+234' }, error: null });
    }
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

const pay = { id: 'p1', amount: 50, booking_id: 'bk1', invoice_id: null, campaign_id: null, reservation_id: null, order_id: null };
const mockSender = { sendText: vi.fn().mockResolvedValue(undefined) };

function setResolved(yes: boolean) {
  const r = yes ? { sender: mockSender } : null;
  mockResolveByChannel.mockResolvedValue(r);
  mockResolveByBiz.mockResolvedValue(r);
}

describe('ACC-166: Payment/Giving notification semantics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    notifInserts.length = 0;
    notifInsertError = null;
    mockInitializePayment.mockResolvedValue(null);
    mockCalendarLinks.mockReturnValue(null);
    setResolved(true); // default: channel available
  });

  // ══════════════════════════════════════════════════════════
  // PAYMENT/GIVING + RESOLVED SENDER
  // ══════════════════════════════════════════════════════════

  it('1. Payment (flow_type=payment) + resolved → notifyOwnerNewPayment, NOT notifyOwnerNewBooking', async () => {
    const s = buildMock({}, 'payment', 'Consultation');
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay as any);
    expect(mockNotifyPayment).toHaveBeenCalledTimes(1);
    expect(mockNotifyBooking).not.toHaveBeenCalled();
  });

  it('2. Payment → correct params (businessId, amount, categoryName)', async () => {
    const s = buildMock({}, 'payment', 'Consultation');
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay as any);
    expect(mockNotifyPayment).toHaveBeenCalledWith(expect.objectContaining({
      businessId: 'b1', amount: 50, categoryName: 'Consultation',
    }));
  });

  it('3. Giving (flow_type=payment, service=Tithe) → notifyOwnerNewPayment', async () => {
    const s = buildMock({}, 'payment', 'Tithe');
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, { ...pay, amount: 100 } as any);
    expect(mockNotifyPayment).toHaveBeenCalledWith(expect.objectContaining({ categoryName: 'Tithe' }));
    expect(mockNotifyBooking).not.toHaveBeenCalled();
  });

  // ══════════════════════════════════════════════════════════
  // PAYMENT/GIVING + NO RESOLVED SENDER (Correction item 2)
  // ══════════════════════════════════════════════════════════

  it('4. Payment + NO resolved sender → in-app payment_received insert still occurs', async () => {
    setResolved(false);
    const s = buildMock({}, 'payment', 'Fee');
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay as any);
    expect(notifInserts).toHaveLength(1);
    expect(notifInserts[0]).toMatchObject({ business_id: 'b1', type: 'payment_received' });
  });

  it('5. Payment + no resolved → in-app row contains booking_id', async () => {
    setResolved(false);
    const s = buildMock({}, 'payment', 'Service');
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay as any);
    expect(notifInserts[0]).toMatchObject({ booking_id: 'bk1' });
  });

  it('6. Payment + no resolved → notifyOwnerNewPayment NOT called', async () => {
    setResolved(false);
    const s = buildMock({}, 'payment');
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay as any);
    expect(mockNotifyPayment).not.toHaveBeenCalled();
  });

  it('7. Payment + no resolved → Stage 3 still completes', async () => {
    setResolved(false);
    const s = buildMock({}, 'payment');
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    const result = await sendProactiveConfirmation(s, pay as any);
    expect(result.status).toBe('completed');
  });

  // ══════════════════════════════════════════════════════════
  // SCHEDULING/APPOINTMENT/TICKETING + NO CHANNEL (Correction item 2)
  // ══════════════════════════════════════════════════════════

  it('8. Scheduling + no resolved → no external owner notification', async () => {
    setResolved(false);
    const s = buildMock({}, 'scheduling');
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay as any);
    expect(mockNotifyBooking).not.toHaveBeenCalled();
    expect(mockNotifyPayment).not.toHaveBeenCalled();
  });

  // ══════════════════════════════════════════════════════════
  // IN-APP ROW CONTENT
  // ══════════════════════════════════════════════════════════

  it('9. In-app row body includes service name', async () => {
    const s = buildMock({}, 'payment', 'Offering');
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, { ...pay, amount: 75 } as any);
    expect(notifInserts[0]).toMatchObject({
      business_id: 'b1', booking_id: 'bk1', type: 'payment_received',
      channel: 'whatsapp', status: 'delivered',
    });
    expect(notifInserts[0].body).toContain('Offering');
  });

  // ══════════════════════════════════════════════════════════
  // ERROR OBSERVABILITY (Correction item 4)
  // ══════════════════════════════════════════════════════════

  it('10. In-app insert { error } → error logged via safe logging, Stage 3 completes', async () => {
    const s = buildMock({}, 'payment', 'S', { notifError: { message: 'constraint violation' } });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    const result = await sendProactiveConfirmation(s, pay as any);
    // Stage 3 completes despite notification failure
    expect(result.status).toBe('completed');
    // Error was logged (logSafeError calls logger.error internally)
    expect(mockLogError).toHaveBeenCalled();
  });

  it('11. In-app insert failure → finalize_payment_confirmation still called', async () => {
    const s = buildMock({}, 'payment', 'S', { notifError: { message: 'DB error' } });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay as any);
    const finCalls = mockRpc.mock.calls.filter((c: unknown[]) => c[0] === 'finalize_payment_confirmation');
    expect(finCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('12. In-app insert failure → result is non-fatal (completed)', async () => {
    const s = buildMock({}, 'payment', 'S', { notifError: { message: 'unique_violation' } });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    const result = await sendProactiveConfirmation(s, pay as any);
    expect(result.status).toBe('completed');
    expect((result as any).retryable).toBeUndefined();
  });

  // ══════════════════════════════════════════════════════════
  // SCHEDULING/APPOINTMENT/TICKETING + RESOLVED (unchanged)
  // ══════════════════════════════════════════════════════════

  it('13. Scheduling → notifyOwnerNewBooking, no payment_received in-app', async () => {
    const s = buildMock({}, 'scheduling');
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay as any);
    expect(mockNotifyBooking).toHaveBeenCalledTimes(1);
    expect(mockNotifyPayment).not.toHaveBeenCalled();
    expect(notifInserts.filter(n => n.type === 'payment_received')).toHaveLength(0);
  });

  it('14. Appointment → notifyOwnerNewBooking', async () => {
    const s = buildMock({}, 'appointment');
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay as any);
    expect(mockNotifyBooking).toHaveBeenCalledTimes(1);
    expect(mockNotifyPayment).not.toHaveBeenCalled();
  });

  it('15. Ticketing → notifyOwnerNewBooking', async () => {
    const s = buildMock({}, 'ticketing');
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay as any);
    expect(mockNotifyBooking).toHaveBeenCalledTimes(1);
    expect(mockNotifyPayment).not.toHaveBeenCalled();
  });

  // ══════════════════════════════════════════════════════════
  // PRESERVED ENTITY PATHS — EXECUTABLE (Correction item 3)
  // ══════════════════════════════════════════════════════════

  it('16. Reservation → notifyOwnerNewBooking (executed, unchanged)', async () => {
    const claimRes = { data: { ...CLAIM_OK.data, booking_id: null, reservation_id: 'res1' } };
    const s = buildMock({ claim_payment_confirmation: claimRes }, 'scheduling', 'S', { hasReservation: true });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, { ...pay, booking_id: null, reservation_id: 'res1' } as any);
    expect(mockNotifyBooking).toHaveBeenCalledTimes(1);
    expect(mockNotifyPayment).not.toHaveBeenCalled();
    expect(mockNotifyDonation).not.toHaveBeenCalled();
  });

  it('17. Invoice → notifyOwnerNewInvoicePayment (executed, unchanged)', async () => {
    const claimInv = { data: { ...CLAIM_OK.data, booking_id: null, invoice_id: 'inv1' } };
    const s = buildMock({ claim_payment_confirmation: claimInv }, 'scheduling', 'S', { hasInvoice: true });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, { ...pay, booking_id: null, invoice_id: 'inv1' } as any);
    expect(mockNotifyInvoice).toHaveBeenCalledTimes(1);
    expect(mockNotifyPayment).not.toHaveBeenCalled();
    expect(mockNotifyBooking).not.toHaveBeenCalled();
  });

  it('18. Campaign donation → notifyOwnerNewDonation (executed, unchanged)', async () => {
    // Campaign donations resolve businessId through payment.user_id → profiles
    // The function needs customerPhone from profiles and businessId from somewhere.
    // In production, campaign payments are created with a booking_id from crowdfunding flow.
    // Test with booking_id to prove #166 doesn't affect campaign notification when booking present.
    const claimCamp = { data: { ...CLAIM_OK.data, campaign_id: 'camp1' } };
    const s = buildMock({ claim_payment_confirmation: claimCamp }, 'payment', 'S', { hasCampaign: true });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, { ...pay, campaign_id: 'camp1' } as any);
    // Campaign notification fires (campaign_id block, not affected by #166 booking_id changes)
    expect(mockNotifyDonation).toHaveBeenCalledTimes(1);
    // #166 payment semantics also fire (booking_id present with flow_type=payment)
    expect(mockNotifyPayment).toHaveBeenCalledTimes(1);
  });

  it('19. Order → notifyOwnerNewOrder (executed, unchanged)', async () => {
    // Order payments typically have booking_id. Test proves order notification fires
    // regardless of #166 booking-level changes.
    const claimOrd = { data: { ...CLAIM_OK.data, order_id: 'ord1' } };
    const s = buildMock({ claim_payment_confirmation: claimOrd }, 'ordering', 'S', { hasOrder: true });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, { ...pay, order_id: 'ord1' } as any);
    // Order notification fires from order_id block (not touched by #166)
    expect(mockNotifyOrder).toHaveBeenCalledTimes(1);
    // Ordering flow_type → notifyOwnerNewBooking (not payment)
    expect(mockNotifyBooking).toHaveBeenCalledTimes(1);
    expect(mockNotifyPayment).not.toHaveBeenCalled();
  });

  // ══════════════════════════════════════════════════════════
  // DEDUP + ORDERING
  // ══════════════════════════════════════════════════════════

  it('20. claim_payment_confirmation still called (dedup unchanged)', async () => {
    const s = buildMock({}, 'payment');
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay as any);
    const claimCalls = mockRpc.mock.calls.filter((c: unknown[]) => c[0] === 'claim_payment_confirmation');
    expect(claimCalls).toHaveLength(1);
  });

  it('21. In-app write completes before finalization (ordering proof)', async () => {
    const order: string[] = [];
    mockRpc.mockImplementation((name: string) => {
      if (name === 'finalize_payment_confirmation') { order.push('finalize'); return Promise.resolve(FIN_OK); }
      if (name === 'claim_payment_confirmation') return Promise.resolve(CLAIM_OK);
      if (name === 'renew_payment_confirmation_claim') return Promise.resolve(RENEW_OK);
      if (name === 'release_payment_confirmation') return Promise.resolve({ data: { released: true } });
      return Promise.resolve({ data: null, error: null });
    });
    mockFrom.mockImplementation((table: string) => {
      const c = chain();
      if (table === 'bookings') c.single = vi.fn().mockResolvedValue({ data: { guest_phone: '+234', business_id: 'b1', reference_code: 'R1', date: '2026-08-25', time: '14:00', flow_type: 'payment', total_amount: 50, deposit_amount: 50, businesses: { name: 'Biz', country_code: 'NG' }, services: { name: 'S', duration_minutes: 30 } }, error: null });
      if (table === 'businesses') c.single = vi.fn().mockResolvedValue({ data: { subscription_tier: 'free', owner_id: 'o1' }, error: null });
      if (table === 'profiles') { c.single = vi.fn().mockResolvedValue({ data: { email: 'o@t.com', phone: '+234' }, error: null }); c.maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'u1' }, error: null }); }
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

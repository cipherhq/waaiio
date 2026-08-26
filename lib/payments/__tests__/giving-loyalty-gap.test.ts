/**
 * #167 GIVING-LOYALTY-GAP — two-dimensional classifier tests.
 *
 * Proves sendProactiveConfirmation passes the correct skipLoyalty value
 * to handlePostCompletion based on the booking's flow_type + service_type.
 *
 * Classifier contract:
 *   flow_type='payment' + service_type='giving'   → skipLoyalty=true
 *   flow_type='payment' + service_type='booking'  → skipLoyalty=false
 *   flow_type='payment' + service_type=undefined   → skipLoyalty=true (fail-closed) + warning
 *   flow_type='payment' + service_type='unknown'   → skipLoyalty=true (fail-closed) + warning
 *   flow_type='scheduling' + service_type='booking' → skipLoyalty=false
 *   flow_type='ticketing' + service_type=undefined  → skipLoyalty=false
 *   No booking (order/reservation/invoice/campaign)  → skipLoyalty=false
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Static dependency mocks ──
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

const mockLoggerWarn = vi.fn();
vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(), warn: mockLoggerWarn, error: vi.fn(), debug: vi.fn(),
    withContext: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
  },
}));
vi.mock('@/lib/errors', () => ({ safeLogErrorContext: () => ({}) }));
vi.mock('@/lib/utils/phone', () => ({
  stripPlus: (p: string) => p.replace(/^\+/, ''),
}));
vi.mock('@/lib/calendar/generate-links', () => ({
  getCalendarLinksText: vi.fn().mockReturnValue(null),
}));
vi.mock('@/lib/utils/sanitize', () => ({
  sanitizeFilterValue: (v: string) => v,
}));
vi.mock('@/lib/constants', () => ({
  formatCurrency: vi.fn().mockReturnValue('₦5,000'),
}));
vi.mock('@/lib/whitelabel', () => ({
  isWhiteLabel: vi.fn().mockReturnValue(false),
}));
vi.mock('@/lib/bot/flows/shared/user', () => ({
  getCustomerName: vi.fn().mockResolvedValue('Jane Doe'),
}));
vi.mock('@/lib/channels/channel-resolver', () => {
  const MockChannelResolver = class {
    resolveByChannelId = vi.fn().mockResolvedValue(null);
    resolveByBusinessId = vi.fn().mockResolvedValue({
      sender: {
        sendText: vi.fn().mockResolvedValue(undefined),
        sendDocument: vi.fn().mockResolvedValue(undefined),
      },
    });
  };
  return { ChannelResolver: MockChannelResolver };
});
vi.mock('@/lib/bot/flows/shared/notify-owner', () => ({
  notifyOwnerNewBooking: vi.fn().mockResolvedValue(undefined),
  notifyOwnerNewOrder: vi.fn().mockResolvedValue(undefined),
  notifyOwnerNewInvoicePayment: vi.fn().mockResolvedValue(undefined),
  notifyOwnerNewDonation: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/email/client', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/email/templates', () => ({
  paymentReceivedEmail: vi.fn().mockReturnValue({ subject: 't', html: '<p/>' }),
  bookingConfirmationEmail: vi.fn().mockReturnValue({ subject: 't', html: '<p/>' }),
  donationReceiptEmail: vi.fn().mockReturnValue({ subject: 't', html: '<p/>' }),
}));
vi.mock('@/lib/bot/flows/shared/send-tickets', () => ({
  sendTicketsAfterPurchase: vi.fn().mockResolvedValue({ success: true, tickets: [] }),
}));

// ── TARGET: intercept handlePostCompletion ──
vi.mock('@/lib/bot/flows/shared/post-completion', () => ({
  handlePostCompletion: vi.fn().mockResolvedValue(undefined),
}));

// ── Helper: build Supabase mock for a booking with specific flow_type + service_type ──
interface BookingConfig {
  flow_type: string;
  service_type?: string; // undefined = no service linked (null JOIN)
}

function buildBookingSupabase(config: BookingConfig) {
  // eslint-disable-next-line
  function chain(): Record<string, any> {
    // eslint-disable-next-line
    const c: Record<string, any> = {};
    ['select', 'eq', 'neq', 'not', 'is', 'in', 'or', 'order', 'limit', 'update', 'insert', 'delete'].forEach(
      m => c[m] = vi.fn().mockReturnValue(c),
    );
    c.single = vi.fn().mockResolvedValue({ data: null, error: null });
    c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    return c;
  }

  return {
    rpc: vi.fn().mockImplementation((name: string) => {
      if (name === 'claim_payment_confirmation') {
        return Promise.resolve({
          data: {
            claimed: true, claim_token: 'tok-1',
            payment_id: 'p1', amount: 5000,
            booking_id: 'bk-1',
            reservation_id: null, invoice_id: null, campaign_id: null, order_id: null,
          },
          error: null,
        });
      }
      if (name === 'renew_payment_confirmation_claim') {
        return Promise.resolve({ data: { renewed: true }, error: null });
      }
      if (name === 'finalize_payment_confirmation') {
        return Promise.resolve({ data: { finalized: true }, error: null });
      }
      if (name === 'release_payment_confirmation') {
        return Promise.resolve({ data: { released: true }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    }),
    from: vi.fn().mockImplementation((table: string) => {
      const c = chain();

      if (table === 'bookings') {
        c.single = vi.fn().mockResolvedValue({
          data: {
            guest_phone: '+2341234567890', guest_email: null,
            guest_name: 'Jane Doe', reference_code: 'BK-001',
            business_id: 'biz-1', date: '2025-01-15', time: '10:00',
            flow_type: config.flow_type, total_amount: 5000, deposit_amount: 0,
            party_size: 1, bot_session_id: null, event_id: null, notes: null,
            businesses: { name: 'Test Church', country_code: 'NG', address: null, payment_gateway: 'paystack' },
            services: config.service_type !== undefined
              ? { name: 'Tithes', duration_minutes: null, service_type: config.service_type }
              : null,
          },
          error: null,
        });
      }

      if (table === 'payments') {
        c.single = vi.fn().mockResolvedValue({
          data: { user_id: null, gateway: 'paystack', metadata: {} },
          error: null,
        });
      }

      if (table === 'businesses') {
        c.single = vi.fn().mockResolvedValue({
          data: { subscription_tier: 'free', owner_id: null },
          error: null,
        });
      }

      return c;
    }),
  };
}

// Helper: build Supabase mock for non-booking payment types
function buildNonBookingSupabase(type: 'order' | 'reservation' | 'invoice' | 'campaign') {
  // eslint-disable-next-line
  function chain(): Record<string, any> {
    // eslint-disable-next-line
    const c: Record<string, any> = {};
    ['select', 'eq', 'neq', 'not', 'is', 'in', 'or', 'order', 'limit', 'update', 'insert', 'delete'].forEach(
      m => c[m] = vi.fn().mockReturnValue(c),
    );
    c.single = vi.fn().mockResolvedValue({ data: null, error: null });
    c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    return c;
  }

  const claimData = {
    claimed: true, claim_token: 'tok-1',
    payment_id: 'p1', amount: 5000,
    booking_id: null,
    reservation_id: type === 'reservation' ? 'res-1' : null,
    invoice_id: type === 'invoice' ? 'inv-1' : null,
    campaign_id: type === 'campaign' ? 'camp-1' : null,
    order_id: type === 'order' ? 'ord-1' : null,
  };

  return {
    rpc: vi.fn().mockImplementation((name: string) => {
      if (name === 'claim_payment_confirmation') return Promise.resolve({ data: claimData, error: null });
      if (name === 'renew_payment_confirmation_claim') return Promise.resolve({ data: { renewed: true }, error: null });
      if (name === 'finalize_payment_confirmation') return Promise.resolve({ data: { finalized: true }, error: null });
      if (name === 'release_payment_confirmation') return Promise.resolve({ data: { released: true }, error: null });
      return Promise.resolve({ data: null, error: null });
    }),
    from: vi.fn().mockImplementation((table: string) => {
      const c = chain();

      if (table === 'reservations' && type === 'reservation') {
        c.single = vi.fn().mockResolvedValue({
          data: {
            guest_phone: '+2341234567890', guest_name: 'Jane Doe',
            reference_code: 'RES-001', business_id: 'biz-1',
            check_in: '2025-01-20', check_out: '2025-01-22',
            total_amount: 5000, deposit_amount: 0,
            businesses: { name: 'Test Biz', country_code: 'NG', payment_gateway: 'paystack' },
          },
          error: null,
        });
      }

      if (table === 'orders' && type === 'order') {
        const orderData = {
          delivery_phone: '+2341234567890', delivery_name: 'Jane Doe',
          delivery_address: null, reference_code: 'ORD-001',
          business_id: 'biz-1', order_items: [],
          businesses: { name: 'Test Biz', country_code: 'NG' },
        };
        c.single = vi.fn().mockResolvedValue({ data: orderData, error: null });
        c.maybeSingle = vi.fn().mockResolvedValue({ data: orderData, error: null });
      }

      if (table === 'invoices' && type === 'invoice') {
        c.single = vi.fn().mockResolvedValue({
          data: {
            customer_phone: '+2341234567890', customer_name: 'Jane Doe',
            reference_code: 'INV-001', business_id: 'biz-1', total_amount: 5000,
            businesses: { name: 'Test Biz', country_code: 'NG', payment_gateway: 'paystack' },
          },
          error: null,
        });
      }

      if (table === 'payments') {
        c.single = vi.fn().mockResolvedValue({
          data: { user_id: null, gateway: 'paystack', metadata: type === 'order' ? { order_id: 'ord-1' } : {} },
          error: null,
        });
      }

      if (table === 'businesses') {
        c.single = vi.fn().mockResolvedValue({
          data: { subscription_tier: 'free', owner_id: null },
          error: null,
        });
      }

      return c;
    }),
  };
}

const BOOKING_PAYMENT = { id: 'p1', amount: 5000, booking_id: 'bk-1', invoice_id: null, campaign_id: null, reservation_id: null, order_id: null };

async function getPostCompletionArgs() {
  const { handlePostCompletion } = await import('@/lib/bot/flows/shared/post-completion');
  return (handlePostCompletion as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
}

describe('#167 GIVING-LOYALTY-GAP: skipLoyalty classifier', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // ── T1: Direct Giving → skipLoyalty=true ──
  it('Direct Giving (flow_type=payment, service_type=giving) → skipLoyalty=true', async () => {
    const { sendProactiveConfirmation } = await import('../send-confirmation');
    const { handlePostCompletion } = await import('@/lib/bot/flows/shared/post-completion');
    const supabase = buildBookingSupabase({ flow_type: 'payment', service_type: 'giving' });

    const result = await sendProactiveConfirmation(supabase as never, BOOKING_PAYMENT);

    console.log('T1 result:', JSON.stringify(result));
    console.log('T1 handlePostCompletion called:', (handlePostCompletion as ReturnType<typeof vi.fn>).mock.calls.length);
    if ((handlePostCompletion as ReturnType<typeof vi.fn>).mock.calls.length > 0) {
      const args = (handlePostCompletion as ReturnType<typeof vi.fn>).mock.calls[0][0];
      console.log('T1 args:', JSON.stringify(args));
      expect(args.skipLoyalty).toBe(true);
    } else {
      throw new Error('handlePostCompletion was not called');
    }
  });

  // ── T2: Generic Payment → skipLoyalty=false ──
  it('Generic Payment (flow_type=payment, service_type=booking) → skipLoyalty=false', async () => {
    const { sendProactiveConfirmation } = await import('../send-confirmation');
    const supabase = buildBookingSupabase({ flow_type: 'payment', service_type: 'booking' });

    const result = await sendProactiveConfirmation(supabase as never, BOOKING_PAYMENT);

    expect(result.status).toBe('completed');
    const args = await getPostCompletionArgs();
    expect(args).toBeDefined();
    expect(args.skipLoyalty).toBe(false);
  });

  // ── T3: Scheduling booking → skipLoyalty=false ──
  it('Scheduling booking (flow_type=scheduling, service_type=booking) → skipLoyalty=false', async () => {
    const { sendProactiveConfirmation } = await import('../send-confirmation');
    const supabase = buildBookingSupabase({ flow_type: 'scheduling', service_type: 'booking' });

    const result = await sendProactiveConfirmation(supabase as never, BOOKING_PAYMENT);

    expect(result.status).toBe('completed');
    const args = await getPostCompletionArgs();
    expect(args).toBeDefined();
    expect(args.skipLoyalty).toBe(false);
  });

  // ── T4: Ticketing booking → skipLoyalty=false ──
  it('Ticketing booking (flow_type=ticketing, no service) → skipLoyalty=false', async () => {
    const { sendProactiveConfirmation } = await import('../send-confirmation');
    const supabase = buildBookingSupabase({ flow_type: 'ticketing' }); // no service_type

    const result = await sendProactiveConfirmation(supabase as never, BOOKING_PAYMENT);

    expect(result.status).toBe('completed');
    const args = await getPostCompletionArgs();
    expect(args).toBeDefined();
    expect(args.skipLoyalty).toBe(false);
  });

  // ── T5: Order payment (no booking) → skipLoyalty=false ──
  it('Order payment (no booking_id) → skipLoyalty=false', async () => {
    const { sendProactiveConfirmation } = await import('../send-confirmation');
    const supabase = buildNonBookingSupabase('order');

    const result = await sendProactiveConfirmation(
      supabase as never,
      { id: 'p1', amount: 5000, booking_id: null, invoice_id: null, campaign_id: null, reservation_id: null, order_id: 'ord-1' },
    );

    expect(result.status).toBe('completed');
    const args = await getPostCompletionArgs();
    expect(args).toBeDefined();
    expect(args.skipLoyalty).toBe(false);
  });

  // ── T6: Reservation payment (no booking) → skipLoyalty=false ──
  it('Reservation payment (no booking_id) → skipLoyalty=false', async () => {
    const { sendProactiveConfirmation } = await import('../send-confirmation');
    const supabase = buildNonBookingSupabase('reservation');

    const result = await sendProactiveConfirmation(
      supabase as never,
      { id: 'p1', amount: 5000, booking_id: null, invoice_id: null, campaign_id: null, reservation_id: 'res-1', order_id: null },
    );

    expect(result.status).toBe('completed');
    const args = await getPostCompletionArgs();
    expect(args).toBeDefined();
    expect(args.skipLoyalty).toBe(false);
  });

  // ── T7: Invoice payment (no booking) → skipLoyalty=false ──
  it('Invoice payment (no booking_id) → skipLoyalty=false', async () => {
    const { sendProactiveConfirmation } = await import('../send-confirmation');
    const supabase = buildNonBookingSupabase('invoice');

    const result = await sendProactiveConfirmation(
      supabase as never,
      { id: 'p1', amount: 5000, booking_id: null, invoice_id: 'inv-1', campaign_id: null, reservation_id: null, order_id: null },
    );

    expect(result.status).toBe('completed');
    const args = await getPostCompletionArgs();
    expect(args).toBeDefined();
    expect(args.skipLoyalty).toBe(false);
  });

  // ── T8: Campaign payment (no booking) → no post-completion (no phone resolved) ──
  // Campaign donations resolve phone from campaign_donations table, not bookings.
  // Without a campaign_donations mock, customerPhone stays null → handlePostCompletion
  // is never called → loyalty is not affected. This confirms campaigns don't interact
  // with the booking-based giving classifier.
  it('Campaign payment (no booking_id) → post-completion skipped (no customer phone)', async () => {
    const { sendProactiveConfirmation } = await import('../send-confirmation');
    const { handlePostCompletion } = await import('@/lib/bot/flows/shared/post-completion');
    const supabase = buildNonBookingSupabase('campaign');

    await sendProactiveConfirmation(
      supabase as never,
      { id: 'p1', amount: 5000, booking_id: null, invoice_id: null, campaign_id: 'camp-1', reservation_id: null, order_id: null },
    );

    // Campaign donations don't go through booking-based loyalty path
    expect(handlePostCompletion).not.toHaveBeenCalled();
  });
});

describe('#167 GIVING-LOYALTY-GAP: ambiguous classification (fail-closed)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // ── T9: flow_type=payment + null service → fail-closed ──
  it('Payment with null service (no service linked) → skipLoyalty=true + warning', async () => {
    const { sendProactiveConfirmation } = await import('../send-confirmation');
    const supabase = buildBookingSupabase({ flow_type: 'payment' }); // service_type=undefined

    const result = await sendProactiveConfirmation(supabase as never, BOOKING_PAYMENT);

    expect(result.status).toBe('completed');
    const args = await getPostCompletionArgs();
    expect(args).toBeDefined();
    expect(args.skipLoyalty).toBe(true);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('Ambiguous payment classification'),
    );
  });

  // ── T10: flow_type=payment + unexpected service_type → fail-closed ──
  it('Payment with unexpected service_type → skipLoyalty=true + warning', async () => {
    const { sendProactiveConfirmation } = await import('../send-confirmation');
    const supabase = buildBookingSupabase({ flow_type: 'payment', service_type: 'something_unexpected' });

    const result = await sendProactiveConfirmation(supabase as never, BOOKING_PAYMENT);

    expect(result.status).toBe('completed');
    const args = await getPostCompletionArgs();
    expect(args).toBeDefined();
    expect(args.skipLoyalty).toBe(true);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('Ambiguous payment classification'),
    );
  });

  // ── T11: Non-payment flow + null service → NO ambiguity (not payment family) ──
  it('Scheduling with null service → skipLoyalty=false (not payment family)', async () => {
    const { sendProactiveConfirmation } = await import('../send-confirmation');
    const supabase = buildBookingSupabase({ flow_type: 'scheduling' }); // no service

    const result = await sendProactiveConfirmation(supabase as never, BOOKING_PAYMENT);

    expect(result.status).toBe('completed');
    const args = await getPostCompletionArgs();
    expect(args).toBeDefined();
    expect(args.skipLoyalty).toBe(false);
    // No ambiguity warning for non-payment flows
    expect(mockLoggerWarn).not.toHaveBeenCalledWith(
      expect.stringContaining('Ambiguous payment classification'),
    );
  });
});

describe('#167 GIVING-LOYALTY-GAP: recurring Giving classification', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // ── T12: Recurring Giving renewal → skipLoyalty=true ──
  // Recurring renewals create bookings with flow_type='payment' + service_id from
  // customer_subscriptions.service_id, which for giving points to a service_type='giving' service.
  it('Recurring Giving renewal (flow_type=payment, service_type=giving) → skipLoyalty=true', async () => {
    const { sendProactiveConfirmation } = await import('../send-confirmation');
    const supabase = buildBookingSupabase({ flow_type: 'payment', service_type: 'giving' });

    const result = await sendProactiveConfirmation(supabase as never, BOOKING_PAYMENT);

    expect(result.status).toBe('completed');
    const args = await getPostCompletionArgs();
    expect(args).toBeDefined();
    expect(args.skipLoyalty).toBe(true);
  });

  // ── T13: Recurring Payment renewal → skipLoyalty=false ──
  it('Recurring Payment renewal (flow_type=payment, service_type=booking) → skipLoyalty=false', async () => {
    const { sendProactiveConfirmation } = await import('../send-confirmation');
    const supabase = buildBookingSupabase({ flow_type: 'payment', service_type: 'booking' });

    const result = await sendProactiveConfirmation(supabase as never, BOOKING_PAYMENT);

    expect(result.status).toBe('completed');
    const args = await getPostCompletionArgs();
    expect(args).toBeDefined();
    expect(args.skipLoyalty).toBe(false);
  });
});

describe('#167 GIVING-LOYALTY-GAP: replay produces same classification', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // ── T14: Replay of Giving payment → same skipLoyalty=true both times ──
  it('Replayed Giving payment produces identical skipLoyalty=true', async () => {
    const { sendProactiveConfirmation } = await import('../send-confirmation');
    const { handlePostCompletion } = await import('@/lib/bot/flows/shared/post-completion');

    // First call
    const supabase1 = buildBookingSupabase({ flow_type: 'payment', service_type: 'giving' });
    await sendProactiveConfirmation(supabase1 as never, BOOKING_PAYMENT);
    const args1 = (handlePostCompletion as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(args1.skipLoyalty).toBe(true);

    (handlePostCompletion as ReturnType<typeof vi.fn>).mockClear();

    // Second call (replay) — same booking data, same result
    const supabase2 = buildBookingSupabase({ flow_type: 'payment', service_type: 'giving' });
    await sendProactiveConfirmation(supabase2 as never, BOOKING_PAYMENT);
    const args2 = (handlePostCompletion as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(args2.skipLoyalty).toBe(true);
  });

  // ── T15: Replay of generic Payment → same skipLoyalty=false both times ──
  it('Replayed generic Payment produces identical skipLoyalty=false', async () => {
    const { sendProactiveConfirmation } = await import('../send-confirmation');
    const { handlePostCompletion } = await import('@/lib/bot/flows/shared/post-completion');

    const supabase1 = buildBookingSupabase({ flow_type: 'payment', service_type: 'booking' });
    await sendProactiveConfirmation(supabase1 as never, BOOKING_PAYMENT);
    const args1 = (handlePostCompletion as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(args1.skipLoyalty).toBe(false);

    (handlePostCompletion as ReturnType<typeof vi.fn>).mockClear();

    const supabase2 = buildBookingSupabase({ flow_type: 'payment', service_type: 'booking' });
    await sendProactiveConfirmation(supabase2 as never, BOOKING_PAYMENT);
    const args2 = (handlePostCompletion as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(args2.skipLoyalty).toBe(false);
  });
});

describe('#167 GIVING-LOYALTY-GAP: payment completion unaffected by classifier', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // ── T16: Giving payment still completes successfully ──
  it('Giving payment completes (status=completed) despite skipLoyalty=true', async () => {
    const { sendProactiveConfirmation } = await import('../send-confirmation');
    const supabase = buildBookingSupabase({ flow_type: 'payment', service_type: 'giving' });

    const result = await sendProactiveConfirmation(supabase as never, BOOKING_PAYMENT);

    expect(result.status).toBe('completed');
  });

  // ── T17: Ambiguous payment still completes successfully ──
  it('Ambiguous payment completes (status=completed) despite fail-closed skipLoyalty', async () => {
    const { sendProactiveConfirmation } = await import('../send-confirmation');
    const supabase = buildBookingSupabase({ flow_type: 'payment' }); // no service

    const result = await sendProactiveConfirmation(supabase as never, BOOKING_PAYMENT);

    expect(result.status).toBe('completed');
  });
});

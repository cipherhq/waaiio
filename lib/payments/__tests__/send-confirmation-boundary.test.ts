/**
 * sendProactiveConfirmation → handlePostCompletion — executable boundary tests.
 *
 * Mocks handlePostCompletion, executes real sendProactiveConfirmation,
 * and asserts the intercepted call args for Booking, Reservation, and Order.
 *
 * Proves the exact amountPaid, skipCustomerSpend, and skipAutomation values
 * that send-confirmation passes to post-completion for each payment type.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Static dependency mocks ──
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
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
  formatCurrency: vi.fn().mockReturnValue('₦8,000'),
}));

// ── Dynamic dependency mocks ──
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

// ── Mock Supabase factory ──
function buildSupabase(paymentType: 'booking' | 'reservation' | 'order') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function chain(): Record<string, any> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
            payment_id: 'p1', amount: 8000,
            booking_id: paymentType === 'booking' ? 'bk-1' : null,
            reservation_id: paymentType === 'reservation' ? 'res-1' : null,
            invoice_id: null, campaign_id: null,
            order_id: paymentType === 'order' ? 'ord-1' : null,
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
          data: paymentType === 'booking' ? {
            guest_phone: '+2341234567890', guest_email: null,
            guest_name: 'Jane Doe', reference_code: 'BK-001',
            business_id: 'biz-1', date: '2025-01-15', time: '10:00',
            flow_type: 'scheduling', total_amount: 8000, deposit_amount: 0,
            party_size: 1, bot_session_id: null, event_id: null, notes: null,
            businesses: { name: 'Test Biz', country_code: 'NG', address: null, payment_gateway: 'paystack' },
            services: { name: 'Haircut', duration_minutes: 30 },
          } : null,
          error: null,
        });
      }

      if (table === 'reservations') {
        c.single = vi.fn().mockResolvedValue({
          data: paymentType === 'reservation' ? {
            guest_phone: '+2341234567890', guest_name: 'Jane Doe',
            reference_code: 'RES-001', business_id: 'biz-1',
            check_in: '2025-01-20', check_out: '2025-01-22',
            total_amount: 8000, deposit_amount: 0,
            businesses: { name: 'Test Biz', country_code: 'NG', payment_gateway: 'paystack' },
          } : null,
          error: null,
        });
      }

      if (table === 'payments') {
        c.single = vi.fn().mockResolvedValue({
          data: {
            user_id: null, gateway: 'paystack',
            metadata: paymentType === 'order' ? { order_id: 'ord-1' } : {},
          },
          error: null,
        });
      }

      if (table === 'orders') {
        const orderData = paymentType === 'order' ? {
          delivery_phone: '+2341234567890', delivery_name: 'Jane Doe',
          delivery_address: null, reference_code: 'ORD-001',
          business_id: 'biz-1', order_items: [],
          businesses: { name: 'Test Biz', country_code: 'NG' },
        } : null;
        c.single = vi.fn().mockResolvedValue({ data: orderData, error: null });
        c.maybeSingle = vi.fn().mockResolvedValue({ data: orderData, error: null });
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

describe('sendProactiveConfirmation → handlePostCompletion call boundary', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('Booking: passes real amountPaid + skipCustomerSpend=true', async () => {
    const { sendProactiveConfirmation } = await import('../send-confirmation');
    const { handlePostCompletion } = await import('@/lib/bot/flows/shared/post-completion');
    const supabase = buildSupabase('booking');

    const result = await sendProactiveConfirmation(
      supabase as never,
      { id: 'p1', amount: 8000, booking_id: 'bk-1', invoice_id: null, campaign_id: null, reservation_id: null, order_id: null },
    );

    expect(result.status).toBe('completed');
    expect(handlePostCompletion).toHaveBeenCalledOnce();
    const args = (handlePostCompletion as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.amountPaid).toBe(8000);           // Real amount for receipts/loyalty
    expect(args.skipCustomerSpend).toBe(true);    // Stage 2 owns durable spend
    expect(args.businessId).toBe('biz-1');
    expect(args.customerPhone).toBe('+2341234567890');
  });

  it('Reservation: passes real amountPaid + skipCustomerSpend=true', async () => {
    const { sendProactiveConfirmation } = await import('../send-confirmation');
    const { handlePostCompletion } = await import('@/lib/bot/flows/shared/post-completion');
    const supabase = buildSupabase('reservation');

    const result = await sendProactiveConfirmation(
      supabase as never,
      { id: 'p1', amount: 8000, booking_id: null, invoice_id: null, campaign_id: null, reservation_id: 'res-1', order_id: null },
    );

    expect(result.status).toBe('completed');
    expect(handlePostCompletion).toHaveBeenCalledOnce();
    const args = (handlePostCompletion as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.amountPaid).toBe(8000);           // Real amount for receipts/loyalty
    expect(args.skipCustomerSpend).toBe(true);    // Stage 2 owns durable spend
    expect(args.businessId).toBe('biz-1');
    expect(args.customerPhone).toBe('+2341234567890');
  });

  it('Order: passes amountPaid=0 + skipCustomerSpend=false (pre-#161 behavior)', async () => {
    const { sendProactiveConfirmation } = await import('../send-confirmation');
    const { handlePostCompletion } = await import('@/lib/bot/flows/shared/post-completion');
    const supabase = buildSupabase('order');

    const result = await sendProactiveConfirmation(
      supabase as never,
      { id: 'p1', amount: 8000, booking_id: null, invoice_id: null, campaign_id: null, reservation_id: null, order_id: 'ord-1' },
    );

    expect(result.status).toBe('completed');
    expect(handlePostCompletion).toHaveBeenCalledOnce();
    const args = (handlePostCompletion as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.amountPaid).toBe(0);              // Orders: amountPaid=0 (unchanged)
    expect(args.skipCustomerSpend).toBe(false);   // NOT set for orders
    expect(args.skipAutomation).toBe(true);       // Orders skip automation at webhook
  });
});

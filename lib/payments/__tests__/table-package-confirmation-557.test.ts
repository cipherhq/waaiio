/**
 * M557 part 2: the paid confirmation of a table booking names its package and
 * minimum spend, read from bookings.metadata.table_offer (written by
 * book_table_atomic). Runs the real sendProactiveConfirmation; harness copied
 * from send-confirmation-boundary.test.ts, with the sent WhatsApp text captured.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sent = vi.hoisted(() => ({ sendText: vi.fn().mockResolvedValue(undefined), booking: {} as Record<string, unknown> }));

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
  formatCurrency: vi.fn((n: number) => `₦${n.toLocaleString('en-NG')}`),
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
      channel: { id: 'ch-dedicated', channel_type: 'dedicated' },
      sender: {
        sendText: sent.sendText,
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

vi.mock('@/lib/bot/transaction-followups', () => ({ startTransactionFollowup: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/payments/transaction-followup', () => ({ resumePaidTransactionFollowup: vi.fn().mockResolvedValue(undefined) }));

// ── TARGET: intercept handlePostCompletion ──
vi.mock('@/lib/bot/flows/shared/post-completion', () => ({
  handlePostCompletion: vi.fn().mockResolvedValue(undefined),
}));

// Post-finalization Save Card is a separate non-blocking lifecycle.
vi.mock('@/lib/payments/saved-card-offer', () => ({
  checkAndOfferSavedCard: vi.fn().mockResolvedValue(undefined),
  retryPendingSavedCardOffer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/merchant-notifications/compatibility', () => ({ hasMerchantNotificationIntent: vi.fn().mockResolvedValue(false) }));

// ── Mock Supabase factory ──
function buildSupabase(paymentType: 'booking' | 'reservation' | 'order') {
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
            payment_id: 'p1', amount: 8000,
            booking_id: paymentType === 'booking' ? 'bk-1' : null,
            reservation_id: paymentType === 'reservation' ? 'res-1' : null,
            invoice_id: null, campaign_id: null,
            order_id: paymentType === 'order' ? 'ord-1' : null,
          },
          error: null,
        });
      }
      // Customer WhatsApp delivery attempt (#197): claimed and authorized, so the text is sent.
      if (name === 'claim_confirmation_delivery') {
        return Promise.resolve({ data: { claimed: true, attempt_id: 'att-1', claim_token: 'dtok-1' }, error: null });
      }
      if (name === 'begin_confirmation_send') {
        return Promise.resolve({ data: { authorized: true }, error: null });
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
            flow_type: 'scheduling', ...sent.booking, total_amount: 8000, deposit_amount: 0,
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

const GOLD = { id: '11111111-1111-4111-8111-111111111111', name: 'Gold', includes: '2 Hennessy VS + 1 Moët', price: 650000 };

async function confirm() {
  const { sendProactiveConfirmation } = await import('../send-confirmation');
  const result = await sendProactiveConfirmation(
    buildSupabase('booking') as never,
    { id: 'p1', amount: 8000, booking_id: 'bk-1', invoice_id: null, campaign_id: null, reservation_id: null, order_id: null },
  );
  expect(result.status).toBe('completed');
  return sent.sendText.mock.calls.map(([m]) => (m as { text?: string }).text || '').join('\n---\n');
}

describe('paid table booking confirmation (M557)', () => {
  beforeEach(() => { vi.clearAllMocks(); sent.booking = {}; });

  it('names the package and minimum spend; pay in full has no "rest at the venue"', async () => {
    sent.booking = { flow_type: 'table_reservation', services: null, metadata: { duration_minutes: 120, table_offer: { payment_mode: 'full', minimum_spend: 500000, package: GOLD } } };
    const text = await confirm();
    expect(text).toContain('🍾 Package: Gold – ₦650,000\n   2 Hennessy VS + 1 Moët\n💵 Minimum spend: ₦500,000\n💰 Amount:');
    expect(text).not.toContain('rest is paid at the venue');
  });

  it('deposit only, no package: the minimum spend and "rest at the venue"', async () => {
    sent.booking = { flow_type: 'table_reservation', services: null, metadata: { table_offer: { payment_mode: 'deposit', minimum_spend: 300000, package: null } } };
    const text = await confirm();
    expect(text).toContain('💵 Minimum spend: ₦300,000\nThe rest is paid at the venue.');
    expect(text).not.toContain('🍾');
  });

  it('a table booking without an offer, and any other booking, get the same message as before', async () => {
    sent.booking = { flow_type: 'table_reservation', services: null, metadata: { duration_minutes: 90 } };
    const plainTable = await confirm();
    expect(plainTable).toContain('Confirmed!');
    expect(plainTable).not.toMatch(/Package|Minimum spend|venue/);
    sent.booking = { metadata: { table_offer: { payment_mode: 'full', minimum_spend: 1, package: GOLD } } };
    const service = await confirm();
    expect(service).toContain('📋 Haircut');
    expect(service).not.toMatch(/Package|Minimum spend/);
  });
});

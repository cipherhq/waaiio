/**
 * customer_whatsapp lifecycle runtime test — exercises the real sendProactiveConfirmation
 * with controlled mocks proving the WhatsApp-origin missing-channel retry sequence.
 *
 * Implementation-Agent: Claude Code
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRpc = vi.fn();
const mockFrom = vi.fn();

function chain() {
  const c: Record<string, unknown> = {};
  ['select', 'eq', 'is', 'in', 'or', 'not', 'neq', 'order', 'limit', 'update', 'upsert'].forEach(m => {
    (c as Record<string, unknown>)[m] = vi.fn().mockReturnValue(c);
  });
  c.single = vi.fn().mockResolvedValue({ data: null, error: null });
  c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
  c.insert = vi.fn().mockResolvedValue({ data: null, error: null });
  return c;
}

// Hoisted mocks
const { mockResolveByChannel, mockResolveByBiz } = vi.hoisted(() => ({
  mockResolveByChannel: vi.fn(),
  mockResolveByBiz: vi.fn(),
}));
const mockSendText = vi.fn().mockResolvedValue({ messageId: 'wamid-123' });
const mockSender = { sendText: mockSendText, sendDocument: vi.fn(), sendImage: vi.fn(), sendButtons: vi.fn() };

vi.mock('@/lib/channels/channel-resolver', () => ({
  ChannelResolver: class {
    resolveByChannelId(...args: unknown[]) { return mockResolveByChannel(...args); }
    resolveByBusinessId(...args: unknown[]) { return mockResolveByBiz(...args); }
  },
}));
vi.mock('@/lib/bot/flows/shared/notify-owner', () => ({
  notifyOwnerNewPayment: vi.fn().mockResolvedValue(undefined),
  notifyOwnerNewBooking: vi.fn().mockResolvedValue(undefined),
  notifyOwnerNewDonation: vi.fn().mockResolvedValue(undefined),
  notifyOwnerNewOrder: vi.fn().mockResolvedValue(undefined),
  notifyOwnerNewInvoicePayment: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/bot/flows/shared/payment', () => ({ initializePayment: vi.fn() }));
vi.mock('@/lib/whitelabel', () => ({ isWhiteLabel: () => false }));
vi.mock('@/lib/bot/flows/shared/post-completion', () => ({ handlePostCompletion: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/email/templates', () => ({
  paymentReceivedEmail: vi.fn().mockReturnValue({ subject: 's', html: 'h' }),
  bookingConfirmationEmail: vi.fn().mockReturnValue({ subject: 's', html: 'h' }),
  donationReceiptEmail: vi.fn().mockReturnValue({ subject: 's', html: 'h' }),
}));
vi.mock('@/lib/bot/flows/shared/send-tickets', () => ({ sendTicketsAfterPurchase: vi.fn().mockResolvedValue({ success: true, tickets: [] }) }));
vi.mock('@/lib/errors', () => ({ safeLogErrorContext: vi.fn().mockReturnValue({}) }));
vi.mock('@/lib/bot/flows/shared/notifications', () => ({ createNotification: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/bot/flows/shared/user', () => ({ getCustomerName: vi.fn().mockResolvedValue('Test') }));
vi.mock('@/lib/calendar/generate-links', () => ({ getCalendarLinksText: vi.fn().mockReturnValue(''), generateGoogleCalendarUrl: vi.fn(), buildCalendarEvent: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

// Track RPC calls for assertion
let rpcCalls: Array<{ name: string; params: Record<string, unknown> }> = [];

// Build the mock supabase with WhatsApp-origin metadata
function buildSupabase(opts: {
  confirmationOrigin: string;
  inboundChannelId?: string;
  hasDeliveryRows?: boolean;
  deliveryStatus?: string;
}) {
  rpcCalls = [];
  mockRpc.mockImplementation((name: string, params: Record<string, unknown>) => {
    rpcCalls.push({ name, params });
    // Claim returns WhatsApp-origin booking payment WITHOUT payment_authority_version
    // (legacy mock — manifestInitialized stays false, uses legacy path)
    if (name === 'claim_payment_confirmation') {
      return Promise.resolve({ data: { claimed: true, claim_token: 'tok-1', payment_id: 'pay-wa', amount: 5000, booking_id: 'bk-wa', invoice_id: null, campaign_id: null, reservation_id: null, order_id: null, payment_authority_version: null }, error: null });
    }
    if (name === 'renew_payment_confirmation_claim') return Promise.resolve({ data: { renewed: true }, error: null });
    if (name === 'finalize_payment_confirmation') return Promise.resolve({ data: { finalized: true, already_finalized: false }, error: null });
    if (name === 'release_payment_confirmation') return Promise.resolve({ data: { released: true }, error: null });
    // Delivery sub-lifecycle RPCs
    if (name === 'claim_confirmation_delivery') {
      return Promise.resolve({ data: { claimed: true, attempt_id: 'att-1', claim_token: 'dtok-1' }, error: null });
    }
    if (name === 'begin_confirmation_send') return Promise.resolve({ data: { authorized: true }, error: null });
    if (name === 'complete_confirmation_send') return Promise.resolve({ data: { completed: true }, error: null });
    if (name === 'fail_confirmation_send') return Promise.resolve({ data: { failed: true }, error: null });
    if (name === 'recover_wamid_attachment') return Promise.resolve({ data: { recovered: true }, error: null });
    return Promise.resolve({ data: null, error: null });
  });

  mockFrom.mockImplementation((table: string) => {
    const c = chain();
    if (table === 'bookings') {
      c.single = vi.fn().mockResolvedValue({
        data: {
          guest_phone: '+2348012345678', guest_email: null, business_id: 'b1', reference_code: 'REF-WA',
          date: '2026-09-20', time: '10:00', flow_type: 'scheduling', total_amount: 5000, deposit_amount: 5000,
          businesses: { name: 'TestBiz', country_code: 'NG', address: null, payment_gateway: 'paystack' },
          services: { name: 'Haircut', duration_minutes: 30, service_type: 'booking' },
        }, error: null,
      });
    }
    if (table === 'payments') {
      c.single = vi.fn().mockResolvedValue({
        data: { user_id: 'u1', metadata: { _confirmation_origin: opts.confirmationOrigin, _inbound_channel_id: opts.inboundChannelId || null }, gateway: 'paystack' },
        error: null,
      });
    }
    if (table === 'businesses') {
      c.single = vi.fn().mockResolvedValue({ data: { subscription_tier: 'free', owner_id: 'o1', metadata: {} }, error: null });
    }
    if (table === 'profiles') {
      c.single = vi.fn().mockResolvedValue({ data: { email: 'owner@test.com', phone: '+234owner' }, error: null });
      c.maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'u1', email: 'o@t.com', phone: '+234' }, error: null });
    }
    if (table === 'notifications') {
      c.insert = vi.fn().mockResolvedValue({ data: null, error: null });
    }
    if (table === 'bot_sessions') {
      c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    }
    if (table === 'payment_confirmation_deliveries') {
      if (opts.hasDeliveryRows) {
        c.maybeSingle = vi.fn().mockResolvedValue({ data: [{ delivery_status: opts.deliveryStatus || 'accepted' }], error: null });
        // For the SELECT used by the bridge
        (c as Record<string, unknown>).then = undefined; // ensure it's not thenable
      }
    }
    return c;
  });

  return { rpc: mockRpc, from: mockFrom, storage: { from: () => ({ upload: vi.fn().mockResolvedValue({ error: null }), createSignedUrl: vi.fn().mockResolvedValue({ data: { signedUrl: 'https://example.com/signed' }, error: null }) }) } } as unknown;
}

const payment = { id: 'pay-wa', amount: 5000, booking_id: 'bk-wa', invoice_id: null, campaign_id: null, reservation_id: null, order_id: null };

describe('customer_whatsapp lifecycle — runtime proof', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rpcCalls = [];
  });

  it('1. WhatsApp-origin + missing channel → retryable, no provider send, no fail_external', async () => {
    // Channel resolution returns null for WhatsApp origin → whatsappOriginMissingChannel = true
    mockResolveByChannel.mockResolvedValue(null);
    mockResolveByBiz.mockResolvedValue(null); // fallback not used for WhatsApp origin

    const s = buildSupabase({ confirmationOrigin: 'whatsapp', inboundChannelId: 'ch-dead' });
    const { sendProactiveConfirmation } = await import('../send-confirmation');
    const result = await sendProactiveConfirmation(s as any, payment as any);

    // Must be retryable (claim released, not finalized)
    expect(result.status).toBe('retryable_failed');
    expect(result.retryable).toBe(true);
    expect((result as any).reason).toBe('whatsapp_origin_missing_channel');

    // No customer WhatsApp send occurred
    expect(mockSendText).not.toHaveBeenCalled();

    // release_payment_confirmation was called (claim released for retry)
    const releaseCalls = rpcCalls.filter(c => c.name === 'release_payment_confirmation');
    expect(releaseCalls.length).toBe(1);

    // finalize_payment_confirmation was NOT called
    const finalizeCalls = rpcCalls.filter(c => c.name === 'finalize_payment_confirmation');
    expect(finalizeCalls.length).toBe(0);

    // fail_external_effect was NOT called for customer_whatsapp
    const failCalls = rpcCalls.filter(c => c.name === 'fail_external_effect');
    expect(failCalls.length).toBe(0);
  });

  it('2. Repair channel + retry → exactly one WhatsApp send, finalization succeeds', async () => {
    // Now channel is resolved (repaired)
    mockResolveByChannel.mockResolvedValue({ sender: mockSender, channelId: 'ch-repaired', phoneNumberId: 'pn-1' });

    const s = buildSupabase({ confirmationOrigin: 'whatsapp', inboundChannelId: 'ch-repaired' });
    const { sendProactiveConfirmation } = await import('../send-confirmation');
    const result = await sendProactiveConfirmation(s as any, payment as any);

    // Finalization succeeds
    expect(result.status).toBe('completed');

    // Exactly one customer WhatsApp send occurred
    expect(mockSendText).toHaveBeenCalledTimes(1);
    // The send was to the customer phone
    // stripPlus removes the + prefix before sending
    expect(mockSendText.mock.calls[0][0]).toMatchObject({ to: '2348012345678' });

    // claim_confirmation_delivery was called (delivery sub-lifecycle)
    const deliveryClaims = rpcCalls.filter(c => c.name === 'claim_confirmation_delivery');
    expect(deliveryClaims.length).toBe(1);

    // begin_confirmation_send was called (emission fence)
    const beginSends = rpcCalls.filter(c => c.name === 'begin_confirmation_send');
    expect(beginSends.length).toBe(1);

    // finalize_payment_confirmation was called
    const finalizeCalls = rpcCalls.filter(c => c.name === 'finalize_payment_confirmation');
    expect(finalizeCalls.length).toBe(1);
  });

  it('3. Another retry after completion → no duplicate WhatsApp emission', async () => {
    mockResolveByChannel.mockResolvedValue({ sender: mockSender, channelId: 'ch-repaired', phoneNumberId: 'pn-1' });

    // Claim returns already_completed on retry
    const s = buildSupabase({ confirmationOrigin: 'whatsapp', inboundChannelId: 'ch-repaired' });
    mockRpc.mockImplementation((name: string, params: Record<string, unknown>) => {
      rpcCalls.push({ name, params });
      if (name === 'claim_payment_confirmation') {
        return Promise.resolve({ data: { claimed: false, already_completed: true, reason: 'already_sent' }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });

    const { sendProactiveConfirmation } = await import('../send-confirmation');
    const result = await sendProactiveConfirmation(s as any, payment as any);

    // Returns already_completed
    expect(result.status).toBe('already_completed');

    // No customer WhatsApp send — already completed
    expect(mockSendText).not.toHaveBeenCalled();

    // No delivery sub-lifecycle RPCs called
    const deliveryClaims = rpcCalls.filter(c => c.name === 'claim_confirmation_delivery');
    expect(deliveryClaims.length).toBe(0);
  });
});

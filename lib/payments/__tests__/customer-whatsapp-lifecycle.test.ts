/**
 * customer_whatsapp Phase-A lifecycle runtime test.
 *
 * Exercises real sendProactiveConfirmation with Phase-A authority
 * (payment_authority_version != null) and a stateful manifest mock
 * that rejects changed effect sets (mimicking Migration 385).
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
vi.mock('@/lib/capabilities/service', () => ({
  getEnabledCapabilities: vi.fn().mockResolvedValue(['scheduling', 'loyalty']),
  getConfiguredCapabilities: vi.fn().mockResolvedValue({ ok: true, rows: [{ capability: 'scheduling', is_enabled: true }, { capability: 'loyalty', is_enabled: true }] }),
}));

// ── Stateful manifest mock ──
// Stores the first-sealed effect set and rejects mismatches on retry
let sealedEffectKeys: string[] | null = null;
let manifestEffects: Map<string, string> = new Map(); // key → status

let rpcCalls: Array<{ name: string; params: Record<string, unknown> }> = [];

function buildSupabase(opts: {
  confirmationOrigin: string;
  inboundChannelId?: string;
  channelResolved: boolean;
}) {
  rpcCalls = [];
  mockRpc.mockImplementation((name: string, params: Record<string, unknown>) => {
    rpcCalls.push({ name, params });

    // Phase-A claim: returns payment_authority_version = 1
    if (name === 'claim_payment_confirmation') {
      return Promise.resolve({ data: {
        claimed: true, claim_token: 'tok-pa', payment_id: 'pay-pa', amount: 5000,
        booking_id: 'bk-pa', invoice_id: null, campaign_id: null, reservation_id: null, order_id: null,
        payment_authority_version: 1,
      }, error: null });
    }
    if (name === 'renew_payment_confirmation_claim') return Promise.resolve({ data: { renewed: true }, error: null });
    if (name === 'release_payment_confirmation') return Promise.resolve({ data: { released: true }, error: null });

    // Stateful manifest initialization
    if (name === 'initialize_terminal_effects') {
      const keys = (params.p_effect_keys as string[]) || [];
      if (sealedEffectKeys === null) {
        // First seal: store the frozen effect set
        sealedEffectKeys = [...keys].sort();
        for (const k of keys) manifestEffects.set(k, 'pending');
        return Promise.resolve({ data: { initialized: true, already_initialized: false, effect_count: keys.length, semantic_hash: 'h1' }, error: null });
      }
      // Retry: verify exact match (mimicking Migration 385)
      const retryKeys = [...keys].sort();
      if (JSON.stringify(retryKeys) !== JSON.stringify(sealedEffectKeys)) {
        return Promise.resolve({ data: { error: 'manifest_mismatch', expected_keys: sealedEffectKeys, received_keys: retryKeys }, error: null });
      }
      return Promise.resolve({ data: { initialized: true, already_initialized: true, effect_count: keys.length, semantic_hash: 'h1' }, error: null });
    }

    // Effect lifecycle RPCs — stateful
    if (name === 'reserve_terminal_effect') {
      const key = params.p_effect_key as string;
      const status = manifestEffects.get(key);
      if (!status) return Promise.resolve({ data: { reserved: false, reason: 'effect_not_in_manifest' }, error: null });
      if (status === 'completed' || status === 'failed' || status === 'indeterminate' || status === 'skipped') {
        return Promise.resolve({ data: { reserved: false, reason: 'already_terminal', current_status: status }, error: null });
      }
      manifestEffects.set(key, 'claimed');
      return Promise.resolve({ data: { reserved: true, effect_token: `etok-${key}` }, error: null });
    }
    if (name === 'begin_terminal_external_emission') {
      return Promise.resolve({ data: { authorized: true }, error: null });
    }
    if (name === 'complete_internal_effect') {
      const key = params.p_effect_key as string;
      manifestEffects.set(key, 'completed');
      return Promise.resolve({ data: { completed: true }, error: null });
    }
    if (name === 'complete_external_effect') {
      const key = params.p_effect_key as string;
      manifestEffects.set(key, 'completed');
      return Promise.resolve({ data: { completed: true }, error: null });
    }
    if (name === 'fail_external_effect') {
      const key = params.p_effect_key as string;
      manifestEffects.set(key, 'failed');
      return Promise.resolve({ data: { failed: true }, error: null });
    }
    if (name === 'mark_effect_indeterminate') {
      const key = params.p_effect_key as string;
      manifestEffects.set(key, 'indeterminate');
      return Promise.resolve({ data: { marked: true }, error: null });
    }
    if (name === 'skip_optional_effect') {
      const key = params.p_effect_key as string;
      manifestEffects.set(key, 'skipped');
      return Promise.resolve({ data: { skipped: true }, error: null });
    }
    if (name === 'finalize_payment_confirmation') {
      return Promise.resolve({ data: { finalized: true, already_finalized: false, has_manifest: true }, error: null });
    }

    // Delivery sub-lifecycle
    if (name === 'claim_confirmation_delivery') {
      return Promise.resolve({ data: { claimed: true, attempt_id: 'att-1', claim_token: 'dtok-1' }, error: null });
    }
    if (name === 'begin_confirmation_send') return Promise.resolve({ data: { authorized: true }, error: null });
    if (name === 'complete_confirmation_send') return Promise.resolve({ data: { completed: true }, error: null });

    return Promise.resolve({ data: null, error: null });
  });

  mockFrom.mockImplementation((table: string) => {
    const c = chain();
    if (table === 'bookings') {
      c.single = vi.fn().mockResolvedValue({
        data: {
          guest_phone: '+2348012345678', guest_email: 'guest@test.com', business_id: 'b1', reference_code: 'REF-PA',
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
      c.single = vi.fn().mockResolvedValue({
        data: { subscription_tier: 'free', owner_id: 'o1', metadata: { loyalty_earning_enabled: true, loyalty_points_mode: 'per_visit', loyalty_points_per_visit: 10 } },
        error: null,
      });
    }
    if (table === 'profiles') {
      c.single = vi.fn().mockResolvedValue({ data: { email: 'owner@test.com', phone: '+234owner' }, error: null });
      c.maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'u1', email: 'o@t.com', phone: '+234' }, error: null });
    }
    if (table === 'notifications') c.insert = vi.fn().mockResolvedValue({ data: null, error: null });
    if (table === 'bot_sessions') c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    if (table === 'payment_confirmation_deliveries') {
      // For bridge: return delivery rows only when channel is resolved
      const rows = opts.channelResolved ? [{ delivery_status: 'accepted' }] : [];
      // The bridge reads with a plain select chain, not .single()
      // Override the chain's implicit resolution
    }
    if (table === 'business_capabilities') {
      // capability resolver mock
    }
    return c;
  });

  return { rpc: mockRpc, from: mockFrom, storage: { from: () => ({ upload: vi.fn().mockResolvedValue({ error: null }), createSignedUrl: vi.fn().mockResolvedValue({ data: { signedUrl: 'https://example.com/signed' }, error: null }) }) } } as unknown;
}

const payment = { id: 'pay-pa', amount: 5000, booking_id: 'bk-pa', invoice_id: null, campaign_id: null, reservation_id: null, order_id: null };

describe('customer_whatsapp Phase-A lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rpcCalls = [];
    sealedEffectKeys = null;
    manifestEffects = new Map();
  });

  it('1. WhatsApp-origin + missing channel: manifest includes customer_whatsapp, no send, retryable', async () => {
    // Channel resolution fails for WhatsApp origin
    mockResolveByChannel.mockResolvedValue(null);
    mockResolveByBiz.mockResolvedValue(null);

    const s = buildSupabase({ confirmationOrigin: 'whatsapp', inboundChannelId: 'ch-dead', channelResolved: false });
    const { sendProactiveConfirmation } = await import('../send-confirmation');
    const result = await sendProactiveConfirmation(s as any, payment as any);

    // Must be retryable
    expect(result.status).toBe('retryable_failed');
    expect(result.retryable).toBe(true);

    // Manifest was initialized (Phase-A payment)
    const initCalls = rpcCalls.filter(c => c.name === 'initialize_terminal_effects');
    expect(initCalls.length).toBe(1);

    // customer_whatsapp IS in the frozen manifest
    expect(sealedEffectKeys).toContain('customer_whatsapp');
    // Sender-dependent WhatsApp effects are also frozen
    expect(sealedEffectKeys).toContain('receipt_pdf_delivery');
    expect(sealedEffectKeys).toContain('customer_loyalty_whatsapp');

    // No provider send occurred
    expect(mockSendText).not.toHaveBeenCalled();

    // customer_whatsapp was NOT terminalized as failed
    const failCalls = rpcCalls.filter(c => c.name === 'fail_external_effect' && (c.params as Record<string, unknown>).p_effect_key === 'customer_whatsapp');
    expect(failCalls.length).toBe(0);

    // WhatsApp-dependent effects were NOT skipped (left pending for retry)
    const skipCalls = rpcCalls.filter(c => c.name === 'skip_optional_effect');
    const skippedKeys = skipCalls.map(c => (c.params as Record<string, unknown>).p_effect_key);
    expect(skippedKeys).not.toContain('receipt_pdf_delivery');
    expect(skippedKeys).not.toContain('customer_loyalty_whatsapp');
    expect(skippedKeys).not.toContain('ticket_delivery_whatsapp');

    // Claim released for retry
    const releaseCalls = rpcCalls.filter(c => c.name === 'release_payment_confirmation');
    expect(releaseCalls.length).toBe(1);

    // Finalize NOT called
    const finalizeCalls = rpcCalls.filter(c => c.name === 'finalize_payment_confirmation');
    expect(finalizeCalls.length).toBe(0);
  });

  it('2. Channel repaired + retry: same manifest (no mismatch), one WhatsApp send, completed', async () => {
    // First attempt: missing channel (seeds the manifest)
    mockResolveByChannel.mockResolvedValue(null);
    mockResolveByBiz.mockResolvedValue(null);
    let s = buildSupabase({ confirmationOrigin: 'whatsapp', inboundChannelId: 'ch-dead', channelResolved: false });
    const mod = await import('../send-confirmation');
    await mod.sendProactiveConfirmation(s as any, payment as any);

    // Verify manifest was sealed
    expect(sealedEffectKeys).not.toBeNull();
    const firstSealKeys = [...sealedEffectKeys!];

    // Second attempt: channel repaired
    vi.clearAllMocks();
    rpcCalls = [];
    mockResolveByChannel.mockResolvedValue({ sender: mockSender, channelId: 'ch-repaired', phoneNumberId: 'pn-1' });
    s = buildSupabase({ confirmationOrigin: 'whatsapp', inboundChannelId: 'ch-repaired', channelResolved: true });
    const result = await mod.sendProactiveConfirmation(s as any, payment as any);

    // Manifest initialization must receive the SAME effect set (no manifest_mismatch)
    const initCalls = rpcCalls.filter(c => c.name === 'initialize_terminal_effects');
    expect(initCalls.length).toBe(1);
    const retryKeys = ((initCalls[0].params as Record<string, unknown>).p_effect_keys as string[]).sort();
    expect(retryKeys).toEqual(firstSealKeys.sort());

    // Exactly one customer WhatsApp send
    expect(mockSendText).toHaveBeenCalledTimes(1);

    // Delivery sub-lifecycle was used
    const deliveryClaims = rpcCalls.filter(c => c.name === 'claim_confirmation_delivery');
    expect(deliveryClaims.length).toBe(1);
    const beginSends = rpcCalls.filter(c => c.name === 'begin_confirmation_send');
    expect(beginSends.length).toBe(1);

    // Finalization succeeded
    expect(result.status).toBe('completed');
  });

  it('3. Third retry after completion: no duplicate emission', async () => {
    // Setup: first attempt seeds manifest, second completes
    mockResolveByChannel.mockResolvedValue(null);
    mockResolveByBiz.mockResolvedValue(null);
    let s = buildSupabase({ confirmationOrigin: 'whatsapp', inboundChannelId: 'ch-dead', channelResolved: false });
    const mod = await import('../send-confirmation');
    await mod.sendProactiveConfirmation(s as any, payment as any);
    vi.clearAllMocks(); rpcCalls = [];
    mockResolveByChannel.mockResolvedValue({ sender: mockSender, channelId: 'ch-ok', phoneNumberId: 'pn-1' });
    s = buildSupabase({ confirmationOrigin: 'whatsapp', inboundChannelId: 'ch-ok', channelResolved: true });
    await mod.sendProactiveConfirmation(s as any, payment as any);

    // Third attempt: claim returns already_completed
    vi.clearAllMocks(); rpcCalls = [];
    mockRpc.mockImplementation((name: string, params: Record<string, unknown>) => {
      rpcCalls.push({ name, params });
      if (name === 'claim_payment_confirmation') {
        return Promise.resolve({ data: { claimed: false, already_completed: true, reason: 'already_sent' }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    const result = await mod.sendProactiveConfirmation(s as any, payment as any);

    expect(result.status).toBe('already_completed');
    expect(mockSendText).not.toHaveBeenCalled();
    expect(rpcCalls.filter(c => c.name === 'claim_confirmation_delivery').length).toBe(0);
  });
});

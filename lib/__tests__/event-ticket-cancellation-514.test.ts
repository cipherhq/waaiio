import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(), guard: vi.fn(), financial: vi.fn(), pdf: vi.fn(),
  provider: vi.fn(), email: vi.fn(), template: vi.fn(() => ({ subject: 'Ticket', html: 'Ticket' })),
}));
vi.mock('resend', () => ({ Resend: class { emails = { send: mocks.provider }; } }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), withContext: () => ({ error: vi.fn() }) } }));
vi.mock('@/lib/pdf/ticket-generator', () => ({ generateTicketsPdf: mocks.pdf }));
vi.mock('@/lib/payments/proactive-localization', () => ({ resolveProactiveLocalization: vi.fn().mockResolvedValue({ language: 'en' }) }));
vi.mock('@/lib/email/client', () => ({ sendEmail: mocks.email }));
vi.mock('@/lib/email/templates', () => ({ ticketConfirmationEmail: mocks.template }));
vi.mock('@/lib/whitelabel', () => ({ isWhiteLabel: () => false }));
vi.mock('@/lib/payments/session-terminalization', () => ({ terminalizeOriginatingSession: vi.fn().mockResolvedValue({ status: 'no_origin' }) }));

vi.mock('@/lib/webhooks/dispatcher', () => ({ dispatchWebhook: mocks.dispatch }));
vi.mock('@/lib/channels/send-guard', () => ({ assertMessagingAllowed: mocks.guard }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({ rpc: mocks.financial }) }));
vi.mock('@/lib/circuit-breaker', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/circuit-breaker')>(),
  isCircuitOpen: () => false, recordSuccess: vi.fn(), recordFailure: vi.fn(),
}));
vi.mock('@/lib/channels/attempt-recording', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/channels/attempt-recording')>(),
  createAttempt: vi.fn().mockResolvedValue('attempt'),
  updateAttemptContext: vi.fn().mockResolvedValue(undefined),
  markSending: vi.fn().mockResolvedValue(undefined),
  markAccepted: vi.fn().mockResolvedValue(undefined),
  markFailed: vi.fn().mockResolvedValue(undefined),
  markAmbiguous: vi.fn().mockResolvedValue(undefined),
}));

import { MetaCloudSender } from '@/lib/channels/message-sender';
import { MetaApiError } from '@/lib/channels/meta-api-error';
import { sendTicketsAfterPurchase, ensureCanonicalTicketRows, deliverTicketsWhatsApp, deliverTicketsEmail } from '@/lib/bot/flows/shared/send-tickets';
import { ensurePaidTicketState } from '@/lib/payments/ticket-business-state';
import { sendProactiveConfirmation } from '@/lib/payments/send-confirmation';
import { authorizeAndFinalize } from '@/lib/payments/authority';

const ticket = { ticketCode: 'TK-ONE', ticketNumber: 1, totalTickets: 1 };
function chain(data: unknown) {
  const c: Record<string, any> = {};
  for (const key of ['select', 'eq', 'in', 'limit', 'order', 'is']) c[key] = vi.fn(() => c);
  c.single = c.maybeSingle = vi.fn(async () => ({ data, error: null }));
  return c;
}
function deliveryDb(options: { cancelled?: boolean; finalizeError?: boolean } = {}) {
  const states = new Map<string, string>();
  const db = {
    from: vi.fn(() => chain({ name: 'Venue', subscription_tier: 'free' })),
    rpc: vi.fn<(name: string, args: Record<string, string>) => Promise<{ data: Record<string, unknown> | null; error: { message: string } | null }>>(async (name, args) => {
      if (name === 'authorize_event_ticket_emission') {
        const id = args.p_channel + ':' + args.p_emission_key;
        if (options.cancelled) return { data: { authorized: false, reason: 'event_cancelled' }, error: null };
        if (states.has(id)) return { data: { authorized: false, state: states.get(id), reason: 'already_authorized' }, error: null };
        states.set(id, 'attempted');
        return { data: { authorized: true, emission_id: id }, error: null };
      }
      if (name === 'finalize_event_ticket_emission') {
        if (options.finalizeError) return { data: null, error: { message: 'db unavailable' } };
        states.set(args.p_emission_id, args.p_state);
        return { data: { finalized: true }, error: null };
      }
      throw new Error('unexpected rpc ' + name);
    }),
  };
  return { db: db as unknown as SupabaseClient, states, rpc: db.rpc };
}
function deliveryOpts(db: SupabaseClient, sender?: any) {
  return {
    supabase: db, sender, businessId: 'biz', bookingId: 'booking', eventId: 'event',
    eventName: 'Event', eventDate: 'Friday', venue: 'Hall', guestName: 'Ada',
    guestPhone: '+15551234567', guestEmail: 'fixture@example.invalid', referenceCode: 'EV-1',
    quantity: 1, tickets: [ticket],
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.email.mockResolvedValue({ success: true, id: 'email-id' });
  mocks.pdf.mockRejectedValue(new Error('PDF unavailable'));
  mocks.dispatch.mockResolvedValue(undefined);
  mocks.guard.mockResolvedValue(undefined);
  mocks.financial.mockResolvedValue({ data: { enforcement_required: false }, error: null });
});

describe('M481 actual ticket adapters', () => {
  it('returns only the canonical issued set', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { success: true, outcome: 'issued', tickets: [ticket] }, error: null });
    const result = await ensureCanonicalTicketRows({ ...deliveryOpts({ rpc } as unknown as SupabaseClient), guestName: 'Ada' });
    expect(result).toEqual({ success: true, tickets: [ticket] });
    expect(rpc).toHaveBeenCalledWith('converge_event_ticket_booking', expect.objectContaining({ p_booking_id: 'booking', p_event_id: 'event', p_quantity: 1 }));
  });
  it.each([
    { success: false, reason: 'identity_mismatch' },
    { success: true, outcome: 'issued', tickets: [] },
    { success: true, outcome: 'issued', tickets: [{ ...ticket, ticketNumber: 2 }] },
  ])('rejects invalid convergence %j', async data => {
    const rpc = vi.fn().mockResolvedValue({ data, error: null });
    expect((await ensureCanonicalTicketRows(deliveryOpts({ rpc } as unknown as SupabaseClient))).success).toBe(false);
  });
  it('propagates cancellation without manufacturing tickets', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { success: false, outcome: 'cancelled_followup_recorded', followup_recorded: true }, error: null });
    expect(await ensureCanonicalTicketRows(deliveryOpts({ rpc } as unknown as SupabaseClient))).toEqual({ success: false, tickets: [], error: 'event_cancelled_followup_recorded' });
  });
  it('Stage 2 distinguishes recorded follow-up from successful issuance', async () => {
    const db = {
      from: () => chain({ flow_type: 'ticketing', event_id: 'event', party_size: 1 }),
      rpc: vi.fn().mockResolvedValue({ data: { success: false, outcome: 'cancelled_followup_recorded', followup_recorded: true }, error: null }),
    };
    expect(await ensurePaidTicketState(db as unknown as SupabaseClient, { paymentBookingId: 'booking' })).toMatchObject({
      success: false, outcome: 'cancelled_followup_recorded', followupRecorded: true,
      inventoryFinalized: false, canonicalRowsComplete: false,
    });
  });
  it('Stage 2 does not accept cancellation without durable follow-up', async () => {
    const db = { from: () => chain({ flow_type: 'ticketing', event_id: 'event', party_size: 1 }),
      rpc: vi.fn().mockResolvedValue({ data: { success: false, outcome: 'cancelled_followup_recorded' }, error: null }) };
    const result = await ensurePaidTicketState(db as unknown as SupabaseClient, { paymentBookingId: 'booking' });
    expect(result.success).toBe(false);
    expect(result.followupRecorded).not.toBe(true);
  });
});

describe('both actual ticket delivery boundaries', () => {
  it('suppresses WhatsApp and every fallback after cancellation', async () => {
    const { db } = deliveryDb({ cancelled: true });
    const sender = { sendImage: vi.fn(), sendText: vi.fn(), sendDocument: vi.fn() };
    await expect(deliverTicketsWhatsApp(deliveryOpts(db, sender))).rejects.toThrow('event_cancelled');
    expect(sender.sendImage).not.toHaveBeenCalled();
    expect(sender.sendText).not.toHaveBeenCalled();
    expect(sender.sendDocument).not.toHaveBeenCalled();
  });
  it('suppresses email after cancellation', async () => {
    const { db } = deliveryDb({ cancelled: true });
    await expect(deliverTicketsEmail(deliveryOpts(db))).rejects.toThrow('event_cancelled');
    expect(mocks.email).not.toHaveBeenCalled();
  });
  it('accepted WhatsApp replay never resends', async () => {
    const { db } = deliveryDb();
    const sender = { sendImage: vi.fn().mockResolvedValue({ messageId: 'wamid' }), sendText: vi.fn() };
    await deliverTicketsWhatsApp(deliveryOpts(db, sender));
    await deliverTicketsWhatsApp(deliveryOpts(db, sender));
    expect(sender.sendImage).toHaveBeenCalledOnce();
    expect(sender.sendImage).toHaveBeenCalledWith(expect.objectContaining({ noRetry: true }));
  });
  it('ambiguous WhatsApp attempt is not retried or converted to text fallback', async () => {
    const { db, states } = deliveryDb();
    const sender = { sendImage: vi.fn().mockRejectedValue(new Error('connection reset')), sendText: vi.fn() };
    await expect(deliverTicketsWhatsApp(deliveryOpts(db, sender))).rejects.toThrow('ambiguous');
    await expect(deliverTicketsWhatsApp(deliveryOpts(db, sender))).rejects.toThrow('already_authorized');
    expect(sender.sendImage).toHaveBeenCalledOnce();
    expect(sender.sendText).not.toHaveBeenCalled();
    expect([...states.values()]).toEqual(['ambiguous']);
  });
  it('acceptance persistence failure never resends', async () => {
    const { db } = deliveryDb({ finalizeError: true });
    const sender = { sendImage: vi.fn().mockResolvedValue({ messageId: 'wamid' }), sendText: vi.fn() };
    await expect(deliverTicketsWhatsApp(deliveryOpts(db, sender))).rejects.toThrow('unresolved');
    await expect(deliverTicketsWhatsApp(deliveryOpts(db, sender))).rejects.toThrow('already_authorized');
    expect(sender.sendImage).toHaveBeenCalledOnce();
    expect(sender.sendText).not.toHaveBeenCalled();
  });
  it.each([
    [{ success: false, error: { statusCode: 400 } }, 'failed', 'ticket_provider_rejected'],
    [{ success: false, error: { statusCode: 503 } }, 'ambiguous', 'ticket_emission_ambiguous'],
    [{ success: true, dev: true }, 'ambiguous', 'ticket_emission_ambiguous'],
  ])('persists email result conservatively: %j', async (result, state, reason) => {
    const { db, states } = deliveryDb();
    mocks.email.mockResolvedValue(result);
    await expect(deliverTicketsEmail(deliveryOpts(db))).rejects.toThrow(String(reason));
    await expect(deliverTicketsEmail(deliveryOpts(db))).rejects.toThrow('already_authorized');
    expect(mocks.email).toHaveBeenCalledOnce();
    expect([...states.values()]).toEqual([state]);
  });
  it('ticket email requests a single provider attempt and accepted replay is silent', async () => {
    const { db } = deliveryDb();
    await deliverTicketsEmail(deliveryOpts(db));
    await deliverTicketsEmail(deliveryOpts(db));
    expect(mocks.email).toHaveBeenCalledOnce();
    expect(mocks.email).toHaveBeenCalledWith(expect.objectContaining({ noRetry: true }));
  });
});

describe('actual Authority → confirmation cancellation mapping', () => {
  function setup(followupFailure = false) {
    let terminated = false;
    const payment = { id: 'payment', amount: 1200, currency: 'USD', gateway: 'stripe', status: 'success',
      payment_authority_version: 1, finalization_completed_at: '2026-10-30T00:00:00Z',
      booking_id: 'booking', invoice_id: null, campaign_id: null, reservation_id: null, order_id: null, metadata: null };
    const db = {
      from: vi.fn((table: string) => chain(table === 'bookings'
        ? { flow_type: 'ticketing', guest_phone: '+15551234567', business_id: 'biz', businesses: { name: 'Event' } }
        : payment)),
      rpc: vi.fn(async (name: string) => {
        if (name === 'claim_payment_confirmation') return { data: terminated
          ? { claimed: false, reason: 'already_terminated', terminal_reason: 'event_cancelled_followup_recorded' }
          : { claimed: true, claim_token: 'claim', payment_id: payment.id, booking_id: payment.booking_id, amount: payment.amount }, error: null };
        if (name === 'terminate_cancelled_event_confirmation') {
          if (followupFailure) return { data: null, error: { message: 'followup failed' } };
          terminated = true;
          return { data: { terminated: true }, error: null };
        }
        if (name === 'release_payment_confirmation') return { data: { released: true }, error: null };
        throw new Error('unexpected rpc ' + name);
      }),
    };
    const process = vi.fn();
    const run = () => authorizeAndFinalize(db as unknown as SupabaseClient, {
      provider: 'stripe', waaiioReference: 'ref', amount: 1200, currency: 'USD', verifiedAt: '2026-10-30',
    }, process, sendProactiveConfirmation);
    return { db, process, run, payment };
  }
  it('first and already-terminated replay retain the specific nonretryable public result', async () => {
    const { run, db, process, payment } = setup();
    const expected = { status: 'not_deliverable', retryable: false, reason: 'event_cancelled_followup_recorded',
      stages: { providerPaid: true, businessFinalized: true, customerConfirmed: false } };
    expect(await run()).toEqual(expected);
    expect(await run()).toEqual(expected);
    expect(payment.status).toBe('success');
    expect(process).not.toHaveBeenCalled();
    expect(db.rpc.mock.calls.filter(([name]) => name === 'terminate_cancelled_event_confirmation')).toHaveLength(1);
    expect(mocks.email).not.toHaveBeenCalled();
  });
  it('follow-up persistence failure is retryable, not a false terminal success', async () => {
    const { run } = setup(true);
    expect(await run()).toMatchObject({ status: 'retryable_failed', retryable: true,
      stages: { providerPaid: true, businessFinalized: true, customerConfirmed: false } });
  });
});

describe('actual email helper retry control', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
  async function actualEmail() {
    vi.resetModules();
    vi.stubEnv('RESEND_API_KEY', 'test-provider-key');
    return vi.importActual<typeof import('@/lib/email/client')>('@/lib/email/client');
  }
  const input = { to: 'fixture@example.invalid', subject: 'Ticket', html: 'Ticket' };
  it.each(['exception', 'returned'] as const)('noRetry invokes provider once for %s ambiguity', async kind => {
    const { sendEmail } = await actualEmail();
    if (kind === 'exception') mocks.provider.mockRejectedValue(new Error('connection reset'));
    else mocks.provider.mockResolvedValue({ data: null, error: { statusCode: 503, message: 'unavailable' } });
    const result = await sendEmail({ ...input, noRetry: true });
    expect(result.success).toBe(false);
    expect(mocks.provider).toHaveBeenCalledOnce();
  });
  it.each(['exception', 'returned'] as const)('default retries %s failures as before', async kind => {
    vi.useFakeTimers();
    const { sendEmail } = await actualEmail();
    if (kind === 'exception') mocks.provider.mockRejectedValue(new Error('connection reset'));
    else mocks.provider.mockResolvedValue({ data: null, error: { statusCode: 503, message: 'unavailable' } });
    const pending = sendEmail(input);
    await vi.runAllTimersAsync();
    expect((await pending).success).toBe(false);
    expect(mocks.provider).toHaveBeenCalledTimes(3);
  });
  it('preserves development response without provider invocation', async () => {
    vi.resetModules();
    vi.stubEnv('RESEND_API_KEY', '');
    const { sendEmail } = await vi.importActual<typeof import('@/lib/email/client')>('@/lib/email/client');
    expect(await sendEmail({ ...input, noRetry: true })).toEqual({ success: true, dev: true });
    expect(mocks.provider).not.toHaveBeenCalled();
  });
});

describe('actual media sender single-attempt option', () => {
  afterEach(() => vi.useRealTimers());
  function senderFixture(method: 'sendImage' | 'sendDocument') {
    const provider = vi.fn();
    const sender = new MetaCloudSender({ [method]: provider } as never, {} as SupabaseClient);
    sender.bindBusiness('business');
    const send = (noRetry?: boolean) => method === 'sendImage'
      ? sender.sendImage({ to: '+15551234567', imageUrl: 'https://example.invalid/ticket', noRetry })
      : sender.sendDocument({ to: '+15551234567', documentUrl: 'https://example.invalid/ticket.pdf', filename: 'Ticket.pdf', noRetry });
    return { provider, send };
  }
  it.each(['sendImage', 'sendDocument'] as const)('%s noRetry makes one provider invocation after 5xx', async method => {
    const { provider, send } = senderFixture(method);
    provider.mockRejectedValue(new MetaApiError('Cloud API error: 503', 503));
    await expect(send(true)).rejects.toThrow('503');
    expect(provider).toHaveBeenCalledOnce();
    expect(mocks.guard).toHaveBeenCalled();
    expect(mocks.financial).toHaveBeenCalledWith('check_or_authorize_send', { p_attempt_id: 'attempt' });
  });
  it.each(['sendImage', 'sendDocument'] as const)('%s preserves default retry behavior', async method => {
    vi.useFakeTimers();
    const { provider, send } = senderFixture(method);
    provider.mockRejectedValueOnce(new MetaApiError('Cloud API error: 503', 503))
      .mockResolvedValue({ messageId: 'wamid-retry' });
    const pending = send();
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ success: true, messageId: 'wamid-retry' });
    expect(provider).toHaveBeenCalledTimes(2);
  });
  it.each(['sendImage', 'sendDocument'] as const)('%s noRetry retains authorization rejection', async method => {
    const { provider, send } = senderFixture(method);
    mocks.guard.mockRejectedValueOnce(new Error('Messaging suspended'));
    await expect(send(true)).rejects.toThrow('Messaging suspended');
    expect(provider).not.toHaveBeenCalled();
  });
  it('actual sender failure persists ambiguous ticket state without fallback or resend', async () => {
    const { db, states } = deliveryDb();
    const provider = vi.fn().mockRejectedValue(new MetaApiError('Cloud API error: 503', 503));
    const sender = new MetaCloudSender({ sendImage: provider } as never, {} as SupabaseClient);
    sender.bindBusiness('business');
    await expect(deliverTicketsWhatsApp(deliveryOpts(db, sender))).rejects.toThrow('ambiguous');
    await expect(deliverTicketsWhatsApp(deliveryOpts(db, sender))).rejects.toThrow('already_authorized');
    expect(provider).toHaveBeenCalledOnce();
    expect([...states.values()]).toEqual(['ambiguous']);
  });
  it('the actual ticket PDF boundary propagates noRetry', async () => {
    const { db } = deliveryDb();
    mocks.pdf.mockResolvedValueOnce(Buffer.from('ticket pdf'));
    Object.assign(db, { storage: { from: () => ({
      upload: vi.fn().mockResolvedValue({ error: null }),
      createSignedUrl: vi.fn().mockResolvedValue({ data: { signedUrl: 'https://example.invalid/ticket.pdf' }, error: null }),
    }) } });
    const sender = {
      sendDocument: vi.fn().mockResolvedValue({ messageId: 'wamid-pdf' }),
      sendImage: vi.fn().mockResolvedValue({ messageId: 'wamid-image' }),
      sendText: vi.fn(),
    };
    await deliverTicketsWhatsApp(deliveryOpts(db, sender));
    expect(sender.sendDocument).toHaveBeenCalledWith(expect.objectContaining({ noRetry: true }));
    expect(sender.sendImage).toHaveBeenCalledWith(expect.objectContaining({ noRetry: true }));
  });
});

describe('actual ticket purchase webhook authorization', () => {
  function fixture(soldOut = false) {
    const options = { cancelled: false };
    const { db, states, rpc } = deliveryDb(options);
    const previous = rpc;
    const original = previous.getMockImplementation()!;
    previous.mockImplementation((name: string, args: Record<string, string>) => {
      if (name === 'converge_event_ticket_booking') return Promise.resolve({
        data: { success: true, outcome: 'issued', tickets: [ticket] }, error: null,
      });
      return original(name, args);
    });
    (db.from as unknown as ReturnType<typeof vi.fn>).mockImplementation((table: string) =>
      chain(table === 'events'
        ? { tickets_sold: soldOut ? 1 : 0, total_tickets: 1 }
        : { name: 'Venue', subscription_tier: 'free' }));
    return { db, states, options };
  }
  it('cancellation after email but before webhook authorization suppresses purchase dispatch', async () => {
    const { db, options } = fixture();
    mocks.email.mockImplementationOnce(async () => {
      options.cancelled = true;
      return { success: true, id: 'email-id' };
    });
    expect(await sendTicketsAfterPurchase(deliveryOpts(db))).toMatchObject({
      success: false, error: 'event_cancelled_followup_recorded',
    });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
  it('rechecks event authority separately before sold-out dispatch', async () => {
    const { db, options } = fixture(true);
    mocks.dispatch.mockImplementationOnce(async () => { options.cancelled = true; });
    expect((await sendTicketsAfterPurchase(deliveryOpts(db))).success).toBe(false);
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    expect(mocks.dispatch).toHaveBeenCalledWith(db, 'biz', 'ticket.purchased', expect.any(Object));
  });
  it('void dispatcher results remain ambiguous and are never blindly replayed', async () => {
    const { db, states } = fixture(true);
    await sendTicketsAfterPurchase(deliveryOpts(db));
    await sendTicketsAfterPurchase(deliveryOpts(db));
    expect(mocks.dispatch).toHaveBeenCalledTimes(2);
    expect(states.get('webhook:ticket.purchased')).toBe('ambiguous');
    expect(states.get('webhook:event.sold_out')).toBe('ambiguous');
    expect(db.rpc).toHaveBeenCalledWith('finalize_event_ticket_emission', {
      p_emission_id: 'webhook:ticket.purchased', p_state: 'ambiguous', p_provider_message_id: null,
    });
  });
  it('documents that a dispatch already authorized before cancellation may finish', async () => {
    const { db, options, states } = fixture();
    mocks.dispatch.mockImplementationOnce(async () => { options.cancelled = true; });
    await sendTicketsAfterPurchase(deliveryOpts(db));
    expect(mocks.dispatch).toHaveBeenCalledOnce();
    expect(states.get('webhook:ticket.purchased')).toBe('ambiguous');
  });
});

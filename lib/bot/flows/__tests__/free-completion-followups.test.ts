import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockContext, getStep } from './helpers';

const mocks = vi.hoisted(() => ({
  start: vi.fn(), release: vi.fn(), guard: vi.fn(), tickets: vi.fn(), post: vi.fn(), intake: vi.fn(),
}));
vi.mock('@/lib/bot/transaction-followups', () => ({ startTransactionFollowup: mocks.start, releaseTransactionFollowupAfterConfirmation: mocks.release }));
vi.mock('../shared/capability-guard', () => ({ requireCurrentCapability: mocks.guard }));
vi.mock('../shared/send-tickets', () => ({ sendTicketsAfterPurchase: mocks.tickets }));
vi.mock('../shared/post-completion', () => ({ handlePostCompletion: mocks.post }));
vi.mock('../shared/notifications', () => ({ createNotification: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../shared/notify-owner', () => ({
  notifyOwnerNewQueueCheckin: vi.fn().mockResolvedValue(undefined),
  notifyOwnerNewTicketSale: vi.fn().mockResolvedValue(undefined),
  notifyOwnerNewOrder: vi.fn().mockResolvedValue(undefined),
  notifyOwnerNewQuoteRequest: vi.fn().mockResolvedValue(undefined),
  notifyOwnerNewBooking: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/tier-limits', () => ({ checkTierLimit: vi.fn().mockResolvedValue({ allowed: true }) }));
vi.mock('@/lib/capabilities/service', () => ({ getEnabledCapabilities: vi.fn().mockResolvedValue([]) }));
vi.mock('@/lib/bot/automation/rules-engine', () => ({ evaluateRules: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/bot/automation/sequence-service', () => ({ triggerSequences: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/integrations/google-calendar', () => ({ syncBookingToCalendar: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/intake/send', () => ({ deliverAfterBookingIntake: mocks.intake }));

import { prepareFreeCompletion } from '../shared/free-completion';
import { waitlistFlow } from '../waitlist.flow';
import { queueCheckinFlow } from '../queue-checkin.flow';
import { ticketingFlow } from '../ticketing.flow';
import { orderingFlow } from '../ordering.flow';
import { reservationFlow } from '../reservation.flow';
import { schedulingFlow } from '../scheduling.flow';

const biz = '00000000-0000-4000-8000-000000000001';
const channel = '00000000-0000-4000-8000-000000000002';
const entity = '00000000-0000-4000-8000-000000000003';

function context(data: Record<string, unknown> = {}, options: { existing?: boolean; failure?: boolean; stockFailure?: boolean; status?: string } = {}) {
  const ctx = createMockContext();
  ctx.business!.id = biz;
  ctx.session.business_id = biz;
  ctx.session.session_data = { _inbound_channel_id: channel, first_name: 'Ada', last_name: 'Test', ...data };
  const committed = {
    id: entity, status: options.status || 'confirmed', total_amount: 0, deposit_amount: 0,
    service_id: null, appointment_id: null, party_size: 1, date: data.date, time: data.time,
    class_session_id: null, staff_id: null,
  };
  ctx.supabase = {
    from: vi.fn((table: string) => {
      let inserted = false;
      const chain: any = {};
      for (const key of ['select', 'update', 'eq', 'neq', 'in', 'is', 'or', 'not', 'lt', 'gt', 'gte', 'lte', 'order', 'limit']) chain[key] = vi.fn(() => chain);
      chain.insert = vi.fn(() => { inserted = true; return chain; });
      chain.single = vi.fn(async () => {
        if (options.failure && inserted) return { data: null, error: { message: 'insert failed' } };
        if (table === 'bookings') return { data: committed, error: null };
        if (table === 'businesses') return { data: { deposit_per_guest: 0 }, error: null };
        return { data: inserted ? { id: entity, reference_code: 'REF1' } : null, error: null };
      });
      chain.maybeSingle = vi.fn(async () => ({ data: options.existing ? { id: entity, queue_number: 2, status: 'waiting' } : null, error: null }));
      chain.then = (resolve: any) => Promise.resolve({ data: [], error: null }).then(resolve);
      return chain;
    }),
    rpc: vi.fn(async (name: string) => {
      if (name === 'create_order_atomic') return { data: { order_id: entity, reference_code: 'REF1', created: true }, error: null };
      if (name === 'apply_order_stock_once' && options.stockFailure) return { data: null, error: { message: 'stock failed' } };
      return { data: { success: !options.failure }, error: null };
    }),
  } as any;
  ctx.standalone = {
    getBotTemplates: vi.fn().mockResolvedValue({ confirmation: 'Confirmed' }),
    checkTierLimits: vi.fn().mockResolvedValue({ isWhitelabel: false }),
    fillTemplate: vi.fn().mockReturnValue('Confirmed'),
  } as any;
  return ctx;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.start.mockResolvedValue(undefined);
  mocks.release.mockResolvedValue(undefined);
  mocks.guard.mockResolvedValue({ allowed: true });
  mocks.tickets.mockResolvedValue({ success: true });
  mocks.post.mockResolvedValue(undefined);
  mocks.intake.mockResolvedValue({ status: 'not_applicable' });
});

describe('Free completion continuation', () => {
  it('waits for the existing after-send work before starting consent; does not start while preparing', async () => {
    const ctx = context();
    const order: string[] = [];
    mocks.release.mockImplementation(async () => { order.push('opt-in'); });
    const callback = await prepareFreeCompletion(ctx, { completionKey: `booking:${entity}`, kind: 'appointment', afterSend: async () => { order.push('intake'); } });
    expect(mocks.release).not.toHaveBeenCalled();
    expect(ctx.session.session_data._transaction_followup_key).toBe(`booking:${entity}`);
    await callback!();
    expect(order).toEqual(['intake', 'opt-in']);
    expect(mocks.start).toHaveBeenCalledWith(ctx.supabase, expect.objectContaining({ businessId: biz, channelId: channel, phone: ctx.from, awaitingConfirmation: true }));
    expect(mocks.release).toHaveBeenCalledWith(ctx.supabase, biz, `booking:${entity}`);
  });

  it('does not guess a channel or take ownership when inbound authority is missing', async () => {
    const ctx = context({ _inbound_channel_id: null });
    expect(await prepareFreeCompletion(ctx, { completionKey: `booking:${entity}`, kind: 'appointment' })).toBeUndefined();
    expect(ctx.session.session_data._transaction_followup_key).toBeUndefined();
  });

  it('does not advance if intake delivery finalization fails', async () => {
    const callback = await prepareFreeCompletion(context(), { completionKey: `booking:${entity}`, kind: 'appointment', afterSend: async () => { throw new Error('intake'); } });
    await expect(callback!()).rejects.toThrow('intake');
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it('does not mark session ownership if durable enrollment fails', async () => {
    const ctx = context();
    mocks.start.mockRejectedValue(new Error('database unavailable'));
    await expect(prepareFreeCompletion(ctx, { completionKey: `booking:${entity}`, kind: 'appointment' })).rejects.toThrow('database unavailable');
    expect(ctx.session.session_data._transaction_followup_key).toBeUndefined();
    expect(mocks.release).not.toHaveBeenCalled();
  });
});

describe('Enrollment success boundaries', () => {
  it('waitlist offers only after the successful enrollment confirmation is sent', async () => {
    const ctx = context({ waitlist_name: 'Ada' });
    const messages = await getStep(waitlistFlow, 'waitlist_confirm').prompt(ctx);
    expect(mocks.release).not.toHaveBeenCalled();
    expect(messages[0]._afterSend).toBeTypeOf('function');
    await messages[0]._afterSend!();
    expect(mocks.start).toHaveBeenCalledWith(ctx.supabase, expect.objectContaining({ completionKey: `waitlist:${entity}`, kind: 'waitlist' }));
  });

  it.each([{ existing: true }, { failure: true }])('waitlist does not offer on existing entry or insertion failure: %o', async options => {
    const ctx = context({ waitlist_name: 'Ada' }, options);
    const messages = await getStep(waitlistFlow, 'waitlist_confirm').prompt(ctx);
    expect(messages.every(m => !m._afterSend)).toBe(true);
    expect(mocks.release).not.toHaveBeenCalled();
    expect(ctx.session.session_data._transaction_followup_key).toBeUndefined();
  });

  it('queue confirmation precedes the completion prompt', async () => {
    const ctx = context({ queue_customer_name: 'Ada', _queue_preview_number: 2 });
    const order: string[] = [];
    vi.mocked(ctx.sender.sendText).mockImplementation(async () => { order.push('confirmation'); return { messages: [{ id: 'wamid' }] } as any; });
    mocks.release.mockImplementation(async () => { order.push('opt-in'); });
    const result = await getStep(queueCheckinFlow, 'queue_confirm_checkin').validate('confirm_checkin', ctx);
    expect(result.valid).toBe(true);
    expect(order).toEqual(['confirmation', 'opt-in']);
    expect(result.data?._transaction_followup_key).toBe(`queue:${entity}`);
  });

  it.each(['cancel_checkin', 'invalid'])('queue %s does not offer', async input => {
    const ctx = context();
    await getStep(queueCheckinFlow, 'queue_confirm_checkin').validate(input, ctx);
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it.each([{ existing: true }, { failure: true }])('queue duplicate/error does not offer: %o', async options => {
    await getStep(queueCheckinFlow, 'queue_confirm_checkin').validate('confirm_checkin', context({}, options));
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it('queue confirmation send failure cannot advance to opt-in', async () => {
    const ctx = context();
    vi.mocked(ctx.sender.sendText).mockRejectedValue(new Error('send failed'));
    await expect(getStep(queueCheckinFlow, 'queue_confirm_checkin').validate('confirm_checkin', ctx)).rejects.toThrow('send failed');
    expect(mocks.release).not.toHaveBeenCalled();
  });
});

describe('Free transaction success boundaries', () => {
  it('free tickets finish delivery before the final confirmation hook', async () => {
    const ctx = context({ booking_id: entity, reference_code: 'REF1', ticket_quantity: 1, total_amount: 0, event_date: '2026-12-01' });
    const messages = await getStep(ticketingFlow, 'process_tickets').prompt(ctx);
    expect(mocks.tickets).toHaveBeenCalledOnce();
    expect(mocks.release).not.toHaveBeenCalled();
    await messages[0]._afterSend!();
    expect(mocks.start).toHaveBeenCalledWith(ctx.supabase, expect.objectContaining({ completionKey: `booking:${entity}`, kind: 'ticketing' }));
  });

  it('ticket fulfillment failure does not start opt-in', async () => {
    mocks.tickets.mockResolvedValue({ success: false, error: 'delivery failed' });
    const messages = await getStep(ticketingFlow, 'process_tickets').prompt(context({ booking_id: entity, reference_code: 'REF1', ticket_quantity: 1, total_amount: 0, event_date: '2026-12-01' }));
    expect(messages.every(m => !m._afterSend)).toBe(true);
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it('ticket finalization failure does not deliver tickets or start opt-in', async () => {
    const ctx = context({ booking_id: entity, reference_code: 'REF1', ticket_quantity: 1, total_amount: 0, event_date: '2026-12-01' }, { failure: true });
    const messages = await getStep(ticketingFlow, 'process_tickets').prompt(ctx);
    expect(messages.every(m => !m._afterSend)).toBe(true);
    expect(mocks.tickets).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it.each(['order', 'stay'])('waits for slow %s customer completion effects before returning the confirmation', async kind => {
    let release!: () => void;
    mocks.post.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const ctx = kind === 'order'
      ? context({ cart: [{ product_id: 'p1', name: 'Gift', price: 0, quantity: 1 }], delivery_type: 'pickup' })
      : context({ check_in: '2026-12-01', check_out: '2026-12-02', nights: 1, nightly_rate: 0 });
    const step = kind === 'order' ? getStep(orderingFlow, 'process_order') : getStep(reservationFlow, 'create_reservation');
    let finished = false;
    const pending = step.prompt(ctx).then(messages => { finished = true; return messages; });
    await vi.waitFor(() => expect(mocks.post).toHaveBeenCalledOnce());
    expect(finished).toBe(false);
    expect(mocks.release).not.toHaveBeenCalled();
    release();
    const messages = await pending;
    expect(messages[0]._afterSend).toBeTypeOf('function');
  });

  it('free order has one confirmation, waits for completion effects, then offers opt-in', async () => {
    const ctx = context({ cart: [{ product_id: 'p1', name: 'Gift', price: 0, quantity: 1 }], delivery_type: 'pickup' });
    const messages = await getStep(orderingFlow, 'process_order').prompt(ctx);
    expect(mocks.post).toHaveBeenCalledOnce();
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('text');
    expect(mocks.release).not.toHaveBeenCalled();
    await messages[0]._afterSend!();
    expect(mocks.start).toHaveBeenCalledWith(ctx.supabase, expect.objectContaining({ completionKey: `order:${entity}` }));
  });

  it('free order does not start completion follow-ups when stock application failed', async () => {
    const ctx = context({ cart: [{ product_id: 'p1', name: 'Gift', price: 0, quantity: 1 }], delivery_type: 'pickup' }, { stockFailure: true });
    const messages = await getStep(orderingFlow, 'process_order').prompt(ctx);
    expect(messages.every(message => !message._afterSend)).toBe(true);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(ctx.session.session_data._transaction_followup_key).toBeUndefined();
  });

  it('free stay waits for confirmation and post-completion effects', async () => {
    const ctx = context({ check_in: '2026-12-01', check_out: '2026-12-02', nights: 1, nightly_rate: 0, guests: 1 });
    const messages = await getStep(reservationFlow, 'create_reservation').prompt(ctx);
    expect(mocks.post).toHaveBeenCalledOnce();
    expect(mocks.release).not.toHaveBeenCalled();
    await messages[0]._afterSend!();
    expect(mocks.start).toHaveBeenCalledWith(ctx.supabase, expect.objectContaining({ completionKey: `reservation:${entity}` }));
  });

  it.each(['confirmed', 'pending'])('scheduling uses persisted %s state and preserves intake finalization', async status => {
    const finalize = vi.fn().mockResolvedValue(undefined);
    mocks.intake.mockResolvedValue({ status: 'prepared', text: 'Complete your intake', url: 'https://example.test/form', finalize });
    const ctx = context({ booking_id: entity, reference_code: 'REF1', date: '2026-12-01', time: '10:00', party_size: 1, service_price: 0 }, { status });
    const messages = await getStep(schedulingFlow, 'create_booking').prompt(ctx);
    expect(mocks.release).not.toHaveBeenCalled();
    await messages[0]._afterSend!();
    expect(finalize).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledTimes(status === 'confirmed' ? 1 : 0);
  });
});

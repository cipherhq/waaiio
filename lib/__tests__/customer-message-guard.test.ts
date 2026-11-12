/**
 * #536 customer message guards: the TypeScript side.
 *
 * - The real guard functions run against a small in-memory database that
 *   answers the reads they make and replays the RPC results the M536 SQL
 *   returns (the SQL itself is proven in customer-message-guards-536.pg.test.ts).
 * - The real MetaCloudSender runs with the attempt, guard and financial modules
 *   mocked at their boundaries, to prove a refused reply creates no attempt,
 *   no financial authorization and no Meta call, and is never retried.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  createAttempt: vi.fn(),
  authorize: vi.fn(),
  settings: {} as Record<string, unknown>,
}));

vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/circuit-breaker', () => ({
  isCircuitOpen: () => false, recordSuccess: vi.fn(), recordFailure: vi.fn(),
  CircuitBreakerOpenError: class extends Error {},
}));
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({ rpc: (...a: unknown[]) => h.authorize(...a) }),
}));
vi.mock('@/lib/channels/send-guard', () => ({
  assertMessagingAllowed: vi.fn().mockResolvedValue(undefined),
  MessagingSuspendedError: class extends Error {},
}));
vi.mock('@/lib/channels/phone-country', () => ({ resolveRecipientCountry: () => 'NG' }));
vi.mock('@/lib/channels/attempt-recording', () => ({
  createAttempt: (...a: unknown[]) => h.createAttempt(...a),
  updateAttemptContext: vi.fn().mockResolvedValue(undefined),
  markSending: vi.fn().mockResolvedValue(undefined),
  markAccepted: vi.fn().mockResolvedValue(undefined),
  markFailed: vi.fn().mockResolvedValue(undefined),
  markAmbiguous: vi.fn().mockResolvedValue(undefined),
  isAmbiguousTransportError: () => false,
  GateBlockError: class extends Error {},
  AmbiguousSendError: class extends Error {},
  WamidPersistenceError: class extends Error {},
}));
vi.mock('@/lib/platformSettings', () => ({
  getPlatformSettingsSync: () => ({
    customer_daily_reply_limit: 50,
    customer_daily_reply_limit_max: 500,
    customer_repeat_message_limit: 3,
    abuse_cooldown_soft_minutes: 5,
    ...h.settings,
  }),
}));

import {
  createCustomerReplyGuard, CustomerDailyLimitError, isCustomerDailyLimitError, recordCustomerInbound,
  sendCustomerDailyLimitNotice, CUSTOMER_DAILY_LIMIT_MESSAGE, installCustomerReplyGuard,
  recordInvalidInput, resolveCustomerDailyReplyLimit, PAYMENT_STEP_IDS, INVALID_INPUT_PAUSE_THRESHOLD,
} from '@/lib/messaging/customer-message-guard';
import { isFinancialDenial, RefusedSendError } from '@/lib/bot/financial-denial';
import { MetaCloudSender } from '@/lib/channels/message-sender';

const BIZ = 'b0000000-0000-4000-a000-000000000536';
const CUSTOMER = '2348031234567';

type RpcResult = { data: unknown; error: unknown };

/** In-memory database for the reads the guard makes and scripted RPC answers. */
function fakeDb(opts: {
  metadata?: Record<string, unknown> | null;
  step?: string | null;
  sessionData?: Record<string, unknown>;
  rpc?: (name: string, args: Record<string, unknown>) => RpcResult;
  sessionError?: boolean;
}) {
  const rpcCalls: Array<[string, Record<string, unknown>]> = [];
  const db = {
    from: vi.fn((table: string) => {
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'limit']) chain[m] = vi.fn(() => chain);
      chain.maybeSingle = vi.fn(async () => {
        if (table === 'businesses') return { data: { metadata: opts.metadata ?? {} }, error: null };
        if (table === 'bot_sessions') {
          if (opts.sessionError) return { data: null, error: { message: 'boom' } };
          return { data: opts.step ? { current_step: opts.step, session_data: opts.sessionData ?? {} } : null, error: null };
        }
        throw new Error(`unexpected table ${table}`);
      });
      return chain;
    }),
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push([name, args]);
      return opts.rpc ? opts.rpc(name, args) : { data: null, error: null };
    }),
  };
  return { db: db as never, rpcCalls };
}

/** Replays M536: record_customer_daily_reply counts; claim_customer_daily_limit_notice is true once. */
function dailyCounter() {
  const counts = new Map<string, number>();
  const told = new Set<string>();
  return (name: string, args: Record<string, unknown>): RpcResult => {
    const key = `${args.p_business_id}:${args.p_phone}`;
    if (name === 'claim_customer_daily_limit_notice') {
      const first = counts.has(key) && !told.has(key);
      told.add(key);
      return { data: first, error: null };
    }
    if (name !== 'record_customer_daily_reply') return { data: null, error: null };
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return { data: { reply_count: n, over_limit: n > (args.p_limit as number) }, error: null };
  };
}

beforeEach(() => {
  h.settings = {};
  h.createAttempt.mockReset().mockResolvedValue('attempt-1');
  h.authorize.mockReset().mockResolvedValue({ data: { enforcement_required: false }, error: null });
});

describe('resolveCustomerDailyReplyLimit', () => {
  const settings = { customer_daily_reply_limit: 50, customer_daily_reply_limit_max: 500 };
  it('uses the platform default when the business has none', () => {
    expect(resolveCustomerDailyReplyLimit(settings, {})).toBe(50);
    expect(resolveCustomerDailyReplyLimit(settings, null)).toBe(50);
    expect(resolveCustomerDailyReplyLimit(settings, { customer_daily_reply_limit: '200' })).toBe(50);
    expect(resolveCustomerDailyReplyLimit(settings, { customer_daily_reply_limit: 12.5 })).toBe(50);
  });
  it('uses the business setting, never below 10 or above the ceiling', () => {
    expect(resolveCustomerDailyReplyLimit(settings, { customer_daily_reply_limit: 120 })).toBe(120);
    expect(resolveCustomerDailyReplyLimit(settings, { customer_daily_reply_limit: 3 })).toBe(10);
    expect(resolveCustomerDailyReplyLimit(settings, { customer_daily_reply_limit: 0 })).toBe(10);
    expect(resolveCustomerDailyReplyLimit(settings, { customer_daily_reply_limit: 100000 })).toBe(500);
  });
  it('clamps the platform default by the ceiling and survives bad admin values', () => {
    expect(resolveCustomerDailyReplyLimit({ customer_daily_reply_limit: 900, customer_daily_reply_limit_max: 500 }, {})).toBe(500);
    expect(resolveCustomerDailyReplyLimit({ customer_daily_reply_limit: -1, customer_daily_reply_limit_max: 0 }, {})).toBe(50);
  });
});

describe('createCustomerReplyGuard', () => {
  it('counts one inbound message once per business, however many replies it sends', async () => {
    const { db, rpcCalls } = fakeDb({ rpc: dailyCounter() });
    const { guard } = createCustomerReplyGuard(db, CUSTOMER);
    await guard(BIZ, CUSTOMER);
    await guard(BIZ, `+${CUSTOMER}`);
    await guard(BIZ, CUSTOMER);
    expect(rpcCalls).toEqual([['record_customer_daily_reply', { p_business_id: BIZ, p_phone: CUSTOMER, p_limit: 50 }]]);
  });

  it('does not limit or count sends to anyone else (owner, staff)', async () => {
    const { db, rpcCalls } = fakeDb({ rpc: dailyCounter() });
    await createCustomerReplyGuard(db, CUSTOMER).guard(BIZ, '2348099999999');
    expect(rpcCalls).toEqual([]);
  });

  it('refuses past the limit with one notice, then refuses quietly', async () => {
    const counter = dailyCounter();
    const { db } = fakeDb({ metadata: { customer_daily_reply_limit: 10 }, rpc: counter });
    for (let i = 0; i < 10; i++) {
      const allowed = createCustomerReplyGuard(db, CUSTOMER);
      await allowed.guard(BIZ, CUSTOMER);
      expect(allowed.takeLimitNotice()).toBe(false);
    }
    const crossing = createCustomerReplyGuard(db, CUSTOMER);
    const first = await crossing.guard(BIZ, CUSTOMER).catch(e => e);
    expect(first).toBeInstanceOf(CustomerDailyLimitError);
    // Every later send in the same message is refused too, with no second count.
    await expect(crossing.guard(BIZ, CUSTOMER)).rejects.toBeInstanceOf(CustomerDailyLimitError);
    expect(crossing.takeLimitNotice()).toBe(true);
    expect(crossing.takeLimitNotice()).toBe(false);
    const after = createCustomerReplyGuard(db, CUSTOMER);
    await expect(after.guard(BIZ, CUSTOMER)).rejects.toBeInstanceOf(CustomerDailyLimitError);
    expect(after.takeLimitNotice()).toBe(false);
  });

  it('never cuts off a customer at a payment step or with a payment under way', async () => {
    for (const step of ['await_payment', 'await_order_payment', 'process_order', 'process_tickets', 'create_reservation']) {
      expect(PAYMENT_STEP_IDS.has(step)).toBe(true);
      const { db } = fakeDb({ step, rpc: () => ({ data: { reply_count: 99, over_limit: true }, error: null }) });
      await expect(createCustomerReplyGuard(db, CUSTOMER).guard(BIZ, CUSTOMER)).resolves.toBeUndefined();
    }
    for (const sessionData of [{ _awaiting_card_pin: true }, { payment_reference: 'ref_1' }, { bank_transfer_reference: 'TRF-1' }]) {
      const { db } = fakeDb({ step: 'pick_time', sessionData, rpc: () => ({ data: { reply_count: 99, over_limit: true }, error: null }) });
      await expect(createCustomerReplyGuard(db, CUSTOMER).guard(BIZ, CUSTOMER)).resolves.toBeUndefined();
    }
    // The reservation check-out date picker is not a payment step.
    expect(PAYMENT_STEP_IDS.has('select_checkout')).toBe(false);
    for (const step of ['select_service', 'select_checkout']) {
      const { db } = fakeDb({ step, rpc: () => ({ data: { reply_count: 99, over_limit: true }, error: null }) });
      await expect(createCustomerReplyGuard(db, CUSTOMER).guard(BIZ, CUSTOMER)).rejects.toBeInstanceOf(CustomerDailyLimitError);
    }
  });

  it('crossing the limit while paying does not use up the notice', async () => {
    const counter = dailyCounter();
    const paying = fakeDb({ step: 'await_payment', metadata: { customer_daily_reply_limit: 10 }, rpc: counter });
    for (let i = 0; i < 12; i++) await createCustomerReplyGuard(paying.db, CUSTOMER).guard(BIZ, CUSTOMER);
    expect(paying.rpcCalls.map(c => c[0])).not.toContain('claim_customer_daily_limit_notice');
    const done = fakeDb({ step: 'select_service', metadata: { customer_daily_reply_limit: 10 }, rpc: counter });
    const refused = createCustomerReplyGuard(done.db, CUSTOMER);
    await expect(refused.guard(BIZ, CUSTOMER)).rejects.toBeInstanceOf(CustomerDailyLimitError);
    expect(refused.takeLimitNotice()).toBe(true);
  });

  it('allows the reply when the count or the payment-step check fails', async () => {
    const down = fakeDb({ rpc: () => ({ data: null, error: { message: 'db down' } }) });
    await expect(createCustomerReplyGuard(down.db, CUSTOMER).guard(BIZ, CUSTOMER)).resolves.toBeUndefined();
    const unsure = fakeDb({ sessionError: true, rpc: () => ({ data: { reply_count: 99, over_limit: true }, error: null }) });
    await expect(createCustomerReplyGuard(unsure.db, CUSTOMER).guard(BIZ, CUSTOMER)).resolves.toBeUndefined();
  });

  it('is a financial denial, so the existing paths pass it up instead of retrying', () => {
    const err = new CustomerDailyLimitError();
    expect(isFinancialDenial(err)).toBe(true);
    expect(isCustomerDailyLimitError(err)).toBe(true);
    expect(isCustomerDailyLimitError(new RefusedSendError(err, 'Pick a time'))).toBe(true);
    expect(isCustomerDailyLimitError(new Error('Financial authorization denied: spend_cap_exceeded'))).toBe(false);
    expect(isCustomerDailyLimitError(new RefusedSendError(new Error('Financial authorization denied: x'), 't'))).toBe(false);
  });

  it('sends the notice as a free platform message, unbinding the business first', async () => {
    const order: string[] = [];
    const sender = {
      enterPlatformDiscovery: vi.fn(() => { order.push('unbind'); }),
      sendPlatformText: vi.fn(async (m: { to: string; text: string }) => { order.push(`send:${m.to}:${m.text}`); }),
    };
    await sendCustomerDailyLimitNotice(sender, CUSTOMER);
    expect(order).toEqual(['unbind', `send:${CUSTOMER}:${CUSTOMER_DAILY_LIMIT_MESSAGE}`]);
    await expect(sendCustomerDailyLimitNotice({ sendPlatformText: async () => { throw new Error('meta down'); } }, CUSTOMER)).resolves.toBeUndefined();
  });
});

describe('recordCustomerInbound', () => {
  const answer = (data: unknown) => fakeDb({ rpc: () => ({ data, error: null }) });

  it('ignores the same text after 3 in a row, and hashes, never stores, the text', async () => {
    const { db, rpcCalls } = answer({ repeat_count: 3, paused: false });
    expect((await recordCustomerInbound(db, CUSTOMER, ' Hello ', 'text')).ignore).toBe(false);
    expect(rpcCalls[0][1].p_text_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rpcCalls)).not.toContain('Hello');
    expect((await recordCustomerInbound(answer({ repeat_count: 4, paused: false }).db, CUSTOMER, 'Hello', 'text')).ignore).toBe(true);
  });

  it('follows the admin repeat setting', async () => {
    h.settings = { customer_repeat_message_limit: 5 };
    expect((await recordCustomerInbound(answer({ repeat_count: 5, paused: false }).db, CUSTOMER, 'hi', 'text')).ignore).toBe(false);
    expect((await recordCustomerInbound(answer({ repeat_count: 6, paused: false }).db, CUSTOMER, 'hi', 'text')).ignore).toBe(true);
  });

  it('never treats taps or media as repeats', async () => {
    const { db, rpcCalls } = answer({ repeat_count: 0, paused: false });
    expect((await recordCustomerInbound(db, CUSTOMER, 'menu_book', 'interactive')).ignore).toBe(false);
    expect(rpcCalls[0][1].p_text_hash).toBeNull();
  });

  it('ignores a paused customer and reports the notice and minutes left', async () => {
    const until = new Date(Date.now() + 4 * 60_000 + 5_000).toISOString();
    expect(await recordCustomerInbound(answer({ paused: true, cooldown_until: until, cooldown_notice_due: true }).db, CUSTOMER, 'hi', 'text'))
      .toEqual({ ignore: true, pausedNoticeDue: true, pausedMinutes: 5 });
    expect(await recordCustomerInbound(answer({ paused: true, cooldown_until: until, cooldown_notice_due: false }).db, CUSTOMER, 'hi', 'text'))
      .toMatchObject({ ignore: true, pausedNoticeDue: false });
  });

  it('processes the message when the guard store fails', async () => {
    const { db } = fakeDb({ rpc: () => ({ data: null, error: { message: 'down' } }) });
    expect(await recordCustomerInbound(db, CUSTOMER, 'hi', 'text')).toEqual({ ignore: false, pausedNoticeDue: false, pausedMinutes: 0 });
  });
});

describe('recordInvalidInput', () => {
  it('pauses on the 5th invalid reply in a row at one step, already told', async () => {
    let n = 0;
    const { db, rpcCalls } = fakeDb({ rpc: (name) => ({ data: name === 'record_customer_invalid_input' ? ++n : '2026-11-12T00:00:00Z', error: null }) });
    for (let i = 1; i < INVALID_INPUT_PAUSE_THRESHOLD; i++) {
      expect((await recordInvalidInput(db, CUSTOMER, 's1:pick_date')).paused).toBe(false);
    }
    expect(await recordInvalidInput(db, CUSTOMER, 's1:pick_date')).toEqual({ paused: true, minutes: 5 });
    expect(rpcCalls.at(-1)).toEqual(['set_customer_cooldown', { p_phone: CUSTOMER, p_seconds: 300, p_notice_sent: true }]);
  });

  it('does not pause when the count fails', async () => {
    const { db, rpcCalls } = fakeDb({ rpc: () => ({ data: null, error: { message: 'down' } }) });
    expect((await recordInvalidInput(db, CUSTOMER, 's1:x')).paused).toBe(false);
    expect(rpcCalls.map(c => c[0])).toEqual(['record_customer_invalid_input']);
  });
});

describe('MetaCloudSender with the customer reply guard', () => {
  function sender(guard?: (b: string, r: string) => Promise<void>) {
    const cloud = { sendText: vi.fn().mockResolvedValue({ messageId: 'wamid.1' }) };
    const s = new MetaCloudSender(cloud as never, {} as never);
    s.bindBusiness(BIZ);
    s.customerReplyGuard = guard;
    return { s, cloud };
  }

  it('refuses before any attempt, financial authorization or Meta call, and does not retry', async () => {
    const guard = vi.fn().mockRejectedValue(new CustomerDailyLimitError());
    const { s, cloud } = sender(guard);
    await expect(s.sendText({ to: CUSTOMER, text: 'hi' })).rejects.toBeInstanceOf(CustomerDailyLimitError);
    expect(guard).toHaveBeenCalledTimes(1);
    expect(guard).toHaveBeenCalledWith(BIZ, CUSTOMER);
    expect(h.createAttempt).not.toHaveBeenCalled();
    expect(h.authorize).not.toHaveBeenCalled();
    expect(cloud.sendText).not.toHaveBeenCalled();
  });

  it('sends normally when the guard allows it', async () => {
    const { s, cloud } = sender(vi.fn().mockResolvedValue(undefined));
    await s.sendText({ to: CUSTOMER, text: 'hi' });
    expect(cloud.sendText).toHaveBeenCalledTimes(1);
  });

  it('never guards platform-intended sends, even with the business bound (STOP/START replies)', async () => {
    const guard = vi.fn().mockRejectedValue(new CustomerDailyLimitError());
    const { s, cloud } = sender(guard);
    await s.sendPlatformText!({ to: CUSTOMER, text: 'You have been unsubscribed.' });
    expect(guard).not.toHaveBeenCalled();
    expect(cloud.sendText).toHaveBeenCalledTimes(1);
  });

  it('never guards platform sends (free notices)', async () => {
    const guard = vi.fn().mockRejectedValue(new CustomerDailyLimitError());
    const cloud = { sendText: vi.fn().mockResolvedValue({ messageId: 'wamid.2' }) };
    const s = new MetaCloudSender(cloud as never, {} as never);
    s.customerReplyGuard = guard;
    await s.sendPlatformText!({ to: CUSTOMER, text: "You've reached today's limit" });
    expect(guard).not.toHaveBeenCalled();
    expect(cloud.sendText).toHaveBeenCalledTimes(1);
  });
});

describe('installCustomerReplyGuard (webhook wiring)', () => {
  function realSender() {
    const cloud = { sendText: vi.fn().mockResolvedValue({ messageId: 'wamid.n' }) };
    const s = new MetaCloudSender(cloud as never, {} as never);
    s.bindBusiness(BIZ);
    return { s, cloud };
  }
  const overLimit = () => fakeDb({ rpc: (name) => name === 'claim_customer_daily_limit_notice'
    ? { data: true, error: null } : { data: { reply_count: 51, over_limit: true }, error: null } });

  it('guards every paid reply to this customer, then clears, sends one notice and binds the business again', async () => {
    const { s, cloud } = realSender();
    const { db } = overLimit();
    const installed = installCustomerReplyGuard(s, db, CUSTOMER);
    await expect(s.sendText({ to: CUSTOMER, text: "I can't process images yet" })).rejects.toBeInstanceOf(CustomerDailyLimitError);
    await expect(s.sendText({ to: CUSTOMER, text: 'menu' })).rejects.toBeInstanceOf(CustomerDailyLimitError);
    expect(cloud.sendText).not.toHaveBeenCalled();
    await installed.finish(BIZ);
    expect(s.customerReplyGuard).toBeUndefined();
    expect(cloud.sendText).toHaveBeenCalledTimes(1);
    expect(cloud.sendText.mock.calls[0][0]).toMatchObject({ to: CUSTOMER, text: CUSTOMER_DAILY_LIMIT_MESSAGE });
    expect(s.boundBusinessId).toBe(BIZ);
    // The next message in the batch is not affected.
    await s.sendText({ to: CUSTOMER, text: 'hello' });
    expect(cloud.sendText).toHaveBeenCalledTimes(2);
  });

  it('sends nothing extra when no reply was refused, and clears even after a throw', async () => {
    const { s, cloud } = realSender();
    const { db } = fakeDb({ rpc: () => ({ data: { reply_count: 1, over_limit: false }, error: null }) });
    const installed = installCustomerReplyGuard(s, db, CUSTOMER);
    try { throw new Error('bot crashed'); } catch { /* the route's catch */ } finally { await installed.finish(BIZ); }
    expect(s.customerReplyGuard).toBeUndefined();
    expect(cloud.sendText).not.toHaveBeenCalled();
  });

  it('does nothing for a sender that is not a MetaCloudSender', async () => {
    const installed = installCustomerReplyGuard({ sendText: vi.fn() }, overLimit().db, CUSTOMER);
    await expect(installed.finish(BIZ)).resolves.toBeUndefined();
  });
});

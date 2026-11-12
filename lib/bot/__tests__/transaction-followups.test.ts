import { randomUUID } from 'node:crypto';
import { createMemoryDb } from '../../__tests__/helpers/memory-db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';

const mocks = vi.hoisted(() => ({
  send: vi.fn(), list: vi.fn(), recurring: vi.fn(), eligibility: vi.fn(), record: vi.fn(), resolve: vi.fn(), incoming: vi.fn(), paid: vi.fn(),
}));
vi.mock('@/lib/channels/channel-resolver', () => ({ ChannelResolver: class {
  resolveByChannelIdForBusiness = mocks.resolve;
  resolveByPhoneNumberId = mocks.incoming;
} }));
vi.mock('@/lib/bot/customer-updates-optin', () => ({
  transactionUpdatesOptInEligibility: mocks.eligibility, recordUpdatesOptIn: mocks.record,
  updatesOptInIncludesWaaiio: (_tier: string, white: boolean) => !white,
}));
vi.mock('@/lib/payments/saved-card-delivery', () => ({ isProvenPreEmission: (e: { name: string }) => e?.name === 'GateBlockError' }));
vi.mock('@/lib/payments/transaction-followup', () => ({ resumePaidTransactionFollowup: mocks.paid }));
vi.mock('@/lib/payments/recurring-offer', () => ({ prepareRecurringOffer: mocks.recurring }));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { claimTransactionCardStep, dismissTransactionFollowups, handleTransactionFollowupTap, paymentHasTransactionFollowup,
  recoverTransactionFollowups, releaseTransactionFollowupAfterConfirmation, resumeTransactionFollowupForPayment, startTransactionFollowup } from '../transaction-followups';

const biz = '10000000-0000-4000-8000-000000000001';
const channel = '20000000-0000-4000-8000-000000000001';
const payment = '30000000-0000-4000-8000-000000000001';
const phone = '+2348012345678';
type Row = Record<string, any>;
const active = new Set(['card_active', 'card_resolved', 'optin_sending', 'awaiting_optin', 'consent_pending', 'consent_recording', 'menu_ready', 'menu_sending']);

/** Stateful fake of database CAS/unique behavior; handlers and coordinator run unmodified. */
function database() {
  const tables: Record<string, Row[]> = {
    transaction_followups: [], bot_sessions: [], customer_consents: [], payments: [], payment_saved_card_offers: [],
    businesses: [{ id: biz, name: 'Test business', subscription_tier: 'starter', is_whitelabel: false }],
  };
  const errors = new Map<string, string>();
  function from(table: string) {
    let operation = 'select';
    let values: Row = {};
    let filters: Array<(r: Row) => boolean> = [];
    let max = Infinity;
    let single = false;
    let orderKey: string | null = null;
    const builder: any = {
      select: () => builder,
      update: (v: Row) => { operation = 'update'; values = v; return builder; },
      upsert: (v: Row) => { operation = 'upsert'; values = v; return builder; },
      eq: (k: string, v: unknown) => { filters.push(r => r[k] === v); return builder; },
      neq: (k: string, v: unknown) => { filters.push(r => r[k] !== v); return builder; },
      in: (k: string, vs: unknown[]) => { filters.push(r => vs.includes(r[k])); return builder; },
      gte: (k: string, v: string) => { filters.push(r => r[k] >= v); return builder; },
      limit: (v: number) => { max = v; return builder; },
      order: (key: string) => { orderKey = key; return builder; },
      maybeSingle: () => { single = true; return builder; },
      then: (resolve: (value: unknown) => unknown, reject: (err: unknown) => unknown) => {
        try {
          if (errors.has(table)) return Promise.resolve({ data: null, error: { code: errors.get(table) } }).then(resolve, reject);
          const rows = tables[table] || [];
          let results = rows.filter(r => filters.every(f => f(r)));
          if (orderKey) results.sort((a, b) => String(a[orderKey!]).localeCompare(String(b[orderKey!])));
          results = results.slice(0, max);
          if (operation === 'upsert') {
            if (!rows.some(r => r.business_id === values.business_id && r.completion_key === values.completion_key)) {
              rows.push({ id: randomUUID(), response: null, responded_at: null, acknowledgment: null,
                claim_token: null, claim_until: null, updated_at: new Date(0).toISOString(), ...values });
            }
            results = [];
          }
          if (operation === 'update') {
            for (const row of results) {
              if (table === 'transaction_followups' && active.has(values.state)
                && rows.some(other => other.id !== row.id && other.phone === row.phone
                  && other.channel_id === row.channel_id && active.has(other.state))) {
                return Promise.resolve({ data: null, error: { code: '23505' } }).then(resolve, reject);
              }
              Object.assign(row, values);
            }
          }
          const result = single ? (results[0] ? { ...results[0] } : null) : results.map(r => ({ ...r }));
          return Promise.resolve({ data: result, error: null }).then(resolve, reject);
        } catch (err) { return Promise.reject(err).then(resolve, reject); }
      },
    };
    return builder;
  }
  const rpc = vi.fn(async (name: string, args: Row) => {
    if (name !== 'decline_saved_card_offer') throw new Error(`unexpected RPC ${name}`);
    const offer = tables.payment_saved_card_offers.find(r => r.payment_id === args.p_payment_id);
    if (!offer) return { data: { result: 'not_found' }, error: null };
    if (offer.customer_phone !== args.p_customer_phone || offer.offer_type !== args.p_expected_offer_type) {
      return { data: { result: 'wrong_customer' }, error: null };
    }
    if (offer.state === 'declined') return { data: { result: 'already_declined' }, error: null };
    if (offer.state === 'accepted') return { data: { result: 'already_accepted' }, error: null };
    if (!['sent', 'ambiguous'].includes(offer.state)) return { data: { result: 'invalid_state' }, error: null };
    offer.state = 'declined';
    return { data: { result: 'transitioned' }, error: null };
  });
  return { db: { from, rpc } as unknown as SupabaseClient, tables, errors, rpc };
}

const start = (extra: Row = {}) => ({ completionKey: 'booking:one', businessId: biz, phone,
  channelId: channel, kind: 'ticketing', lang: 'en', ...extra });
const tap = (id: string, yes = true, extra: Row = {}) => ({
  from: phone, text: `txupdates_${yes ? 'yes' : 'no'}:${id}`, messageType: 'button', channelId: channel, ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.send.mockReset().mockResolvedValue({ messageId: 'wamid.123' });
  mocks.list.mockReset().mockResolvedValue({ messageId: 'wamid.list' });
  mocks.recurring.mockReset().mockResolvedValue(undefined);
  mocks.eligibility.mockReset().mockResolvedValue('eligible');
  mocks.record.mockReset().mockResolvedValue({ status: 'granted', businessName: 'Test business', waaiioSubscribed: true });
  const resolved = { sender: { sendButtons: mocks.send, sendList: mocks.list }, channel: { id: channel, phone_number_id: 'pnid', channel_type: 'shared' } };
  mocks.resolve.mockReset().mockResolvedValue(resolved);
  mocks.incoming.mockReset().mockResolvedValue(resolved);
  mocks.paid.mockReset().mockResolvedValue(undefined);
});

describe('durable transaction follow-up sequence', () => {
  it('canonical completion consent creates the transport subscriber key that real STOP discovers and revokes', async () => {
    const actual = await vi.importActual<typeof import('../customer-updates-optin')>('../customer-updates-optin');
    mocks.record.mockImplementation(actual.recordUpdatesOptIn);
    const state = database();
    const transportPhone = phone.slice(1);
    const consent = createMemoryDb({
      businesses: [{ id: biz, name: 'Test business', subscription_tier: 'growth', is_whitelabel: false, country_code: 'NG' }],
      bot_sessions: [{ id: 'contact', business_id: biz, whatsapp_number: transportPhone }],
      customer_profiles: [], customer_consents: [], messaging_opt_outs: [], launch_subscribers: [],
      whatsapp_channels: [{ id: channel, phone_number_id: 'pnid', channel_type: 'shared', is_active: true, country_code: 'NG' }],
    });
    const db = { from: (table: string) => table === 'transaction_followups'
      ? state.db.from(table) : consent.from(table), rpc: state.rpc } as unknown as SupabaseClient;
    await startTransactionFollowup(db, start());
    const row = state.tables.transaction_followups[0];
    expect(row.phone).toBe(phone);
    await handleTransactionFollowupTap(db, tap(row.id, true, { from: transportPhone }));
    expect(row.state).toBe('done');
    expect(row.phone).toBe(phone);
    expect(consent.tables.customer_consents).toHaveLength(2);
    expect(consent.tables.customer_consents.every(r => r.phone === phone)).toBe(true);
    expect(consent.tables.launch_subscribers).toEqual([expect.objectContaining({ wa_number: transportPhone, opt_in_status: 'active' })]);

    // Use the actual STOP discovery and revocation methods; only unrelated merchant
    // candidate discovery and outbound confirmation are isolated here.
    const { BotService } = await import('../bot.service');
    const bot = Object.create(BotService.prototype) as any;
    bot.supabase = db;
    bot._resolveStopCandidates = vi.fn().mockResolvedValue({ candidates: [], channelVerified: true });
    bot.sendPlatformText = vi.fn().mockResolvedValue(undefined);
    expect(await bot._handleStopRequest(transportPhone, undefined, 'pnid')).toBe(true);
    expect(consent.tables.launch_subscribers[0]).toMatchObject({ wa_number: transportPhone, opt_in_status: 'opted_out', notification_status: 'skipped' });
    expect(bot.sendPlatformText).toHaveBeenCalledWith(transportPhone, expect.stringContaining('unsubscribed'));
  }, 60_000);

  it('persists free completion before its confirmation and does not advance before the after-send proof', async () => {
    const { db, tables } = database();
    await startTransactionFollowup(db, start({ awaitingConfirmation: true }));
    expect(tables.transaction_followups[0].state).toBe('awaiting_confirmation');
    await recoverTransactionFollowups(db);
    expect(mocks.send).not.toHaveBeenCalled();
    await releaseTransactionFollowupAfterConfirmation(db, biz, 'booking:one');
    await releaseTransactionFollowupAfterConfirmation(db, biz, 'booking:one');
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(tables.transaction_followups[0].state).toBe('awaiting_optin');
  });

  it('does not release a paid or wrong-business confirmation through the free hook', async () => {
    const { db } = database();
    await startTransactionFollowup(db, start({ paymentId: payment, waitForCard: true }));
    await expect(releaseTransactionFollowupAfterConfirmation(db, biz, 'booking:one')).rejects.toThrow('not_free');
    await expect(releaseTransactionFollowupAfterConfirmation(db, 'other', 'booking:one')).rejects.toThrow('lookup');
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('holds all follow-ups until the paid card step is explicitly resolved', async () => {
    const { db, tables } = database();
    await startTransactionFollowup(db, start({ paymentId: payment, waitForCard: true }));
    expect(mocks.send).not.toHaveBeenCalled();
    await resumeTransactionFollowupForPayment(db, payment);
    expect(mocks.send).not.toHaveBeenCalled();
    await resumeTransactionFollowupForPayment(db, payment, { cardResolved: true });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(tables.transaction_followups[0].state).toBe('awaiting_optin');
    expect(mocks.send.mock.calls[0][0].buttons.map((b: Row) => b.id)).toEqual([
      `txupdates_yes:${tables.transaction_followups[0].id}`, `txupdates_no:${tables.transaction_followups[0].id}`,
    ]);
  });

  it('records explicit yes then sends final options exactly once despite replay', async () => {
    const { db, tables } = database();
    await startTransactionFollowup(db, start());
    const id = tables.transaction_followups[0].id;
    await Promise.all([handleTransactionFollowupTap(db, tap(id)), handleTransactionFollowupTap(db, tap(id))]);
    await handleTransactionFollowupTap(db, tap(id));
    expect(mocks.record).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(mocks.send.mock.calls[1][0].buttons.some((b: Row) => b.id === 'menu')).toBe(true);
    expect(tables.transaction_followups[0].state).toBe('done');
  });

  it('No thanks continues to business options without recording consent', async () => {
    const { db, tables } = database();
    await startTransactionFollowup(db, start());
    await handleTransactionFollowupTap(db, tap(tables.transaction_followups[0].id, false));
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(tables.transaction_followups[0]).toMatchObject({ state: 'done', response: 'no' });
  });

  it('preserves the business-only scope actually shown when branding changes before Yes', async () => {
    const { db, tables } = database();
    tables.businesses[0].is_whitelabel = true;
    await startTransactionFollowup(db, start());
    expect(tables.transaction_followups[0].includes_waaiio).toBe(false);
    tables.businesses[0].is_whitelabel = false;
    await handleTransactionFollowupTap(db, tap(tables.transaction_followups[0].id));
    expect(mocks.record.mock.calls[0][1].includesWaaiio).toBe(false);
  });

  it.each(['already opted in', 'STOP', 'revoked', 'no contact'])('skips the offer when ineligible: %s', async () => {
    const { db, tables } = database();
    mocks.eligibility.mockResolvedValue('ineligible');
    await startTransactionFollowup(db, start());
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0][0].buttons.some((b: Row) => b.id === 'menu')).toBe(true);
    expect(mocks.record).not.toHaveBeenCalled();
    expect(tables.transaction_followups[0].state).toBe('done');
  });

  it('leaves eligibility lookup failure queued instead of permanently skipping opt-in', async () => {
    const { db, tables } = database();
    mocks.eligibility.mockResolvedValue('error');
    await startTransactionFollowup(db, start());
    expect(tables.transaction_followups[0].state).toBe('ready');
    expect(mocks.send).not.toHaveBeenCalled();
    mocks.eligibility.mockResolvedValue('eligible');
    await recoverTransactionFollowups(db);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it.each(['save_card_pin', 'verify_card_pin', 'replace_card_pin'])('does not interrupt active %s', async current_step => {
    const { db, tables } = database();
    tables.bot_sessions.push({ id: 'pin', whatsapp_number: phone.slice(1), is_active: true, current_step });
    await startTransactionFollowup(db, start());
    expect(mocks.send).not.toHaveBeenCalled();
    tables.bot_sessions[0].is_active = false;
    await recoverTransactionFollowups(db);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it('also defers final menu if the customer starts another PIN while answering opt-in', async () => {
    const { db, tables } = database();
    await startTransactionFollowup(db, start());
    tables.bot_sessions.push({ whatsapp_number: phone, is_active: true, current_step: 'save_card_pin' });
    await handleTransactionFollowupTap(db, tap(tables.transaction_followups[0].id, false));
    expect(tables.transaction_followups[0].state).toBe('menu_ready');
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent starts and serializes different completed transactions', async () => {
    const { db, tables } = database();
    await Promise.all([startTransactionFollowup(db, start()), startTransactionFollowup(db, start()),
      startTransactionFollowup(db, start({ completionKey: 'booking:two' }))]);
    expect(tables.transaction_followups).toHaveLength(2);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(tables.transaction_followups.map(r => r.state).sort()).toEqual(['awaiting_optin', 'ready']);
  });

  it('blocks another completion while an existing card offer owns the conversation', async () => {
    const { db } = database();
    await startTransactionFollowup(db, start({ paymentId: payment, waitForCard: true }));
    expect(await claimTransactionCardStep(db, payment)).toBe(true);
    await startTransactionFollowup(db, start({ completionKey: 'booking:two' }));
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('finishes A card, opt-in and menu before B can offer its card on the same conversation', async () => {
    const { db, tables } = database();
    const paymentB = '30000000-0000-4000-8000-000000000002';
    await startTransactionFollowup(db, start({ paymentId: payment, waitForCard: true }));
    await startTransactionFollowup(db, start({ completionKey: 'booking:two', paymentId: paymentB, waitForCard: true }));
    const claims = await Promise.all([claimTransactionCardStep(db, payment), claimTransactionCardStep(db, paymentB)]);
    expect(claims).toEqual([true, false]);
    expect(tables.transaction_followups.map(r => r.state)).toEqual(['card_active', 'waiting_card']);
    mocks.eligibility.mockResolvedValueOnce('error');
    await resumeTransactionFollowupForPayment(db, payment, { cardResolved: true });
    expect(tables.transaction_followups[0].state).toBe('card_resolved');
    expect(await claimTransactionCardStep(db, paymentB)).toBe(false);
    await resumeTransactionFollowupForPayment(db, payment);
    expect(tables.transaction_followups[0].state).toBe('awaiting_optin');
    expect(await claimTransactionCardStep(db, paymentB)).toBe(false);
    await handleTransactionFollowupTap(db, tap(tables.transaction_followups[0].id, false));
    expect(tables.transaction_followups[0].state).toBe('done');
    expect(await claimTransactionCardStep(db, paymentB)).toBe(true);
    expect(tables.transaction_followups[1].state).toBe('card_active');
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });

  it('keeps the card-resolved conversation owner after a proven pre-emission opt-in failure', async () => {
    const { db, tables } = database();
    await startTransactionFollowup(db, start({ paymentId: payment, waitForCard: true }));
    await claimTransactionCardStep(db, payment);
    mocks.send.mockRejectedValueOnce(Object.assign(new Error('blocked'), { name: 'GateBlockError' }));
    await resumeTransactionFollowupForPayment(db, payment, { cardResolved: true });
    expect(tables.transaction_followups[0].state).toBe('card_resolved');
    await recoverTransactionFollowups(db);
    expect(tables.transaction_followups[0].state).toBe('awaiting_optin');
  });

  it.each([{ phone: '+2348012345679' }, { channelId: 'other' }, { paymentId: payment }])('rejects changed identity on replay: %j', async changed => {
    const { db, tables } = database();
    await startTransactionFollowup(db, start());
    await expect(startTransactionFollowup(db, start(changed))).rejects.toThrow('identity_mismatch');
    expect(tables.transaction_followups).toHaveLength(1);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it.each([
    { from: '+2348012345679' }, { channelId: 'other' }, { channelBusinessId: 'other' },
    { messageType: 'text' }, { destinationPhone: 'wrong' },
  ])('rejects a mismatched or typed consent input: %j', async changed => {
    const { db, tables } = database();
    await startTransactionFollowup(db, start());
    expect(await handleTransactionFollowupTap(db, tap(tables.transaction_followups[0].id, true, changed))).toBe(true);
    expect(mocks.record).not.toHaveBeenCalled();
    expect(tables.transaction_followups[0].state).toBe('awaiting_optin');
  });

  it('resolves exact receiving channel when the early inbound hook has only phone-number ID', async () => {
    const { db, tables } = database();
    await startTransactionFollowup(db, start());
    await handleTransactionFollowupTap(db, tap(tables.transaction_followups[0].id, false, { channelId: undefined, destinationPhone: 'pnid' }));
    expect(mocks.incoming).toHaveBeenCalledWith('pnid');
    expect(tables.transaction_followups[0].state).toBe('done');
  });

  it('retries proven pre-emission failure, but never repeats ambiguous sends', async () => {
    const { db, tables } = database();
    mocks.send.mockRejectedValueOnce(Object.assign(new Error('blocked'), { name: 'GateBlockError' }));
    await startTransactionFollowup(db, start());
    expect(tables.transaction_followups[0].state).toBe('ready');
    mocks.send.mockRejectedValueOnce(new Error('timeout'));
    await expect(recoverTransactionFollowups(db)).resolves.toBeUndefined();
    expect(tables.transaction_followups[0].state).toBe('optin_sending');
    await recoverTransactionFollowups(db);
    expect(mocks.send).toHaveBeenCalledTimes(2);
    // A real matching tap proves the ambiguous prompt reached the customer.
    await handleTransactionFollowupTap(db, tap(tables.transaction_followups[0].id, false));
    expect(tables.transaction_followups[0].state).toBe('done');
  });

  it('missing WAMID stays fenced rather than assuming delivery', async () => {
    const { db, tables } = database();
    mocks.send.mockResolvedValue({});
    await startTransactionFollowup(db, start());
    await recoverTransactionFollowups(db);
    expect(tables.transaction_followups[0].state).toBe('optin_sending');
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it('recovers persisted Yes after grant lookup failure without another opt-in prompt', async () => {
    const { db, tables } = database();
    await startTransactionFollowup(db, start());
    mocks.record.mockResolvedValueOnce({ status: 'error' });
    await handleTransactionFollowupTap(db, tap(tables.transaction_followups[0].id));
    const row = tables.transaction_followups[0];
    expect(row.state).toBe('consent_recording');
    await recoverTransactionFollowups(db);
    expect(mocks.record).toHaveBeenCalledTimes(1); // lease has not expired
    row.claim_until = new Date(0).toISOString();
    await recoverTransactionFollowups(db);
    expect(mocks.record).toHaveBeenCalledTimes(2);
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(row.state).toBe('done');
  });

  it('does not let recovery of an old Yes override a newer revocation', async () => {
    const { db, tables } = database();
    await startTransactionFollowup(db, start());
    mocks.record.mockResolvedValueOnce({ status: 'error' });
    await handleTransactionFollowupTap(db, tap(tables.transaction_followups[0].id));
    const row = tables.transaction_followups[0];
    row.claim_until = new Date(0).toISOString();
    tables.customer_consents.push({ id: 'revoked', business_id: biz, phone,
      channel: 'whatsapp', purpose: 'marketing', status: 'revoked', created_at: row.responded_at });
    await recoverTransactionFollowups(db);
    expect(mocks.record).toHaveBeenCalledTimes(1);
    expect(row.state).toBe('done');
  });

  it('explicit navigation dismisses old unanswered prompts without consent or another send', async () => {
    const { db, tables } = database();
    await startTransactionFollowup(db, start());
    await dismissTransactionFollowups(db, { from: phone, destinationPhone: 'pnid' });
    expect(tables.transaction_followups[0].state).toBe('done');
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenCalledTimes(1);
    await startTransactionFollowup(db, start({ completionKey: 'booking:two' }));
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });

  it('does not dismiss another phone/channel or accepted card setup', async () => {
    const { db, tables } = database();
    await startTransactionFollowup(db, start({ waitForCard: true, paymentId: payment }));
    await claimTransactionCardStep(db, payment);
    tables.payment_saved_card_offers.push({ payment_id: payment, customer_phone: phone, business_id: biz, offer_type: 'save', state: 'accepted' });
    await dismissTransactionFollowups(db, { from: phone, channelId: channel });
    expect(tables.transaction_followups[0].state).toBe('card_active');
    await resumeTransactionFollowupForPayment(db, payment, { cardResolved: true });
    await dismissTransactionFollowups(db, { from: '+2348012345679', channelId: channel });
    await dismissTransactionFollowups(db, { from: phone, channelId: 'other' });
    expect(tables.transaction_followups[0].state).toBe('awaiting_optin');
  });

  it.each(['sent', 'ambiguous'])('explicit menu navigation declines an ignored %s card offer before releasing its owner', async state => {
    const { db, tables, rpc } = database();
    await startTransactionFollowup(db, start({ waitForCard: true, paymentId: payment }));
    await claimTransactionCardStep(db, payment);
    tables.payment_saved_card_offers.push({ payment_id: payment, customer_phone: phone, business_id: biz, offer_type: 'save', state });
    await dismissTransactionFollowups(db, { from: phone, channelId: channel });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(tables.payment_saved_card_offers[0].state).toBe('declined');
    expect(tables.transaction_followups[0].state).toBe('done');
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('explicit navigation retires an unclaimed card task but keeps a pending provider offer fenced', async () => {
    const { db, tables, rpc } = database();
    await startTransactionFollowup(db, start({ waitForCard: true, paymentId: payment }));
    await dismissTransactionFollowups(db, { from: phone, channelId: channel });
    expect(tables.transaction_followups[0].state).toBe('done');
    expect(await claimTransactionCardStep(db, payment)).toBe(false);
    const otherPayment = 'other';
    await startTransactionFollowup(db, start({ waitForCard: true, paymentId: otherPayment, completionKey: 'other' }));
    await claimTransactionCardStep(db, otherPayment);
    tables.payment_saved_card_offers.push({ payment_id: otherPayment, customer_phone: phone, business_id: biz, offer_type: 'save', state: 'pending' });
    await dismissTransactionFollowups(db, { from: phone, channelId: channel });
    expect(tables.transaction_followups[1].state).toBe('card_active');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('delegates waiting-card recovery to payment authority and scopes ownership checks', async () => {
    const { db } = database();
    await startTransactionFollowup(db, start({ waitForCard: true, paymentId: payment }));
    await recoverTransactionFollowups(db);
    expect(mocks.paid).toHaveBeenCalledWith(db, payment);
    expect(await paymentHasTransactionFollowup(db, payment, biz)).toBe(true);
    expect(await paymentHasTransactionFollowup(db, payment, 'other')).toBe(false);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('rotates unresolved card rows so later ready conversations are not starved by the batch limit', async () => {
    const { db, tables } = database();
    await startTransactionFollowup(db, start({ waitForCard: true, paymentId: payment }));
    await startTransactionFollowup(db, start({ waitForCard: true, paymentId: 'other', completionKey: 'two', phone: '+2348012345679' }));
    mocks.eligibility.mockResolvedValue('error');
    await startTransactionFollowup(db, start({ completionKey: 'three', phone: '+2348012345680' }));
    mocks.eligibility.mockResolvedValue('eligible');
    await recoverTransactionFollowups(db, 2);
    expect(mocks.send).not.toHaveBeenCalled();
    await recoverTransactionFollowups(db, 2);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(tables.transaction_followups[2].state).toBe('awaiting_optin');
  });

  it('continues recovery for unrelated conversations after one send fails', async () => {
    const { db, tables } = database();
    mocks.eligibility.mockResolvedValue('error');
    await startTransactionFollowup(db, start());
    await startTransactionFollowup(db, start({ completionKey: 'other', phone: '+2348012345679' }));
    mocks.eligibility.mockResolvedValue('eligible');
    mocks.send.mockRejectedValueOnce(new Error('network timeout'));
    await recoverTransactionFollowups(db);
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(tables.transaction_followups.map(r => r.state)).toEqual(['optin_sending', 'awaiting_optin']);
  });

  it('offers eligible recurring setup only as a final menu action after the opt-in answer', async () => {
    const { db, tables } = database();
    tables.payments.push({ id: payment, business_id: biz, amount: 100, booking_id: 'booking' });
    mocks.recurring.mockResolvedValue({ id: 'recurring_setup:intent', title: 'Set Up Recurring', description: 'Repeat this payment' });
    await startTransactionFollowup(db, start({ paymentId: payment, waitForCard: true }));
    expect(mocks.recurring).not.toHaveBeenCalled();
    await resumeTransactionFollowupForPayment(db, payment, { cardResolved: true });
    expect(mocks.recurring).not.toHaveBeenCalled();
    await handleTransactionFollowupTap(db, tap(tables.transaction_followups[0].id, false));
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.list.mock.calls[0][0]).toMatchObject({ noRetry: true, messageCategory: 'service' });
    expect(mocks.list.mock.calls[0][0].items.map((i: Row) => i.postbackText)).toContain('recurring_setup:intent');
    expect(mocks.send).toHaveBeenCalledTimes(1); // only the earlier explicit opt-in prompt
    expect(tables.transaction_followups[0].state).toBe('done');
  });

  it('explicit navigation releases a BYO card step that can never get an offer', async () => {
    const { db, tables } = database();
    tables.payments.push({ id: payment, business_id: biz, gateway: 'paystack', metadata: { payment_origin: 'byo', byo: true } });
    await startTransactionFollowup(db, start({ waitForCard: true, paymentId: payment }));
    await claimTransactionCardStep(db, payment);
    await dismissTransactionFollowups(db, { from: phone, channelId: channel });
    expect(tables.transaction_followups[0].state).toBe('done');
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('explicit navigation keeps a claimed Waaiio-collected card step that may still send its offer', async () => {
    const { db, tables } = database();
    tables.payments.push({ id: payment, business_id: biz, gateway: 'paystack', metadata: { payment_origin: 'platform' } });
    await startTransactionFollowup(db, start({ waitForCard: true, paymentId: payment }));
    await claimTransactionCardStep(db, payment);
    await dismissTransactionFollowups(db, { from: phone, channelId: channel });
    expect(tables.transaction_followups[0].state).toBe('card_active');
  });

  it('does not release a card step when its payment cannot be read', async () => {
    const { db, tables, errors } = database();
    await startTransactionFollowup(db, start({ waitForCard: true, paymentId: payment }));
    await claimTransactionCardStep(db, payment);
    errors.set('payments', 'boom');
    await expect(dismissTransactionFollowups(db, { from: phone, channelId: channel })).rejects.toThrow('transaction_followup_dismiss_payment');
    expect(tables.transaction_followups[0].state).toBe('card_active');
  });

  it('a stuck BYO order no longer blocks the next payment once the customer moves on (staging 2026-11-12)', async () => {
    const { db, tables } = database();
    const order = '30000000-0000-4000-8000-000000000002';
    tables.payments.push({ id: order, business_id: biz, gateway: 'paystack', metadata: { payment_origin: 'byo' } });
    await startTransactionFollowup(db, start({ waitForCard: true, paymentId: order, completionKey: 'payment:order', kind: 'ordering' }));
    await claimTransactionCardStep(db, order);
    await startTransactionFollowup(db, start({ waitForCard: true, paymentId: payment, completionKey: 'payment:booking', kind: 'scheduling' }));
    expect(await claimTransactionCardStep(db, payment)).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Blocked by another follow-up'), expect.objectContaining({ to: 'card_active' }));
    await dismissTransactionFollowups(db, { from: phone, channelId: channel });
    expect(tables.transaction_followups.find(r => r.payment_id === order)?.state).toBe('done');
    // The unclaimed booking row was retired by the same navigation, freeing the conversation.
    expect(tables.transaction_followups.some(r => active.has(r.state))).toBe(false);
  });
});


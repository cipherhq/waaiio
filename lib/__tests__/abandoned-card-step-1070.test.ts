/**
 * #1070 Defect B (Owner approved 2026-11-16): an accepted save-card offer whose
 * customer left the PIN step must not lock the chat. Staging: follow-up for an
 * earlier Stripe payment stayed card_active (offer accepted/replace, no active
 * bot session), so the next payment's follow-up hit the one-per-conversation
 * unique index forever.
 *
 * Real modules: lib/payments/transaction-followup, lib/bot/transaction-followups,
 * lib/payments/abandoned-card-step, saved-card-compat, next-steps-menu.
 * Faked: database (with the conversation unique index), channel resolver/sender,
 * opt-in eligibility, Stripe/Paystack card-offer senders.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const m = vi.hoisted(() => ({
  buttons: vi.fn(), list: vi.fn(), eligibility: vi.fn(), stripe: vi.fn(), paystackOffer: vi.fn(), paystackEligibility: vi.fn(), retry: vi.fn(),
}));
vi.mock('@/lib/channels/channel-resolver', () => ({ ChannelResolver: class {
  async resolveByChannelIdForBusiness() {
    return { channel: { id: 'channel', channel_type: 'dedicated', phone_number_id: 'pnid' }, sender: { sendButtons: m.buttons, sendList: m.list } };
  }
  async resolveByPhoneNumberId() { return null; }
} }));
vi.mock('@/lib/bot/customer-updates-optin', () => ({
  transactionUpdatesOptInEligibility: m.eligibility, recordUpdatesOptIn: vi.fn(), updatesOptInIncludesWaaiio: () => true,
}));
vi.mock('@/lib/payments/saved-card-offer', () => ({
  checkStripeConsentAndOffer: m.stripe, checkAndOfferSavedCard: m.paystackOffer,
  checkSavedCardOfferEligibility: m.paystackEligibility, retryPendingSavedCardOffer: m.retry,
}));
vi.mock('@/lib/payments/saved-card-delivery', () => ({ isProvenPreEmission: () => false }));
vi.mock('@/lib/payments/recurring-offer', () => ({ prepareRecurringOffer: vi.fn(async () => undefined) }));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { resumePaidTransactionFollowup } from '@/lib/payments/transaction-followup';
import { dismissTransactionFollowups, recoverTransactionFollowups } from '@/lib/bot/transaction-followups';
import { ABANDONED_CARD_STEP_GRACE_MS } from '@/lib/payments/abandoned-card-step';

const biz = '10000000-0000-4000-8000-000000000001';
const phone = '+2348012345678';
const oldPay = '30000000-0000-4000-8000-000000000001';
const newPay = '30000000-0000-4000-8000-000000000002';
const conversationStates = new Set(['card_active', 'card_resolved', 'optin_sending', 'awaiting_optin', 'consent_pending',
  'consent_recording', 'menu_ready', 'menu_sending']);
type Row = Record<string, any>;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

/** Stateful fake: CAS updates and the transaction_followups_conversation_prompt unique index (23505). */
function database() {
  const tables: Record<string, Row[]> = {
    transaction_followups: [], bot_sessions: [], payment_saved_card_offers: [], customer_consents: [],
    payments: [], payment_confirmation_deliveries: [],
    businesses: [{ id: biz, name: 'BalaShop', subscription_tier: 'starter', is_whitelabel: false }],
  };
  const writes: Array<{ table: string; values: Row }> = [];
  const rpc = vi.fn(async (name: string) => ({ data: null, error: { code: `unexpected_rpc_${name}` } }));
  function from(table: string) {
    let operation = 'select';
    let values: Row = {};
    const filters: Array<(r: Row) => boolean> = [];
    let max = Infinity;
    let single = false;
    let orderKey: string | null = null;
    const builder: any = {
      select: () => builder,
      update: (v: Row) => { operation = 'update'; values = v; return builder; },
      eq: (k: string, v: unknown) => { filters.push(r => r[k] === v); return builder; },
      in: (k: string, vs: unknown[]) => { filters.push(r => vs.includes(r[k])); return builder; },
      gte: (k: string, v: string) => { filters.push(r => r[k] >= v); return builder; },
      limit: (v: number) => { max = v; return builder; },
      order: (k: string) => { orderKey = k; return builder; },
      maybeSingle: () => { single = true; return builder; },
      then: (resolve: (value: unknown) => unknown, reject: (err: unknown) => unknown) => {
        const rows = tables[table] || [];
        let results = rows.filter(r => filters.every(f => f(r)));
        if (orderKey) results.sort((a, b) => String(a[orderKey!]).localeCompare(String(b[orderKey!])));
        results = results.slice(0, max);
        if (operation === 'update') {
          writes.push({ table, values });
          for (const row of results) {
            if (table === 'transaction_followups' && conversationStates.has(values.state)
              && rows.some(o => o.id !== row.id && o.phone === row.phone && o.channel_id === row.channel_id && conversationStates.has(o.state))) {
              return Promise.resolve({ data: null, error: { code: '23505' } }).then(resolve, reject);
            }
            Object.assign(row, values);
          }
        }
        const data = single ? (results[0] ? { ...results[0] } : null) : results.map(r => ({ ...r }));
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }
  return { db: { from, rpc } as unknown as SupabaseClient, tables, writes, rpc };
}

/** Old Stripe ticket follow-up holding the chat (card_active) and the new payment's follow-up queued behind it. */
function stagingScenario(offer: Row = {}) {
  const env = database();
  const { tables } = env;
  for (const id of [oldPay, newPay]) {
    tables.payments.push({ id, business_id: biz, status: 'success', gateway: 'stripe', confirmation_sent_at: ago(60_000),
      amount: 5000, booking_id: null, metadata: { payment_origin: 'platform', _inbound_channel_id: 'channel' } });
    tables.payment_confirmation_deliveries.push({ id: `d-${id}`, payment_id: id, delivery_status: 'delivered' });
  }
  tables.transaction_followups.push(
    { id: randomUUID(), completion_key: 'payment:old', business_id: biz, phone, channel_id: 'channel', payment_id: oldPay,
      kind: 'ticketing', lang: 'en', state: 'card_active', updated_at: ago(3_600_000) },
    { id: randomUUID(), completion_key: 'payment:new', business_id: biz, phone, channel_id: 'channel', payment_id: newPay,
      kind: 'ticketing', lang: 'en', state: 'waiting_card', updated_at: ago(60_000) },
  );
  tables.payment_saved_card_offers.push({ id: 'offer-old', payment_id: oldPay, customer_phone: phone, business_id: biz,
    offer_type: 'replace', state: 'accepted', consent_source: 'provider_checkout',
    resolved_at: ago(4 * 3_600_000), activation_send_started_at: ago(4 * 3_600_000), activation_prompt_sent_at: ago(4 * 3_600_000),
    ...offer });
  const followup = (pay: string) => tables.transaction_followups.find(r => r.payment_id === pay)!;
  return { ...env, followup, offerRow: () => tables.payment_saved_card_offers[0] };
}

const pinSession = (step = 'replace_card_pin') => ({ id: 'pin', whatsapp_number: phone.slice(1), is_active: true, current_step: step });

beforeEach(() => {
  vi.clearAllMocks();
  m.buttons.mockResolvedValue({ messageId: 'wamid.menu' });
  m.eligibility.mockResolvedValue('already');
  m.stripe.mockResolvedValue('pending');
});

describe('#1070 abandoned accepted card step', () => {
  it('accepted offer, no PIN session, past grace: recovery releases the old follow-up and the new payment proceeds to its card step', async () => {
    const { db, followup, offerRow, writes } = stagingScenario();
    const before = { ...offerRow() };

    await recoverTransactionFollowups(db);

    // Old follow-up resolved through opt-in eligibility to its next-steps menu.
    expect(followup(oldPay).state).toBe('done');
    expect(m.buttons).toHaveBeenCalledTimes(1);
    // New payment claimed the conversation and its card step ran (Stripe consent check).
    expect(followup(newPay).state).toBe('card_active');
    expect(m.stripe).toHaveBeenCalledWith(db, newPay, phone, biz, expect.anything());
    // Offer, saved cards and payments untouched: the only writes are follow-up transitions/touches.
    expect(offerRow()).toEqual(before);
    expect(new Set(writes.map(w => w.table))).toEqual(new Set(['transaction_followups']));
  });

  it('webhook/resume path releases the follow-up with cardResolved and the new row then claims the chat', async () => {
    const { db, followup } = stagingScenario();
    await resumePaidTransactionFollowup(db, oldPay);
    expect(followup(oldPay).state).toBe('done');
    await resumePaidTransactionFollowup(db, newPay);
    expect(followup(newPay).state).toBe('card_active');
    expect(m.stripe).toHaveBeenCalledTimes(1);
  });

  it('Paystack WhatsApp-accepted offer (no provider consent) is released the same way', async () => {
    const { db, followup, tables } = stagingScenario({ consent_source: 'whatsapp', offer_type: 'save',
      activation_send_started_at: null, activation_prompt_sent_at: null });
    tables.payments.forEach(p => { p.gateway = 'paystack'; });
    m.paystackEligibility.mockResolvedValue({ eligible: true });
    await recoverTransactionFollowups(db);
    expect(followup(oldPay).state).toBe('done');
    expect(followup(newPay).state).toBe('card_active');
    expect(m.paystackOffer).toHaveBeenCalledWith(db, newPay, phone, biz, expect.anything(), 'channel');
  });

  it.each(['save_card_pin', 'replace_card_pin', 'verify_card_pin'])('accepted offer with an active %s session stays held', async step => {
    const { db, followup, tables } = stagingScenario();
    tables.bot_sessions.push(pinSession(step));
    await recoverTransactionFollowups(db);
    expect(followup(oldPay).state).toBe('card_active');
    expect(followup(newPay).state).toBe('waiting_card');
    expect(m.buttons).not.toHaveBeenCalled(); expect(m.stripe).not.toHaveBeenCalled();
  });

  it('an expired PIN session that was never closed does not hold the chat', async () => {
    const { db, followup, tables } = stagingScenario();
    tables.bot_sessions.push({ ...pinSession('save_card_pin'), expires_at: ago(60_000) });
    await resumePaidTransactionFollowup(db, oldPay);
    expect(followup(oldPay).state).toBe('done');
  });

  it('an unexpired PIN session still holds the chat', async () => {
    const { db, followup, tables } = stagingScenario();
    tables.bot_sessions.push({ ...pinSession('save_card_pin'), expires_at: new Date(Date.now() + 600_000).toISOString() });
    await recoverTransactionFollowups(db);
    expect(followup(oldPay).state).toBe('card_active');
    expect(followup(newPay).state).toBe('waiting_card');
  });

  it('staging: saved-card payment gets its next-steps menu despite an expired PIN chat at another business', async () => {
    // TestBiz order paid with a saved own-account Paystack card; this morning's
    // BalaShop save_card_pin session expired but stayed is_active.
    const env = database();
    const { db, tables } = env;
    tables.payments.push({ id: newPay, business_id: biz, status: 'success', gateway: 'paystack', confirmation_sent_at: ago(60_000),
      amount: 5000, booking_id: null, metadata: { payment_origin: 'byo', saved_method: true } });
    tables.payment_confirmation_deliveries.push({ id: 'd-new', payment_id: newPay, delivery_status: 'delivered' });
    tables.transaction_followups.push({ id: randomUUID(), completion_key: 'payment:new', business_id: biz, phone, channel_id: 'channel',
      payment_id: newPay, kind: 'ordering', lang: 'en', state: 'waiting_card', updated_at: ago(60_000) });
    tables.bot_sessions.push({ id: 'old-pin', business_id: 'another-business', whatsapp_number: phone.slice(1), is_active: true,
      current_step: 'save_card_pin', expires_at: ago(18 * 3_600_000) });
    m.paystackEligibility.mockResolvedValue({ eligible: false, reason: 'same_auth_already_saved' });
    await recoverTransactionFollowups(db);
    expect(m.buttons).toHaveBeenCalledTimes(1);
    expect(m.buttons.mock.calls[0][0].buttons.map((b: { id: string }) => b.id)).toEqual(['my orders', 'menu']);
    expect(tables.transaction_followups[0].state).not.toBe('waiting_card');
  });

  it('an inactive PIN session does not hold the chat', async () => {
    const { db, followup, tables } = stagingScenario();
    tables.bot_sessions.push({ ...pinSession(), is_active: false });
    await resumePaidTransactionFollowup(db, oldPay);
    expect(followup(oldPay).state).toBe('done');
  });

  it('accepted within the grace window stays held (accept is about to open the PIN session)', async () => {
    const recent = ago(ABANDONED_CARD_STEP_GRACE_MS - 30_000);
    const { db, followup } = stagingScenario({ resolved_at: recent, activation_send_started_at: recent, activation_prompt_sent_at: recent });
    await recoverTransactionFollowups(db);
    expect(followup(oldPay).state).toBe('card_active');
    expect(followup(newPay).state).toBe('waiting_card');
  });

  it('grace counts from the latest activation step, not only the accept time', async () => {
    const { db, followup } = stagingScenario({ resolved_at: ago(3_600_000), activation_send_started_at: ago(60_000), activation_prompt_sent_at: null });
    await resumePaidTransactionFollowup(db, oldPay);
    expect(followup(oldPay).state).toBe('card_active');
  });

  it('Stripe Checkout consent whose activation prompt was never started stays held for the activation worker', async () => {
    const { db, followup } = stagingScenario({ activation_send_started_at: null, activation_prompt_sent_at: null });
    await resumePaidTransactionFollowup(db, oldPay);
    expect(followup(oldPay).state).toBe('card_active');
  });

  it('accepted offer without an accept timestamp stays held', async () => {
    const { db, followup } = stagingScenario({ consent_source: 'whatsapp', resolved_at: null, activation_send_started_at: null, activation_prompt_sent_at: null });
    await resumePaidTransactionFollowup(db, oldPay);
    expect(followup(oldPay).state).toBe('card_active');
  });

  it.each(['sent', 'ambiguous', 'committed'])('old %s offer behaviour is unchanged on the resume path (still holds)', async state => {
    const { db, followup } = stagingScenario({ state });
    await recoverTransactionFollowups(db);
    expect(followup(oldPay).state).toBe('card_active');
    expect(followup(newPay).state).toBe('waiting_card');
  });

  it('confirmed offer still releases as before', async () => {
    const { db, followup } = stagingScenario({ state: 'confirmed' });
    await resumePaidTransactionFollowup(db, oldPay);
    expect(followup(oldPay).state).toBe('done');
  });

  describe('explicit navigation (hi/menu)', () => {
    it('retires an abandoned accepted step without declining or changing the offer', async () => {
      const { db, followup, offerRow, rpc } = stagingScenario();
      await dismissTransactionFollowups(db, { from: phone, channelId: 'channel' });
      expect(followup(oldPay).state).toBe('done');
      expect(rpc).not.toHaveBeenCalled();
      expect(offerRow().state).toBe('accepted');
      expect(m.buttons).not.toHaveBeenCalled(); // navigation shows its own menu
    });

    it('keeps an accepted step with an active PIN session', async () => {
      const { db, followup, tables, rpc } = stagingScenario();
      tables.bot_sessions.push(pinSession());
      await dismissTransactionFollowups(db, { from: phone, channelId: 'channel' });
      expect(followup(oldPay).state).toBe('card_active');
      expect(rpc).not.toHaveBeenCalled();
    });

    it('keeps an accepted step within grace', async () => {
      const recent = ago(10_000);
      const { db, followup } = stagingScenario({ resolved_at: recent, activation_send_started_at: recent, activation_prompt_sent_at: recent });
      await dismissTransactionFollowups(db, { from: phone, channelId: 'channel' });
      expect(followup(oldPay).state).toBe('card_active');
    });

    it('keeps a committed step', async () => {
      const { db, followup, rpc } = stagingScenario({ state: 'committed' });
      await dismissTransactionFollowups(db, { from: phone, channelId: 'channel' });
      expect(followup(oldPay).state).toBe('card_active');
      expect(rpc).not.toHaveBeenCalled();
    });
  });
});

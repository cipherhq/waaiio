/**
 * SMS as a real channel (#1131, Owner decisions 2026-11-18): page counting,
 * pricing (cost x 1.2), NG/GH-only and same-country rules, quiet hours, the
 * BulkSMS v2 client, charge-on-acceptance / release-on-failure, opt-out and
 * suspension skips, idempotency, and Waaiio-paid admin sends.
 *
 * The database side (reserve x units, ceil(cost x 1.2), refusals) is proven
 * against real PostgreSQL in sms-billing-551-db.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  sendSms: vi.fn(),
  configured: vi.fn(() => true),
  blocksMarketing: vi.fn(async () => false),
  blocksReminder: vi.fn(async () => false),
  assertAllowed: vi.fn(async () => undefined),
  permission: vi.fn(async () => true),
}));

vi.mock('@/lib/sms/bulksms-ng', async (orig) => ({
  ...(await orig<object>()),
  sendSms: m.sendSms,
  isSmsConfigured: m.configured,
}));
vi.mock('@/lib/customer-suspension', async (orig) => ({
  ...(await orig<object>()),
  blocksMarketing: m.blocksMarketing,
  blocksReminder: m.blocksReminder,
}));
vi.mock('@/lib/channels/send-guard', () => ({ assertMessagingAllowed: m.assertAllowed }));
vi.mock('@/lib/merchants/recipient-permission', () => ({ hasRecipientPermission: m.permission }));

import { countSmsSegments, prepareSmsText } from '@/lib/sms/segments';
import { isQuietHours, smsPricePerPage, smsRateFromPricing, smsRecipient } from '@/lib/sms/pricing';
import { sendBusinessSms, sendPlatformSms } from '@/lib/sms/send';
import { deliverSmsBroadcast } from '@/lib/admin-broadcast/sms';
import { estimateSmsCampaign, sendSmsCampaign } from '@/lib/sms/campaign';

// ── A small in-memory Supabase double ──

type Row = Record<string, unknown>;
function fakeDb(opts: {
  country?: string | null;
  optOuts?: number;
  auth?: Row | null;
  authError?: boolean;
  /** Successive check_or_authorize_send answers (then `auth`). */
  authSequence?: Row[];
  pricing?: Row;
  /** financial_disposition read back after an authorization error (undefined = read fails). */
  disposition?: string;
} = {}) {
  const state = {
    smsSends: [] as Row[],
    attempts: [] as Row[],
    attemptUpdates: [] as Row[],
    broadcastRecipients: [] as Row[],
    rpc: [] as Array<{ name: string; args: Row }>,
  };
  const db = {
    rpc: vi.fn(async (name: string, args: Row) => {
      state.rpc.push({ name, args });
      if (name === 'check_or_authorize_send') {
        if (opts.authError) return { data: null, error: { message: 'boom' } };
        if (opts.authSequence?.length) return { data: opts.authSequence.shift(), error: null };
        return { data: opts.auth === undefined ? { authorized: true, cost_minor: 838, currency_code: 'NGN' } : opts.auth, error: null };
      }
      if (name === 'settle_message_cost') return { data: { settled: true }, error: null };
      return { data: null, error: null };
    }),
    from(table: string) {
      const q: { op: string; payload?: Row; filters: Row } = { op: 'select', filters: {} };
      const builder: Record<string, unknown> = {};
      const chain = (fn?: (...a: unknown[]) => void) => (...a: unknown[]) => { fn?.(...a); return builder; };
      Object.assign(builder, {
        select: chain(),
        insert: chain((p) => { q.op = 'insert'; q.payload = p as Row; }),
        update: chain((p) => { q.op = 'update'; q.payload = p as Row; }),
        upsert: chain((p) => { q.op = 'upsert'; q.payload = p as Row; }),
        eq: chain((k, v) => { q.filters[k as string] = v; }),
        in: chain(), is: chain(), order: chain(), limit: chain(), lte: chain(),
        single: () => run(),
        maybeSingle: () => run(),
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => run().then(resolve, reject),
      });
      async function run(): Promise<{ data: unknown; error: unknown; count?: number }> {
        if (table === 'businesses') return { data: { country_code: opts.country === undefined ? 'NG' : opts.country }, error: null };
        if (table === 'messaging_opt_outs') return { data: null, error: null, count: opts.optOuts ?? 0 };
        if (table === 'sms_sends') {
          if (q.op === 'insert') {
            if (state.smsSends.some(r => r.idempotency_key === q.payload!.idempotency_key)) return { data: null, error: { code: '23505' } };
            const row = { id: `send-${state.smsSends.length + 1}`, ...q.payload };
            state.smsSends.push(row);
            return { data: { id: row.id }, error: null };
          }
          if (q.op === 'update') {
            const rows = state.smsSends.filter(r => Object.entries(q.filters).every(([k, v]) => r[k] === v));
            for (const row of rows) Object.assign(row, q.payload);
            return { data: rows.map(r => ({ id: r.id })), error: null };
          }
          return { data: state.smsSends.find(r => r.idempotency_key === q.filters.idempotency_key) ?? null, error: null };
        }
        if (table === 'message_send_attempts') {
          if (q.op === 'insert') {
            const row = { id: `attempt-${state.attempts.length + 1}`, ...q.payload };
            state.attempts.push(row);
            return { data: { id: row.id }, error: null };
          }
          if (q.op === 'select') {
            return opts.disposition ? { data: { financial_disposition: opts.disposition }, error: null } : { data: null, error: { message: 'down' } };
          }
          state.attemptUpdates.push({ ...q.payload, id: q.filters.id });
          return { data: null, error: null };
        }
        if (table === 'platform_config_versions') {
          return { data: { config_snapshot: { messaging_pricing: opts.pricing ?? { NGN: { rates: { NG: { sms_cost: 698 } } } } } }, error: null };
        }
        if (table === 'admin_broadcast_recipients') {
          if (q.op === 'upsert') {
            if (state.broadcastRecipients.some(r => r.phone === q.payload!.phone)) return { data: [], error: null };
            state.broadcastRecipients.push({ ...q.payload });
            return { data: [{ id: 'r' }], error: null };
          }
          const row = state.broadcastRecipients.find(r => r.phone === q.filters.phone);
          if (row) Object.assign(row, q.payload);
          return { data: null, error: null };
        }
        return { data: null, error: null };
      }
      return builder;
    },
  };
  return { db: db as never, state };
}

const NOON_UTC = new Date('2026-11-18T12:00:00Z');
const NG_PHONE = '2348031234567';
const base = { businessId: 'biz-1', phone: NG_PHONE, text: 'Hello from the shop', purpose: 'campaign' as const, now: NOON_UTC };

beforeEach(() => {
  vi.clearAllMocks();
  m.configured.mockReturnValue(true);
  m.blocksMarketing.mockResolvedValue(false);
  m.blocksReminder.mockResolvedValue(false);
  m.sendSms.mockResolvedValue({ sent: true, messageId: 'bsng-1', cost: 6.49, pages: 1 });
  m.permission.mockResolvedValue(true);
  m.assertAllowed.mockResolvedValue(undefined);
});

describe('page counting', () => {
  it('plain text: 160 characters is one page, then 153 per page', () => {
    expect(countSmsSegments('a'.repeat(160))).toMatchObject({ unicode: false, pages: 1, perPage: 160 });
    expect(countSmsSegments('a'.repeat(161)).pages).toBe(2);
    expect(countSmsSegments('a'.repeat(306)).pages).toBe(2);
    expect(countSmsSegments('a'.repeat(307)).pages).toBe(3);
  });

  it('Yoruba accents need Unicode: 70 characters for one page, then 67', () => {
    const yo = 'Ẹ ku ọjọ́ ìbí';
    expect(countSmsSegments(yo)).toMatchObject({ unicode: true, pages: 1, perPage: 70 });
    expect(countSmsSegments(`ẹ${'a'.repeat(69)}`).pages).toBe(1);
    expect(countSmsSegments(`ẹ${'a'.repeat(70)}`).pages).toBe(2);
    expect(countSmsSegments(`ẹ${'a'.repeat(134)}`).pages).toBe(3);
  });

  it('USSD codes, links and stray symbols are sent exactly as typed; only WhatsApp marker pairs are removed', () => {
    expect(prepareSmsText('Pay with *737*1*5000#')).toBe('Pay with *737*1*5000#');
    expect(prepareSmsText('Shop: https://x.co/p?utm_source=wa&my_shop=1')).toBe('Shop: https://x.co/p?utm_source=wa&my_shop=1');
    expect(prepareSmsText('5 * 3 = 15, a_b')).toBe('5 * 3 = 15, a_b');
    expect(prepareSmsText('*Big sale* and _today_ only.')).toBe('Big sale and today only.');
  });

  it('Waaiio-written texts drop decorative emoji (plain SMS); accents always stay', () => {
    const reminder = '⏰ *Reminder*\nParty 🎉 📅 Sat\n📍 Lekki\nSee you there! 🙏';
    expect(prepareSmsText(reminder, { stripEmoji: true })).toBe('Reminder\nParty Sat\nLekki\nSee you there!');
    expect(countSmsSegments(reminder, { stripEmoji: true }).unicode).toBe(false);
    expect(countSmsSegments(reminder).unicode).toBe(true); // a merchant's own emoji are kept
    expect(prepareSmsText('Ẹ ku ọjọ́ ìbí 🎂', { stripEmoji: true })).toBe('Ẹ ku ọjọ́ ìbí');
  });

  it('curly quotes and dashes never force Unicode; WhatsApp markers are removed', () => {
    expect(prepareSmsText('*Sale* – don’t miss “it”…')).toBe('Sale - don\'t miss "it"...');
    expect(countSmsSegments('Don’t miss it – today').unicode).toBe(false);
  });

  it('GSM extension characters count twice; emoji count twice in Unicode', () => {
    expect(countSmsSegments('€'.repeat(80)).characters).toBe(160);
    expect(countSmsSegments('€'.repeat(81)).pages).toBe(2);
    expect(countSmsSegments('🎉').characters).toBe(2);
  });
});

describe('pricing, countries and quiet hours', () => {
  it('merchant price per page is the cost x 1.2, rounded up', () => {
    expect(smsPricePerPage(698)).toBe(838); // ₦6.98 → ₦8.38
    expect(smsPricePerPage(50)).toBe(60);
    expect(smsPricePerPage(1)).toBe(2);
  });

  it('reads sms_cost only, never falls back to WhatsApp rates', () => {
    const pricing = { NGN: { rates: { NG: { marketing: 800, '*': 500, sms_cost: 698 } } }, GHS: { rates: { GH: { '*': 50 } } } };
    expect(smsRateFromPricing(pricing, 'NG')).toEqual({ currency: 'NGN', costMinor: 698, priceMinor: 838 });
    expect(smsRateFromPricing(pricing, 'GH')).toBeNull();
    expect(smsRateFromPricing(pricing, 'US')).toBeNull();
  });

  it('only Nigerian and Ghanaian numbers are SMS recipients', () => {
    expect(smsRecipient('08031234567', 'NG')).toEqual({ phone: NG_PHONE, country: 'NG' });
    expect(smsRecipient('+233201234567')).toEqual({ phone: '233201234567', country: 'GH' });
    expect(smsRecipient('+14155550100')).toBeNull();
    expect(smsRecipient('+447700900123')).toBeNull();
  });

  it('quiet hours are 20:00-08:00 local time (Nigeria UTC+1, Ghana UTC+0)', () => {
    expect(isQuietHours('NG', new Date('2026-11-18T19:00:00Z'))).toBe(true); // 20:00 WAT
    expect(isQuietHours('NG', new Date('2026-11-18T18:59:00Z'))).toBe(false);
    expect(isQuietHours('NG', new Date('2026-11-18T07:00:00Z'))).toBe(false); // 08:00 WAT
    expect(isQuietHours('GH', new Date('2026-11-18T19:30:00Z'))).toBe(false);
    expect(isQuietHours('GH', new Date('2026-11-18T07:59:00Z'))).toBe(true);
  });
});

describe('sendBusinessSms (charged to messaging credit)', () => {
  it('charges only when BulkSMS accepts: reserve units = pages, then settle charged', async () => {
    const { db, state } = fakeDb();
    const text = 'a'.repeat(200); // 2 pages
    const out = await sendBusinessSms(db, { ...base, text, idempotencyKey: 'campaign:r1:2348031234567' });
    expect(out).toEqual({ status: 'sent', pages: 2, priceMinor: 838, currency: 'NGN' });
    expect(state.attempts[0]).toMatchObject({ message_category: 'sms', units: 2, recipient_country_code: 'NG', attempt_scope: 'business', business_id: 'biz-1' });
    expect(state.rpc.map(r => r.name)).toEqual(['check_or_authorize_send', 'settle_message_cost']);
    expect(state.rpc[1].args).toEqual({ p_attempt_id: 'attempt-1', p_outcome: 'charged' });
    expect(m.sendSms).toHaveBeenCalledWith(expect.objectContaining({ to: NG_PHONE, unicode: false }));
    expect(state.smsSends[0]).toMatchObject({ status: 'accepted', provider_message_id: 'bsng-1', price_minor: 838, pages: 2 });
  });

  it('sends Unicode when the text needs it', async () => {
    const { db } = fakeDb();
    await sendBusinessSms(db, { ...base, text: 'Ẹ ku àbọ̀', idempotencyKey: 'k-unicode-1' });
    expect(m.sendSms).toHaveBeenCalledWith(expect.objectContaining({ unicode: true }));
  });

  it('releases the reservation when BulkSMS refuses', async () => {
    m.sendSms.mockResolvedValue({ sent: false, error: 'SMS refused (BSNG-2002)' });
    const { db, state } = fakeDb();
    const out = await sendBusinessSms(db, { ...base, idempotencyKey: 'k-refused-1' });
    expect(out.status).toBe('failed');
    expect(state.rpc[1].args).toEqual({ p_attempt_id: 'attempt-1', p_outcome: 'released' });
    expect(state.smsSends[0].status).toBe('failed');
  });

  it('a sender name BulkSMS has not approved (pending/unregistered) fails cleanly: recorded, released, not charged', async () => {
    m.sendSms.mockResolvedValue({ sent: false, error: 'SMS refused (BSNG-2004)' });
    const { db, state } = fakeDb();
    const out = await sendBusinessSms(db, { ...base, idempotencyKey: 'k-pending-sender' });
    expect(out).toEqual({ status: 'failed', reason: 'SMS refused (BSNG-2004)' });
    expect(state.rpc.map(r => r.name)).toEqual(['check_or_authorize_send', 'settle_message_cost']);
    expect(state.rpc[1].args).toEqual({ p_attempt_id: 'attempt-1', p_outcome: 'released' });
    expect(state.attemptUpdates).toContainEqual(expect.objectContaining({ status: 'failed_send' }));
    expect(state.smsSends[0]).toMatchObject({ status: 'failed', error: 'SMS refused (BSNG-2004)' });
  });

  it('an unknown provider outcome is released (not charged) and flagged for review', async () => {
    m.sendSms.mockResolvedValue({ sent: false, ambiguous: true, error: 'SMS provider did not answer' });
    const { db, state } = fakeDb();
    expect(await sendBusinessSms(db, { ...base, idempotencyKey: 'k-amb-1' })).toEqual({ status: 'unknown' });
    expect(state.rpc[1].args.p_outcome).toBe('released');
    expect(state.attemptUpdates).toContainEqual(expect.objectContaining({ status: 'ambiguous', needs_reconciliation: true }));
    expect(state.smsSends[0].status).toBe('unknown');
  });

  it('short credit skips the SMS: nothing sent, nothing settled', async () => {
    const { db, state } = fakeDb({ auth: { authorized: false, reason: 'insufficient_allowance_balance' } });
    expect(await sendBusinessSms(db, { ...base, idempotencyKey: 'k-poor-1' })).toEqual({ status: 'skipped', reason: 'insufficient_credit' });
    expect(m.sendSms).not.toHaveBeenCalled();
    expect(state.rpc.map(r => r.name)).toEqual(['check_or_authorize_send']);
  });

  it('refuses while the financial gate is off, so Waaiio never pays for a merchant SMS', async () => {
    const { db } = fakeDb({ auth: { enforcement_required: false, reason: 'gate_off' } });
    expect(await sendBusinessSms(db, { ...base, idempotencyKey: 'k-gate-1' })).toEqual({ status: 'skipped', reason: 'not_authorized' });
    expect(m.sendSms).not.toHaveBeenCalled();
  });

  it('an authorization error never sends; a reservation that committed anyway is released at once', async () => {
    const reserved = fakeDb({ authError: true, disposition: 'reserved' });
    expect(await sendBusinessSms(reserved.db, { ...base, idempotencyKey: 'k-auth-err' })).toEqual({ status: 'skipped', reason: 'not_authorized' });
    expect(reserved.state.rpc.map(r => r.name)).toEqual(['check_or_authorize_send', 'settle_message_cost']);
    expect(reserved.state.rpc[1].args.p_outcome).toBe('released');
    expect(reserved.state.smsSends[0].status).toBe('failed');

    const none = fakeDb({ authError: true, disposition: 'pending_authorization' });
    await sendBusinessSms(none.db, { ...base, idempotencyKey: 'k-auth-err-2' });
    expect(none.state.rpc.map(r => r.name)).toEqual(['check_or_authorize_send']);

    // Cannot tell: the attempt stays pending for the expiry job, and the key is never re-sent.
    const unknown = fakeDb({ authError: true });
    await sendBusinessSms(unknown.db, { ...base, idempotencyKey: 'k-auth-err-3' });
    expect(unknown.state.attemptUpdates).not.toContainEqual(expect.objectContaining({ status: 'failed_send' }));
    expect(unknown.state.smsSends[0].status).toBe('unknown');
    expect(await sendBusinessSms(unknown.db, { ...base, idempotencyKey: 'k-auth-err-3' })).toEqual({ status: 'duplicate', previous: 'unknown' });
    expect(m.sendSms).not.toHaveBeenCalled();
  });

  it('skips opted-out customers for campaigns and invites', async () => {
    const { db, state } = fakeDb({ optOuts: 1 });
    expect(await sendBusinessSms(db, { ...base, idempotencyKey: 'k-opt-1' })).toEqual({ status: 'skipped', reason: 'opted_out' });
    expect(await sendBusinessSms(db, { ...base, purpose: 'invite', idempotencyKey: 'k-opt-2' })).toEqual({ status: 'skipped', reason: 'opted_out' });
    expect(state.smsSends).toHaveLength(0);
    expect(m.sendSms).not.toHaveBeenCalled();
  });

  it('skips suspended customers (marketing check for campaigns, reminder check for reminders)', async () => {
    m.blocksMarketing.mockResolvedValue(true);
    m.blocksReminder.mockResolvedValue(true);
    const { db } = fakeDb();
    expect(await sendBusinessSms(db, { ...base, idempotencyKey: 'k-sus-1' })).toEqual({ status: 'skipped', reason: 'suspended' });
    expect(await sendBusinessSms(db, { ...base, purpose: 'reminder', idempotencyKey: 'k-sus-2' })).toEqual({ status: 'skipped', reason: 'suspended' });
    expect(m.sendSms).not.toHaveBeenCalled();
  });

  it('NG/GH only, and only to numbers in the business country', async () => {
    const ng = fakeDb();
    expect(await sendBusinessSms(ng.db, { ...base, phone: '+233201234567', idempotencyKey: 'k-c1' })).toEqual({ status: 'skipped', reason: 'other_country' });
    expect(await sendBusinessSms(ng.db, { ...base, phone: '+14155550100', idempotencyKey: 'k-c2' })).toEqual({ status: 'skipped', reason: 'not_sms_number' });
    const us = fakeDb({ country: 'US' });
    expect(await sendBusinessSms(us.db, { ...base, idempotencyKey: 'k-c3' })).toEqual({ status: 'skipped', reason: 'business_not_eligible' });
    const gh = fakeDb({ country: 'GH' });
    expect((await sendBusinessSms(gh.db, { ...base, phone: '0201234567', idempotencyKey: 'k-c4' })).status).toBe('sent');
    expect(m.sendSms).toHaveBeenCalledTimes(1);
  });

  it('campaigns wait for 8am; reminders still go at night', async () => {
    const night = new Date('2026-11-18T21:00:00Z'); // 22:00 WAT
    const { db } = fakeDb();
    expect(await sendBusinessSms(db, { ...base, now: night, idempotencyKey: 'k-q1' })).toEqual({ status: 'skipped', reason: 'quiet_hours' });
    expect((await sendBusinessSms(db, { ...base, purpose: 'reminder', now: night, idempotencyKey: 'k-q2' })).status).toBe('sent');
  });

  it('one SMS per idempotency key: a retry never sends or charges twice', async () => {
    const { db, state } = fakeDb();
    await sendBusinessSms(db, { ...base, idempotencyKey: 'campaign:r2:2348031234567' });
    const again = await sendBusinessSms(db, { ...base, idempotencyKey: 'campaign:r2:2348031234567' });
    expect(again).toEqual({ status: 'duplicate', previous: 'accepted' });
    expect(m.sendSms).toHaveBeenCalledTimes(1);
    expect(state.rpc.filter(r => r.name === 'settle_message_cost')).toHaveLength(1);
  });

  it('a key whose earlier try was refused can be sent again (top up, send again); nothing is texted twice', async () => {
    const { db, state } = fakeDb({ authSequence: [{ authorized: false, reason: 'insufficient_allowance_balance' }] });
    const key = 'campaign:r3:2348031234567';
    expect(await sendBusinessSms(db, { ...base, idempotencyKey: key })).toEqual({ status: 'skipped', reason: 'insufficient_credit' });
    expect(state.smsSends[0].status).toBe('failed');
    expect((await sendBusinessSms(db, { ...base, idempotencyKey: key })).status).toBe('sent');
    expect(state.smsSends).toHaveLength(1);
    expect(state.smsSends[0]).toMatchObject({ status: 'accepted', attempt_id: 'attempt-2' });
    expect(await sendBusinessSms(db, { ...base, idempotencyKey: key })).toEqual({ status: 'duplicate', previous: 'accepted' });
    expect(m.sendSms).toHaveBeenCalledTimes(1);
  });

  it('a key with an unknown outcome is never sent again', async () => {
    m.sendSms.mockResolvedValueOnce({ sent: false, ambiguous: true });
    const { db } = fakeDb();
    await sendBusinessSms(db, { ...base, idempotencyKey: 'k-unknown-again' });
    expect(await sendBusinessSms(db, { ...base, idempotencyKey: 'k-unknown-again' })).toEqual({ status: 'duplicate', previous: 'unknown' });
    expect(m.sendSms).toHaveBeenCalledTimes(1);
  });

  it('a business whose messaging is paused is skipped before anything is reserved or sent', async () => {
    m.assertAllowed.mockRejectedValue(new Error('suspended'));
    const { db, state } = fakeDb();
    expect(await sendBusinessSms(db, { ...base, idempotencyKey: 'k-biz-sus' })).toEqual({ status: 'skipped', reason: 'business_suspended' });
    expect(state.rpc).toHaveLength(0);
    expect(m.sendSms).not.toHaveBeenCalled();
  });

  it('reminders are sent without decorative emoji (plain SMS, fewer pages)', async () => {
    const { db } = fakeDb();
    await sendBusinessSms(db, { ...base, purpose: 'reminder', text: 'See you tomorrow at Shop 🙏', idempotencyKey: 'k-emoji' });
    expect(m.sendSms).toHaveBeenCalledWith(expect.objectContaining({ message: 'See you tomorrow at Shop', unicode: false }));
  });

  it('SMS stays off until a registered sender name is configured', async () => {
    m.configured.mockReturnValue(false);
    const { db, state } = fakeDb();
    expect(await sendBusinessSms(db, { ...base, idempotencyKey: 'k-off' })).toEqual({ status: 'skipped', reason: 'not_configured' });
    expect(state.rpc).toHaveLength(0);
  });

  it('refuses a message longer than 10 pages', async () => {
    const { db } = fakeDb();
    expect(await sendBusinessSms(db, { ...base, text: 'a'.repeat(1531), idempotencyKey: 'k-long' })).toEqual({ status: 'skipped', reason: 'too_long' });
  });
});

describe('merchant SMS campaigns: estimate and send', () => {
  it('estimate: pages x price per page x recipients in the business country only', async () => {
    const { db } = fakeDb();
    const e = await estimateSmsCampaign(db, { businessCountry: 'NG', phones: ['08031234567', '+2348039999999', '+233201234567', '+14155550100'], message: 'a'.repeat(200), now: NOON_UTC });
    expect(e).toMatchObject({ available: true, pages: 2, unicode: false, currency: 'NGN', pricePerPageMinor: 838, recipients: 2, notSmsNumbers: 2, totalMinor: 3352, quietHoursNow: false });
  });

  it('estimate: refuses unsupported countries, missing prices and a switched-off channel', async () => {
    expect(await estimateSmsCampaign(fakeDb().db, { businessCountry: 'US', phones: [], message: 'x' })).toMatchObject({ available: false, problem: 'country_not_supported' });
    expect(await estimateSmsCampaign(fakeDb({ pricing: { NGN: { rates: { NG: { '*': 500 } } } } }).db, { businessCountry: 'NG', phones: [], message: 'x' }))
      .toMatchObject({ available: false, problem: 'not_priced' });
    m.configured.mockReturnValue(false);
    expect(await estimateSmsCampaign(fakeDb().db, { businessCountry: 'NG', phones: [], message: 'x' })).toMatchObject({ available: false, problem: 'not_configured' });
  });

  it('send: needs SMS or WhatsApp marketing consent, dedupes numbers, sums the charge', async () => {
    m.permission.mockImplementation((async (_db: unknown, _b: unknown, phone: string, _p: unknown, channel: string) =>
      phone === '2348031234567' ? channel === 'whatsapp' : phone === '2348032222222' ? channel === 'sms' : false) as never);
    const { db } = fakeDb();
    const r = await sendSmsCampaign(db, { businessId: 'biz-1', businessCountry: 'NG', requestId: 'r9', phones: ['08031234567', '+2348031234567', '08032222222', '08033333333'], message: 'Sale', now: NOON_UTC });
    expect(r).toMatchObject({ sent: 2, chargedMinor: 1676, currency: 'NGN', skipped: { no_consent: 1 } });
    expect(m.sendSms).toHaveBeenCalledTimes(2);
  });

  it('send: stops when credit runs out and counts the rest as not attempted; sending again reaches only them', async () => {
    const { db } = fakeDb({ authSequence: [{ authorized: true, cost_minor: 838, currency_code: 'NGN' }, { authorized: false, reason: 'insufficient_allowance_balance' }] });
    const phones = ['08031111111', '08032222222', '08033333333', '08034444444'];
    const first = await sendSmsCampaign(db, { businessId: 'biz-1', businessCountry: 'NG', requestId: 'r10', phones, message: 'Sale', now: NOON_UTC });
    expect(first).toMatchObject({ sent: 1, skipped: { insufficient_credit: 1, not_attempted: 2 } });
    const again = await sendSmsCampaign(db, { businessId: 'biz-1', businessCountry: 'NG', requestId: 'r10', phones, message: 'Sale', now: NOON_UTC });
    expect(again).toMatchObject({ sent: 3, alreadySent: 1 });
    expect(m.sendSms).toHaveBeenCalledTimes(4);
  });
});

describe('Waaiio-paid admin SMS never touches merchant credit', () => {
  it('sendPlatformSms makes no attempt, reservation or settlement', async () => {
    const { db, state } = fakeDb();
    expect((await sendPlatformSms(db, { phone: NG_PHONE, text: 'Hi from Waaiio', idempotencyKey: 'admin-broadcast:b1:2348031234567' })).status).toBe('sent');
    expect(state.rpc).toHaveLength(0);
    expect(state.attempts).toHaveLength(0);
    expect(state.smsSends[0]).toMatchObject({ scope: 'platform', business_id: null, purpose: 'admin_broadcast', status: 'accepted' });
  });

  it('deliverSmsBroadcast skips opted-out and suspended numbers, sends each number once, charges nobody', async () => {
    const { db, state } = fakeDb();
    const checks = new Map([[NG_PHONE, 'ok' as const], ['233201234567', 'opted_out' as const], ['2348039999999', 'suspended' as const]]);
    const summary = await deliverSmsBroadcast(db, { broadcastId: 'b1', phones: [...checks.keys()], checks, message: 'Hi', intervalMs: 0 });
    expect(summary).toMatchObject({ sent: 1, skippedOptedOut: 1, skippedSuspended: 1, failed: 0 });
    const replay = await deliverSmsBroadcast(db, { broadcastId: 'b1', phones: [NG_PHONE], checks, message: 'Hi', intervalMs: 0 });
    expect(replay.sent).toBe(0);
    expect(m.sendSms).toHaveBeenCalledTimes(1);
    expect(state.rpc).toHaveLength(0);
  });
});

describe('BulkSMS v2 client', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; vi.unstubAllEnvs(); });

  async function client() {
    const real = await vi.importActual<typeof import('@/lib/sms/bulksms-ng')>('@/lib/sms/bulksms-ng');
    return real;
  }

  it('without a sender name nothing is sent', async () => {
    vi.stubEnv('BULKSMS_NG_API_TOKEN', 'test-token');
    vi.stubEnv('BULKSMS_SENDER_ID', '');
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as never;
    const { sendSms, isSmsConfigured } = await client();
    expect(isSmsConfigured()).toBe(false);
    expect(await sendSms({ to: NG_PHONE, message: 'x' })).toMatchObject({ sent: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never uses the TICKETRACK sender name for Waaiio traffic; WAAIIO is accepted', async () => {
    vi.stubEnv('BULKSMS_NG_API_TOKEN', 'test-token');
    const { isSmsConfigured, smsSenderId } = await client();
    vi.stubEnv('BULKSMS_SENDER_ID', 'TICKETRACK');
    expect(smsSenderId()).toBeNull();
    expect(isSmsConfigured()).toBe(false);
    vi.stubEnv('BULKSMS_SENDER_ID', 'WAAIIO');
    expect(smsSenderId()).toBe('WAAIIO');
  });

  it('a pending or unregistered sender name refused by BulkSMS is a definite failure, not ambiguous', async () => {
    vi.stubEnv('BULKSMS_NG_API_TOKEN', 'test-token');
    vi.stubEnv('BULKSMS_SENDER_ID', 'WAAIIO');
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      status: 'error', code: 'BSNG-2004', error: { message: 'Sender ID not approved', code: 'BSNG-2004' },
    }), { status: 422 })) as never;
    const { sendSms } = await client();
    const result = await sendSms({ to: NG_PHONE, message: 'x' });
    expect(result).toEqual({ sent: false, error: 'SMS refused (BSNG-2004)' });
    expect(result.ambiguous).toBeUndefined();
  });

  it('posts to the sandbox v2 endpoint with the sender name and Unicode flag, and reads cost/pages', async () => {
    vi.stubEnv('BULKSMS_NG_API_TOKEN', 'test-token');
    vi.stubEnv('BULKSMS_SENDER_ID', 'Waaiio');
    vi.stubEnv('BULKSMS_NG_SANDBOX', 'true');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      status: 'success', code: 'BSNG-0000', data: { message_id: 'm-1', cost: 6.49, page_count: 1 },
    }), { status: 200 }));
    globalThis.fetch = fetchMock as never;
    const { sendSms } = await client();
    expect(await sendSms({ to: NG_PHONE, message: 'Ẹ ku', unicode: true, reference: 'send-1' }))
      .toEqual({ sent: true, messageId: 'm-1', cost: 6.49, pages: 1 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://www.bulksmsnigeria.com/api/sandbox/v2/sms');
    expect(JSON.parse(init.body as string)).toEqual({ from: 'Waaiio', to: NG_PHONE, body: 'Ẹ ku', unicode: true, customer_reference: 'send-1' });
  });

  it('a 4xx refusal is a definite failure; 5xx and network errors are ambiguous', async () => {
    vi.stubEnv('BULKSMS_NG_API_TOKEN', 'test-token');
    vi.stubEnv('BULKSMS_SENDER_ID', 'Waaiio');
    const { sendSms } = await client();
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ status: 'error', code: 'BSNG-2012' }), { status: 409 })) as never;
    expect(await sendSms({ to: NG_PHONE, message: 'x' })).toEqual({ sent: false, error: 'SMS refused (BSNG-2012)' });
    globalThis.fetch = vi.fn(async () => new Response('oops', { status: 502 })) as never;
    expect(await sendSms({ to: NG_PHONE, message: 'x' })).toMatchObject({ sent: false, ambiguous: true });
    globalThis.fetch = vi.fn(async () => { throw new TypeError('fetch failed'); }) as never;
    expect(await sendSms({ to: NG_PHONE, message: 'x' })).toMatchObject({ sent: false, ambiguous: true });
  });

  it('refuses numbers outside Nigeria and Ghana', async () => {
    vi.stubEnv('BULKSMS_NG_API_TOKEN', 'test-token');
    vi.stubEnv('BULKSMS_SENDER_ID', 'Waaiio');
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as never;
    const { sendSms } = await client();
    expect(await sendSms({ to: '14155550100', message: 'x' })).toMatchObject({ sent: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

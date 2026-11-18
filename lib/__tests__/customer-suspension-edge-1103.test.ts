/**
 * #1103 follow-up: Supabase Edge Function campaigns and reminders skip a
 * suspended customer's number (Owner decision 2026-11-17: blocked from ALL
 * bots). Fails closed: an unreadable status sends nothing.
 *
 * Each real Edge Function (Deno.serve handler) runs under Node with a stubbed
 * Deno global, an in-memory database in place of supabase-js, and a stubbed
 * fetch that stands in for the Meta Cloud API. The shared send path
 * (_shared/attempt-recording.ts) runs for real, so "no Meta request and no
 * message_send_attempts row" means nothing was emitted for that number.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'path';
import { createMemoryDb, type MemoryDb } from './helpers/memory-db';

const h = vi.hoisted(() => {
  const env: Record<string, string> = {
    SUPABASE_URL: 'http://supabase.invalid', SUPABASE_SERVICE_ROLE_KEY: 'test-service-role',
    WHATSAPP_TOKEN: 'test-token', WHATSAPP_PHONE_NUMBER_ID: 'pn-edge', ENVIRONMENT: 'production',
    NEXT_PUBLIC_APP_URL: 'https://app.invalid',
  };
  const state = { db: null as unknown, handler: null as null | ((req: Request) => Promise<Response>) };
  (globalThis as { Deno?: unknown }).Deno = {
    env: { get: (k: string) => env[k] },
    serve: (fn: (req: Request) => Promise<Response>) => { state.handler = fn; },
  };
  return state;
});
vi.mock('https://esm.sh/@supabase/supabase-js@2', () => ({ createClient: () => h.db }));

import { customerSendBlocked } from '../../supabase/functions/_shared/customer-suspension';

const BIZ = '11111111-1111-4111-8111-111111111111';
const SUSPENDED = '2348012345678';
const CLEAR = '2348099999999';
const NOW = new Date('2026-11-18T15:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const utcDate = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString().split('T')[0];
const suspension = { id: 'sus-1', phone: SUSPENDED, reason: 'abuse', suspended_by: 'admin-1', suspended_at: '2026-11-17T00:00:00Z', last_notified_at: null };

const handlers = new Map<string, (req: Request) => Promise<Response>>();
async function handlerFor(fn: string) {
  if (!handlers.has(fn)) {
    h.handler = null;
    await import(resolve(__dirname, `../../supabase/functions/${fn}/index.ts`));
    if (!h.handler) throw new Error(`${fn} did not register a Deno.serve handler`);
    handlers.set(fn, h.handler);
  }
  return handlers.get(fn)!;
}

let metaTo: string[] = [];
function world(tables: Record<string, Record<string, unknown>[]>): MemoryDb {
  const db = createMemoryDb({
    businesses: [{ id: BIZ, name: 'Lagos Barbers', messaging_suspended: false, metadata: { reminder_hours: [24] } }],
    customer_suspensions: [suspension],
    message_send_attempts: [],
    ...tables,
  });
  (db as unknown as { rpc: unknown }).rpc = async (name: string) => (name === 'check_or_authorize_send'
    ? { data: { enforcement_required: false }, error: null }
    : { data: null, error: null });
  h.db = db;
  return db;
}
async function run(fn: string) {
  const res = await (await handlerFor(fn))(new Request('http://edge.invalid'));
  expect(res.status).toBe(200);
}
const attemptsTo = (db: MemoryDb) => db.tables.message_send_attempts.map(r => String(r.recipient_phone).replace(/\D/g, ''));
const row = (db: MemoryDb, table: string, phoneCol: string, phone: string) =>
  db.tables[table].find(r => String(r[phoneCol]).replace(/\D/g, '') === phone)!;

beforeEach(() => {
  metaTo = [];
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
    metaTo.push(JSON.parse(init.body).to);
    return new Response(JSON.stringify({ messages: [{ id: `wamid.${metaTo.length}` }] }), { status: 200 });
  }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('_shared/customer-suspension customerSendBlocked', () => {
  it('blocks a suspended number in any format, clears others, fails closed on a read error', async () => {
    const db = world({});
    expect(await customerSendBlocked(db as never, SUSPENDED)).toBe(true);
    expect(await customerSendBlocked(db as never, `+${SUSPENDED}`)).toBe(true);
    expect(await customerSendBlocked(db as never, CLEAR)).toBe(false);
    expect(await customerSendBlocked(db as never, null)).toBe(false);
    db.failReads.add('customer_suspensions');
    expect(await customerSendBlocked(db as never, CLEAR)).toBe(true);
  });
});

describe('Edge campaigns (marketing)', () => {
  it('birthday-campaign: only the customer who is not suspended is wished', async () => {
    const db = world({
      customer_profiles: [SUSPENDED, CLEAR].map(phone => ({
        id: `cp-${phone}`, phone, name: 'Ada', business_id: BIZ, total_visits: 3, birthday_wished_year: null,
        date_of_birth: '1990-11-18T12:00:00Z', notification_opt_in: true,
        businesses: { name: 'Lagos Barbers', category: 'barber', metadata: {} },
      })),
    });
    await run('birthday-campaign');
    expect(metaTo).toEqual([CLEAR]);
    expect(attemptsTo(db)).toEqual([CLEAR]);
    expect(row(db, 'customer_profiles', 'phone', SUSPENDED).birthday_wished_year).toBeNull();
  });

  it('birthday-campaign: an unreadable suspension status sends nothing (fails closed)', async () => {
    const db = world({
      customer_profiles: [{
        id: 'cp-1', phone: CLEAR, name: 'Ada', business_id: BIZ, total_visits: 3, birthday_wished_year: null,
        date_of_birth: '1990-11-18T12:00:00Z', notification_opt_in: true,
        businesses: { name: 'Lagos Barbers', category: 'barber', metadata: {} },
      }],
    });
    db.failReads.add('customer_suspensions');
    await run('birthday-campaign');
    expect(metaTo).toEqual([]);
    expect(db.tables.message_send_attempts).toEqual([]);
  });

  it('customer-reengagement: only the customer who is not suspended is messaged', async () => {
    const db = world({
      customer_profiles: [SUSPENDED, CLEAR].map(phone => ({
        id: `cp-${phone}`, phone, name: 'Ada', business_id: BIZ, total_visits: 3, total_spent: 0,
        last_seen_at: ago(20 * DAY), reengagement_sent_at: null, notification_opt_in: true,
        businesses: { name: 'Lagos Barbers', category: 'barber', country_code: 'NG' },
      })),
    });
    await run('customer-reengagement');
    expect(metaTo).toEqual([CLEAR]);
    expect(row(db, 'customer_profiles', 'phone', SUSPENDED).reengagement_sent_at).toBeNull();
  });

  it('abandoned-cart-reminder: only the customer who is not suspended is reminded', async () => {
    const db = world({
      bot_sessions: [SUSPENDED, CLEAR].map(phone => ({
        id: `s-${phone}`, whatsapp_number: phone, business_id: BIZ, is_active: true, cart_reminder_sent: false,
        updated_at: ago(2 * HOUR), current_step: 'view_cart', session_data: { cart: [{ id: 'p1' }] },
      })),
    });
    await run('abandoned-cart-reminder');
    expect(metaTo).toEqual([CLEAR]);
    expect(row(db, 'bot_sessions', 'whatsapp_number', SUSPENDED).cart_reminder_sent).toBe(false);
  });

  it('process-sequences: the suspended customer\'s step is held an hour, unsent; the other advances', async () => {
    const db = world({
      bot_sequence_enrollments: [SUSPENDED, CLEAR].map(phone => ({
        id: `en-${phone}`, sequence_id: 'seq-1', business_id: BIZ, customer_phone: `+${phone}`, status: 'active',
        current_step: 0, next_send_at: ago(60_000), context: {},
      })),
      bot_sequence_steps: [0, 1].map(i => ({ id: `st-${i}`, sequence_id: 'seq-1', step_order: i, message_content: `Step ${i}`, delay_minutes: 60, condition: null })),
    });
    await run('process-sequences');
    expect(metaTo).toEqual([CLEAR]);
    const held = row(db, 'bot_sequence_enrollments', 'customer_phone', SUSPENDED);
    expect(held.current_step).toBe(0);
    expect(held.status).toBe('active');
    expect(held.next_send_at).toBe(new Date(NOW.getTime() + HOUR).toISOString());
    expect(row(db, 'bot_sequence_enrollments', 'customer_phone', CLEAR).current_step).toBe(1);
  });
});

describe('Edge reminders', () => {
  it('booking-reminders: booking, check-in and post-visit messages go only to the customer who is not suspended', async () => {
    const db = world({
      bookings: [
        ...[SUSPENDED, CLEAR].map(phone => ({
          id: `bk-${phone}`, business_id: BIZ, guest_phone: phone, guest_name: 'Ada', date: utcDate(DAY), time: null,
          status: 'confirmed', deleted_at: null, reminder_24h_sent: false,
        })),
        ...[SUSPENDED, CLEAR].map(phone => ({
          id: `done-${phone}`, business_id: BIZ, guest_phone: phone, guest_name: 'Ada', date: utcDate(-2 * DAY),
          status: 'completed', feedback_requested: false, deleted_at: null, service_id: null,
          services: null, businesses: { name: 'Lagos Barbers', slug: 'lagos-barbers' },
        })),
      ],
      reservations: [SUSPENDED, CLEAR].map(phone => ({
        id: `rs-${phone}`, business_id: BIZ, guest_phone: phone, guest_name: 'Ada', check_in: utcDate(DAY), check_out: utcDate(3 * DAY),
        nights: 2, status: 'confirmed', property_id: 'pr-1', properties: { name: 'Suite', address: 'Lagos' },
      })),
      whatsapp_config: [],
    });
    await run('booking-reminders');
    expect(metaTo).toEqual([CLEAR, CLEAR, CLEAR]);
    expect(row(db, 'bookings', 'guest_phone', SUSPENDED).reminder_24h_sent).toBe(false);
    expect(db.tables.bookings.find(r => r.id === `done-${SUSPENDED}`)!.feedback_requested).toBe(false);
    expect(db.tables.bookings.find(r => r.id === `done-${CLEAR}`)!.feedback_requested).toBe(true);
  });

  it('recurring-reminder: no payment reminder or recovery/cancellation message to a suspended customer; the schedule and auto-cancel still run', async () => {
    const db = world({
      customer_subscriptions: [
        ...[SUSPENDED, CLEAR].map(phone => ({
          id: `due-${phone}`, business_id: BIZ, customer_phone: phone, customer_name: 'Ada', status: 'active', authorization_code: null,
          next_charge_at: ago(HOUR), amount: 5000, currency: 'NGN', frequency: 'monthly', service_id: null,
          businesses: { name: 'Lagos Gym', slug: 'lagos-gym', country_code: 'NG' },
        })),
        ...[SUSPENDED, CLEAR].map(phone => ({
          id: `late-${phone}`, business_id: BIZ, customer_phone: phone, customer_name: 'Ada', status: 'past_due', failure_count: 1,
          auto_cancel_notified: false, amount: 5000, currency: 'NGN', frequency: 'monthly', businesses: { name: 'Lagos Gym', country_code: 'NG' },
        })),
        {
          id: 'cancel-suspended', business_id: BIZ, customer_phone: SUSPENDED, customer_name: 'Ada', status: 'past_due', failure_count: 3,
          auto_cancel_notified: false, amount: 5000, currency: 'NGN', frequency: 'monthly', businesses: { name: 'Lagos Gym', country_code: 'NG' },
        },
      ],
      services: [],
    });
    await run('recurring-reminder');
    expect(metaTo).toEqual([CLEAR, CLEAR]);
    expect(attemptsTo(db)).not.toContain(SUSPENDED);
    // Money state is unchanged by the suspension: the due date still advances and the auto-cancel still happens.
    const due = db.tables.customer_subscriptions.find(r => r.id === `due-${SUSPENDED}`)!;
    expect(new Date(String(due.next_charge_at)).getTime()).toBeGreaterThan(NOW.getTime());
    expect(db.tables.customer_subscriptions.find(r => r.id === 'cancel-suspended')!.status).toBe('cancelled');
  });

  it('contract-reminders: only the signer who is not suspended is reminded', async () => {
    const db = world({
      contracts: [SUSPENDED, CLEAR].map(phone => ({
        id: `ct-${phone}`, business_id: BIZ, title: 'Lease', signer_phone: `+${phone}`, signer_name: 'Ada', token: `tok-${phone}`,
        status: 'pending', reminder_24h_sent: false, reminder_48h_sent: false, created_at: ago(30 * HOUR), token_expires_at: new Date(NOW.getTime() + 2 * DAY).toISOString(),
      })),
    });
    await run('contract-reminders');
    expect(metaTo).toEqual([CLEAR]);
    expect(row(db, 'contracts', 'signer_phone', SUSPENDED).reminder_24h_sent).toBe(false);
  });

  it('noshow-reschedule: only the customer who is not suspended is prompted', async () => {
    const db = world({
      bookings: [SUSPENDED, CLEAR].map(phone => ({
        id: `ns-${phone}`, business_id: BIZ, guest_phone: phone, guest_name: 'Ada', date: utcDate(0), time: '10:00', service_id: null,
        status: 'no_show', reschedule_prompted: false, deleted_at: null, businesses: { name: 'Lagos Barbers', slug: 'lagos-barbers' }, services: null,
      })),
    });
    await run('noshow-reschedule');
    expect(metaTo).toEqual([CLEAR]);
    expect(row(db, 'bookings', 'guest_phone', SUSPENDED).reschedule_prompted).toBe(false);
  });
});

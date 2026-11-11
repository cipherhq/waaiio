import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryDb } from './helpers/memory-db';

vi.mock('@/lib/payments/saved-card-compat', () => ({
  canonicalSavedCardPhone: (phone: string) => phone.startsWith('+') ? phone : `+${phone}`,
  isSharedPlatformPaystackCompatible: vi.fn().mockResolvedValue({ compatible: true }),
}));
import { startSavedCardFromPaymentId } from '@/lib/payments/saved-card-offer';

// Application establishment plus the actual shared-channel SQL resolver. Never remote.
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL required; saved-card routing proof must not skip');
const parsed = new URL(url);
if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) throw new Error('Disposable localhost only');
const database = `card_routing_${randomUUID().replaceAll('-', '')}`;
const business = randomUUID(), channel = randomUUID(), otherChannel = randomUUID();
const sessionId = randomUUID(), pickerId = randomUUID(), paymentId = randomUUID(), offerId = randomUUID();
const phone = '+2348012345678';
let control: Client, db: Client;
const query = async (sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows;
const read = async (receivingChannel = channel) =>
  (await query('SELECT get_shared_conversation($1,$2) result', [phone.slice(1), receivingChannel]))[0].result;

function applicationDb(replacement = false) {
  const memory = createMemoryDb({
    payments: [{ id: paymentId, business_id: business, status: 'success', gateway: 'paystack', booking_id: 'booking',
      metadata: { payment_origin: 'platform', _inbound_channel_id: channel, _card_authorization: {
        reusable: true, authorization_code: 'fixture-new', customer_code: 'fixture-customer',
        email: 'fixture@example.test', last4: '5678', brand: 'visa',
      } } }],
    bookings: [{ id: 'booking', guest_phone: phone }],
    saved_payment_methods: replacement ? [{ id: randomUUID(), customer_phone: phone, gateway: 'paystack',
      is_active: true, authorization_code: 'fixture-old', customer_code: 'fixture-customer', card_last4: '1234', card_brand: 'visa' }] : [],
    payment_saved_card_offers: [{ id: offerId, payment_id: paymentId, business_id: business,
      customer_phone: phone, channel_id: channel, state: 'accepted' }],
  });
  return { ...memory, rpc: async (name: string, args: Record<string, unknown>) => {
    if (name !== 'establish_saved_card_session') throw new Error(`Unexpected RPC ${name}`);
    const rows = await query('SELECT establish_saved_card_session($1,$2,$3,$4) result',
      [args.p_canon_phone, args.p_business_id, args.p_current_step, JSON.stringify(args.p_session_data)]);
    return { data: rows[0].result, error: null };
  } };
}

beforeAll(async () => {
  control = new Client({ connectionString: url }); await control.connect();
  await control.query(`CREATE DATABASE ${database}`); parsed.pathname = `/${database}`;
  db = new Client({ connectionString: parsed.toString() }); await db.connect();
  for (const role of ['anon', 'authenticated', 'service_role']) {
    if (!(await query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).length) await query(`CREATE ROLE ${role}`);
  }
  await query(`CREATE SCHEMA extensions;
    CREATE TABLE whatsapp_channels (id uuid PRIMARY KEY, channel_type text, is_active boolean, connection_status text);
    CREATE TABLE businesses (id uuid PRIMARY KEY, status text, wa_method text, assigned_channel_id uuid);
    CREATE TABLE bot_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), whatsapp_number text, business_id uuid,
      is_active boolean, expires_at timestamptz, current_step text, session_data jsonb, version bigint DEFAULT 0,
      conversation_log jsonb, updated_at timestamptz DEFAULT now());
    CREATE UNIQUE INDEX bot_sessions_business ON bot_sessions(whatsapp_number,business_id) WHERE business_id IS NOT NULL;`);
  // Read production definitions; unrelated M398 delivery RPCs need no fixture here.
  const m398 = readFileSync('supabase/migrations/398_saved_card_session_normalization.sql', 'utf8');
  const sectionEnd = m398.indexOf('CREATE OR REPLACE FUNCTION claim_exact_activation_delivery');
  if (sectionEnd < 0) throw new Error('M398 establishment section boundary missing');
  await db.query(m398.slice(0, sectionEnd));
  await db.query(readFileSync('supabase/migrations/493_shared_conversation_binding.sql', 'utf8'));
}, 30000);
afterAll(async () => {
  await db?.end();
  if (control) { await control.query(`DROP DATABASE IF EXISTS ${database}`); await control.end(); }
});
beforeEach(async () => {
  await query('TRUNCATE bot_conversation_bindings,bot_sessions,businesses,whatsapp_channels CASCADE');
  await query("INSERT INTO whatsapp_channels VALUES ($1,'shared',true,'active'),($2,'shared',true,'active')", [channel, otherChannel]);
  await query("INSERT INTO businesses VALUES ($1,'active','shared',$2)", [business, channel]);
  await query(`INSERT INTO bot_sessions(id,whatsapp_number,business_id,is_active,expires_at,current_step,session_data)
    VALUES($1,$2,$3,false,now()-interval '1 minute','completed',$4)`,
  [sessionId, phone.slice(1), business, JSON.stringify({ _inbound_channel_id: channel })]);
  await query('INSERT INTO bot_conversation_bindings VALUES($1,$2,$3,$4,10)', [phone.slice(1), channel, business, sessionId]);
});

describe('saved-card establishment → shared resolver, real PostgreSQL', () => {
  it.each([false, true])('resumes the exact PIN session after no-session establishment; replacement=%s', async replacement => {
    const send = vi.fn();
    await startSavedCardFromPaymentId(applicationDb(replacement) as any, send, phone, null, paymentId);
    expect(send).toHaveBeenCalledOnce();
    const next = await read();
    expect(next.session?.id).toBe(sessionId);
    expect(next.session.business_id).toBe(business);
    expect(next.session.current_step).toBe(replacement ? 'replace_card_pin' : 'save_card_pin');
    expect(next.session.session_data[replacement ? '_replace_payment_id' : '_save_card_payment_id']).toBe(paymentId);
    expect(next.version).toBe(10);
  });
  it('does not expose the PIN session on another receiving channel', async () => {
    await startSavedCardFromPaymentId(applicationDb() as any, vi.fn(), phone, null, paymentId);
    expect((await read()).session?.id).toBe(sessionId);
    expect((await read(otherChannel)).session).toBeNull();
  });
  it('does not establish merchant selection from payment history without an explicit binding', async () => {
    await query('DELETE FROM bot_conversation_bindings');
    await startSavedCardFromPaymentId(applicationDb() as any, vi.fn(), phone, null, paymentId);
    expect((await read()).session).toBeNull();
    expect((await query('SELECT count(*) count FROM bot_conversation_bindings'))[0].count).toBe('0');
  });
  it('preserves deliberate current-picker precedence without phone-wide PIN fallback', async () => {
    await startSavedCardFromPaymentId(applicationDb() as any, vi.fn(), phone, null, paymentId);
    await query(`INSERT INTO bot_sessions(id,whatsapp_number,business_id,is_active,expires_at,current_step,session_data)
      VALUES($1,$2,NULL,true,now()+interval '1 hour','select_business_suggestion',$3)`,
    [pickerId, phone.slice(1), JSON.stringify({ _inbound_channel_id: channel, _conversation_version: 10, suggestions: [{ id: business }] })]);
    expect((await read()).session.id).toBe(pickerId);
    await query('UPDATE bot_sessions SET is_active=false WHERE id=$1', [pickerId]);
    expect((await read()).session?.id).toBe(sessionId);
  });
});

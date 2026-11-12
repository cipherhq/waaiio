/**
 * M536 — customer message guards (daily per-customer reply limit, repeats,
 * invalid-input runs, shared pause). Real PostgreSQL proof (disposable local
 * database, created and dropped here).
 *
 * Fixture: businesses, bot_sessions and platform_settings with the columns M536 touches.
 * M536 is applied from disk as one whole-file statement, twice (idempotency).
 * Every call runs as service_role, the only role allowed to execute them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const url = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_PG_TESTS === 'true' && !url) throw new Error('Disposable PostgreSQL is required for the M536 proof');
if (url && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('Disposable local PostgreSQL required');
const suite = url ? describe : describe.skip;

const m536 = readFileSync('supabase/migrations/536_customer_message_guards.sql', 'utf8');
const database = `m536_${randomUUID().replaceAll('-', '')}`;

suite('M536 customer message guards (real PostgreSQL)', () => {
  let control: pg.Client;
  let client: pg.Client;
  const q = (text: string, params?: unknown[]) => client.query(text, params);

  /** One statement in its own transaction as `role`. */
  async function as<T extends pg.QueryResultRow = pg.QueryResultRow>(role: string, sql: string, params: unknown[] = []) {
    await q('BEGIN');
    try {
      await q(`SET LOCAL ROLE ${role}`);
      const result = await client.query<T>(sql, params);
      await q('COMMIT');
      return result;
    } catch (err) {
      await q('ROLLBACK');
      throw err;
    }
  }
  async function errorOf(fn: () => Promise<unknown>): Promise<{ message?: string; code?: string }> {
    try { await fn(); } catch (err) { return err as { message?: string; code?: string }; }
    return {};
  }
  const daily = async (biz: string, phone: string, limit: number) =>
    (await as('service_role', 'SELECT public.record_customer_daily_reply($1, $2, $3) AS r', [biz, phone, limit])).rows[0].r;
  const PAYMENT_STEPS = ['await_payment', 'process_order'];
  const inbound = async (phone: string, hash: string | null, windowSeconds = 600) =>
    (await as('service_role', 'SELECT public.record_customer_inbound($1, $2, $3, $4) AS r', [phone, hash, windowSeconds, PAYMENT_STEPS])).rows[0].r;
  const claim = async (biz: string, phone: string) =>
    (await as('service_role', 'SELECT public.claim_customer_daily_limit_notice($1, $2) AS r', [biz, phone])).rows[0].r;
  const setSession = (phone: string, step: string, data: Record<string, unknown> = {}) =>
    q(`INSERT INTO public.bot_sessions (whatsapp_number, current_step, session_data, is_active, updated_at) VALUES ($1, $2, $3, true, now())
       ON CONFLICT (whatsapp_number) DO UPDATE SET current_step = $2, session_data = $3, updated_at = now()`, [phone, step, data]);
  const invalid = async (phone: string, key: string, windowSeconds = 600) =>
    (await as('service_role', 'SELECT public.record_customer_invalid_input($1, $2, $3) AS r', [phone, key, windowSeconds])).rows[0].r;
  const pause = async (phone: string, seconds: number, noticeSent: boolean) =>
    as('service_role', 'SELECT public.set_customer_cooldown($1, $2, $3)', [phone, seconds, noticeSent]);

  const BIZ_A = randomUUID();
  const BIZ_B = randomUUID();

  beforeAll(async () => {
    control = new pg.Client({ connectionString: url }); await control.connect();
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await control.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} NOLOGIN; END IF; END $$`);
    }
    await control.query('ALTER ROLE service_role BYPASSRLS');
    await control.query(`CREATE DATABASE ${database}`);
    const u = new URL(url!); u.pathname = `/${database}`;
    client = new pg.Client({ connectionString: u.toString() }); await client.connect();
    await q(`
      CREATE SCHEMA IF NOT EXISTS extensions;
      CREATE TABLE public.businesses (id uuid PRIMARY KEY);
      CREATE TABLE public.platform_settings (key varchar(100) PRIMARY KEY, value jsonb NOT NULL DEFAULT '{}', description text);
      CREATE TABLE public.bot_sessions (
        whatsapp_number text PRIMARY KEY, current_step text, session_data jsonb NOT NULL DEFAULT '{}',
        is_active boolean NOT NULL DEFAULT true, updated_at timestamptz NOT NULL DEFAULT now()
      );
      GRANT SELECT ON public.bot_sessions TO service_role;
      INSERT INTO public.platform_settings (key, value) VALUES ('customer_daily_reply_limit', '80');
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    `);
    await q('INSERT INTO public.businesses (id) VALUES ($1), ($2)', [BIZ_A, BIZ_B]);
    await q(m536);
    await q(m536);
  });

  afterAll(async () => {
    await client?.end();
    await control?.query(`DROP DATABASE IF EXISTS ${database}`);
    await control?.end();
  });

  it('is idempotent and keeps an existing admin value for the daily default', async () => {
    const { rows } = await q(`SELECT key, value, description IS NOT NULL AS described FROM public.platform_settings ORDER BY key`);
    expect(rows).toEqual([
      { key: 'customer_daily_reply_limit', value: 80, described: false },
      { key: 'customer_daily_reply_limit_max', value: 500, described: true },
      { key: 'customer_repeat_message_limit', value: 3, described: true },
    ]);
  });

  it('only service_role can read the tables or run the functions; RLS is on', async () => {
    const { rows: rls } = await q(`SELECT relname, relrowsecurity FROM pg_class
      WHERE relname IN ('customer_daily_reply_usage', 'customer_message_guard') ORDER BY relname`);
    expect(rls).toEqual([
      { relname: 'customer_daily_reply_usage', relrowsecurity: true },
      { relname: 'customer_message_guard', relrowsecurity: true },
    ]);
    for (const role of ['anon', 'authenticated']) {
      expect((await errorOf(() => as(role, 'SELECT * FROM public.customer_daily_reply_usage'))).code).toBe('42501');
      expect((await errorOf(() => as(role, 'SELECT * FROM public.customer_message_guard'))).code).toBe('42501');
      expect((await errorOf(() => as(role, 'SELECT public.record_customer_daily_reply($1, $2, 5)', [BIZ_A, '2348000000001']))).code).toBe('42501');
      expect((await errorOf(() => as(role, 'SELECT public.record_customer_inbound($1, NULL, 60, NULL)', ['2348000000001']))).code).toBe('42501');
      expect((await errorOf(() => as(role, 'SELECT public.claim_customer_daily_limit_notice($1, $2)', [BIZ_A, '2348000000001']))).code).toBe('42501');
      expect((await errorOf(() => as(role, 'SELECT public.record_customer_invalid_input($1, $2, 60)', ['2348000000001', 'k']))).code).toBe('42501');
      expect((await errorOf(() => as(role, 'SELECT public.set_customer_cooldown($1, 60, true)', ['2348000000001']))).code).toBe('42501');
    }
    const { rows: definer } = await q(`SELECT proname, prosecdef, proconfig FROM pg_proc
      WHERE proname IN ('claim_customer_daily_limit_notice', 'record_customer_daily_reply', 'record_customer_inbound', 'record_customer_invalid_input', 'set_customer_cooldown')
      ORDER BY proname`);
    expect(definer.map(r => [r.proname, r.prosecdef, r.proconfig])).toEqual([
      ['claim_customer_daily_limit_notice', false, ['search_path=public, extensions']],
      ['record_customer_daily_reply', false, ['search_path=public, extensions']],
      ['record_customer_inbound', false, ['search_path=public, extensions']],
      ['record_customer_invalid_input', false, ['search_path=public, extensions']],
      ['set_customer_cooldown', false, ['search_path=public, extensions']],
    ]);
  });

  it('counts replies per customer per business', async () => {
    const phone = '2348000000002';
    for (let i = 1; i <= 3; i++) {
      expect(await daily(BIZ_A, phone, 3)).toEqual({ reply_count: i, over_limit: false });
    }
    expect(await daily(BIZ_A, phone, 3)).toEqual({ reply_count: 4, over_limit: true });
    expect(await daily(BIZ_A, phone, 3)).toEqual({ reply_count: 5, over_limit: true });
    // Another business, and another customer, have their own counts.
    expect(await daily(BIZ_B, phone, 3)).toEqual({ reply_count: 1, over_limit: false });
    expect(await daily(BIZ_A, '2348000000003', 3)).toEqual({ reply_count: 1, over_limit: false });
  });

  it('counting never uses up the notice; claiming gives it exactly once per day', async () => {
    const phone = '2348000000011';
    expect(await claim(BIZ_A, phone)).toBe(false); // no row today yet
    for (let i = 0; i < 5; i++) await daily(BIZ_A, phone, 1); // over the limit, e.g. while paying
    const { rows } = await q('SELECT notice_sent FROM public.customer_daily_reply_usage WHERE business_id = $1 AND phone = $2', [BIZ_A, phone]);
    expect(rows[0].notice_sent).toBe(false);
    expect(await claim(BIZ_A, phone)).toBe(true);
    expect(await claim(BIZ_A, phone)).toBe(false);
    expect(await claim(BIZ_B, phone)).toBe(false);
  });

  it('counts exactly and gives the notice once when the same customer races itself', async () => {
    const phone = '2348000000004';
    await daily(BIZ_A, phone, 1);
    const u = new URL(url!); u.pathname = `/${database}`;
    const racers = await Promise.all([0, 1, 2, 3].map(async () => {
      const c = new pg.Client({ connectionString: u.toString() }); await c.connect();
      try {
        await c.query('BEGIN'); await c.query('SET LOCAL ROLE service_role');
        const { rows } = await c.query('SELECT public.record_customer_daily_reply($1, $2, 1) AS r', [BIZ_A, phone]);
        const { rows: claimed } = await c.query('SELECT public.claim_customer_daily_limit_notice($1, $2) AS c', [BIZ_A, phone]);
        await c.query('COMMIT');
        return { count: (rows[0].r as { reply_count: number }).reply_count, claimed: claimed[0].c as boolean };
      } finally { await c.end(); }
    }));
    expect(racers.filter(r => r.claimed)).toHaveLength(1);
    expect(racers.map(r => r.count).sort()).toEqual([2, 3, 4, 5]);
  });

  it('starts a new count on a new UTC day and prunes rows older than a week', async () => {
    const phone = '2348000000005';
    await q(`INSERT INTO public.customer_daily_reply_usage (business_id, phone, usage_date, reply_count, notice_sent)
      VALUES ($1, $2, (now() AT TIME ZONE 'UTC')::date - 1, 99, true), ($1, $2, (now() AT TIME ZONE 'UTC')::date - 9, 99, true)`, [BIZ_A, phone]);
    expect(await daily(BIZ_A, phone, 3)).toEqual({ reply_count: 1, over_limit: false });
    expect(await claim(BIZ_A, phone)).toBe(true); // yesterday's notice does not carry over
    const { rows } = await q(`SELECT (now() AT TIME ZONE 'UTC')::date - usage_date AS age FROM public.customer_daily_reply_usage
      WHERE business_id = $1 AND phone = $2 ORDER BY age`, [BIZ_A, phone]);
    expect(rows.map(r => r.age)).toEqual([0, 1]);
  });

  it('rejects bad arguments', async () => {
    expect((await errorOf(() => daily(BIZ_A, '', 3))).message).toMatch(/invalid arguments/);
    expect((await errorOf(() => daily(BIZ_A, '2348000000006', 0))).message).toMatch(/invalid arguments/);
    expect((await errorOf(() => claim(BIZ_A, ''))).message).toMatch(/invalid arguments/);
    expect((await errorOf(() => inbound('', null))).message).toMatch(/invalid arguments/);
    expect((await errorOf(() => invalid('2348000000006', null as unknown as string))).message).toMatch(/invalid arguments/);
    expect((await errorOf(() => pause('2348000000006', 0, true))).message).toMatch(/invalid arguments/);
  });

  it('counts the same text in a row, restarts on different text, taps or an old repeat', async () => {
    const phone = '2348000000007';
    expect((await inbound(phone, 'h1')).repeat_count).toBe(1);
    expect((await inbound(phone, 'h1')).repeat_count).toBe(2);
    expect((await inbound(phone, 'h1')).repeat_count).toBe(3);
    expect((await inbound(phone, 'h1')).repeat_count).toBe(4);
    expect((await inbound(phone, 'h2')).repeat_count).toBe(1);
    expect((await inbound(phone, null)).repeat_count).toBe(0);
    expect((await inbound(phone, 'h2')).repeat_count).toBe(1);
    await q(`UPDATE public.customer_message_guard SET last_text_at = now() - interval '11 minutes' WHERE phone = $1`, [phone]);
    expect((await inbound(phone, 'h2')).repeat_count).toBe(1);
  });

  it('the same answer at a new step is not a repeat', async () => {
    const phone = '2348000000012';
    await setSession(phone, 'pick_item');
    expect((await inbound(phone, 'one')).repeat_count).toBe(1);
    expect((await inbound(phone, 'one')).repeat_count).toBe(2);
    await setSession(phone, 'pick_quantity');
    expect((await inbound(phone, 'one')).repeat_count).toBe(1);
  });

  it('a paying customer never builds a repeat count', async () => {
    const phone = '2348000000013';
    await setSession(phone, 'process_order');
    for (let i = 0; i < 5; i++) expect((await inbound(phone, 'yes')).repeat_count).toBe(0);
    await setSession(phone, 'pick_time', { _awaiting_card_pin: true });
    for (let i = 0; i < 5; i++) expect((await inbound(phone, '1234')).repeat_count).toBe(0);
    await setSession(phone, 'pick_time', { bank_transfer_reference: 'TRF-1' });
    expect((await inbound(phone, 'sent')).repeat_count).toBe(0);
    await setSession(phone, 'pick_time', { _awaiting_card_pin: false, payment_reference: null });
    expect((await inbound(phone, 'sent')).repeat_count).toBe(1);
  });

  it('holds a pause and tells the customer once, unless the caller already did', async () => {
    const phone = '2348000000008';
    await pause(phone, 300, false);
    const first = await inbound(phone, 'x');
    expect(first).toMatchObject({ paused: true, cooldown_notice_due: true });
    expect(Date.parse(first.cooldown_until) - Date.now()).toBeGreaterThan(290_000);
    expect(await inbound(phone, 'y')).toMatchObject({ paused: true, cooldown_notice_due: false });

    const told = '2348000000009';
    await pause(told, 300, true);
    expect(await inbound(told, 'x')).toMatchObject({ paused: true, cooldown_notice_due: false });

    // A shorter pause never cuts a longer one short.
    await pause(told, 60, true);
    const { rows } = await q(`SELECT cooldown_until > now() + interval '200 seconds' AS long FROM public.customer_message_guard WHERE phone = $1`, [told]);
    expect(rows[0].long).toBe(true);

    await q(`UPDATE public.customer_message_guard SET cooldown_until = now() - interval '1 second' WHERE phone = $1`, [phone]);
    expect(await inbound(phone, 'z')).toMatchObject({ paused: false, cooldown_notice_due: false });
  });

  it('messages during a pause never build a repeat count, so "menu" after the pause is answered', async () => {
    const phone = '2348000000014';
    expect((await inbound(phone, 'menu')).repeat_count).toBe(1);
    expect((await inbound(phone, 'menu')).repeat_count).toBe(2);
    await pause(phone, 300, true);
    const { rows: reset } = await q('SELECT repeat_count, last_text_hash FROM public.customer_message_guard WHERE phone = $1', [phone]);
    expect(reset[0]).toEqual({ repeat_count: 0, last_text_hash: null });
    for (let i = 0; i < 4; i++) expect(await inbound(phone, 'menu')).toMatchObject({ paused: true, repeat_count: 0 });
    await q(`UPDATE public.customer_message_guard SET cooldown_until = now() - interval '1 second' WHERE phone = $1`, [phone]);
    expect(await inbound(phone, 'menu')).toMatchObject({ paused: false, repeat_count: 1 });
  });

  it('counts invalid replies at one step, restarts at another step or after the window, and a pause resets it', async () => {
    const phone = '2348000000010';
    for (let i = 1; i <= 4; i++) expect(await invalid(phone, 's1:date')).toBe(i);
    expect(await invalid(phone, 's1:time')).toBe(1);
    expect(await invalid(phone, 's1:time')).toBe(2);
    await q(`UPDATE public.customer_message_guard SET last_invalid_at = now() - interval '11 minutes' WHERE phone = $1`, [phone]);
    expect(await invalid(phone, 's1:time')).toBe(1);
    await pause(phone, 60, true);
    const { rows } = await q(`SELECT invalid_count, invalid_step_key FROM public.customer_message_guard WHERE phone = $1`, [phone]);
    expect(rows[0]).toEqual({ invalid_count: 0, invalid_step_key: null });
    expect(await invalid(phone, 's1:time')).toBe(1);
  });
});

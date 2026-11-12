/**
 * M536 — customer message guards (daily per-customer reply limit, repeats,
 * invalid-input runs, shared pause). Real PostgreSQL proof (disposable local
 * database, created and dropped here).
 *
 * Fixture: businesses and platform_settings with the columns M536 touches.
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
  const inbound = async (phone: string, hash: string | null, windowSeconds = 600) =>
    (await as('service_role', 'SELECT public.record_customer_inbound($1, $2, $3) AS r', [phone, hash, windowSeconds])).rows[0].r;
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
      CREATE TABLE public.platform_settings (key varchar(100) PRIMARY KEY, value jsonb NOT NULL DEFAULT '{}');
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
    const { rows } = await q(`SELECT key, value FROM public.platform_settings ORDER BY key`);
    expect(rows).toEqual([
      { key: 'customer_daily_reply_limit', value: 80 },
      { key: 'customer_daily_reply_limit_max', value: 500 },
      { key: 'customer_repeat_message_limit', value: 3 },
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
      expect((await errorOf(() => as(role, 'SELECT public.record_customer_inbound($1, NULL, 60)', ['2348000000001']))).code).toBe('42501');
      expect((await errorOf(() => as(role, 'SELECT public.record_customer_invalid_input($1, $2, 60)', ['2348000000001', 'k']))).code).toBe('42501');
      expect((await errorOf(() => as(role, 'SELECT public.set_customer_cooldown($1, 60, true)', ['2348000000001']))).code).toBe('42501');
    }
    const { rows: definer } = await q(`SELECT proname, prosecdef, proconfig FROM pg_proc
      WHERE proname IN ('record_customer_daily_reply', 'record_customer_inbound', 'record_customer_invalid_input', 'set_customer_cooldown')
      ORDER BY proname`);
    expect(definer.map(r => [r.proname, r.prosecdef, r.proconfig])).toEqual([
      ['record_customer_daily_reply', false, ['search_path=public, extensions']],
      ['record_customer_inbound', false, ['search_path=public, extensions']],
      ['record_customer_invalid_input', false, ['search_path=public, extensions']],
      ['set_customer_cooldown', false, ['search_path=public, extensions']],
    ]);
  });

  it('counts replies per customer per business and owes the notice exactly once', async () => {
    const phone = '2348000000002';
    for (let i = 1; i <= 3; i++) {
      expect(await daily(BIZ_A, phone, 3)).toEqual({ reply_count: i, over_limit: false, notice_due: false });
    }
    expect(await daily(BIZ_A, phone, 3)).toEqual({ reply_count: 4, over_limit: true, notice_due: true });
    expect(await daily(BIZ_A, phone, 3)).toEqual({ reply_count: 5, over_limit: true, notice_due: false });
    // Another business, and another customer, have their own counts.
    expect(await daily(BIZ_B, phone, 3)).toEqual({ reply_count: 1, over_limit: false, notice_due: false });
    expect(await daily(BIZ_A, '2348000000003', 3)).toEqual({ reply_count: 1, over_limit: false, notice_due: false });
  });

  it('owes the notice once when the same customer races itself', async () => {
    const phone = '2348000000004';
    await daily(BIZ_A, phone, 1);
    const u = new URL(url!); u.pathname = `/${database}`;
    const racers = await Promise.all([0, 1, 2, 3].map(async () => {
      const c = new pg.Client({ connectionString: u.toString() }); await c.connect();
      try {
        await c.query('BEGIN'); await c.query('SET LOCAL ROLE service_role');
        const { rows } = await c.query('SELECT public.record_customer_daily_reply($1, $2, 1) AS r', [BIZ_A, phone]);
        await c.query('COMMIT');
        return rows[0].r as { notice_due: boolean; reply_count: number };
      } finally { await c.end(); }
    }));
    expect(racers.filter(r => r.notice_due)).toHaveLength(1);
    expect(racers.map(r => r.reply_count).sort()).toEqual([2, 3, 4, 5]);
  });

  it('starts a new count on a new UTC day and prunes rows older than a week', async () => {
    const phone = '2348000000005';
    await q(`INSERT INTO public.customer_daily_reply_usage (business_id, phone, usage_date, reply_count, notice_sent)
      VALUES ($1, $2, (now() AT TIME ZONE 'UTC')::date - 1, 99, true), ($1, $2, (now() AT TIME ZONE 'UTC')::date - 9, 99, true)`, [BIZ_A, phone]);
    expect(await daily(BIZ_A, phone, 3)).toEqual({ reply_count: 1, over_limit: false, notice_due: false });
    const { rows } = await q(`SELECT (now() AT TIME ZONE 'UTC')::date - usage_date AS age FROM public.customer_daily_reply_usage
      WHERE business_id = $1 AND phone = $2 ORDER BY age`, [BIZ_A, phone]);
    expect(rows.map(r => r.age)).toEqual([0, 1]);
  });

  it('rejects bad arguments', async () => {
    expect((await errorOf(() => daily(BIZ_A, '', 3))).message).toMatch(/invalid arguments/);
    expect((await errorOf(() => daily(BIZ_A, '2348000000006', 0))).message).toMatch(/invalid arguments/);
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

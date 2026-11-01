import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
const url = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_PG_TESTS === 'true' && !url) throw new Error('Disposable PostgreSQL required');
const suite = url ? describe : describe.skip;
suite('embedded signup session database boundary', () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    const target = new URL(url!);
    const ci = process.env.GITHUB_ACTIONS === 'true' && process.env.REQUIRE_PG_TESTS === 'true' && target.username === 'test_runner' && /^\/pg_test_\d+$/.test(target.pathname);
    if (!['localhost', '127.0.0.1'].includes(target.hostname) || (!ci && target.pathname !== '/signup_session_test')) throw new Error('Disposable local database only');
    pool = new pg.Pool({ connectionString: url });
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await pool.query(`DO $$ BEGIN CREATE ROLE ${role} NOLOGIN ${role === 'service_role' ? 'BYPASSRLS' : ''}; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    }
    await pool.query('GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role');
    await pool.query(readFileSync('supabase/migrations/495_embedded_signup_sessions.sql', 'utf8'));
  });
  afterAll(async () => { await pool?.end(); });
  it.each(['anon', 'authenticated'])('%s cannot read or create sessions', async role => {
    for (const sql of ['SELECT * FROM public.whatsapp_signup_sessions', "INSERT INTO public.whatsapp_signup_sessions VALUES(repeat('a',64),'test',now())"]) {
      const c = await pool.connect();
      try { await c.query('BEGIN'); await c.query(`SET LOCAL ROLE ${role}`); await expect(c.query(sql)).rejects.toMatchObject({ code: '42501' }); }
      finally { await c.query('ROLLBACK'); c.release(); }
    }
  });
  it('service role can create and atomically consume a session only once', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN'); await c.query('SET LOCAL ROLE service_role');
      await c.query("INSERT INTO public.whatsapp_signup_sessions VALUES(repeat('b',64),'encrypted-test',now()+interval '10 minutes')");
      const sql = "DELETE FROM public.whatsapp_signup_sessions WHERE session_key=repeat('b',64) AND expires_at>now() RETURNING payload";
      expect((await c.query(sql)).rows).toEqual([{ payload: 'encrypted-test' }]);
      expect((await c.query(sql)).rows).toEqual([]);
    } finally { await c.query('ROLLBACK'); c.release(); }
  });
  it('does not consume expired sessions', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN'); await c.query('SET LOCAL ROLE service_role');
      await c.query("INSERT INTO public.whatsapp_signup_sessions VALUES(repeat('c',64),'expired',now()-interval '1 minute')");
      expect((await c.query("DELETE FROM public.whatsapp_signup_sessions WHERE session_key=repeat('c',64) AND expires_at>now() RETURNING payload")).rows).toEqual([]);
    } finally { await c.query('ROLLBACK'); c.release(); }
  });
});

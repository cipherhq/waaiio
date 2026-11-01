/** Real database CAS proof; Auth transport and HTTP behavior are tested separately. */
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const url = process.env.TEST_DATABASE_URL;
if (!url && process.env.REQUIRE_PG_TESTS === 'true') throw new Error('TEST_DATABASE_URL required for step-up CAS proof');
const suite = url ? describe : describe.skip;
const ADMIN = '00000000-0000-0000-0000-000000000101';
const FACTOR = '00000000-0000-0000-0000-000000000102';
const ID = '00000000-0000-0000-0000-000000000103';
const C1 = '00000000-0000-0000-0000-000000000104';
const C2 = '00000000-0000-0000-0000-000000000105';
const pending = `id='${ID}' AND admin_user_id='${ADMIN}' AND session_id='session-a' AND factor_id='${FACTOR}' AND verified_at IS NULL AND consumed_at IS NULL AND expires_at>now()`;
const bind = `${pending} AND challenge_id IS NULL`;
const consume = `id='${ID}' AND admin_user_id='${ADMIN}' AND session_id='session-a' AND action_type='payout_generate' AND params_hash='bound-generate-hash' AND verified_at IS NOT NULL AND consumed_at IS NULL AND expires_at>now() AND target_id IS NULL`;
suite('Admin step-up CAS — disposable local PostgreSQL', () => {
  let control: Client, a: Client, b: Client, observer: Client;
  const database = `stepup_cas_${randomUUID().replaceAll('-', '')}`;
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) throw new Error('Disposable localhost PostgreSQL only');
    control = new Client({ connectionString: url }); await control.connect();
    await control.query(`CREATE DATABASE ${database}`); parsed.pathname = `/${database}`;
    [a, b, observer] = [0, 1, 2].map(() => new Client({ connectionString: parsed.toString(), statement_timeout: 5000 }));
    await Promise.all([a.connect(), b.connect(), observer.connect()]);
    await a.query('CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY)');
    for (const role of ['anon', 'authenticated', 'service_role']) {
      if (!(await a.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount) await a.query(`CREATE ROLE ${role}`);
    }
    const migration = readFileSync('supabase/migrations/439_admin_mfa_enforcement.sql', 'utf8');
    // Execute the exact canonical table/RLS/ACL/index section, not unrelated admin policies.
    const tableStart = migration.indexOf('CREATE TABLE IF NOT EXISTS public.admin_step_up_authorizations');
    const tableEnd = migration.indexOf('-- §2.');
    if (tableStart < 0 || tableEnd <= tableStart) throw new Error('Canonical M439 section markers changed');
    await a.query(migration.slice(tableStart, tableEnd));
    await a.query('INSERT INTO auth.users(id) VALUES($1)', [ADMIN]);
  }, 15000);
  beforeEach(async () => {
    await a.query('TRUNCATE admin_step_up_authorizations');
    await a.query("INSERT INTO admin_step_up_authorizations(id,admin_user_id,session_id,action_type,params_hash,factor_id) VALUES($1,$2,'session-a','payout_generate','bound-generate-hash',$3)", [ID, ADMIN, FACTOR]);
  });
  afterAll(async () => {
    await Promise.all([a?.end(), b?.end(), observer?.end()]);
    if (control) { await control.query(`DROP DATABASE IF EXISTS ${database}`); await control.end(); }
  });
  async function lockedRace(first: string, second: string) {
    await a.query('BEGIN');
    const winner = await a.query(first);
    const pid = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const waiting = b.query(second).then(result => ({ result }), error => ({ error }));
    let blocked = false;
    try {
      for (let i = 0; i < 100; i++) {
        if ((await observer.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0]?.wait_event_type === 'Lock') { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    } finally { await a.query('COMMIT'); }
    const outcome = await waiting;
    expect(blocked).toBe(true);
    if ('error' in outcome) throw outcome.error;
    expect([winner.rowCount, outcome.result.rowCount]).toEqual([1, 0]);
  }
  it('two challenge binders have one winner; only its exact challenge can verify', async () => {
    await lockedRace(`UPDATE admin_step_up_authorizations SET challenge_id='${C1}' WHERE ${bind} RETURNING id`, `UPDATE admin_step_up_authorizations SET challenge_id='${C2}' WHERE ${bind} RETURNING id`);
    expect((await a.query(`UPDATE admin_step_up_authorizations SET verified_at=now() WHERE ${pending} AND challenge_id='${C2}'`)).rowCount).toBe(0);
    expect((await a.query(`UPDATE admin_step_up_authorizations SET verified_at=now() WHERE ${pending} AND challenge_id='${C1}'`)).rowCount).toBe(1);
    expect((await a.query('SELECT challenge_id FROM admin_step_up_authorizations')).rows[0].challenge_id).toBe(C1);
  });
  it('two consumers have one winner and replay is denied', async () => {
    await a.query(`UPDATE admin_step_up_authorizations SET challenge_id='${C1}',verified_at=now()`);
    const command = `UPDATE admin_step_up_authorizations SET consumed_at=now() WHERE ${consume} RETURNING id`;
    await lockedRace(command, command);
    expect((await a.query(command)).rowCount).toBe(0);
  });
  it('binding rejects wrong identities and verified, consumed, expired or already-bound rows', async () => {
    for (const wrong of [bind.replace(ADMIN, C2), bind.replace('session-a', 'session-b'), bind.replace(FACTOR, C2), bind.replace(ID, C2)]) {
      expect((await a.query(`UPDATE admin_step_up_authorizations SET challenge_id='${C1}' WHERE ${wrong}`)).rowCount).toBe(0);
    }
    for (const mutation of ['verified_at=now()', 'consumed_at=now()', "expires_at=now()-interval '1 second'", `challenge_id='${C2}'`]) {
      await a.query(`UPDATE admin_step_up_authorizations SET ${mutation}`);
      expect((await a.query(`UPDATE admin_step_up_authorizations SET challenge_id='${C1}' WHERE ${bind}`)).rowCount).toBe(0);
      await a.query("UPDATE admin_step_up_authorizations SET verified_at=NULL,consumed_at=NULL,challenge_id=NULL,expires_at=now()+interval '5 minutes'");
    }
  });
  it('consume binds action, parameters, session, admin, target and validity', async () => {
    await a.query('UPDATE admin_step_up_authorizations SET verified_at=now()');
    for (const wrong of [consume.replace('payout_generate', 'payout_approve'), consume.replace('bound-generate-hash', 'other-hash'), consume.replace('session-a', 'session-b'), consume.replace(ADMIN, C2), consume.replace('target_id IS NULL', "target_id='other'")]) {
      expect((await a.query(`UPDATE admin_step_up_authorizations SET consumed_at=now() WHERE ${wrong}`)).rowCount).toBe(0);
    }
    for (const mutation of ['verified_at=NULL', "expires_at=now()-interval '1 second'"]) {
      await a.query(`UPDATE admin_step_up_authorizations SET ${mutation}`);
      expect((await a.query(`UPDATE admin_step_up_authorizations SET consumed_at=now() WHERE ${consume}`)).rowCount).toBe(0);
      await a.query("UPDATE admin_step_up_authorizations SET verified_at=now(),expires_at=now()+interval '5 minutes'");
    }
    expect((await a.query('SELECT consumed_at FROM admin_step_up_authorizations')).rows[0].consumed_at).toBeNull();
  });
});

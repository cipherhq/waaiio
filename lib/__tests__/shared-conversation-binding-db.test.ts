import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';

// Disposable PostgreSQL only. This suite never accepts a staging/production URL.
const pgBin = execFileSync('pg_config', ['--bindir'], {encoding:'utf8'}).trim();
const dir = mkdtempSync(join(tmpdir(), 'waaiio-binding-'));
let db: Client;
let started = false;
const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const ch = uuid(1), otherCh = uuid(2), a = uuid(3), b = uuid(4), sa = uuid(5), sb = uuid(6), picker = uuid(7);
const config = { host: dir, database: 'postgres', user: process.env.USER };
const query = async (sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows;
const read = async (channel = ch, phone = 'customer') => (await query('select get_shared_conversation($1,$2) c', [phone, channel]))[0].c;
const select = async (session = sa, version = 0, pickerId: string | null = null, pickerVersion: number | null = null) =>
  (await query('select select_shared_conversation($1,$2,$3,$4,$5,$6) ok', ['customer', ch, session, version, pickerId, pickerVersion]))[0].ok;

beforeAll(async () => {
  execFileSync(join(pgBin,'initdb'), ['-D', join(dir, 'data'), '-A', 'trust', '--no-locale'], { stdio: 'pipe' });
  execFileSync(join(pgBin,'pg_ctl'), ['-D', join(dir, 'data'), '-l', join(dir, 'server.log'), '-o', `-k ${dir} -c listen_addresses=''`, '-w', 'start'], { stdio: 'pipe' });
  started = true;
  db = new Client(config); await db.connect();
  await query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE TABLE whatsapp_channels (id uuid PRIMARY KEY, channel_type text, is_active boolean, connection_status text);
    CREATE TABLE businesses (id uuid PRIMARY KEY, status text, wa_method text, assigned_channel_id uuid);
    CREATE TABLE bot_sessions (id uuid PRIMARY KEY, whatsapp_number text, business_id uuid, is_active boolean,
      expires_at timestamptz, current_step text, session_data jsonb, version bigint DEFAULT 0);`);
  await db.query(readFileSync(join(process.cwd(), 'supabase/migrations/493_shared_conversation_binding.sql'), 'utf8'));
}, 30000);
afterAll(async () => {
  await db?.end();
  if (started) execFileSync(join(pgBin,'pg_ctl'), ['-D', join(dir, 'data'), '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await query('TRUNCATE bot_conversation_bindings, bot_sessions, businesses, whatsapp_channels CASCADE');
  await query(`INSERT INTO whatsapp_channels VALUES ($1,'shared',true,'active'),($2,'shared',true,'active');`, [ch, otherCh]);
  await query(`INSERT INTO businesses VALUES ($1,'active','shared',$3),($2,'active','shared',$3)`, [a,b,ch]);
  await query(`INSERT INTO bot_sessions VALUES ($1,'customer',$3,true,now()+interval '1 hour','select_date',$5,0),
    ($2,'customer',$4,true,now()+interval '1 hour','select_date',$5,0)`, [sa,sb,a,b,JSON.stringify({_inbound_channel_id:ch})]);
});
describe('explicit shared conversation selection — real PostgreSQL', () => {
  it('does not select either merchant from history alone', async () => { expect((await read()).session).toBeNull(); });
  it('selects A and retains A for subsequent context-free replies with two active merchants', async () => {
    expect(await select()).toBe(true); expect((await read()).session.id).toBe(sa);
    await query("UPDATE bot_sessions SET current_step='collect_name' WHERE id=$1",[sa]);
    expect((await read()).session.current_step).toBe('collect_name');
    expect((await query('SELECT is_active FROM bot_sessions WHERE id=$1',[sb]))[0].is_active).toBe(true);
  });
  it('isolates sender and receiving channel', async () => {
    await select(); expect((await read(otherCh)).session).toBeNull(); expect((await read(ch,'different')).session).toBeNull();
  });
  it.each(['is_active=false', "expires_at=now()-interval '1 second'"])('rejects invalid session %s', async (change) => {
    await select(); await query(`UPDATE bot_sessions SET ${change} WHERE id=$1`,[sa]);
    expect((await read()).session).toBeNull(); expect(await select(sa,1)).toBe(false);
  });
  it('does not follow a session rebound to a different business', async () => {
    await select(); await query('UPDATE bot_sessions SET business_id=$1 WHERE id=$2',[b,sa]);
    expect((await read()).session).toBeNull();
  });
  it.each(['directory_search','directory_results'])('resumes channel-bound %s navigation', async (step) => {
    await query(`INSERT INTO bot_sessions VALUES ($1,'customer',NULL,true,now()+interval '1 hour',$2,$3,0)`,
      [picker,step,JSON.stringify({_inbound_channel_id:ch,_conversation_version:0})]);
    expect((await read()).session.id).toBe(picker);
    expect((await read(otherCh)).session).toBeNull();
  });
  it('consumes a stored directory result using its businessId field', async () => {
    await query(`INSERT INTO bot_sessions VALUES ($1,'customer',NULL,true,now()+interval '1 hour','directory_results',$2,0)`,
      [picker,JSON.stringify({_inbound_channel_id:ch,_conversation_version:0,_directory_results:[{businessId:a}]})]);
    expect(await select(sa,0,picker,0)).toBe(true);
    expect((await read()).session.id).toBe(sa);
  });
  it('rejects reassigned business on lookup and selection', async () => {
    await select(); await query('UPDATE businesses SET assigned_channel_id=$1 WHERE id=$2',[otherCh,a]);
    expect((await read()).session).toBeNull(); expect(await select(sa,1)).toBe(false);
  });
  it('resumes and atomically consumes a stored picker before merchant sessions', async () => {
    await query(`INSERT INTO bot_sessions VALUES ($1,'customer',NULL,true,now()+interval '1 hour','select_business_suggestion',$2,2)`,
      [picker,JSON.stringify({_inbound_channel_id:ch,_conversation_version:0,suggestions:[{id:a},{id:b}]})]);
    expect((await read()).session.id).toBe(picker);
    expect(await select(sa,0,picker,1)).toBe(false);
    expect(await select(sa,0,picker,2)).toBe(true);
    expect((await read()).session.id).toBe(sa); expect(await select(sb,1,picker,2)).toBe(false);
  });
  it('rejects a picker choice absent from the stored options', async () => {
    await query(`INSERT INTO bot_sessions VALUES ($1,'customer',NULL,true,now()+interval '1 hour','select_business_suggestion',$2,0)`,
      [picker,JSON.stringify({_inbound_channel_id:ch,_conversation_version:0,suggestions:[{id:b}]})]);
    expect(await select(sa,0,picker,0)).toBe(false);
  });
  it('allows only one concurrent selection with the same expected version', async () => {
    const other = new Client(config); await other.connect();
    try {
      const results = await Promise.all([select(sa), other.query('select select_shared_conversation($1,$2,$3,0) ok',['customer',ch,sb]).then(r=>r.rows[0].ok)]);
      expect(results.sort()).toEqual([false,true]); expect((await read()).version).toBe(1);
    } finally { await other.end(); }
  });
  it('keeps a version tombstone after session deletion so stale requests cannot reset CAS', async () => {
    await select(); await query('DELETE FROM bot_sessions WHERE id=$1',[sa]);
    expect((await read()).version).toBe(1); expect(await select(sb,0)).toBe(false);
  });
  it('denies browser roles and grants only service execution, with RLS enabled', async () => {
    for (const role of ['anon','authenticated']) {
      const [row] = await query(`SELECT has_table_privilege($1,'bot_conversation_bindings','SELECT') tbl,
        has_function_privilege($1,'get_shared_conversation(text,uuid)','EXECUTE') rd,
        has_function_privilege($1,'select_shared_conversation(text,uuid,uuid,bigint,uuid,bigint)','EXECUTE') wr`,[role]);
      expect(row).toEqual({tbl:false,rd:false,wr:false});
    }
    expect((await query("select relrowsecurity from pg_class where oid='bot_conversation_bindings'::regclass"))[0].relrowsecurity).toBe(true);
    expect((await query("select has_function_privilege('service_role','get_shared_conversation(text,uuid)','EXECUTE') ok"))[0].ok).toBe(true);
  });
});

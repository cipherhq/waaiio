import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const url = process.env.TEST_DATABASE_URL;
if (!url && process.env.REQUIRE_PG_TESTS === 'true') throw new Error('TEST_DATABASE_URL required for rejection concurrency proof');
const suite = url ? describe : describe.skip;
suite('M498 manual settlement rejection guard — disposable local PostgreSQL', () => {
  let control: Client, a: Client, b: Client, c: Client;
  const name = `payout_reject_${randomUUID().replaceAll('-', '')}`;
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) throw new Error('Disposable localhost PostgreSQL only');
    control = new Client({ connectionString: url }); await control.connect();
    await control.query(`CREATE DATABASE ${name}`);
    parsed.pathname = `/${name}`;
    a = new Client({ connectionString: parsed.toString() }); b = new Client({ connectionString: parsed.toString() }); c = new Client({ connectionString: parsed.toString() });
    await Promise.all([a.connect(), b.connect(), c.connect()]);
    await a.query(`CREATE TABLE public.business_payouts(id uuid primary key,status text,transfer_method text,flags jsonb DEFAULT '[]',rejected_reason text,updated_at timestamptz);
      CREATE TABLE public.payout_adjustments(id uuid primary key,applied_to_payout_id uuid);`);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      if (!(await a.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount) await a.query(`CREATE ROLE ${role}`);
    }
    await a.query(readFileSync('lib/__tests__/fixtures/payout-reject-prerequisites.sql', 'utf8'));
    await a.query(readFileSync('supabase/migrations/498_manual_settlement_rejection_guard.sql', 'utf8'));
  }, 15_000);
  afterAll(async () => {
    await Promise.all([a?.end(), b?.end(), c?.end()]);
    if (control) { await control.query(`DROP DATABASE IF EXISTS ${name}`); await control.end(); }
  });
  async function seed(status: string, method: string | null) {
    const id = randomUUID(), adj = randomUUID();
    await a.query('INSERT INTO business_payouts(id,status,transfer_method)VALUES($1,$2,$3)', [id,status,method]);
    await a.query('INSERT INTO payout_adjustments(id,applied_to_payout_id)VALUES($1,$2)', [adj,id]);
    return { id, adj };
  }
  it('rejects manual approval committed while rejection waits; preserves payout and adjustment link', async () => {
    const {id,adj} = await seed('pending',null);
    expect((await c.query('SELECT status FROM business_payouts WHERE id=$1',[id])).rows[0].status).toBe('pending');
    await a.query('BEGIN');
    await a.query("UPDATE business_payouts SET status='approved',transfer_method='manual_bank' WHERE id=$1",[id]);
    const pid=(await b.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    const outcome=b.query("SELECT * FROM reject_payout_and_release_adjustments($1,'fixture')",[id]).then(()=>'unexpected success', e=>e.message);
    let blocked=false;
    for(let i=0;i<100;i++){if((await c.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0]?.wait_event_type==='Lock'){blocked=true;break;}await new Promise(r=>setTimeout(r,10));}
    await a.query('COMMIT');
    expect(blocked).toBe(true); expect(await outcome).toContain('manual_settlement_in_flight');
    expect((await c.query('SELECT status,transfer_method FROM business_payouts WHERE id=$1',[id])).rows[0]).toEqual({status:'approved',transfer_method:'manual_bank'});
    expect((await c.query('SELECT applied_to_payout_id FROM payout_adjustments WHERE id=$1',[adj])).rows[0].applied_to_payout_id).toBe(id);
  });
  it.each([['pending',null],['held',null],['approved','paystack_transfer']])('retains allowed rejection %s/%s',async(status,method)=>{
    const {id,adj}=await seed(status!,method);
    expect((await a.query("SELECT * FROM reject_payout_and_release_adjustments($1,'fixture')",[id])).rowCount).toBe(1);
    expect((await a.query('SELECT status FROM business_payouts WHERE id=$1',[id])).rows[0].status).toBe('rejected');
    expect((await a.query('SELECT applied_to_payout_id FROM payout_adjustments WHERE id=$1',[adj])).rows[0].applied_to_payout_id).toBeNull();
  });
  it('preserves service-only EXECUTE grants and invoker/search_path contract',async()=>{
    const r=(await a.query("SELECT prosecdef,proconfig,has_function_privilege('anon',oid,'EXECUTE') anon,has_function_privilege('authenticated',oid,'EXECUTE') authenticated,has_function_privilege('service_role',oid,'EXECUTE') service FROM pg_proc WHERE oid='public.reject_payout_and_release_adjustments(uuid,text)'::regprocedure")).rows[0];
    expect(r).toMatchObject({prosecdef:false,anon:false,authenticated:false,service:true});expect(r.proconfig).toContain('search_path=public, pg_temp');
  });
});

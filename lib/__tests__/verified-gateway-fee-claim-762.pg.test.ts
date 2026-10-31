/**
 * M485 executable contract. Real migration/RPCs and independent PG sessions.
 * The designated PG job requires TEST_DATABASE_URL and zero skips.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const url = process.env.TEST_DATABASE_URL;
if (!url && process.env.REQUIRE_PG_TESTS === 'true') throw new Error('TEST_DATABASE_URL required for M485');
const dbDescribe = url ? describe : describe.skip;
const migration = (name: string) => readFileSync(resolve('supabase/migrations', name), 'utf8');
const legacyIds = Array.from({ length: 8 }, () => randomUUID());
const claimSql = 'SELECT public.claim_payment_finalization_with_verified_fee($1,$2,$3,$4,$5,$6,$7) AS result';
const args = (id: string, fee: number | string | null = 8, supplied: boolean | null = true) =>
  [id, 'paystack', id, 5000, 'NGN', supplied, fee];
const legacySql = 'SELECT public.claim_payment_finalization($1) AS result';

dbDescribe('M485 verified fee claim — real PostgreSQL', () => {
  let admin: Client;
  let first: Client;
  let second: Client;
  let rollbackEvidence: { columns: number; definition: boolean; acl: boolean };
  const open = async () => {
    const client = new Client({ connectionString: url, query_timeout: 15000 });
    await client.connect();
    await client.query("SET statement_timeout = '12s'");
    return client;
  };
  const row = async (id: string) => (await admin.query('SELECT * FROM public.payments WHERE id=$1', [id])).rows[0];
  const fresh = async (extra = '') => {
    const id = randomUUID();
    await admin.query(`INSERT INTO public.payments(id,gateway_reference ${extra ? ',' + extra.split('=')[0] : ''})
      VALUES($1::uuid,$1::text ${extra ? ',' + extra.slice(extra.indexOf('=') + 1) : ''})`, [id]);
    return id;
  };
  const claim = async (id: string, fee: number | string | null = 8, supplied: boolean | null = true, client?: Client) =>
    (await (client || first).query(claimSql, args(id, fee, supplied))).rows[0].result;
  const legacy = async (id: string, client?: Client) => (await (client || first).query(legacySql, [id])).rows[0].result;
  const release = async (id: string, token: string) =>
    (await first.query('SELECT release_payment_finalization($1,$2) AS result', [id, token])).rows[0].result;

  beforeAll(async () => {
    admin = await open();
    await admin.query(`
      CREATE SCHEMA IF NOT EXISTS extensions;
      CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
      DO $$ BEGIN
        IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
        IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
        IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
      END $$;
      CREATE TABLE public.payments (
        id uuid PRIMARY KEY, amount numeric NOT NULL DEFAULT 5000,
        currency text NOT NULL DEFAULT 'NGN', gateway text NOT NULL DEFAULT 'paystack',
        gateway_reference text UNIQUE, status text NOT NULL DEFAULT 'success',
        booking_id uuid, invoice_id uuid, campaign_id uuid, reservation_id uuid, order_id uuid,
        gateway_fee integer NOT NULL DEFAULT 0, metadata jsonb NOT NULL DEFAULT '{}'
      );
    `);
    // Apply the actual M314 lifecycle definitions, including unchanged complete/release.
    // Its unrelated order-stock function is parsed but never called in this fixture.
    await admin.query(migration('314_payment_finalization_lifecycle.sql'));
    const acl = migration('351_security_definer_acl_hardening.sql').split('\n').filter(line =>
      /^(REVOKE|GRANT).*public\.(claim|complete|release)_payment_finalization\(/.test(line)).join('\n');
    if (acl.split('\n').length !== 12) throw new Error('M351 lifecycle ACL fixture changed');
    await admin.query(acl);
    for (const [index, id] of legacyIds.entries()) {
      await admin.query(`INSERT INTO payments(id,gateway_reference,gateway_fee,status,finalization_processing_at,finalization_completed_at)
        VALUES($1::uuid,$1::text,7,$2,$3,$4)`, [id, index === 0 ? 'pending' : 'success',
        index === 1 ? new Date() : null, index === 2 ? new Date() : null]);
    }
    const before = (await admin.query(`SELECT pg_get_functiondef('claim_payment_finalization(uuid)'::regprocedure) AS definition,
      proacl::text AS acl FROM pg_proc WHERE oid='claim_payment_finalization(uuid)'::regprocedure`)).rows[0];
    // Fail after the full DDL and self-checks, before COMMIT; then compare prior state.
    const sql = migration('485_verified_gateway_fee_claim.sql');
    await expect(admin.query(sql.replace(/COMMIT;\s*$/, () => "DO $$ BEGIN RAISE EXCEPTION 'rollback_probe'; END $$; COMMIT;"))).rejects.toThrow('rollback_probe');
    await admin.query('ROLLBACK');
    const after = (await admin.query(`SELECT pg_get_functiondef('claim_payment_finalization(uuid)'::regprocedure) AS definition,
      proacl::text AS acl FROM pg_proc WHERE oid='claim_payment_finalization(uuid)'::regprocedure`)).rows[0];
    const columns = (await admin.query(`SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema='public' AND table_name='payments' AND column_name='gateway_fee_contract_version'`)).rows[0].n;
    rollbackEvidence = { columns, definition: before.definition === after.definition, acl: before.acl === after.acl };
    await admin.query(sql);
    await admin.query('GRANT USAGE ON SCHEMA public TO service_role,anon,authenticated; GRANT SELECT,UPDATE ON payments TO service_role');
    first = await open(); second = await open();
    await first.query('SET ROLE service_role'); await second.query('SET ROLE service_role');
  }, 30000);

  afterAll(async () => {
    await Promise.all([first, second, admin].filter(Boolean).map(async client => {
      await client.query('ROLLBACK'); await client.end();
    }));
  });

  it('rolls back full migration DDL and preserves previous claim definition/ACL', () => {
    expect(rollbackEvidence).toEqual({ columns: 0, definition: true, acl: true });
  });
  it('leaves existing rows unclassified and marks only later inserts', async () => {
    expect((await row(legacyIds[0])).gateway_fee_contract_version).toBeNull();
    expect((await row(await fresh())).gateway_fee_contract_version).toBe(1);
  });
  it('atomically returns accepted fee and the exact legacy claim keys', async () => {
    const id = await fresh(); const result = await claim(id, 8);
    expect(Object.keys(result).sort()).toEqual(['claimed','claim_token','payment_id','amount','booking_id','invoice_id','campaign_id','reservation_id','order_id','gateway_fee'].sort());
    expect(result.gateway_fee).toBe(8);
    expect(await row(id)).toMatchObject({ gateway_fee: 8, verified_gateway_fee: 8, gateway_fee_claim_snapshot: 8, finalization_claim_token: result.claim_token });
  });
  it.each([0, 2147483647])('accepts integer boundary %s', async fee => {
    const id = await fresh(); expect((await claim(id, fee)).gateway_fee).toBe(fee);
    expect((await row(id)).verified_gateway_fee).toBe(fee);
  });
  it.each([-1, 0.5, 2147483648, 'NaN', 'Infinity', '-Infinity', null])('rejects invalid supplied value %s without mutation', async fee => {
    const id = await fresh(); expect(await claim(id, fee)).toMatchObject({ claimed: false, reason: 'invalid_gateway_fee' });
    expect(await row(id)).toMatchObject({ gateway_fee: 0, verified_gateway_fee: null, gateway_fee_claim_sealed_at: null, finalization_claim_token: null });
  });
  it.each([[false, 0], [null, null]] as const)('rejects malformed presence %s / %s', async (supplied, fee) => {
    const id = await fresh(); expect((await claim(id, fee, supplied)).reason).toBe('invalid_gateway_fee');
  });
  it.each([[1,'stripe'], [2,'foreign'], [3,4999], [4,'USD']] as const)('rejects canonical mismatch at parameter %s', async (index, value) => {
    const id=await fresh(); const values: unknown[]=args(id); values[index]=value;
    expect((await first.query(claimSql,values)).rows[0].result.claimed).toBe(false);
    expect((await row(id)).finalization_claim_token).toBeNull();
  });
  it('returns missing/non-success outcomes without a seal', async () => {
    expect((await claim(randomUUID())).reason).toBe('not_found');
    const id=await fresh("status='pending'");
    expect((await claim(id)).reason).toBe('not_successful');
    expect((await row(id)).gateway_fee_claim_sealed_at).toBeNull();
  });
  it('seals absent separately from supplied zero across release and expiry', async () => {
    const id=await fresh(); const a=await claim(id,null,false);
    expect((await row(id)).verified_gateway_fee).toBeNull();
    await release(id,a.claim_token);
    expect((await claim(id,0)).reason).toBe('fee_snapshot_sealed');
    const b=await claim(id,null,false);
    await admin.query("UPDATE payments SET finalization_processing_at=now()-interval '5 minutes' WHERE id=$1",[id]);
    expect((await claim(id,0)).reason).toBe('fee_snapshot_sealed');
    expect((await legacy(id)).claimed).toBe(true);
    expect(b.claim_token).not.toBe(a.claim_token);
  });
  it('allows identical recovery and rejects changed fee after partial work/release', async () => {
    const id=await fresh(); const a=await claim(id,8);
    await first.query("UPDATE payments SET metadata='{\"partial\":true}' WHERE id=$1",[id]);
    expect((await release(id,a.claim_token)).released).toBe(true);
    expect((await claim(id,9)).reason).toBe('fee_conflict');
    const b=await claim(id,8); expect(b.claimed).toBe(true);
    expect(b.claim_token).not.toBe(a.claim_token);
    expect(await row(id)).toMatchObject({ verified_gateway_fee:8,metadata:{partial:true} });
  });
  it('keeps five-minute lease and complete/release token fencing', async () => {
    const id=await fresh(); const a=await legacy(id);
    expect((await legacy(id)).reason).toBe('processing_in_progress');
    expect((await release(id,randomUUID())).reason).toBe('token_mismatch');
    await admin.query("UPDATE payments SET finalization_processing_at=now()-interval '5 minutes' WHERE id=$1",[id]);
    const b=await legacy(id); expect(b.claimed).toBe(true);
    expect((await first.query('SELECT complete_payment_finalization($1,$2) AS result',[id,a.claim_token])).rows[0].result.reason).toBe('token_mismatch');
    expect((await first.query('SELECT complete_payment_finalization($1,$2) AS result',[id,b.claim_token])).rows[0].result.completed).toBe(true);
    expect(await legacy(id)).toEqual({claimed:false,already_completed:true,reason:'already_finalized'});
    expect((await release(id,b.claim_token)).reason).toBe('already_completed');
  });
  it.each([0,1,2,3])('protects unclassified pending/active/completed/released history %s', async index => {
    const id=legacyIds[index];
    await first.query("UPDATE payments SET gateway_fee=99,metadata='{\"card\":\"kept\"}' WHERE id=$1",[id]);
    expect(await row(id)).toMatchObject({gateway_fee:7,verified_gateway_fee:null,metadata:{card:'kept'}});
    if (index===0) await first.query("UPDATE payments SET status='success' WHERE id=$1",[id]);
    expect((await claim(id,8)).reason).toBe('legacy_fee_reconciliation_required');
    const noChange=await claim(id,7);
    expect(noChange.reason || noChange.claimed).toBe(index===1?'processing_in_progress':index===2?'already_finalized':true);
    expect((await row(id)).verified_gateway_fee).toBeNull();
  });
  it('preserves sealed provenance and card metadata during old standalone updates', async () => {
    const id=await fresh(); await claim(id,8);
    const before=await row(id);
    await first.query("UPDATE payments SET gateway_fee=0, verified_gateway_fee=NULL, gateway_fee_claim_snapshot=NULL, gateway_fee_claim_sealed_at=NULL, metadata='{\"card\":\"kept\"}' WHERE id=$1",[id]);
    const after=await row(id);
    expect(after).toMatchObject({gateway_fee:8,verified_gateway_fee:8,gateway_fee_claim_snapshot:8,metadata:{card:'kept'}});
    expect(after.gateway_fee_claim_sealed_at).toEqual(before.gateway_fee_claim_sealed_at);
  });
  it('rejects classification upgrades and direct provenance creation by service_role', async () => {
    await expect(first.query('UPDATE payments SET gateway_fee_contract_version=1 WHERE id=$1',[legacyIds[4]])).rejects.toThrow('immutable');
    const id=await fresh();
    await expect(first.query('UPDATE payments SET verified_gateway_fee=0,gateway_fee_claim_snapshot=0,gateway_fee_claim_sealed_at=now() WHERE id=$1',[id])).rejects.toThrow('requires claim RPC');
    await expect(first.query('UPDATE payments SET gateway_fee_contract_version=NULL WHERE id=$1',[id])).rejects.toThrow('immutable');
  });
  it('rolls back fee and claim together when a post-write trigger fails', async () => {
    const id=await fresh();
    await admin.query(`CREATE FUNCTION public.m485_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id='${id}'::uuid AND NEW.gateway_fee_claim_sealed_at IS NOT NULL THEN RAISE EXCEPTION 'claim_probe'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER m485_fail AFTER UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION public.m485_fail();`);
    try { await expect(claim(id,8)).rejects.toThrow('claim_probe'); }
    finally { await admin.query('DROP TRIGGER m485_fail ON payments; DROP FUNCTION public.m485_fail()'); }
    expect(await row(id)).toMatchObject({status:'success',gateway_fee:0,verified_gateway_fee:null,gateway_fee_claim_sealed_at:null,finalization_claim_token:null});
    expect((await claim(id,9)).gateway_fee).toBe(9);
  });
  it('retains committed seal when the caller discards the response', async () => {
    const id=await fresh();
    await first.query('BEGIN'); await claim(id,8); await first.query('COMMIT');
    // Deliberately discard the returned token, as with a lost commit response.
    expect((await claim(id,8)).reason).toBe('processing_in_progress');
    expect((await claim(id,9)).reason).toBe('fee_conflict');
    expect(await row(id)).toMatchObject({gateway_fee:8,verified_gateway_fee:8});
  });

  async function waitBlocked(pid: number) {
    const deadline=Date.now()+5000;
    while(Date.now()<deadline) {
      const result=await admin.query('SELECT cardinality(pg_blocking_pids($1)) AS n',[pid]);
      if(result.rows[0].n>0) return;
    }
    throw new Error('Second session never reached the row-lock barrier');
  }
  it.each(['same','different','old-first','new-first','absent-first','supplied-first','old-update'] as const)(
    'serializes two sessions: %s', async scenario => {
      const id=await fresh();
      await first.query('BEGIN');
      const winner=scenario==='old-first'?await legacy(id):await claim(id,scenario==='absent-first'?null:8,scenario!=='absent-first');
      const pid=(await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const follower=scenario==='new-first'
        ? second.query(legacySql,[id])
        : scenario==='old-update'
          ? second.query("UPDATE payments SET gateway_fee=0,metadata='{\"card\":\"kept\"}' WHERE id=$1 RETURNING gateway_fee AS result",[id])
          : second.query(claimSql,args(id,scenario==='different'?9:scenario==='supplied-first'?null:8,scenario!=='supplied-first'));
      // Attach a rejection handler immediately; always release the lock on assertion failure.
      const outcome=follower.then(value=>({value,error:null}),error=>({value:null,error}));
      try { await waitBlocked(pid); } finally { await first.query('COMMIT'); }
      const finished=await outcome;
      expect(finished.error).toBeNull();
      const result=finished.value!.rows[0].result;
      const expected=scenario==='different'?'fee_conflict':
        scenario==='old-first'||scenario==='absent-first'?'fee_snapshot_sealed':'processing_in_progress';
      if(scenario==='old-update') expect(result).toBe(8);
      else expect(result.reason).toBe(expected);
      expect((await row(id)).finalization_claim_token).toBe(winner.claim_token);
      expect((await row(id)).gateway_fee).toBe(scenario==='old-first'||scenario==='absent-first'?0:8);
    });

  it.each(['anon','authenticated'])('denies both claim RPCs and lifecycle RPCs to %s', async role => {
    const client=await open();
    try {
      await client.query('SET ROLE '+role);
      for(const [sql,values] of [[legacySql,[randomUUID()]],[claimSql,args(randomUUID())],
        ['SELECT complete_payment_finalization($1,$2)',[randomUUID(),randomUUID()]],
        ['SELECT release_payment_finalization($1,$2)',[randomUUID(),randomUUID()]]] as const) {
        await expect(client.query(sql,[...values])).rejects.toThrow('permission denied');
      }
    } finally {await client.end();}
  });
  it('verifies final function ownership, path, PUBLIC ACL and integer schema', async () => {
    const functions=(await admin.query(`SELECT p.proname,p.prosecdef,p.proconfig,
      p.proowner=(SELECT relowner FROM pg_class WHERE oid='payments'::regclass) AS owner_ok,
      EXISTS(SELECT FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_exec
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname IN ('claim_payment_finalization','claim_payment_finalization_with_verified_fee')`)).rows;
    expect(functions).toHaveLength(2);
    for(const f of functions) expect(f).toMatchObject({prosecdef:true,proconfig:['search_path=public, extensions'],owner_ok:true,public_exec:false});
    const cols=(await admin.query("SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='payments' AND column_name IN ('gateway_fee','verified_gateway_fee','gateway_fee_claim_snapshot')")).rows;
    expect(cols).toHaveLength(3); expect(cols.every(c=>c.data_type==='integer')).toBe(true);
  });
});

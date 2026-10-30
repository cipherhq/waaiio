import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const url = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_PG_TESTS === 'true' && !url) throw new Error('Disposable PostgreSQL is required');
const suite = url ? describe : describe.skip;
const id = (n: number) => '00000000-0000-4000-a762-' + n.toString(16).padStart(12, '0');
const owner = id(1), other = id(2), business = id(3), otherBusiness = id(4), party = id(5), otherParty = id(6);
const t1 = id(7), t2 = id(8), foreignTable = id(9), i1 = id(10), i2 = id(11), group = id(12);
suite('M486 actual migrations and atomic seating (disposable PG)', () => {
  let pool: pg.Pool;
  let migratedPin = false;
  const rpc = async (op: string, payload: Record<string, unknown> = {}, actor = owner) =>
    (await pool.query('SELECT public.party_seating_486($1,$2,$3,$4) AS value', [party, actor, op, payload])).rows[0].value;
  async function fixtures() {
    await pool.query(`
      INSERT INTO public.businesses(id,owner_id,name) VALUES($1,$2,'Seating'),($3,$4,'Other');
    `, [business, owner, otherBusiness, other]);
    await pool.query("INSERT INTO public.parties(id,business_id,name,date) VALUES($1,$2,'Party','2027-01-01'),($3,$4,'Other','2027-01-01')",
      [party,business,otherParty,otherBusiness]);
    await pool.query("INSERT INTO public.party_tables(id,business_id,party_id,name,capacity) VALUES($1,$2,$3,'A',2),($4,$2,$3,'B',2),($5,$6,$7,'Other',2)",
      [t1,business,party,t2,foreignTable,otherBusiness,otherParty]);
    await pool.query("INSERT INTO public.event_invites(id,business_id,party_id,guest_phone,guest_name,status) VALUES($1,$2,$3,'100','One','accepted'),($4,$2,$3,'200','Two','accepted')",
      [i1,business,party,i2]);
  }
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 6 });
    await pool.query(`
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE TABLE IF NOT EXISTS auth.users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        raw_app_meta_data JSONB DEFAULT '{}'
      );
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $
        SELECT COALESCE(
          NULLIF(current_setting('request.jwt.claim.sub', true), ''),
          NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
        )::uuid;
      $ LANGUAGE SQL STABLE;

      DO $ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF; END $;
      DO $ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; END $;
      DO $ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF; END $;

      GRANT USAGE ON SCHEMA auth TO service_role, anon, authenticated;
      GRANT SELECT ON auth.users TO service_role;
      GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

      CREATE OR REPLACE FUNCTION public.has_admin_role(roles text[]) RETURNS boolean
        LANGUAGE sql STABLE AS $fn$ SELECT false $fn$;

      CREATE TABLE IF NOT EXISTS public.businesses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id UUID NOT NULL,
        name TEXT NOT NULL DEFAULT 'Test',
        slug TEXT UNIQUE,
        status TEXT DEFAULT 'active'
      );

      CREATE TABLE IF NOT EXISTS public.parties (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        name VARCHAR(200) NOT NULL,
        date DATE NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'active',
        max_guests INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.event_invites (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        event_id UUID,
        party_id UUID REFERENCES parties(id) ON DELETE CASCADE,
        guest_phone VARCHAR(20) NOT NULL,
        guest_name VARCHAR(100),
        status VARCHAR(20) NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','accepted','maybe','declined')),
        plus_ones INTEGER NOT NULL DEFAULT 0,
        tags TEXT[] DEFAULT '{}',
        invite_token VARCHAR(32) NOT NULL DEFAULT substr(replace(gen_random_uuid()::text, '-', ''), 1, 24),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.businesses TO service_role, authenticated;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.parties TO service_role, authenticated;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.event_invites TO service_role, authenticated;

    `);
    await pool.query(readFileSync(join(process.cwd(), 'supabase/migrations/457_party_tables_seats.sql'), 'utf8'));
    await fixtures();
    await pool.query('UPDATE public.event_invites SET table_id=$1 WHERE id=$2', [t1,i1]);
    await pool.query(readFileSync(join(process.cwd(), 'supabase/migrations/486_party_seating_groups_pins_atomic_plans.sql'), 'utf8'));
    migratedPin = (await pool.query('SELECT seating_pinned FROM public.event_invites WHERE id=$1',[i1])).rows[0].seating_pinned;
  }, 30000);
  beforeEach(async () => {
    await pool.query('DELETE FROM public.event_invites WHERE party_id=ANY($1)', [[party,otherParty]]);
    await pool.query('DELETE FROM public.party_seating_group_tables WHERE party_id=ANY($1)', [[party,otherParty]]);
    await pool.query('DELETE FROM public.party_seating_groups WHERE party_id=ANY($1)', [[party,otherParty]]);
    await pool.query('DELETE FROM public.party_seating_commits WHERE party_id=ANY($1)', [[party,otherParty]]);
    await pool.query('DELETE FROM public.party_tables WHERE party_id=ANY($1)', [[party,otherParty]]);
    await pool.query('DELETE FROM public.parties WHERE id=ANY($1)', [[party,otherParty]]);
    await pool.query('DELETE FROM public.businesses WHERE id=ANY($1)', [[business,otherBusiness]]);
    await fixtures();
  });
  afterAll(async () => { if (pool) await pool.end(); });
  const plan = async (assignments = [{ invite_id:i1, table_id:t1 },{ invite_id:i2, table_id:t2 }], partial = false) => ({
    op:'commit', seed:1, fingerprint:(await rpc('snapshot')).fingerprint, planHash:'a'.repeat(64),
    acknowledgePartial:partial, assignments,
  });

  it('preserves existing assignment as pinned during the actual migration', () => {
    expect(migratedPin).toBe(true);
  });
  it('allows owner and denies an unrelated actor', async () => {
    expect((await rpc('snapshot')).guests).toHaveLength(2);
    await expect(rpc('snapshot',{},other)).rejects.toMatchObject({ code:'42501' });
  });
  it('enforces RPC grants, fixed search_path, RLS and owner-only group reads', async () => {
    const result = await pool.query(`SELECT
      has_function_privilege('anon','public.party_seating_486(uuid,uuid,text,jsonb)','EXECUTE') AS anon,
      has_function_privilege('authenticated','public.party_seating_486(uuid,uuid,text,jsonb)','EXECUTE') AS member,
      has_function_privilege('service_role','public.party_seating_486(uuid,uuid,text,jsonb)','EXECUTE') AS service,
      (SELECT proconfig FROM pg_proc WHERE oid='public.party_seating_486(uuid,uuid,text,jsonb)'::regprocedure) AS config`);
    expect(result.rows[0]).toMatchObject({ anon:false,member:false,service:true });
    expect(result.rows[0].config).toContain('search_path=public, extensions');
    await rpc('save_group',{ name:'Family', table_ids:[t1] });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE authenticated');
      await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[owner]);
      expect((await client.query('SELECT * FROM public.party_seating_groups')).rows).toHaveLength(1);
      await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[other]);
      expect((await client.query('SELECT * FROM public.party_seating_groups')).rows).toHaveLength(0);
      await expect(client.query('SELECT public.party_seating_486($1,$2,$3,$4)',[party,owner,'snapshot',{}])).rejects.toMatchObject({ code:'42501' });
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
  it('validates group allowed tables and reads saved configuration', async () => {
    const saved = await rpc('save_group',{ name:'Family',table_ids:[t1,t2] });
    expect(saved.groups[0].table_ids).toEqual([t1,t2]);
    await expect(rpc('save_group',{ name:'Invalid',table_ids:[foreignTable] })).rejects.toMatchObject({ code:'23514' });
    expect((await rpc('snapshot')).groups).toHaveLength(1);
  });
  it('prevents cross-party membership and direct table assignment', async () => {
    await pool.query('INSERT INTO public.party_seating_groups(id,party_id,business_id,name) VALUES($1,$2,$3,$4)',[group,otherParty,otherBusiness,'Foreign']);
    await expect(rpc('membership',{invite_id:i1,group_id:group})).rejects.toMatchObject({code:'23514'});
    await expect(pool.query('UPDATE public.event_invites SET table_id=$1 WHERE id=$2',[foreignTable,i1])).rejects.toMatchObject({code:'23514'});
  });
  it('manual assignment pins; unpin persists; table deletion cannot silently unassign', async () => {
    let saved = await rpc('manual',{invite_id:i1,table_id:t1});
    expect(saved.guests.find((g: {id:string}) => g.id===i1).seating_pinned).toBe(true);
    await expect(pool.query('DELETE FROM public.party_tables WHERE id=$1',[t1])).rejects.toMatchObject({code:'23514'});
    saved = await rpc('pin',{invite_id:i1,pinned:false});
    expect(saved.guests.find((g: {id:string}) => g.id===i1).seating_pinned).toBe(false);
  });
  it('commits a complete plan atomically and preserves replay identity', async () => {
    const payload = await plan();
    const saved = await rpc('commit',payload);
    expect(saved.success).toBe(true);
    expect(saved.snapshot.guests.every((g: {seating_pinned:boolean}) => !g.seating_pinned)).toBe(true);
    expect(await rpc('commit',payload)).toEqual(saved);
    expect(await rpc('replay',Object.fromEntries(Object.entries(payload).filter(([k])=>k!=='assignments')))).toEqual(saved);
    await expect(rpc('replay',{...payload,seed:2})).rejects.toMatchObject({code:'40001'});
  });
  it('rejects moving a pin and rolls back the entire plan', async () => {
    await rpc('manual',{invite_id:i1,table_id:t1});
    const before = await rpc('snapshot');
    await expect(rpc('commit',await plan([{invite_id:i1,table_id:t2},{invite_id:i2,table_id:t1}]))).rejects.toMatchObject({code:'23514'});
    expect(await rpc('snapshot')).toEqual(before);
  });
  it('permits validated swaps between full tables without disabling M457 triggers', async () => {
    await pool.query('UPDATE public.event_invites SET plus_ones=1 WHERE party_id=$1',[party]);
    await rpc('commit',await plan());
    const swapped = await plan([{invite_id:i1,table_id:t2},{invite_id:i2,table_id:t1}]);
    swapped.planHash = 'b'.repeat(64);
    const saved = await rpc('commit',swapped);
    expect(saved.snapshot.guests.find((g: {id:string})=>g.id===i1).table_id).toBe(t2);
    expect(saved.snapshot.guests.find((g: {id:string})=>g.id===i2).table_id).toBe(t1);
  });
  it('capacity-conflicting pinned RSVP growth preserves status, weight and table', async () => {
    await rpc('manual',{invite_id:i1,table_id:t1});
    const before = await rpc('snapshot');
    await expect(pool.query("UPDATE public.event_invites SET plus_ones=2,status='maybe' WHERE id=$1",[i1])).rejects.toThrow();
    expect(await rpc('snapshot')).toEqual(before);
  });
  it('requires explicit partial acknowledgment and persists shown overflow unassigned', async () => {
    const assignments = [{invite_id:i1,table_id:t1},{invite_id:i2,table_id:null}] as {invite_id:string;table_id:string|null}[];
    const payload = { ...(await plan()), assignments };
    await expect(rpc('commit',payload)).rejects.toMatchObject({code:'23514'});
    const saved = await rpc('commit',{...payload,acknowledgePartial:true});
    expect(saved.snapshot.guests.find((g: {id:string})=>g.id===i2).table_id).toBeNull();
  });
  it('rejects incomplete, duplicate and over-capacity plans without partial writes', async () => {
    const before = await rpc('snapshot');
    await expect(rpc('commit',{...(await plan()),assignments:[{invite_id:i1,table_id:t1}]})).rejects.toMatchObject({code:'23514'});
    await expect(rpc('commit',{...(await plan()),assignments:[{invite_id:i1,table_id:t1},{invite_id:i1,table_id:t2}]})).rejects.toMatchObject({code:'23514'});
    await pool.query('UPDATE public.event_invites SET plus_ones=1 WHERE id=$1',[i1]);
    const weighted = await rpc('snapshot');
    await expect(rpc('commit',await plan([{invite_id:i1,table_id:t1},{invite_id:i2,table_id:t1}]))).rejects.toThrow();
    expect(await rpc('snapshot')).toEqual(weighted);
    expect(before.guests.every((g: {table_id:string|null})=>g.table_id===null)).toBe(true);
  });
  it('protects allowed tables and refuses deleting assigned group permissions', async () => {
    const s = await rpc('save_group',{ name:'Family',table_ids:[t1] });
    const g = s.groups[0].id;
    await rpc('membership',{invite_id:i1,group_id:g});
    await expect(rpc('manual',{invite_id:i1,table_id:t2})).rejects.toMatchObject({code:'23514'});
    await rpc('manual',{invite_id:i1,table_id:t1});
    await expect(rpc('save_group',{id:g,name:'Family',table_ids:[t2]})).rejects.toMatchObject({code:'23514'});
    expect((await rpc('snapshot')).groups[0].table_ids).toEqual([t1]);
  });
  it.each(['manual','growth','capacity','group'])('rejects stale commit after concurrent %s write', async kind => {
    const payload = await plan();
    const writer = await pool.connect();
    const committer = await pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query("SELECT pg_advisory_xact_lock(hashtext('party:' || $1::text))",[party]);
      const pid = (await committer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const waiting = committer.query('SELECT public.party_seating_486($1,$2,$3,$4)',[party,owner,'commit',payload])
        .then(() => ({code:'unexpected success'}), error => ({code:error.code}));
      let blocked = false;
      for (let n=0;n<100;n++) {
        const row = (await pool.query('SELECT wait_event FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0];
        if (row?.wait_event==='advisory') { blocked=true; break; }
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      expect(blocked).toBe(true);
      if(kind==='manual') await writer.query('UPDATE public.event_invites SET table_id=$1 WHERE id=$2',[t1,i1]);
      if(kind==='growth') await writer.query('UPDATE public.event_invites SET plus_ones=1 WHERE id=$1',[i1]);
      if(kind==='capacity') await writer.query('UPDATE public.party_tables SET capacity=3 WHERE id=$1',[t1]);
      if(kind==='group') await writer.query('INSERT INTO public.party_seating_groups(id,party_id,business_id,name) VALUES($1,$2,$3,$4)',[group,party,business,'New']);
      await writer.query('COMMIT');
      expect((await waiting).code).toBe('40001');
    } finally { await writer.query('ROLLBACK'); writer.release(); committer.release(); }
  }, 15000);
  it('serializes competing commits, allowing one and rejecting the stale other', async () => {
    const payload = await plan();
    const results = await Promise.allSettled([rpc('commit',payload),rpc('commit',{...payload,planHash:'b'.repeat(64)})]);
    expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);
    const rejected = results.find(x=>x.status==='rejected') as PromiseRejectedResult;
    expect(rejected.reason.code).toBe('40001');
  });
});

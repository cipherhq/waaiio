import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const url = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_PG_TESTS === 'true' && !url) throw new Error('Disposable PostgreSQL is required');
const suite = url ? describe : describe.skip;
const id = (n: number) => '00000000-0000-4000-a489-' + n.toString(16).padStart(12, '0');
const owner=id(1), other=id(2), business=id(3), otherBusiness=id(4), party=id(5), otherParty=id(6), invite=id(7), table=id(8);
const questions = [{id:'diet',label:'Meal?',type:'short_text',required:true},{id:'access',label:'Step-free access?',type:'yes_no',required:true}];
suite('M489 Party Questions with real M457/M486 capacity authority', () => {
  let pool: pg.Pool;
  const defs = (payload: unknown = {revision:0,questions}, actor=owner) => pool.query('SELECT public.party_questions_489($1,$2,$3) value',[party,actor,payload]);
  const complete = (payload: unknown = {status:'accepted',plus_ones:0,revision:1,answers:{diet:'Vegetarian',access:false}}, sender: string|null=null, biz: string|null=null) => pool.query('SELECT public.complete_party_rsvp_489($1,$2,$3,$4) value',['party-token-489',payload,sender,biz]);
  const saved = async () => (await pool.query('SELECT * FROM public.event_invites WHERE id=$1',[invite])).rows[0];
  beforeAll(async () => {
    pool = new pg.Pool({connectionString:url,max:6});
    await pool.query(`
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE TABLE IF NOT EXISTS auth.users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        raw_app_meta_data JSONB DEFAULT '{}'
      );
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
        SELECT COALESCE(
          NULLIF(current_setting('request.jwt.claim.sub', true), ''),
          NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
        )::uuid;
      $$ LANGUAGE SQL STABLE;

      DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF; END $$;
      DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; END $$;
      DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF; END $$;

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
        allow_plus_ones boolean NOT NULL DEFAULT true,
        max_plus_ones integer DEFAULT 3,
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
        dietary_notes text,
        responded_at timestamptz,
        invite_token VARCHAR(32) NOT NULL DEFAULT substr(replace(gen_random_uuid()::text, '-', ''), 1, 24),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.businesses TO service_role, authenticated;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.parties TO service_role, authenticated;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.event_invites TO service_role, authenticated;

    `);

    for (const file of ['457_party_tables_seats.sql','486_party_seating_groups_pins_atomic_plans.sql','489_party_rsvp_questions.sql'])
      await pool.query(readFileSync(join(process.cwd(),'supabase/migrations',file),'utf8'));
  });
  beforeEach(async () => {
    await pool.query('DELETE FROM public.event_invites WHERE business_id=ANY($1)',[[business,otherBusiness]]);
    await pool.query('DELETE FROM public.parties WHERE business_id=ANY($1)',[[business,otherBusiness]]);
    await pool.query('DELETE FROM public.businesses WHERE id=ANY($1)',[[business,otherBusiness]]);
    await pool.query('INSERT INTO auth.users(id) VALUES($1),($2) ON CONFLICT DO NOTHING',[owner,other]);
    await pool.query("INSERT INTO businesses(id,owner_id,name) VALUES($1,$2,'A'),($3,$4,'B')",[business,owner,otherBusiness,other]);
    await pool.query("INSERT INTO parties(id,business_id,name,date,max_guests) VALUES($1,$2,'A','2027-01-01',5),($3,$4,'B','2027-01-01',5)",[party,business,otherParty,otherBusiness]);
    await pool.query("INSERT INTO event_invites(id,business_id,party_id,guest_phone,invite_token,status) VALUES($1,$2,$3,'+15551234567','party-token-489','maybe')",[invite,business,party]);
    await pool.query("INSERT INTO party_tables(id,business_id,party_id,name,capacity) VALUES($1,$2,$3,'A',1)",[table,business,party]);
    await pool.query('UPDATE event_invites SET table_id=$1 WHERE id=$2',[table,invite]);
  });
  afterAll(async () => { await pool?.end(); });
  it('saves false as an answer and preserves pinned seating', async () => {
    await defs(); await complete(undefined,'15551234567',business);
    const row=await saved(); expect(row.status).toBe('accepted'); expect(row.custom_answers.access).toBe(false);
    expect(row.saved_question_snapshot).toEqual(questions); expect(row.saved_answer_revision).toBe(1); expect(row.table_id).toBe(table); expect(row.seating_pinned).toBe(true);
    await complete(); expect((await saved()).custom_answers).toEqual(row.custom_answers);
  });
  it('rejects wrong owner, sender and business', async () => {
    await expect(defs(undefined,other)).rejects.toMatchObject({code:'42501'}); await defs();
    await expect(complete(undefined,'15559999999',business)).rejects.toMatchObject({code:'42501'});
    await expect(complete(undefined,'15551234567',otherBusiness)).rejects.toMatchObject({code:'42501'});
    expect((await saved()).status).toBe('maybe');
  });
  it('requires answers only for acceptance and keeps historical snapshots on decline', async () => {
    await defs(); await expect(complete({status:'accepted',revision:1,answers:{}})).rejects.toMatchObject({code:'22023'});
    expect((await saved()).status).toBe('maybe'); await complete();
    await defs({revision:1,questions:[...questions,{id:'new',label:'New required',type:'yes_no',required:true}]});
    await complete({status:'declined'}); const row=await saved(); expect(row.status).toBe('declined'); expect(row.saved_answer_revision).toBe(1);
    await expect(complete()).rejects.toMatchObject({code:'40001'});
  });
  it('rolls back answers on table capacity failure', async () => {
    await defs(); const before=await saved();
    await expect(complete({status:'accepted',plus_ones:1,revision:1,answers:{diet:'Yes',access:true}})).rejects.toMatchObject({code:'23514'});
    const after=await saved(); for(const key of ['status','plus_ones','custom_answers','saved_answer_revision','table_id','seating_pinned']) expect(after[key]).toEqual(before[key]);
  });
  it('denies direct definition and answer writes from authenticated and service roles', async () => {
    await defs();
    for(const role of ['authenticated','service_role']) {
      const c=await pool.connect();
      try {
        await c.query('BEGIN'); await c.query(`SET LOCAL ROLE ${role}`); await c.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[owner]);
        await expect(c.query('UPDATE parties SET question_revision=2 WHERE id=$1',[party])).rejects.toMatchObject({code:'42501'}); await c.query('ROLLBACK');
        await c.query('BEGIN'); await c.query(`SET LOCAL ROLE ${role}`); await c.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[owner]);
        await expect(c.query("UPDATE event_invites SET status='accepted',custom_answers=$1,saved_answer_revision=1,saved_question_snapshot=$2 WHERE id=$3",[{diet:'Yes',access:false},JSON.stringify(questions),invite])).rejects.toMatchObject({code:'42501'});
      } finally {await c.query('ROLLBACK');c.release();}
    }
  });
  it('executes owner-scoped definition and completion wrappers as service_role', async () => {
    const c=await pool.connect();
    try {
      await c.query('BEGIN'); await c.query('SET LOCAL ROLE service_role');
      await c.query('SELECT public.party_questions_489($1,$2,$3)',[party,owner,{revision:0,questions}]);
      const result=await c.query('SELECT public.complete_party_rsvp_489($1,$2,$3,$4) value',['party-token-489',{status:'accepted',revision:1,answers:{diet:'Vegetarian',access:false}},'15551234567',business]);
      expect(result.rows[0].value.status).toBe('accepted'); await c.query('COMMIT');
    } finally {await c.query('ROLLBACK');c.release();}
  });
  it('rejects removing party identity from answered invitations', async () => {
    await defs(); await complete();
    await pool.query('UPDATE event_invites SET table_id=NULL,seating_pinned=false WHERE id=$1',[invite]);
    await expect(pool.query('UPDATE event_invites SET party_id=NULL WHERE id=$1',[invite])).rejects.toMatchObject({code:'22023'});
    expect((await saved()).party_id).toBe(party);
  });
  it('rejects snapshot-only forgery even when no questions are configured', async () => {
    const c=await pool.connect();
    try {
      await c.query('BEGIN'); await c.query('SET LOCAL ROLE service_role');
      await expect(c.query('UPDATE event_invites SET saved_question_snapshot=$1 WHERE id=$2',[JSON.stringify(questions),invite])).rejects.toMatchObject({code:'42501'});
    } finally {await c.query('ROLLBACK');c.release();}
  });
  it('does not permit retired question IDs to be reused', async () => {
    await defs(); await defs({revision:1,questions:[]});
    await expect(defs({revision:2,questions})).rejects.toMatchObject({code:'22023'});
  });
  it('serializes question edits against completion without mixed snapshots', async () => {
    await defs(); const c=await pool.connect();
    try {
      await c.query('BEGIN'); await c.query("SELECT pg_advisory_xact_lock(hashtext('party:'||$1))",[party]);
      const completion=complete().then(()=> 'saved', e=>e.code);
      await c.query('SELECT public.party_questions_489($1,$2,$3)',[party,owner,{revision:1,questions:[]}]); await c.query('COMMIT');
      expect(await completion).toBe('40001'); expect((await saved()).status).toBe('maybe');
    } finally {await c.query('ROLLBACK');c.release();}
  });
  it('concurrent seating and RSVP complete without a lock cycle', async () => {
    await defs(); const results=await Promise.all([
      complete(),pool.query("SELECT public.party_seating_486($1,$2,'pin',$3)",[party,owner,{invite_id:invite,pinned:true}])
    ]); expect(results).toHaveLength(2); expect((await saved()).saved_answer_revision).toBe(1);
  });
});

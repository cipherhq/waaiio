/**
 * #514: executable M481 evidence on a disposable PostgreSQL database.
 * CI discovers this file, clones pg_template_clean per file and requires zero skips.
 * Local ordinary unit runs may skip without TEST_DATABASE_URL; REQUIRE_PG_TESTS
 * fails closed. These are SQL integration tests, not HTTP route evidence.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const url = process.env.TEST_DATABASE_URL;
if (!url && process.env.REQUIRE_PG_TESTS === 'true') throw new Error('TEST_DATABASE_URL required');
if (url) {
  const parsed = new URL(url);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
    || !/^\/(pg_test_[a-z0-9_]+|event_cancellation_test)$/.test(parsed.pathname)) {
    throw new Error('M481 tests require an explicitly named disposable local database');
  }
}
const suite = url ? describe : describe.skip;
const id = () => randomUUID();
let db: Client;
async function connect() {
  const c = new Client({ connectionString: url });
  await c.connect();
  await c.query("SET statement_timeout='8s'");
  return c;
}
async function rpc(c: Client, name: string, args: unknown[]) {
  const slots = args.map((_, i) => '$' + (i + 1)).join(',');
  return (await c.query('SELECT public.' + name + '(' + slots + ') AS result', args)).rows[0].result;
}
async function install() {
  db = await connect();
  // Match main M001/M002/M010/M072/M114/M304/M307 columns and relevant FK edges.
  // CI supplies roles, auth.users, businesses; standalone disposable setup may not.
  await db.query(`
    DO $$ BEGIN
      IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
      IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    END $$;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE TABLE IF NOT EXISTS auth.users(id uuid PRIMARY KEY);
    ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS raw_app_meta_data jsonb DEFAULT '{}';
    CREATE TABLE IF NOT EXISTS public.profiles(id uuid PRIMARY KEY REFERENCES auth.users(id));
    CREATE TABLE IF NOT EXISTS public.businesses(id uuid PRIMARY KEY,owner_id uuid REFERENCES auth.users(id),name text NOT NULL);
    CREATE TYPE public.event_status AS ENUM('draft','published','sold_out','cancelled','completed');
    CREATE TABLE public.events(id uuid PRIMARY KEY,business_id uuid NOT NULL REFERENCES public.businesses(id),
      name varchar(300) NOT NULL,date date NOT NULL,time time,venue varchar(300),price integer NOT NULL DEFAULT 0,
      status public.event_status NOT NULL DEFAULT 'published',tickets_sold integer DEFAULT 0,total_tickets integer DEFAULT 100,
      updated_at timestamptz NOT NULL DEFAULT now(),created_at timestamptz DEFAULT now());
    CREATE FUNCTION public.update_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at=now(); RETURN NEW; END $$;
    CREATE TRIGGER update_events_updated_at BEFORE UPDATE ON public.events FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
    CREATE TABLE public.bot_sessions(id uuid PRIMARY KEY,business_id uuid REFERENCES public.businesses(id),session_data jsonb DEFAULT '{}');
    CREATE TABLE public.bookings(id uuid PRIMARY KEY,business_id uuid NOT NULL REFERENCES public.businesses(id),
      event_id uuid REFERENCES public.events(id),bot_session_id uuid REFERENCES public.bot_sessions(id),flow_type text DEFAULT 'ticketing',
      party_size integer CHECK(party_size>0),quantity integer,status text DEFAULT 'confirmed',
      guest_name text,guest_phone text,guest_email text,tickets_finalized boolean DEFAULT false);
    CREATE TABLE public.event_ticket_types(id uuid PRIMARY KEY,event_id uuid NOT NULL REFERENCES public.events(id),
      name text DEFAULT 'General',price numeric DEFAULT 0,tickets_sold integer DEFAULT 0,total_tickets integer DEFAULT 100,is_active boolean DEFAULT true);
    CREATE TABLE public.event_tickets(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id uuid NOT NULL REFERENCES public.businesses(id),booking_id uuid NOT NULL REFERENCES public.bookings(id),
      event_id uuid NOT NULL REFERENCES public.events(id),ticket_code varchar(12) UNIQUE NOT NULL,ticket_number integer NOT NULL,
      guest_name text,guest_phone text,status text DEFAULT 'valid',ticket_type_id uuid REFERENCES public.event_ticket_types(id),
      ticket_type_name text,UNIQUE(booking_id,ticket_number));
    CREATE TABLE public.payments(id uuid PRIMARY KEY,business_id uuid REFERENCES public.businesses(id),
      booking_id uuid REFERENCES public.bookings(id),status text DEFAULT 'success',amount numeric DEFAULT 100,currency text DEFAULT 'NGN',
      confirmation_sent_at timestamptz,confirmation_processing_at timestamptz,confirmation_claim_token uuid,confirmation_terminal_reason text);
    CREATE TABLE public.alerts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),business_id uuid NOT NULL REFERENCES public.businesses(id),
      type text NOT NULL,severity text NOT NULL,title text NOT NULL,message text NOT NULL,metadata jsonb);
    CREATE TABLE public.admin_audit_logs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),actor_id uuid REFERENCES public.profiles(id),
      action varchar(50) NOT NULL,entity_type varchar(50),entity_id uuid,details jsonb);
    GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO service_role;
    GRANT SELECT ON auth.users TO service_role;
    ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
    GRANT SELECT,UPDATE,DELETE ON public.events TO authenticated;
    GRANT SELECT ON public.businesses TO authenticated;
    CREATE POLICY owner_events ON public.events TO authenticated
      USING(business_id IN (SELECT id FROM public.businesses WHERE owner_id=NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid))
      WITH CHECK(business_id IN (SELECT id FROM public.businesses WHERE owner_id=NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid));
  `);
  await db.query(readFileSync(resolve(process.cwd(), 'supabase/migrations/481_event_cancellation_operations.sql'), 'utf8'));
}
async function reset() {
  await db.query('RESET ROLE');
  await db.query('TRUNCATE public.event_ticket_emissions,public.event_ticket_issuance_state,public.event_cancelled_payment_followups,public.event_cancellation_recipients,public.event_mutation_operations,public.event_tickets,public.payments,public.event_ticket_types,public.bookings,public.bot_sessions,public.events,public.alerts,public.admin_audit_logs CASCADE');
}
async function seed(paid = true, issued = true) {
  const f = { actor: id(), owner: id(), business: id(), event: id(), booking: id(), payment: id(), tier: id(), operation: id(), revision: '' };
  await db.query("INSERT INTO auth.users(id,raw_app_meta_data) VALUES($1,'{\"role\":\"admin\"}'),($2,'{}')", [f.actor,f.owner]);
  await db.query('INSERT INTO public.profiles(id) VALUES($1),($2)',[f.actor,f.owner]);
  await db.query("INSERT INTO public.businesses(id,owner_id,name) VALUES($1,$2,'Fixture')",[f.business,f.owner]);
  await db.query("INSERT INTO public.events(id,business_id,name,date,time,venue,price) VALUES($1,$2,'Original','2027-01-01','12:00','Hall',100)",[f.event,f.business]);
  await db.query("INSERT INTO public.bookings(id,business_id,event_id,party_size,quantity,guest_name,guest_phone,tickets_finalized) VALUES($1,$2,$3,2,2,'Fixture','+15550000100',$4)",[f.booking,f.business,f.event,issued]);
  await db.query('INSERT INTO public.event_ticket_types(id,event_id,tickets_sold) VALUES($1,$2,$3)',[f.tier,f.event,issued?2:0]);
  if (paid) await db.query('INSERT INTO public.payments(id,business_id,booking_id) VALUES($1,$2,$3)',[f.payment,f.business,f.booking]);
  if (issued) {
    await db.query("INSERT INTO public.event_tickets(business_id,booking_id,event_id,ticket_code,ticket_number,guest_phone,ticket_type_id) VALUES($1,$2,$3,'T514-A',1,'+15550000100',$4),($1,$2,$3,'T514-B',2,'15550000100',$4)",[f.business,f.booking,f.event,f.tier]);
    await db.query('UPDATE public.events SET tickets_sold=2 WHERE id=$1',[f.event]);
  }
  // PostgreSQL text preserves microsecond precision; JS Date would truncate revisions.
  f.revision=(await db.query('SELECT updated_at::text AS revision FROM public.events WHERE id=$1',[f.event])).rows[0].revision;
  return f;
}
type Fixture = Awaited<ReturnType<typeof seed>>;
async function mutate(f: Fixture, changes: Record<string, unknown> = { status: 'cancelled' }, c = db, operation = f.operation, revision = f.revision) {
  return rpc(c,'mutate_event',[f.event,f.business,f.actor,'admin',revision,operation,JSON.stringify(changes)]);
}
async function observeBlocked(observer: Client, pid: number) {
  for (let n=0;n<100;n++) {
    const row=(await observer.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0];
    if (row?.wait_event_type==='Lock') return;
    await new Promise(r=>setTimeout(r,20));
  }
  throw new Error('Expected PostgreSQL lock wait was not observed');
}

suite('M481 event cancellation transaction and notification authority', () => {
  beforeAll(install);
  beforeEach(reset);
  afterAll(async()=>{ if(db) await db.end(); });

  it('saves all six fields and retains a payload-bound response across later edits', async()=>{
    const f=await seed();
    const changes={name:'  Edited event  ',date:'2027-02-03',time:'18:45',venue:null,price:225,status:'published'};
    await db.query('SET ROLE service_role');
    const result=await mutate(f,changes);
    expect(result).toMatchObject({success:true,cancelled:false,event:{...changes,time:'18:45:00'}});
    const revision=(await db.query('SELECT updated_at::text AS v FROM public.events WHERE id=$1',[f.event])).rows[0].v;
    expect((await mutate(f,{name:'Later'},db,id(),revision)).success).toBe(true);
    expect(await mutate(f,changes)).toEqual({...result,replayed:true});
    expect((await mutate(f,{...changes,price:226})).reason).toBe('operation_conflict');
    expect((await mutate(f,{name:'Stale'},db,id())).reason).toBe('revision_conflict');
    expect((await db.query('SELECT count(*)::int AS n FROM public.admin_audit_logs')).rows[0].n).toBe(2);
  });

  it('cancels only valid tickets, deduplicates recipient and successful-payment followup, and audits atomically',async()=>{
    const f=await seed();
    await db.query("UPDATE public.event_tickets SET status='used' WHERE ticket_number=2");
    const result=await mutate(f);
    expect(result).toMatchObject({success:true,cancelled:true,counts:{cancelled_tickets:1,recipients:1,refunds_pending:1}});
    expect((await db.query('SELECT status FROM public.event_tickets ORDER BY ticket_number')).rows.map(r=>r.status)).toEqual(['cancelled','used']);
    const snapshot=(await db.query('SELECT affected_ticket_ids FROM public.event_mutation_operations')).rows[0].affected_ticket_ids;
    expect(snapshot).toHaveLength(1);
    expect((await mutate(f)).replayed).toBe(true);
    expect((await db.query('SELECT count(*)::int AS n FROM public.alerts')).rows[0].n).toBe(1);
    expect((await db.query('SELECT status,amount,currency,confirmation_sent_at FROM public.payments')).rows[0]).toMatchObject({status:'success',amount:'100',currency:'NGN',confirmation_sent_at:null});
  });

  it('rejects foreign tenant and untrusted actor before writing',async()=>{
    const f=await seed();
    const foreign=await rpc(db,'mutate_event',[f.event,id(),f.actor,'admin',f.revision,f.operation,'{"status":"cancelled"}']);
    expect(foreign.reason).toBe('identity_mismatch');
    const nonAdmin=await rpc(db,'mutate_event',[f.event,f.business,f.owner,'admin',f.revision,f.operation,'{"status":"cancelled"}']);
    expect(nonAdmin.reason).toBe('identity_mismatch');
    expect((await db.query('SELECT count(*)::int AS n FROM public.event_mutation_operations')).rows[0].n).toBe(0);
  });

  it.each(['anon','authenticated'])('denies %s both RPC and durable tables',async(role)=>{
    const f=await seed();
    await db.query('SET ROLE '+role);
    await expect(mutate(f)).rejects.toMatchObject({code:'42501'});
    await expect(db.query('SELECT * FROM public.event_mutation_operations')).rejects.toMatchObject({code:'42501'});
    await expect(db.query("SELECT private.mutate_event($1,$2,$3,'admin',$4,$5,'{}')",[f.event,f.business,f.actor,f.revision,f.operation])).rejects.toMatchObject({code:'42501'});
  });

  it('allows owner ordinary update but blocks reopening through direct merchant UPDATE',async()=>{
    const f=await seed();
    await mutate(f);
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[f.owner]);
    await db.query('SET ROLE authenticated');
    expect((await db.query("UPDATE public.events SET venue='New venue' WHERE id=$1 RETURNING venue",[f.event])).rows[0].venue).toBe('New venue');
    await expect(db.query("UPDATE public.events SET status='published' WHERE id=$1",[f.event])).rejects.toMatchObject({code:'23514'});
    expect((await db.query('SELECT status FROM public.events WHERE id=$1',[f.event])).rows[0].status).toBe('cancelled');
  });

  it.each(['alerts','admin_audit_logs'])('rolls back every effect if %s persistence fails',async(table)=>{
    const f=await seed();
    await db.query("CREATE FUNCTION public.fail_514() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END $$");
    await db.query('CREATE TRIGGER fail_514 BEFORE INSERT ON public.'+table+' FOR EACH ROW EXECUTE FUNCTION public.fail_514()');
    try {
      await expect(mutate(f)).rejects.toThrow('fixture failure');
      expect((await db.query('SELECT status FROM public.events WHERE id=$1',[f.event])).rows[0].status).toBe('published');
      expect((await db.query("SELECT count(*)::int AS n FROM public.event_tickets WHERE status='valid'")).rows[0].n).toBe(2);
      for(const t of ['event_mutation_operations','event_cancellation_recipients','event_cancelled_payment_followups','alerts','admin_audit_logs']) {
        expect((await db.query('SELECT count(*)::int AS n FROM public.'+t)).rows[0].n).toBe(0);
      }
    } finally {
      await db.query('DROP TRIGGER fail_514 ON public.'+table);
      await db.query('DROP FUNCTION public.fail_514()');
    }
  });

  it('serializes concurrent duplicate and competing cancellation requests',async()=>{
    const f=await seed(); const a=await connect();const b=await connect();
    try{
      const pid=(await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await a.query('BEGIN'); const first=await mutate(f,{status:'cancelled'},a);
      const duplicate=mutate(f,{status:'cancelled'},b);
      await observeBlocked(db,pid);await a.query('COMMIT');
      expect(await duplicate).toEqual({...first,replayed:true});
      expect((await mutate(f,{status:'cancelled'},b,id())).reason).toBe('revision_conflict');
      expect((await db.query('SELECT count(*)::int AS n FROM public.event_mutation_operations WHERE is_cancellation')).rows[0].n).toBe(1);
    }finally{await a.query('ROLLBACK');await a.end();await b.end();}
  },10000);

  it('reclaims only expired pre-attempt leases and fences stale attempts',async()=>{
    const f=await seed();await mutate(f);
    const rid=(await db.query('SELECT id FROM public.event_cancellation_recipients')).rows[0].id;
    const first=await rpc(db,'claim_event_cancellation_notification',[rid]);
    expect(first.claimed).toBe(true);
    expect((await rpc(db,'claim_event_cancellation_notification',[rid])).claimed).toBe(false);
    await db.query("UPDATE public.event_cancellation_recipients SET claim_expires_at=now()-interval '1 second' WHERE id=$1",[rid]);
    const next=await rpc(db,'claim_event_cancellation_notification',[rid]);
    expect(next.claimed).toBe(true);
    expect((await rpc(db,'mark_event_cancellation_notification_attempted',[rid,first.claim_token])).marked).toBe(false);
    expect((await rpc(db,'finalize_event_cancellation_notification',[rid,next.claim_token,'pending',null])).finalized).toBe(true);
    const active=await rpc(db,'claim_event_cancellation_notification',[rid]);
    expect((await rpc(db,'mark_event_cancellation_notification_attempted',[rid,active.claim_token])).marked).toBe(true);
    await db.query("UPDATE public.event_cancellation_recipients SET claim_expires_at=now()-interval '1 hour' WHERE id=$1",[rid]);
    expect((await rpc(db,'claim_event_cancellation_notification',[rid])).claimed).toBe(false);
    expect((await rpc(db,'finalize_event_cancellation_notification',[rid,active.claim_token,'pending',null])).finalized).toBe(false);
    expect((await rpc(db,'finalize_event_cancellation_notification',[rid,active.claim_token,'ambiguous',null])).finalized).toBe(true);
    expect((await rpc(db,'claim_event_cancellation_notification',[rid])).claimed).toBe(false);
  });

  it('requires provider evidence for accepted notification and never reclaims it',async()=>{
    const f=await seed();await mutate(f);
    const rid=(await db.query('SELECT id FROM public.event_cancellation_recipients')).rows[0].id;
    const claim=await rpc(db,'claim_event_cancellation_notification',[rid]);
    await rpc(db,'mark_event_cancellation_notification_attempted',[rid,claim.claim_token]);
    expect((await rpc(db,'finalize_event_cancellation_notification',[rid,claim.claim_token,'accepted',null])).finalized).toBe(false);
    expect((await rpc(db,'finalize_event_cancellation_notification',[rid,claim.claim_token,'accepted','provider-514'])).finalized).toBe(true);
    expect((await rpc(db,'finalize_event_cancellation_notification',[rid,claim.claim_token,'accepted','provider-514'])).finalized).toBe(true);
    expect((await rpc(db,'claim_event_cancellation_notification',[rid])).claimed).toBe(false);
  });
  it('ordinary save preserves permitted unsold-event deletion while retaining operation and audit identity',async()=>{
    const f=await seed(false,false);
    await db.query('DELETE FROM public.bookings WHERE id=$1',[f.booking]);
    await db.query('DELETE FROM public.event_ticket_types WHERE id=$1',[f.tier]);
    const saved=await mutate(f,{name:'Corrected unsold event'});
    expect(saved).toMatchObject({success:true,cancelled:false});
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[f.owner]);
    await db.query('SET ROLE authenticated');
    expect((await db.query('DELETE FROM public.events WHERE id=$1 RETURNING id',[f.event])).rows).toEqual([{id:f.event}]);
    await db.query('RESET ROLE');
    const operation=(await db.query('SELECT event_id,cancellation_event_id,is_cancellation,response_payload FROM public.event_mutation_operations WHERE id=$1',[f.operation])).rows[0];
    expect(operation).toMatchObject({event_id:f.event,cancellation_event_id:null,is_cancellation:false,response_payload:saved});
    expect((await db.query('SELECT entity_id FROM public.admin_audit_logs WHERE entity_id=$1',[f.event])).rows).toEqual([{entity_id:f.event}]);
  });

  it('cancellation evidence still restricts deletion and survives the rejected delete',async()=>{
    const f=await seed(false,false);
    await db.query('DELETE FROM public.bookings WHERE id=$1',[f.booking]);
    await db.query('DELETE FROM public.event_ticket_types WHERE id=$1',[f.tier]);
    const cancelled=await mutate(f);
    await expect(db.query('DELETE FROM public.events WHERE id=$1',[f.event])).rejects.toMatchObject({code:'23503'});
    expect((await db.query('SELECT cancellation_event_id,response_payload FROM public.event_mutation_operations WHERE id=$1',[f.operation])).rows[0]).toEqual({cancellation_event_id:f.event,response_payload:cancelled});
    expect((await db.query('SELECT entity_id FROM public.admin_audit_logs WHERE entity_id=$1',[f.event])).rows).toEqual([{entity_id:f.event}]);
  });

  it('a new edit operation on a cancelled event saves without replacing original pending effects or history',async()=>{
    const f=await seed();
    const original=await mutate(f);
    const before=(await db.query('SELECT * FROM public.event_cancellation_recipients WHERE operation_id=$1',[f.operation])).rows;
    expect(before).toHaveLength(1);
    expect(before[0].state).toBe('pending');
    const revision=(await db.query('SELECT updated_at::text AS v FROM public.events WHERE id=$1',[f.event])).rows[0].v;
    const editId=id();
    const edited=await mutate(f,{name:'Corrected cancelled event',status:'cancelled'},db,editId,revision);
    expect(edited).toMatchObject({success:true,cancelled:false,event:{status:'cancelled',name:'Corrected cancelled event'},counts:{cancelled_tickets:0,recipients:0,refunds_pending:0}});
    expect((await db.query('SELECT * FROM public.event_cancellation_recipients WHERE operation_id=$1',[f.operation])).rows).toEqual(before);
    expect((await db.query('SELECT count(*)::int AS n FROM public.event_cancellation_recipients WHERE operation_id=$1',[editId])).rows[0].n).toBe(0);
    expect((await db.query('SELECT response_payload FROM public.event_mutation_operations WHERE id=$1',[f.operation])).rows[0].response_payload).toEqual(original);
    expect((await db.query('SELECT count(*)::int AS n FROM public.alerts')).rows[0].n).toBe(1);
    expect(await mutate(f)).toEqual({...original,replayed:true});
    expect((await db.query('SELECT id FROM public.event_mutation_operations WHERE is_cancellation')).rows).toEqual([{id:f.operation}]);
  });

  it('a new edit on a legacy cancelled event leaves unknown cancellation history unknown',async()=>{
    const f=await seed(false,false);
    await db.query("UPDATE public.events SET status='cancelled' WHERE id=$1",[f.event]);
    const revision=(await db.query('SELECT updated_at::text AS v FROM public.events WHERE id=$1',[f.event])).rows[0].v;
    const edited=await mutate(f,{venue:'Corrected legacy venue',status:'cancelled'},db,f.operation,revision);
    expect(edited).toMatchObject({success:true,cancelled:false,event:{status:'cancelled',venue:'Corrected legacy venue'}});
    expect((await db.query('SELECT count(*)::int AS n FROM public.event_mutation_operations WHERE is_cancellation')).rows[0].n).toBe(0);
    expect((await db.query('SELECT count(*)::int AS n FROM public.event_cancellation_recipients')).rows[0].n).toBe(0);
    expect((await db.query('SELECT count(*)::int AS n FROM public.alerts')).rows[0].n).toBe(0);
  });

});

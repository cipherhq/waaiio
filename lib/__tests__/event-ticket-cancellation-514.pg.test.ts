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
    GRANT SELECT,UPDATE ON public.events TO authenticated;
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

suite('M481 cancellation versus issuance, emission and payment confirmation',()=>{
  beforeAll(install);
  beforeEach(reset);
  afterAll(async()=>{if(db) await db.end();});

  it('converges rows and inventory once, then resolves a legacy NULL-tier repeat from durable issuance identity',async()=>{
    const f=await seed(false,false);
    await db.query('SET ROLE service_role');
    const first=await rpc(db,'finalize_free_ticket_booking',[f.booking,f.event,f.tier,2]);
    expect(first).toMatchObject({success:true,outcome:'issued',inventory_finalized:true});
    expect(first.tickets).toHaveLength(2);
    const again=await rpc(db,'converge_event_ticket_booking',[f.booking,f.event,null,2]);
    expect(again.tickets).toEqual(first.tickets);
    expect(again.already_finalized).toBe(true);
    expect((await db.query('SELECT tickets_sold FROM public.events WHERE id=$1',[f.event])).rows[0].tickets_sold).toBe(2);
    expect((await db.query('SELECT tickets_sold FROM public.event_ticket_types WHERE id=$1',[f.tier])).rows[0].tickets_sold).toBe(2);
  });

  it('repairs missing canonical rows on finalized historical booking without incrementing inventory',async()=>{
    const f=await seed();
    await db.query('DELETE FROM public.event_tickets WHERE ticket_number=2');
    const result=await rpc(db,'converge_event_ticket_booking',[f.booking,f.event,null,2]);
    expect(result).toMatchObject({success:true,already_finalized:true});
    expect(result.tickets).toHaveLength(2);
    expect((await db.query('SELECT tickets_sold FROM public.events')).rows[0].tickets_sold).toBe(2);
  });

  it('does not infer an arbitrary tier or accept wrong booking identity',async()=>{
    const f=await seed(false,false);
    expect((await rpc(db,'converge_event_ticket_booking',[f.booking,f.event,null,2])).reason).toBe('ticket_type_required');
    expect((await rpc(db,'converge_event_ticket_booking',[f.booking,id(),f.tier,2])).reason).toBe('booking_identity_mismatch');
    expect((await rpc(db,'converge_event_ticket_booking',[f.booking,f.event,f.tier,3])).reason).toBe('booking_identity_mismatch');
    const other=await seed(false,false);
    expect((await rpc(db,'converge_event_ticket_booking',[f.booking,f.event,other.tier,2])).reason).toBe('ticket_type_wrong_event');
    expect((await db.query('SELECT count(*)::int AS n FROM public.event_tickets')).rows[0].n).toBe(0);
  });

  it('rolls back inventory, marker and issuance identity if canonical row insertion fails',async()=>{
    const f=await seed(false,false);
    await db.query("CREATE FUNCTION public.reject_second_ticket_514() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.ticket_number=2 THEN RAISE EXCEPTION 'fixture ticket failure'; END IF; RETURN NEW; END $$");
    await db.query('CREATE TRIGGER reject_second_ticket_514 BEFORE INSERT ON public.event_tickets FOR EACH ROW EXECUTE FUNCTION public.reject_second_ticket_514()');
    try{
      await expect(rpc(db,'converge_event_ticket_booking',[f.booking,f.event,f.tier,2])).rejects.toThrow('fixture ticket failure');
      expect((await db.query('SELECT tickets_sold FROM public.events')).rows[0].tickets_sold).toBe(0);
      expect((await db.query('SELECT tickets_finalized FROM public.bookings')).rows[0].tickets_finalized).toBe(false);
      expect((await db.query('SELECT count(*)::int AS n FROM public.event_tickets')).rows[0].n).toBe(0);
      expect((await db.query('SELECT count(*)::int AS n FROM public.event_ticket_issuance_state')).rows[0].n).toBe(0);
    }finally{
      await db.query('DROP TRIGGER reject_second_ticket_514 ON public.event_tickets');
      await db.query('DROP FUNCTION public.reject_second_ticket_514()');
    }
  });

  it.each([true,false])('cancellation wins before issuance (paid=%s) with no ticket or inventory resurrection',async(paid)=>{
    const f=await seed(paid,false);
    await mutate(f);
    const result=await rpc(db,'converge_event_ticket_booking',[f.booking,f.event,f.tier,2]);
    expect(result).toMatchObject({success:false,outcome:'cancelled_followup_recorded',followup_recorded:true,inventory_finalized:false,tickets:[]});
    expect((await db.query('SELECT tickets_sold FROM public.events')).rows[0].tickets_sold).toBe(0);
    expect((await db.query('SELECT tickets_finalized FROM public.bookings')).rows[0].tickets_finalized).toBe(false);
    expect((await db.query('SELECT count(*)::int AS n FROM public.event_tickets')).rows[0].n).toBe(0);
    expect((await db.query('SELECT count(*)::int AS n FROM public.event_cancelled_payment_followups')).rows[0].n).toBe(paid?1:0);
    await rpc(db,'finalize_free_ticket_booking',[f.booking,f.event,f.tier,2]);
    expect((await db.query('SELECT count(*)::int AS n FROM public.alerts')).rows[0].n).toBe(paid?1:0);
  });

  it('checks cancellation before the already-finalized shortcut',async()=>{
    const f=await seed();
    await mutate(f);
    expect((await rpc(db,'converge_event_ticket_booking',[f.booking,f.event,f.tier,2])).outcome).toBe('cancelled_followup_recorded');
    expect((await db.query("SELECT count(*)::int AS n FROM public.event_tickets WHERE status='valid'")).rows[0].n).toBe(0);
    expect((await db.query('SELECT tickets_sold FROM public.events')).rows[0].tickets_sold).toBe(2);
  });

  it('serializes cancellation first against issuance while holding booking FK authority without deadlock',async()=>{
    const f=await seed(true,false);const a=await connect();const b=await connect();
    try{
      const pid=(await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await a.query('BEGIN');await mutate(f,{status:'cancelled'},a);
      const issuing=rpc(b,'converge_event_ticket_booking',[f.booking,f.event,f.tier,2]);
      await observeBlocked(db,pid);await a.query('COMMIT');
      expect((await issuing).outcome).toBe('cancelled_followup_recorded');
      expect((await db.query('SELECT count(*)::int AS n FROM public.event_tickets')).rows[0].n).toBe(0);
    }finally{await a.query('ROLLBACK');await a.end();await b.end();}
  },10000);

  it('issuance first commits valid rows; stale cancellation retries with current revision and snapshots them',async()=>{
    const f=await seed(true,false);const a=await connect();const b=await connect();
    try{
      const pid=(await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await a.query('BEGIN');expect((await rpc(a,'converge_event_ticket_booking',[f.booking,f.event,f.tier,2])).success).toBe(true);
      const cancelling=mutate(f,{status:'cancelled'},b);
      await observeBlocked(db,pid);await a.query('COMMIT');
      expect((await cancelling).reason).toBe('revision_conflict');
      const rev=(await db.query('SELECT updated_at::text AS v FROM public.events')).rows[0].v;
      expect((await mutate(f,{status:'cancelled'},b,f.operation,rev)).counts.cancelled_tickets).toBe(2);
      expect((await db.query("SELECT count(*)::int AS n FROM public.event_tickets WHERE status='valid'")).rows[0].n).toBe(0);
    }finally{await a.query('ROLLBACK');await a.end();await b.end();}
  },10000);

  it('authorizes each artifact once and preserves acceptance evidence after cancellation',async()=>{
    const f=await seed();
    const auth=await rpc(db,'authorize_event_ticket_emission',[f.booking,'whatsapp','document:T514-A']);
    expect(auth.authorized).toBe(true);
    expect((await rpc(db,'authorize_event_ticket_emission',[f.booking,'whatsapp','document:T514-A'])).state).toBe('attempted');
    expect((await rpc(db,'finalize_event_ticket_emission',[auth.emission_id,'accepted',null])).finalized).toBe(false);
    expect((await rpc(db,'finalize_event_ticket_emission',[auth.emission_id,'accepted','provider-514'])).finalized).toBe(true);
    await mutate(f);
    expect(await rpc(db,'authorize_event_ticket_emission',[f.booking,'whatsapp','document:T514-A'])).toMatchObject({authorized:false,state:'accepted',provider_message_id:'provider-514'});
    expect((await rpc(db,'authorize_event_ticket_emission',[f.booking,'whatsapp','image:T514-A'])).reason).toBe('event_cancelled');
    expect((await rpc(db,'authorize_event_ticket_emission',[f.booking,'email','email'])).authorized).toBe(false);
  });

  it('never reauthorizes an ambiguous artifact',async()=>{
    const f=await seed();
    const auth=await rpc(db,'authorize_event_ticket_emission',[f.booking,'email','email']);
    await rpc(db,'finalize_event_ticket_emission',[auth.emission_id,'ambiguous',null]);
    expect(await rpc(db,'authorize_event_ticket_emission',[f.booking,'email','email'])).toMatchObject({authorized:false,state:'ambiguous'});
  });

  it('terminates only the current payment claim and records followup without marking confirmation sent or mutating money',async()=>{
    const f=await seed(true,false);await mutate(f);
    const token=id();
    await db.query('UPDATE public.payments SET confirmation_claim_token=$1,confirmation_processing_at=now() WHERE id=$2',[token,f.payment]);
    expect((await rpc(db,'terminate_cancelled_event_confirmation',[f.payment,id()])).reason).toBe('token_mismatch');
    expect((await db.query('SELECT count(*)::int AS n FROM public.alerts')).rows[0].n).toBe(0);
    expect((await rpc(db,'terminate_cancelled_event_confirmation',[f.payment,token])).terminated).toBe(true);
    expect((await rpc(db,'terminate_cancelled_event_confirmation',[f.payment,token])).already_terminated).toBe(true);
    expect((await db.query('SELECT status,amount,currency,confirmation_sent_at,confirmation_terminal_reason,confirmation_claim_token FROM public.payments')).rows[0]).toMatchObject({
      status:'success',amount:'100',currency:'NGN',confirmation_sent_at:null,confirmation_terminal_reason:'event_cancelled_followup_recorded',confirmation_claim_token:null
    });
    expect((await db.query('SELECT count(*)::int AS n FROM public.alerts')).rows[0].n).toBe(1);
  });

  it('does not terminate a non-cancelled payment and rejects an expired cancellation claim',async()=>{
    const f=await seed(true,false);const token=id();
    expect(await rpc(db,'terminate_cancelled_event_confirmation',[f.payment,token])).toEqual({terminated:false,reason:'not_cancelled'});
    await mutate(f);
    await db.query("UPDATE public.payments SET confirmation_claim_token=$1,confirmation_processing_at=now()-interval '6 minutes' WHERE id=$2",[token,f.payment]);
    expect((await rpc(db,'terminate_cancelled_event_confirmation',[f.payment,token])).reason).toBe('claim_expired');
    expect((await db.query('SELECT count(*)::int AS n FROM public.alerts')).rows[0].n).toBe(0);
  });

  it('rolls back cancellation terminal evidence when followup persistence fails',async()=>{
    const f=await seed(true,false);await mutate(f);const token=id();
    await db.query('UPDATE public.payments SET confirmation_claim_token=$1,confirmation_processing_at=now() WHERE id=$2',[token,f.payment]);
    await db.query("CREATE FUNCTION public.fail_followup_514() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture followup failure'; END $$");
    await db.query('CREATE TRIGGER fail_followup_514 BEFORE INSERT ON public.event_cancelled_payment_followups FOR EACH ROW EXECUTE FUNCTION public.fail_followup_514()');
    try{
      await expect(rpc(db,'terminate_cancelled_event_confirmation',[f.payment,token])).rejects.toThrow('fixture followup failure');
      expect((await db.query('SELECT confirmation_terminal_reason,confirmation_claim_token FROM public.payments')).rows[0]).toEqual({confirmation_terminal_reason:null,confirmation_claim_token:token});
      expect((await db.query('SELECT count(*)::int AS n FROM public.alerts')).rows[0].n).toBe(0);
    }finally{
      await db.query('DROP TRIGGER fail_followup_514 ON public.event_cancelled_payment_followups');
      await db.query('DROP FUNCTION public.fail_followup_514()');
    }
  });
  it('cancellation does not wait on booking/payment locks held by a finalizer waiting for the event',async()=>{
    const f=await seed(true,true);const a=await connect();const b=await connect();
    try{
      const pid=(await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await a.query('BEGIN');await a.query('SELECT id FROM public.events WHERE id=$1 FOR UPDATE',[f.event]);
      await b.query('BEGIN');await b.query('SELECT id FROM public.bookings WHERE id=$1 FOR UPDATE',[f.booking]);
      await b.query('SELECT id FROM public.payments WHERE id=$1 FOR UPDATE',[f.payment]);
      const finishing=rpc(b,'converge_event_ticket_booking',[f.booking,f.event,f.tier,2]);
      await observeBlocked(db,pid);
      expect((await mutate(f,{status:'cancelled'},a)).counts.refunds_pending).toBe(1);
      await a.query('COMMIT');
      expect((await finishing).outcome).toBe('cancelled_followup_recorded');
      await b.query('COMMIT');
      expect((await db.query('SELECT count(*)::int AS n FROM public.alerts')).rows[0].n).toBe(1);
    }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');await a.end();await b.end();}
  },10000);

  it('editing a cancelled event preserves original cancellation authority for paid convergence',async()=>{
    const f=await seed(true,false);
    await mutate(f);
    const revision=(await db.query('SELECT updated_at::text AS v FROM public.events WHERE id=$1',[f.event])).rows[0].v;
    const editId=id();
    expect((await mutate(f,{name:'Corrected cancelled title'},db,editId,revision)).cancelled).toBe(false);
    expect(await rpc(db,'converge_event_ticket_booking',[f.booking,f.event,f.tier,2])).toMatchObject({
      success:false,outcome:'cancelled_followup_recorded',followup_recorded:true,tickets:[]
    });
    expect((await db.query('SELECT operation_id,payment_id FROM public.event_cancelled_payment_followups')).rows).toEqual([{operation_id:f.operation,payment_id:f.payment}]);
    expect((await db.query('SELECT count(*)::int AS n FROM public.event_tickets')).rows[0].n).toBe(0);
    expect((await db.query('SELECT tickets_sold FROM public.events WHERE id=$1',[f.event])).rows[0].tickets_sold).toBe(0);
  });

  it('a saved edit does not fabricate cancellation authority for a legacy cancelled event',async()=>{
    const f=await seed(true,false);
    await db.query("UPDATE public.events SET status='cancelled' WHERE id=$1",[f.event]);
    const revision=(await db.query('SELECT updated_at::text AS v FROM public.events WHERE id=$1',[f.event])).rows[0].v;
    expect((await mutate(f,{name:'Corrected legacy title'},db,f.operation,revision)).cancelled).toBe(false);
    expect(await rpc(db,'converge_event_ticket_booking',[f.booking,f.event,f.tier,2])).toEqual({success:false,reason:'legacy_cancellation_unverified'});
    expect((await db.query('SELECT count(*)::int AS n FROM public.event_cancelled_payment_followups')).rows[0].n).toBe(0);
    expect((await db.query('SELECT count(*)::int AS n FROM public.event_tickets')).rows[0].n).toBe(0);
  });

});

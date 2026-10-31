import { describe,it,expect,beforeAll,afterAll,beforeEach } from 'vitest';
import pg from 'pg';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
const url=process.env.TEST_DATABASE_URL;
if(process.env.REQUIRE_PG_TESTS==='true'&&!url)throw new Error('Disposable PostgreSQL required');
const suite=url?describe:describe.skip;
const id=(n:number)=>'00000000-0000-4000-a490-'+n.toString(16).padStart(12,'0');
const business=id(1),party=id(2),invite=id(3),otherBusiness=id(4),otherParty=id(5),otherInvite=id(6),run=id(7);
suite('M490 real PostgreSQL reminder claims and tenant boundaries',()=>{
 let pool:pg.Pool;
 beforeAll(async()=>{
  pool=new pg.Pool({connectionString:url,max:5});
  await pool.query(`CREATE SCHEMA IF NOT EXISTS private;
   DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; END $$;
   CREATE TABLE IF NOT EXISTS public.businesses(id uuid PRIMARY KEY);
   CREATE TABLE IF NOT EXISTS public.parties(id uuid PRIMARY KEY,business_id uuid NOT NULL REFERENCES public.businesses(id));
   CREATE TABLE IF NOT EXISTS public.event_invites(id uuid PRIMARY KEY,party_id uuid REFERENCES public.parties(id),business_id uuid NOT NULL REFERENCES public.businesses(id));
   GRANT USAGE ON SCHEMA public,private TO service_role;
   GRANT SELECT ON public.parties,public.event_invites TO service_role;`);
  await pool.query(readFileSync(join(process.cwd(),'supabase/migrations/490_party_reminder_delivery.sql'),'utf8'));
 });
 beforeEach(async()=>{
  await pool.query('DELETE FROM public.party_reminder_attempts; DELETE FROM public.party_reminder_runs; DELETE FROM public.event_invites; DELETE FROM public.parties; DELETE FROM public.businesses');
  await pool.query('INSERT INTO public.businesses(id) VALUES($1),($2)',[business,otherBusiness]);
  await pool.query('INSERT INTO public.parties(id,business_id) VALUES($1,$2),($3,$4)',[party,business,otherParty,otherBusiness]);
  await pool.query('INSERT INTO public.event_invites(id,party_id,business_id) VALUES($1,$2,$3),($4,$5,$6)',[invite,party,business,otherInvite,otherParty,otherBusiness]);
 });
 afterAll(async()=>{await pool?.end();});
 const claim=()=>pool.query("INSERT INTO public.party_reminder_runs(id,party_id,business_id,purpose,fingerprint) VALUES($1,$2,$3,'followup',$4)",[run,party,business,'a'.repeat(64)]);
 it('allows only one concurrent occurrence claim',async()=>{
  const results=await Promise.allSettled([claim(),claim()]);expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);
  expect((results.find(x=>x.status==='rejected') as PromiseRejectedResult).reason.code).toBe('23505');
 });
 it('rejects duplicate channel dispatch and cross-tenant invitation',async()=>{
  await claim();const send=()=>pool.query("INSERT INTO party_reminder_attempts(run_id,invite_id,channel,content) VALUES($1,$2,'email',$3)",[run,invite,{text:'Reminder'}]);
  await send();await expect(send()).rejects.toMatchObject({code:'23505'});
  await expect(pool.query("INSERT INTO party_reminder_attempts(run_id,invite_id,channel,content) VALUES($1,$2,'email','{}')",[run,otherInvite])).rejects.toMatchObject({code:'42501'});
 });
 it('does not allow resetting or changing an ambiguous dispatch identity',async()=>{
  await claim();await pool.query("INSERT INTO party_reminder_attempts(run_id,invite_id,channel,content) VALUES($1,$2,'email','{}')",[run,invite]);
  await pool.query("UPDATE party_reminder_attempts SET state='unknown' WHERE run_id=$1",[run]);
  await expect(pool.query("UPDATE party_reminder_attempts SET state='dispatched' WHERE run_id=$1",[run])).rejects.toMatchObject({code:'22023'});
  await expect(pool.query("UPDATE party_reminder_runs SET fingerprint=$1 WHERE id=$2",['b'.repeat(64),run])).rejects.toMatchObject({code:'22023'});
 });
 it('service_role can record dispatch; authenticated cannot read or write it',async()=>{
  const c=await pool.connect();try{
   await c.query('BEGIN');await c.query('SET LOCAL ROLE service_role');
   await c.query("INSERT INTO public.party_reminder_runs(id,party_id,business_id,purpose,fingerprint) VALUES($1,$2,$3,'chase',$4)",[run,party,business,'a'.repeat(64)]);await c.query('COMMIT');
   await c.query('BEGIN');await c.query('SET LOCAL ROLE authenticated');await expect(c.query('SELECT * FROM public.party_reminder_runs')).rejects.toMatchObject({code:'42501'});
  }finally{await c.query('ROLLBACK');c.release();}
 });
 it('retains existing guest and party deletion behavior',async()=>{
  await claim();await pool.query("INSERT INTO party_reminder_attempts(run_id,invite_id,channel,content) VALUES($1,$2,'email','{}')",[run,invite]);
  await pool.query('DELETE FROM event_invites WHERE id=$1',[invite]);expect((await pool.query('SELECT * FROM party_reminder_attempts')).rowCount).toBe(0);
  await pool.query('DELETE FROM parties WHERE id=$1',[party]);expect((await pool.query('SELECT * FROM party_reminder_runs')).rowCount).toBe(0);
 });
});

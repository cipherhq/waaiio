// Disposable local database only. No hosted credentials or production fixtures.
// M491_TEST_DATABASE_URL=postgresql://localhost:55491/waaiio_m491_test node scripts/test-m491-concurrency.mjs
import pg from 'pg';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const url = process.env.M491_TEST_DATABASE_URL;
if (!url) throw new Error('M491_TEST_DATABASE_URL is required; this suite never silently skips');
const parsed = new URL(url);
if (!['localhost','127.0.0.1'].includes(parsed.hostname) || parsed.pathname !== '/waaiio_m491_test') throw new Error('Use only the disposable local waaiio_m491_test database');
const pool = new pg.Pool({ connectionString:url, max:4 });
const b='00000000-0000-0000-0000-000000000001', shared='00000000-0000-0000-0000-000000000002', cand='00000000-0000-0000-0000-000000000003';
const transition = c=>c.query('select public.transition_to_shared($1) as result',[b]);
const promote = c=>c.query('select public.promote_channel_candidate($1,$2) as result',[cand,b]);
let assertions=0;
function check(value,expected) { assert.deepEqual(value,expected);assertions++; }
async function seed() {
 await pool.query('TRUNCATE public.whatsapp_channel_candidates, public.businesses, public.whatsapp_channels');
 await pool.query("INSERT INTO public.whatsapp_channels(id,channel_type,country_code,is_active) VALUES($1,'shared','US',true)",[shared]);
 await pool.query("INSERT INTO public.businesses(id,country_code,wa_method,assigned_channel_id) VALUES($1,'US','shared',$2)",[b,shared]);
 await pool.query("INSERT INTO public.whatsapp_channel_candidates(id,business_id,status,expected_assigned_channel_id,expected_wa_method,connection_source,business_wa_method,provider,country_code) VALUES($1,$2,'ready',$3,'shared','manual','transfer','meta','US')",[cand,b,shared]);
}
async function waitForLock(pid) {
 for(let i=0;i<100;i++) {
  if((await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0]?.wait_event_type==='Lock') return;
  await new Promise(r=>setTimeout(r,20));
 }
 throw new Error('Second RPC did not wait for first transaction lock');
}
try {
 const fixture=readFileSync('supabase/tests/491_shared_recovery_candidate_fence.sql','utf8')
   .replace('\\ir ../migrations/491_shared_recovery_candidate_fence.sql',()=>readFileSync('supabase/migrations/491_shared_recovery_candidate_fence.sql','utf8'));
 await pool.query(fixture);
 console.log('PASS SQL fixture: pending/validating/ready cancellation, late status overwrite, allocation failure and catalog grants');
 for(const role of ['anon','authenticated']) for(const rpc of ['transition','promote']) {
  const c=await pool.connect();try {await c.query('BEGIN');await c.query(`SET LOCAL ROLE ${role}`);await assert.rejects(()=>rpc==='transition'?transition(c):promote(c),e=>e.code==='42501');assertions++;}finally{await c.query('ROLLBACK');c.release();}
 }
 await seed();const c=await pool.connect();try {await c.query('BEGIN');await c.query('SET LOCAL ROLE service_role');check((await transition(c)).rows[0].result.transitioned,true);check((await promote(c)).rows[0].result.reason,'candidate_cancelled');}finally{await c.query('ROLLBACK');c.release();}
 for(const first of ['cancel','promote']) {
  await seed();const a=await pool.connect(),second=await pool.connect();
  try {
   await a.query('BEGIN');await second.query('BEGIN');
   const initial=await(first==='cancel'?transition(a):promote(a));
   check(first==='cancel'?initial.rows[0].result.transitioned:initial.rows[0].result.ok,true);
   const pid=(await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   const pending=first==='cancel'?promote(second):transition(second);
   await waitForLock(pid);await a.query('COMMIT');
   const result=(await pending).rows[0].result;await second.query('COMMIT');
   if(first==='cancel') check(result.reason,'candidate_cancelled');else check(result.transitioned,true);
   const state=(await pool.query('SELECT wa_method,assigned_channel_id,whatsapp_channel_id FROM public.businesses WHERE id=$1',[b])).rows[0];
   check(state,{wa_method:'shared',assigned_channel_id:shared,whatsapp_channel_id:null});
   check(Number((await pool.query("SELECT count(*) FROM public.whatsapp_channels WHERE channel_type='dedicated' AND is_active")).rows[0].count),0);
   console.log(`PASS two-session ordering: ${first} first`);
  }finally{await a.query('ROLLBACK');await second.query('ROLLBACK');a.release();second.release();}
 }
 console.log(`PASS ${assertions} executable role/concurrency assertions; zero skipped`);
}finally{await pool.end();}

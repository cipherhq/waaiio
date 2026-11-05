import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createHmac } from 'node:crypto';
const base=process.env.POSTGREST_604_URL, oldBase=process.env.OLD_POSTGREST_604_URL;
if(process.env.REQUIRE_POSTGREST_604==='true'&&(!base||!oldBase||!process.env.POSTGREST_604_SECRET)) throw new Error('Real PostgREST infrastructure required');
const suite=base&&oldBase?describe:describe.skip;
const business='00000000-0000-4000-a604-000000000101';
const user='00000000-0000-4000-a604-000000000102';
const service='00000000-0000-4000-a604-000000000103';
suite('M518 real PostgREST old/new payload and schema compatibility',()=>{
 let db:pg.Pool, oldDb:pg.Pool;
 const payload={p_business_id:business,p_user_id:user,p_service_id:service,p_staff_id:null,
   p_date:'2027-12-01',p_time:'10:00',p_party_size:1,p_max_capacity:1,p_flow_type:'scheduling',
   p_deposit_amount:1000,p_deposit_status:'pending',p_status:'pending',p_guest_name:'Guest',
   p_guest_phone:'+2348000000604',p_guest_email:null,p_special_requests:null,p_venue_address:null,
   p_end_date:null,p_addons_snapshot:null,p_promo_code_id:null,p_total_amount:1000,p_staff_name:null};
 const terms={price:1000,deposit:0,discount:0,country:'NG'};
 function jwt(role:string) {
   const header=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
   const claims=Buffer.from(JSON.stringify({role,exp:Math.floor(Date.now()/1000)+600})).toString('base64url');
   return header+'.'+claims+'.'+createHmac('sha256',process.env.POSTGREST_604_SECRET!).update(header+'.'+claims).digest('base64url');
 }
 async function call(name:string,body:unknown,role='service_role',url=base!) {
   return fetch(url+'/rpc/'+name,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+jwt(role)},body:JSON.stringify(body)});
 }
 beforeAll(async()=>{
   db=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});
   oldDb=new pg.Pool({connectionString:process.env.OLD_TEST_DATABASE_URL});
   for(const pool of [db,oldDb]) {
     await pool.query("INSERT INTO auth.users(id,email) VALUES($1,'http604@example.test') ON CONFLICT DO NOTHING",[user]);
     await pool.query('INSERT INTO profiles(id) VALUES($1) ON CONFLICT DO NOTHING',[user]);
     await pool.query(`INSERT INTO businesses(id,name,slug,address,city,neighborhood,phone,country_code,owner_id,status,metadata)
       VALUES($1,'HTTP604','http604','1 Test','Lagos','VI','+2348000000604','NG',$2,'active','{"prepay_mode":"full"}')`,[business,user]);
     await pool.query("INSERT INTO services(id,business_id,name,price,deposit_amount,is_active,max_capacity,duration_minutes) VALUES($1,$2,'Service',1000,0,true,1,30)",[service,business]);
   }
 });
 beforeEach(async()=>{await db.query('DELETE FROM bookings WHERE business_id=$1',[business]);});
 afterAll(async()=>{await db?.end();await oldDb?.end();});
 it('resolves the new named payload from the live schema cache',async()=>{
   const response=await call('book_slot_authoritative_604',{...payload,p_expected_terms:terms});
   expect(response.status).toBe(200);
   expect(await response.json()).toEqual([expect.objectContaining({slot_available:true,committed_total:1000,committed_deposit:1000})]);
 });
 it('retains the exact old named payload and three-column result',async()=>{
   const response=await call('book_slot_atomic',{...payload,p_expected_price:1000,p_expected_deposit:0});
   expect(response.status).toBe(200);
   const rows=await response.json();
   expect(Object.keys(rows[0]).sort()).toEqual(['booking_id','reference_code','slot_available']);
   expect(rows[0].slot_available).toBe(true);
 });
 it('rejects stale accepted terms over HTTP without a booking',async()=>{
   const response=await call('book_slot_authoritative_604',{...payload,p_expected_terms:{...terms,price:999}});
   expect(response.ok).toBe(false);
   expect((await db.query('SELECT count(*)::int n FROM bookings WHERE business_id=$1',[business])).rows[0].n).toBe(0);
 });
 it.each(['anon','authenticated'])('denies %s while service-role access remains available',async role=>{
   const response=await call('book_slot_authoritative_604',{...payload,p_expected_terms:terms},role);
   expect([401,403]).toContain(response.status);
   const permitted=await call('book_slot_authoritative_604',{...payload,p_expected_terms:terms});
   expect(permitted.status).toBe(200);
 });
 it('fails closed for new-app payload against the actual pre-M518 schema',async()=>{
   const response=await call('book_slot_authoritative_604',{...payload,p_expected_terms:terms},'service_role',oldBase!);
   expect(response.status).toBe(404);
   expect((await response.json()).code).toBe('PGRST202');
   expect((await oldDb.query('SELECT count(*)::int n FROM bookings WHERE business_id=$1',[business])).rows[0].n).toBe(0);
 });
 it('leaves the three legacy booking functions identical to the pre-M518 schema, grants included',async()=>{
   const sql=`SELECT p.oid::regprocedure::text sig, pg_get_functiondef(p.oid) def, p.proacl::text acl,
       p.prosecdef, p.proconfig::text cfg
     FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
       AND p.proname IN ('book_slot_atomic','book_manual_slot_atomic','book_with_package_atomic') ORDER BY 1`;
   const before=(await oldDb.query(sql)).rows, after=(await db.query(sql)).rows;
   expect(before).toHaveLength(3);
   expect(after).toEqual(before);
 });
 it('books the live public-route payload the same with and without M518',async()=>{
   const priced='00000000-0000-4000-a604-000000000104';
   const live={...payload,p_service_id:priced,p_date:'2027-12-05',p_max_capacity:5,p_party_size:2,
     p_deposit_amount:2000,p_total_amount:2000};
   const outcomes=[];
   for(const [pool,url] of [[oldDb,oldBase!],[db,base!]] as const){
     await pool.query("INSERT INTO services(id,business_id,name,price,deposit_amount,is_active,max_capacity,duration_minutes) VALUES($1,$2,'Priced',5000,1000,true,5,30) ON CONFLICT(id) DO NOTHING",[priced,business]);
     await pool.query('DELETE FROM bookings WHERE business_id=$1',[business]);
     const response=await call('book_slot_atomic',live,'service_role',url);
     expect(response.status).toBe(200);
     const [row]=await response.json();
     expect(row.slot_available).toBe(true);
     outcomes.push((await pool.query('SELECT total_amount::int,deposit_amount::int,deposit_status::text,status::text FROM bookings WHERE id=$1',[row.booking_id])).rows[0]);
     await pool.query('DELETE FROM bookings WHERE business_id=$1',[business]);
   }
   expect(outcomes[1]).toEqual(outcomes[0]);
   expect(outcomes[0]).toEqual({total_amount:2000,deposit_amount:2000,deposit_status:'pending',status:'pending'});
 });
 it('resolves the new manual wrapper with full value and zero upfront',async()=>{
   const response=await call('book_manual_slot_authoritative_604',{
     p_business_id:business,p_user_id:user,p_service_id:service,p_staff_id:null,
     p_date:'2027-12-01',p_time:'10:00',p_party_size:1,p_max_capacity:1,
     p_guest_name:'Guest',p_guest_phone:'+2348000000604',p_guest_email:null,p_notes:null,
     p_total_amount:1000,p_staff_name:null,p_expected_terms:terms});
   expect(response.status).toBe(200);
   expect(await response.json()).toEqual([expect.objectContaining({committed_total:1000,committed_deposit:0})]);
 });
});

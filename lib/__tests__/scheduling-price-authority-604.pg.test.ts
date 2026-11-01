import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const url = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_PG_TESTS === 'true' && !url) throw new Error('Disposable PostgreSQL is required');
const suite = url ? describe : describe.skip;
const id = (n: number) => '00000000-0000-4000-a604-' + n.toString(16).padStart(12, '0');
const business=id(1), user=id(2), service=id(3), promo=id(4), addon=id(5);
suite('M497 final-state scheduling authority', () => {
 let pool: pg.Pool;
 let admin: pg.Pool;
 const databaseName = 'core604_' + randomUUID().replaceAll('-', '');
 let databaseCreated = false;
 function payload(overrides: Record<string, unknown> = {}) {
   return { p_business_id:business,p_user_id:user,p_service_id:service,p_staff_id:null,
     p_date:'2027-12-01',p_time:'10:00',p_party_size:1,p_max_capacity:99,p_flow_type:'scheduling',
     p_deposit_amount:1000,p_deposit_status:'pending',p_status:'pending',
     p_guest_name:'Guest',p_guest_phone:'+2348000000604',p_guest_email:'core604@example.test',
     p_special_requests:null,p_venue_address:null,p_end_date:null,p_addons_snapshot:null,
     p_promo_code_id:null,p_total_amount:1000,p_staff_name:null,
     p_expected_terms:{price:1000,deposit:0,discount:0,country:'NG'},
     ...overrides };
 }
 async function rpc(overrides: Record<string,unknown> = {}, role='service_role') {
   const p=payload(overrides), entries=Object.entries(p);
   const client=await pool.connect();
   try {
     await client.query('BEGIN');
     await client.query('SET LOCAL ROLE '+role);
     const result=await client.query('SELECT to_jsonb(r) AS result FROM public.book_slot_authoritative_604('+
       entries.map(([k],i)=>k+' => $'+(i+1)).join(',')+') r',entries.map(([,v])=>typeof v==='object'&&v!==null?JSON.stringify(v):v));
     await client.query('COMMIT');
     return result.rows[0].result;
   } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
 }
 beforeAll(async()=>{
   // Bootstrap a fresh, owned database; CI's shared template contains skeletal app tables.
   const endpoint = new URL(url!);
   if (!['localhost', '127.0.0.1', '[::1]', 'postgres'].includes(endpoint.hostname)) {
     throw new Error('Core604 requires a disposable local CI PostgreSQL endpoint');
   }
   admin=new pg.Pool({connectionString:url,max:1});
   await admin.query('CREATE DATABASE "' + databaseName + '" TEMPLATE template0');
   databaseCreated = true;
   const isolatedUrl = new URL(url!);
   isolatedUrl.pathname = '/' + databaseName;
   execFileSync('bash',['scripts/ci-bootstrap-test-db.sh',isolatedUrl.toString()],{encoding:'utf8',timeout:180000,stdio:'pipe'});
   pool=new pg.Pool({connectionString:isolatedUrl.toString(),max:6});
   await pool.query("INSERT INTO auth.users(id,email) VALUES($1,'core604@example.test') ON CONFLICT DO NOTHING",[user]);
   await pool.query("INSERT INTO profiles(id,phone) VALUES($1,'+2348000000604') ON CONFLICT(id) DO UPDATE SET phone=EXCLUDED.phone",[user]);
   await pool.query(`INSERT INTO businesses(id,name,slug,address,city,neighborhood,phone,country_code,owner_id,status,metadata)
     VALUES($1,'Core604','core604','1 Test','Lagos','VI','+2348000000604','NG',$2,'active','{"prepay_mode":"full"}')`,[business,user]);
   await pool.query("INSERT INTO services(id,business_id,name,price,deposit_amount,is_active,max_capacity,duration_minutes) VALUES($1,$2,'Service',1000,0,true,1,30)",[service,business]);
 },200000);
 beforeEach(async()=>{
   await pool.query('DELETE FROM bookings WHERE business_id=$1',[business]);
   await pool.query('DELETE FROM service_addons WHERE business_id=$1',[business]);
   await pool.query('DELETE FROM promo_codes WHERE business_id=$1',[business]);
   await pool.query("UPDATE businesses SET metadata='{\"prepay_mode\":\"full\"}',deposit_per_guest=0 WHERE id=$1",[business]);
   await pool.query('UPDATE services SET price=1000,deposit_amount=0,max_capacity=1,is_active=true,price_is_variable=false WHERE id=$1',[service]);
 });
 afterAll(async()=>{
   await pool?.end();
   try {
     if (databaseCreated) await admin.query('DROP DATABASE "' + databaseName + '"');
   } finally { await admin?.end(); }
 });
 it('commits full value and payable from authoritative rows',async()=>{
   const r=await rpc();
   expect(r).toMatchObject({slot_available:true,committed_total:1000,committed_deposit:1000});
   expect((await pool.query('SELECT total_amount::int,deposit_amount::int FROM bookings WHERE id=$1',[r.booking_id])).rows[0])
     .toEqual({total_amount:1000,deposit_amount:1000});
 });
 it('multiplies service value by participants',async()=>{
   expect(await rpc({p_party_size:3,p_total_amount:3000,p_deposit_amount:3000})).toMatchObject({committed_total:3000,committed_deposit:3000});
 });
 it('keeps explicit service deposit flat and separate from full value',async()=>{
   await pool.query('UPDATE services SET deposit_amount=200 WHERE id=$1',[service]);
   expect(await rpc({p_party_size:3,p_total_amount:3000,p_deposit_amount:200,
     p_expected_terms:{price:1000,deposit:200,discount:0,country:'NG'}})).toMatchObject({committed_total:3000,committed_deposit:200});
 });
 it('rejects stale price without creating a booking',async()=>{
   await pool.query('UPDATE services SET price=1200 WHERE id=$1',[service]);
   await expect(rpc()).rejects.toThrow('terms_changed');
   expect((await pool.query('SELECT count(*)::int n FROM bookings WHERE business_id=$1',[business])).rows[0].n).toBe(0);
 });
 it('rejects mismatched business identity',async()=>{
   await expect(rpc({p_business_id:id(99)})).rejects.toThrow('business_unavailable');
 });
 it('rejects unconfirmed variable terms',async()=>{
   await pool.query('UPDATE services SET price_is_variable=true WHERE id=$1',[service]);
   await expect(rpc()).rejects.toThrow('verified_quote_required');
 });
 it('derives addon value from its locked row',async()=>{
   await pool.query("INSERT INTO service_addons(id,business_id,service_id,name,price,is_active,is_required) VALUES($1,$2,$3,'Addon',100,true,false)",[addon,business,service]);
   expect(await rpc({p_addons_snapshot:[{id:addon,name:'Addon',price:100}],p_total_amount:1100,p_deposit_amount:1100}))
     .toMatchObject({committed_total:1100,committed_deposit:1100});
 });
 it('rejects stale addon terms',async()=>{
   await pool.query("INSERT INTO service_addons(id,business_id,service_id,name,price,is_active,is_required) VALUES($1,$2,$3,'Addon',100,true,false)",[addon,business,service]);
   await expect(rpc({p_addons_snapshot:[{id:addon,price:1}]})).rejects.toThrow('addon_terms_changed');
 });
 it('serializes the last authoritative slot despite caller capacity 99',async()=>{
   const results=await Promise.all([rpc(),rpc({p_guest_phone:'+2348000000605'})]);
   expect(results.filter(r=>r.slot_available)).toHaveLength(1);
 });
 it.each(['anon','authenticated'])('denies the %s HTTP role at the RPC boundary',async role=>{
   await expect(rpc({},role)).rejects.toThrow(/permission denied/);
 });
 it('preserves the exact legacy signature and direct-payment function',async()=>{
   const row=(await pool.query(`SELECT
    to_regprocedure('public.book_slot_atomic(uuid,uuid,uuid,uuid,date,text,integer,integer,text,integer,text,text,text,text,text,text,text,date,jsonb,uuid,integer,text,uuid,uuid,integer,integer,uuid,uuid,integer,integer)') IS NOT NULL AS legacy,
    to_regprocedure('public.create_payment_booking_atomic(uuid,uuid,uuid,uuid,integer,text,text,text,integer)') IS NOT NULL AS direct,
    to_regprocedure('public.cancel_booking_with_release(uuid,text,uuid)') IS NOT NULL AS cancel`)).rows[0];
   expect(row).toEqual({legacy:true,direct:true,cancel:true});
 });
});

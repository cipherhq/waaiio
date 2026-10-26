/**
 * M469 real PostgreSQL settlement/refund currency authority regression.
 * Exercise actual migration + functions against an isolated disposable database.
 */
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
const URL = process.env.TEST_DATABASE_URL;
if (!URL && process.env.REQUIRE_PG_TESTS === 'true') throw new Error('M469 requires TEST_DATABASE_URL');
const suite = URL ? describe : describe.skip;
const B = '00000000-0000-0000-0000-000000000469';
const OTHER = '00000000-0000-0000-0000-000000000470';
const ADMIN = '00000000-0000-0000-0000-000000000471';
const run = (sql: string, values: unknown[] = []) => db.query(sql, values);
let db: Client;
const connect = async () => { const c = new Client({ connectionString: URL }); await c.connect(); return c; };
const sqlFile = (p: string) => readFileSync(resolve('supabase/migrations',p),'utf8');
async function payment(currency: string | null, direct=false, business=B, gross=100, fee=10) {
 const id=randomUUID(), booking=randomUUID();
 await run("INSERT INTO public.bookings(id,deposit_status) VALUES($1,'paid')",[booking]);
 await run("INSERT INTO public.payments(id,business_id,booking_id,currency,amount,status,gateway_reference,created_at) VALUES($1,$2,$3,$4,$5,'paid',$6,'2026-10-02')",[id,business,booking,currency,gross,'T-'+id]);
 await run("INSERT INTO public.platform_fees(id,business_id,payment_id,booking_id,transaction_amount,fee_total,gateway_fee,fee_percentage,fee_flat,waived,is_direct_transfer,created_at) VALUES($1,$2,$3,$4,$5,$6,0,0,0,false,$7,'2026-10-02')",[randomUUID(),business,id,booking,gross,fee,direct]);
 return id;
}
async function payout(net:number,currency:string|null,status='approved',business=B) {
 const id=randomUUID();
 await run("INSERT INTO public.business_payouts(id,business_id,net_amount,currency,status,transfer_method,period_start,period_end) VALUES($1,$2,$3,$4,$5,'manual_bank','2026-10-01','2026-10-07')",[id,business,net,currency,status]);
 return id;
}
async function refund(pid:string,amount=100,business=B) {
 const id=randomUUID();
 await run("INSERT INTO public.refunds(id,business_id,payment_id,status,amount,reason,initiated_by) VALUES($1,$2,$3,'provider_success_unfinalized',$4,'test', $5)",[id,business,pid,amount,ADMIN]);
 return id;
}
async function confirm(id:string) { return run("SELECT * FROM public.confirm_manual_settlement($1,'external-confirm',true,$2)",[id,ADMIN]); }
async function force(id:string) { return run("SELECT * FROM public.force_settle_executed_transfer($1,'external-force','Bank transfer executed',true,$2)",[id,ADMIN]); }
async function finish(id:string) { return run("SELECT public.finalize_refund_execution($1) AS result",[id]); }

suite('M469 settlement and refund currency safety — real PostgreSQL', () => {
 beforeAll(async () => {
  db=await connect();
  await run(`
   CREATE SCHEMA IF NOT EXISTS extensions;
   DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
   END $$;
   CREATE TYPE public.payment_status AS ENUM ('paid','refunded');
   CREATE TABLE public.business_payouts (
    id UUID PRIMARY KEY,business_id UUID NOT NULL,net_amount NUMERIC NOT NULL,
    status TEXT NOT NULL,transfer_method TEXT NOT NULL,
    period_start DATE NOT NULL,period_end DATE NOT NULL,
    transfer_reference TEXT,paid_at TIMESTAMPTZ,updated_at TIMESTAMPTZ);
   CREATE TABLE public.payout_adjustments (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,business_id UUID NOT NULL,
    amount NUMERIC NOT NULL,reason TEXT,payment_id UUID,payout_id UUID);
   CREATE TABLE public.payments (
    id UUID PRIMARY KEY,business_id UUID NOT NULL,booking_id UUID,invoice_id UUID,order_id UUID,reservation_id UUID,
    currency VARCHAR(3), amount NUMERIC NOT NULL,status public.payment_status NOT NULL DEFAULT 'paid',
    refund_amount NUMERIC,refund_reason TEXT,refunded_at TIMESTAMPTZ,refunded_by UUID,
    gateway_reference TEXT,created_at TIMESTAMPTZ DEFAULT now());
   CREATE TABLE public.platform_fees (
    id UUID PRIMARY KEY,business_id UUID NOT NULL,payment_id UUID,
    booking_id UUID,invoice_id UUID,order_id UUID,
    transaction_amount NUMERIC NOT NULL,fee_total NUMERIC DEFAULT 0,gateway_fee NUMERIC DEFAULT 0,
    fee_percentage NUMERIC DEFAULT 0,fee_flat NUMERIC DEFAULT 0,
    waived BOOLEAN DEFAULT false,is_direct_transfer BOOLEAN,refunded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now());
   CREATE TABLE public.refunds (
    id UUID PRIMARY KEY,business_id UUID NOT NULL,payment_id UUID NOT NULL,
    status TEXT NOT NULL,amount NUMERIC NOT NULL,reason TEXT,initiated_by UUID,finalized_at TIMESTAMPTZ);
   CREATE TABLE public.bookings(id UUID PRIMARY KEY,deposit_status TEXT);
   CREATE TABLE public.reservations(id UUID PRIMARY KEY,deposit_status TEXT);
   CREATE TABLE public.admin_audit_logs(
    actor_id UUID NOT NULL, action TEXT, entity_type TEXT, entity_id UUID,details JSONB);
   CREATE UNIQUE INDEX idx_business_payouts_period_unique ON public.business_payouts(business_id,period_start,period_end)
     WHERE status NOT IN ('rejected','failed');
   CREATE FUNCTION public.confirm_manual_settlement(p_payout_id uuid,p_transfer_ref text,p_attestation boolean,p_admin_id uuid) RETURNS TABLE(confirmed_id uuid)
     LANGUAGE plpgsql AS $$ BEGIN RETURN; END; $$;
   CREATE FUNCTION public.force_settle_executed_transfer(p_payout_id uuid,p_transfer_ref text,p_reason text,p_attestation boolean,p_admin_id uuid)
     RETURNS TABLE(settled_id uuid,adjustment_amount numeric)
     LANGUAGE plpgsql AS $$ BEGIN RETURN; END; $$;
   CREATE FUNCTION public.finalize_refund_execution(p_refund_id uuid) RETURNS jsonb
     LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END; $$;
  `);
  await run(sqlFile('466_payout_currency_authority.sql'));
  await run(sqlFile('468_payout_dedup_currency_authority.sql'));
  await run(sqlFile('469_settlement_currency_authority.sql'));
 },120000);
 beforeEach(async () => { await run("TRUNCATE public.payout_adjustments,public.admin_audit_logs,public.refunds,public.platform_fees,public.payments,public.bookings,public.reservations,public.business_payouts"); });
 afterAll(async () => {if(db) await db.end();});
 it('does not count NGN revenue toward a USD settlement',async()=>{
  await payment('USD');await payment('NGN',false,B,1000000,0);
  const id=await payout(150,'USD');
  await expect(confirm(id)).rejects.toThrow(/insufficient_balance/);
  expect((await run('SELECT status FROM public.business_payouts WHERE id=$1',[id])).rows[0].status).toBe('approved');
 });
 it('settles valid USD independently of a separate NGN paid payout',async()=>{
  await payment('USD');await payout(100000,'NGN','paid');
  const id=await payout(75,'USD');
  const r=await confirm(id);
  expect(r.rows[0].confirmed_id).toBe(id);
  expect((await run('SELECT status FROM public.business_payouts WHERE id=$1',[id])).rows[0].status).toBe('paid');
  expect((await run('SELECT details->>\'currency\' AS c FROM public.admin_audit_logs')).rows[0].c).toBe('USD');
 });
 it('rejects legacy unknown-currency history atomically',async()=>{
  await payment('USD'); await payout(20,null,'paid');
  const id=await payout(30,'USD');
  await expect(confirm(id)).rejects.toThrow(/currency_reconciliation_required/);
  expect((await run('SELECT status FROM public.business_payouts WHERE id=$1',[id])).rows[0].status).toBe('approved');
 });
 it('rejects unknown-currency adjustments',async()=>{
  await payment('USD');
  const id=await payout(30,'USD');
  await run("INSERT INTO public.payout_adjustments(business_id,amount,reason) VALUES($1,-5,'legacy')",[B]);
  await expect(force(id)).rejects.toThrow(/currency_reconciliation_required/);
 });
 it('force settlement creates only a USD-denominated shortfall adjustment',async()=>{
  await payment('USD');await payment('NGN',false,B,1000000,0);
  const id=await payout(110,'USD');
  const r=await force(id);
  expect(Number(r.rows[0].adjustment_amount)).toBe(-20);
  const rows=(await run('SELECT currency,amount FROM public.payout_adjustments')).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0].currency).toBe('USD');
  expect(Number(rows[0].amount)).toBe(-20);
 });
 it('refund links to correct-currency, same-period paid payout',async()=>{
  const pid=await payment('USD');
  const booking=(await run('SELECT booking_id FROM public.payments WHERE id=$1',[pid])).rows[0].booking_id;
  await run('UPDATE public.platform_fees SET fee_percentage=10 WHERE payment_id=$1',[pid]);
  // Different-currency payment for the SAME booking must not have its fee reversed.
  const otherPayment=randomUUID();
  await run("INSERT INTO public.payments(id,business_id,booking_id,currency,amount,status,gateway_reference,created_at) VALUES($1,$2,$3,'NGN',100,'paid','NGN-2','2026-10-02')",[otherPayment,B,booking]);
  await run("INSERT INTO public.platform_fees(id,business_id,payment_id,booking_id,transaction_amount,fee_total,gateway_fee,fee_percentage,fee_flat,waived,is_direct_transfer) VALUES($1,$2,$3,$4,100,10,0,0,0,false,false)",[randomUUID(),B,otherPayment,booking]);
  await payout(400,'NGN','paid');
  const matched=await payout(80,'USD','paid');
  const rid=await refund(pid,20);
  expect((await finish(rid)).rows[0].result.finalized).toBe(true);
  const x=(await run('SELECT payout_id,currency,amount FROM public.payout_adjustments')).rows;
  expect(x).toHaveLength(1);
  expect(x[0].payout_id).toBe(matched);
  expect(x[0].currency).toBe('USD');
  expect(Number(x[0].amount)).toBe(-20);
  const fees=(await run('SELECT payment_id,fee_total FROM public.platform_fees')).rows;
  expect(Number(fees.find(f=>f.payment_id===pid).fee_total)).toBe(8);
  expect(Number(fees.find(f=>f.payment_id===otherPayment).fee_total)).toBe(10);
 });
 it('direct-split refunds never create platform-held adjustments',async()=>{
  const pid=await payment('USD',true);await payout(70,'USD','paid');
  const rid=await refund(pid);
  expect((await finish(rid)).rows[0].result.finalized).toBe(true);
  expect((await run('SELECT count(*)::int n FROM public.payout_adjustments')).rows[0].n).toBe(0);
 });
 it('supports single-payment legacy booking fee without changing its payment_id',async()=>{
  const pid=await payment('USD');
  const paidId=await payout(70,'USD','paid');
  await run('UPDATE public.platform_fees SET payment_id=NULL,fee_percentage=10 WHERE payment_id=$1',[pid]);
  const rid=await refund(pid,20);
  expect((await finish(rid)).rows[0].result.finalized).toBe(true);
  const f=(await run('SELECT payment_id,fee_total FROM public.platform_fees')).rows[0];
  expect(f.payment_id).toBeNull();
  expect(Number(f.fee_total)).toBe(8);
  const adj=(await run('SELECT payout_id,currency,amount FROM public.payout_adjustments')).rows;
  expect(adj).toHaveLength(1);
  expect(adj[0].payout_id).toBe(paidId);
  expect(adj[0].currency).toBe('USD');
  expect(Number(adj[0].amount)).toBe(-20);
 });
 it('blocks ambiguous legacy fee linked to a shared booking',async()=>{
  const pid=await payment('USD');
  const booking=(await run('SELECT booking_id FROM public.payments WHERE id=$1',[pid])).rows[0].booking_id;
  await run('UPDATE public.platform_fees SET payment_id=NULL WHERE payment_id=$1',[pid]);
  await run("INSERT INTO public.payments(id,business_id,booking_id,currency,amount,status,gateway_reference,created_at) VALUES($1,$2,$3,'USD',100,'paid','SECOND','2026-10-02')",[randomUUID(),B,booking]);
  const rid=await refund(pid,20);
  await expect(finish(rid)).rejects.toThrow(/refund_fee_payment_provenance_required/);
  expect((await run('SELECT refund_amount FROM public.payments WHERE id=$1',[pid])).rows[0].refund_amount).toBeNull();
  expect((await run('SELECT status FROM public.refunds WHERE id=$1',[rid])).rows[0].status).toBe('provider_success_unfinalized');
 });
 it('refund missing currency rolls back payment and remains unfinalized',async()=>{
  const pid=await payment(null);const rid=await refund(pid);
  await expect(finish(rid)).rejects.toThrow(/refund_currency_unclassified/);
  expect((await run('SELECT refund_amount FROM public.payments WHERE id=$1',[pid])).rows[0].refund_amount).toBeNull();
  expect((await run('SELECT status FROM public.refunds WHERE id=$1',[rid])).rows[0].status).toBe('provider_success_unfinalized');
 });
 it('legacy paid payouts block refund adjustment linkage without partial commits',async()=>{
  const pid=await payment('USD');await payout(80,null,'paid');
  const rid=await refund(pid);
  await expect(finish(rid)).rejects.toThrow(/refund_payout_currency_reconciliation_required/);
  expect((await run('SELECT refund_amount FROM public.payments WHERE id=$1',[pid])).rows[0].refund_amount).toBeNull();
  expect((await run('SELECT count(*)::int n FROM public.payout_adjustments')).rows[0].n).toBe(0);
  await run('DELETE FROM public.business_payouts');
  await payout(80,'USD','paid');
  await run("INSERT INTO public.business_payouts(id,business_id,net_amount,currency,status,transfer_method,period_start,period_end) VALUES($1,$2,75,'USD','paid','manual_bank','2026-09-30','2026-10-08')",[randomUUID(),B]);
  await expect(finish(rid)).rejects.toThrow(/refund_payout_allocation_ambiguous/);
  expect((await run('SELECT count(*)::int n FROM public.payout_adjustments')).rows[0].n).toBe(0);
 });
 it('settlement audit failure rolls back paid transition',async()=>{
  await payment('USD');const id=await payout(70,'USD');
  await expect(run("SELECT * FROM public.confirm_manual_settlement($1,'EXT',true,NULL)",[id])).rejects.toThrow();
  expect((await run('SELECT status FROM public.business_payouts WHERE id=$1',[id])).rows[0].status).toBe('approved');
 });
 it('refund and settlement racing cannot leave unadjusted paid refunded funds',async()=>{
  const pid=await payment('USD');const id=await payout(70,'USD');const rid=await refund(pid);
  const a=await connect(),b=await connect();
  try {
   await Promise.allSettled([
    a.query("SELECT * FROM public.confirm_manual_settlement($1,'RACE',true,$2)",[id,ADMIN]),
    b.query('SELECT public.finalize_refund_execution($1)',[rid]),
   ]);
   const p=(await run('SELECT status FROM public.business_payouts WHERE id=$1',[id])).rows[0].status;
   const f=(await run('SELECT status FROM public.refunds WHERE id=$1',[rid])).rows[0].status;
   const n=(await run("SELECT count(*)::int n FROM public.payout_adjustments WHERE currency='USD'")).rows[0].n;
   expect(!(p==='paid' && f==='success' && n===0)).toBe(true);
   expect(p==='paid' || f==='success').toBe(true);
  }finally{await a.end();await b.end();}
 },30000);
 it('refund adjustment uses fee allocation time, not payment initiation time, for period matching',async()=>{
  // P1-4 regression: payment created Sunday, fee recorded Monday (next period)
  const pid=randomUUID(), booking=randomUUID();
  await run("INSERT INTO public.bookings(id,deposit_status) VALUES($1,'paid')",[booking]);
  // Payment initiated Sunday (period A: Oct 1-7)
  await run("INSERT INTO public.payments(id,business_id,booking_id,currency,amount,status,gateway_reference,created_at) VALUES($1,$2,$3,'USD',100,'paid',$4,'2026-10-07')",[pid,B,booking,'T-'+pid]);
  // Fee recorded Monday (period B: Oct 8-14) — webhook delayed across period boundary
  await run("INSERT INTO public.platform_fees(id,business_id,payment_id,booking_id,transaction_amount,fee_total,gateway_fee,fee_percentage,fee_flat,waived,is_direct_transfer,created_at) VALUES($1,$2,$3,$4,100,10,0,10,0,false,false,'2026-10-08')",[randomUUID(),B,pid,booking]);
  // Only period B has a paid payout (the fee landed in period B)
  const periodB=await payout(80,'USD','paid');
  await run("UPDATE public.business_payouts SET period_start='2026-10-08',period_end='2026-10-14' WHERE id=$1",[periodB]);
  const rid=await refund(pid,50);
  expect((await finish(rid)).rows[0].result.finalized).toBe(true);
  const adj=(await run('SELECT payout_id,currency,amount FROM public.payout_adjustments')).rows;
  expect(adj).toHaveLength(1);
  expect(adj[0].payout_id).toBe(periodB);
  expect(adj[0].currency).toBe('USD');
  expect(Number(adj[0].amount)).toBe(-50);
 });
 it('never grants privileged settlement to anonymous or authenticated database roles',async()=>{
  const q=await run("SELECT has_function_privilege('anon','public.confirm_manual_settlement(uuid,text,boolean,uuid)','EXECUTE') AS anon, has_function_privilege('authenticated','public.force_settle_executed_transfer(uuid,text,text,boolean,uuid)','EXECUTE') AS member, has_function_privilege('service_role','public.finalize_refund_execution(uuid)','EXECUTE') AS svc");
  expect(q.rows[0]).toMatchObject({anon:false,member:false,svc:true});
 });
});

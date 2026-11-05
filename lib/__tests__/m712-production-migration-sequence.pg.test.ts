/**
 * PR #712 production-shaped migration regression — disposable PostgreSQL.
 * Applies M439->M453->M454->M466->M468->M469->M472 on a M425-baseline DB.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { readFileSync } from 'fs';
import { resolve } from 'path';
const URL = process.env.TEST_DATABASE_URL;
if (!URL && process.env.REQUIRE_PG_TESTS === 'true') throw new Error('requires TEST_DATABASE_URL');
const suite = URL ? describe : describe.skip;
let db: Client;
const run = (s: string, v: unknown[] = []) => db.query(s, v);
const exec = (s: string) => db.query(s);
const sqlFile = (p: string) => readFileSync(resolve('supabase/migrations', p), 'utf8');
const fixture = (p: string) => readFileSync(resolve('lib/__tests__/fixtures', p), 'utf8');
const AID = '00000000-0000-0000-0000-000000000001';
const BIZ = '00000000-0000-0000-0000-000000000100';

suite('PR #712 production migration sequence — M425 baseline', () => {
  beforeAll(async () => {
    db = new Client({ connectionString: URL }); await db.connect();
    await exec(`CREATE SCHEMA IF NOT EXISTS auth; CREATE SCHEMA IF NOT EXISTS extensions;
      DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END $$;
      CREATE TABLE IF NOT EXISTS auth.users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), raw_app_meta_data JSONB DEFAULT '{}');
      ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS raw_app_meta_data JSONB DEFAULT '{}';`);
    await run("INSERT INTO auth.users (id,raw_app_meta_data) VALUES ($1,'{\"role\":\"admin\"}'::jsonb) ON CONFLICT (id) DO UPDATE SET raw_app_meta_data=EXCLUDED.raw_app_meta_data", [AID]);
    await exec("CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID LANGUAGE plpgsql STABLE AS $$ BEGIN RETURN COALESCE(nullif(current_setting('auth.test_uid',true),'')::uuid,NULL); END; $$");
    await exec("CREATE OR REPLACE FUNCTION auth.jwt() RETURNS JSONB LANGUAGE plpgsql STABLE AS $$ DECLARE v text; BEGIN v:=current_setting('auth.jwt_aal',true); IF v IS NULL OR v='' THEN v:='aal1'; END IF; RETURN jsonb_build_object('aal',v); END; $$");
    await exec("CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ DECLARE r text; BEGIN SELECT raw_app_meta_data->>'role' INTO r FROM auth.users WHERE id=auth.uid(); RETURN COALESCE(r='admin',false); EXCEPTION WHEN OTHERS THEN RETURN false; END; $$");
    await exec("CREATE OR REPLACE FUNCTION public.is_support() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ DECLARE r text; BEGIN SELECT raw_app_meta_data->>'role' INTO r FROM auth.users WHERE id=auth.uid(); RETURN COALESCE(r IN ('admin','support'),false); EXCEPTION WHEN OTHERS THEN RETURN false; END; $$");
    await exec("CREATE OR REPLACE FUNCTION public.is_admin_or_support() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$ SELECT public.is_support() $$");
    await exec("CREATE OR REPLACE FUNCTION public.is_admin_or_finance() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ DECLARE r text; BEGIN SELECT raw_app_meta_data->>'role' INTO r FROM auth.users WHERE id=auth.uid(); RETURN COALESCE(r IN ('admin','finance'),false); EXCEPTION WHEN OTHERS THEN RETURN false; END; $$");
    await exec("CREATE OR REPLACE FUNCTION public.has_platform_role(p_roles text[]) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ DECLARE r text; BEGIN SELECT raw_app_meta_data->>'role' INTO r FROM auth.users WHERE id=auth.uid(); RETURN COALESCE(r=ANY(p_roles),false); EXCEPTION WHEN OTHERS THEN RETURN false; END; $$");
    // Load M439 admin RPC stubs (exact signatures)
    await exec(fixture('m439-pre-stubs.sql'));
    // All tables M439 rewrites RLS on
    const t = ['profiles','ai_usage','businesses','campaign_donations','conversation_usage','countries','fraud_events','payout_accounts','resellers','alerts','llm_classifications','pending_transfers','platform_fee_invoices','reseller_invoices','subscription_payments','business_broadcasts','event_invites','flow_dropoffs','parties','invoices','admin_role_permissions','business_bank_accounts','event_tickets','growth_pricing','reseller_payouts','admin_impersonation_tokens'];
    for (const n of t) { const pk = n==='countries'?'code VARCHAR(4) PRIMARY KEY':'id UUID PRIMARY KEY DEFAULT gen_random_uuid()'; await exec(`CREATE TABLE IF NOT EXISTS public.${n} (${pk}); ALTER TABLE public.${n} ENABLE ROW LEVEL SECURITY`); }
    // Settlement/payout schema
    await exec(`CREATE TABLE IF NOT EXISTS public.admin_audit_logs (actor_id UUID,action TEXT,entity_type TEXT,entity_id UUID,details JSONB);
      CREATE TYPE public.payment_status AS ENUM ('paid','refunded');
      CREATE TABLE public.business_payouts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(),business_id UUID NOT NULL,net_amount NUMERIC NOT NULL,status TEXT NOT NULL DEFAULT 'pending',transfer_method TEXT NOT NULL DEFAULT 'manual_bank',period_start DATE NOT NULL,period_end DATE NOT NULL,transfer_reference TEXT,paid_at TIMESTAMPTZ,updated_at TIMESTAMPTZ);
      ALTER TABLE public.business_payouts ENABLE ROW LEVEL SECURITY;
      CREATE TABLE public.payout_adjustments (id UUID DEFAULT gen_random_uuid() PRIMARY KEY,business_id UUID NOT NULL,amount NUMERIC NOT NULL,reason TEXT,payment_id UUID,payout_id UUID);
      CREATE TABLE public.payments (id UUID PRIMARY KEY,business_id UUID NOT NULL,booking_id UUID,invoice_id UUID,order_id UUID,reservation_id UUID,currency VARCHAR(3),amount NUMERIC NOT NULL,status public.payment_status NOT NULL DEFAULT 'paid',refund_amount NUMERIC,refund_reason TEXT,refunded_at TIMESTAMPTZ,refunded_by UUID,gateway_reference TEXT,created_at TIMESTAMPTZ DEFAULT now());
      CREATE TABLE public.platform_fees (id UUID PRIMARY KEY DEFAULT gen_random_uuid(),business_id UUID NOT NULL,payment_id UUID,booking_id UUID,invoice_id UUID,order_id UUID,transaction_amount NUMERIC NOT NULL,fee_total NUMERIC DEFAULT 0,gateway_fee NUMERIC DEFAULT 0,fee_percentage NUMERIC DEFAULT 0,fee_flat NUMERIC DEFAULT 0,waived BOOLEAN DEFAULT false,is_direct_transfer BOOLEAN,refunded_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE public.refunds (id UUID PRIMARY KEY,business_id UUID NOT NULL,payment_id UUID NOT NULL,status TEXT NOT NULL,amount NUMERIC NOT NULL,reason TEXT,initiated_by UUID,finalized_at TIMESTAMPTZ);
      CREATE TABLE public.bookings (id UUID PRIMARY KEY,deposit_status TEXT);
      CREATE TABLE public.reservations (id UUID PRIMARY KEY,deposit_status TEXT); ALTER TABLE public.reservations ENABLE ROW LEVEL SECURITY;
      CREATE UNIQUE INDEX idx_business_payouts_period_unique ON public.business_payouts (business_id,period_start,period_end) WHERE status NOT IN ('rejected','failed');
      CREATE FUNCTION public.confirm_manual_settlement(p_payout_id uuid,p_transfer_ref text,p_attestation boolean,p_admin_id uuid) RETURNS TABLE(confirmed_id uuid) LANGUAGE plpgsql AS $fn$ BEGIN RETURN; END; $fn$;
      CREATE FUNCTION public.force_settle_executed_transfer(p_payout_id uuid,p_transfer_ref text,p_reason text,p_attestation boolean,p_admin_id uuid) RETURNS TABLE(settled_id uuid,adjustment_amount numeric) LANGUAGE plpgsql AS $fn$ BEGIN RETURN; END; $fn$;
      CREATE FUNCTION public.finalize_refund_execution(p_refund_id uuid) RETURNS jsonb LANGUAGE plpgsql AS $fn$ BEGIN RETURN NULL; END; $fn$;`);
    // Seed legacy data
    for (let i=0;i<11;i++){const s=new Date(2026,4+Math.floor(i/4),1+(i%4)*7),e=new Date(s);e.setDate(s.getDate()+6);
      await run("INSERT INTO public.business_payouts (business_id,net_amount,status,transfer_method,period_start,period_end) VALUES ($1,$2,'pending','manual_bank',$3,$4)",[BIZ,1000*(i+1),s.toISOString().slice(0,10),e.toISOString().slice(0,10)]);}
    for (let i=0;i<10;i++) await run("INSERT INTO public.platform_fees (business_id,payment_id,transaction_amount,fee_total) VALUES ($1,NULL,$2,$3)",[BIZ,1000+i*100,50+i*5]);
  }, 120000);
  afterAll(async () => { if (db) await db.end(); });

  it('pre-M439: is_admin works without aal2', async () => {
    await exec("SET auth.test_uid='"+AID+"'"); await exec("SET auth.jwt_aal='aal1'");
    expect((await run("SELECT public.is_admin() AS ok")).rows[0].ok).toBe(true);
  });
  it('M439 applies on M425 baseline', async () => {
    await exec(sqlFile('439_admin_mfa_enforcement.sql'));
    expect((await run("SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='admin_step_up_authorizations') AS ok")).rows[0].ok).toBe(true);
    expect((await run("SELECT EXISTS(SELECT 1 FROM pg_proc WHERE proname='has_admin_role') AS ok")).rows[0].ok).toBe(true);
  });
  it('M439: aal1 rejected', async () => { await exec("SET auth.test_uid='"+AID+"'"); await exec("SET auth.jwt_aal='aal1'");
    expect((await run("SELECT public.has_admin_role(ARRAY['admin']) AS ok")).rows[0].ok).toBe(false); });
  it('M439: aal2 accepted', async () => { await exec("SET auth.test_uid='"+AID+"'"); await exec("SET auth.jwt_aal='aal2'");
    expect((await run("SELECT public.is_admin() AS ok")).rows[0].ok).toBe(true); });
  it('M439: step_up ACL', async () => {
    const g=await run("SELECT has_table_privilege('anon','public.admin_step_up_authorizations','SELECT') AS a, has_table_privilege('service_role','public.admin_step_up_authorizations','SELECT') AS s");
    expect(g.rows[0]).toMatchObject({a:false,s:true}); });
  it('M453 applies', async () => { await exec(sqlFile('453_settlement_confirmation.sql'));
    expect((await run("SELECT length(prosrc)::int AS n FROM pg_proc WHERE proname='confirm_manual_settlement'")).rows[0].n).toBeGreaterThan(100); });
  it('M454 applies', async () => { await exec(sqlFile('454_settlement_force_reconciliation.sql'));
    expect((await run("SELECT length(prosrc)::int AS n FROM pg_proc WHERE proname='force_settle_executed_transfer'")).rows[0].n).toBeGreaterThan(100); });
  it('M466: legacy payouts retain NULL', async () => { await exec(sqlFile('466_payout_currency_authority.sql'));
    expect((await run("SELECT count(*)::int n FROM public.business_payouts WHERE currency IS NULL AND status='pending'")).rows[0].n).toBe(11); });
  it('M468: currency-scoped index', async () => { await exec(sqlFile('468_payout_dedup_currency_authority.sql'));
    expect((await run("SELECT indexdef FROM pg_indexes WHERE indexname='idx_business_payouts_period_unique'")).rows[0].indexdef).toContain('COALESCE'); });
  it('M469 applies', async () => { await exec(sqlFile('469_settlement_currency_authority.sql'));
    expect((await run("SELECT prosrc FROM pg_proc WHERE proname='confirm_manual_settlement'")).rows[0].prosrc).toContain('currency'); });
  it('M469 grants', async () => { const g=await run("SELECT has_function_privilege('anon','public.confirm_manual_settlement(uuid,text,boolean,uuid)','EXECUTE') AS a, has_function_privilege('service_role','public.finalize_refund_execution(uuid)','EXECUTE') AS s");
    expect(g.rows[0]).toMatchObject({a:false,s:true}); });
  it('M472: fee fix', async () => { await exec(sqlFile('472_refund_fee_allocation_period_fix.sql'));
    expect((await run("SELECT prosrc FROM pg_proc WHERE proname='finalize_refund_execution'")).rows[0].prosrc).toContain('v_fee_allocated_at'); });
  it('11 NULL-currency payouts survive', async () => { expect((await run("SELECT count(*)::int n FROM public.business_payouts WHERE currency IS NULL AND status='pending'")).rows[0].n).toBe(11); });
  it('10 unlinked fees survive', async () => { expect((await run("SELECT count(*)::int n FROM public.platform_fees WHERE payment_id IS NULL")).rows[0].n).toBe(10); });
  it('unique index excludes only rejected/failed', async () => { const d=(await run("SELECT indexdef FROM pg_indexes WHERE indexname='idx_business_payouts_period_unique'")).rows[0].indexdef as string;
    expect(d).toContain("'rejected'"); expect(d).toContain("'failed'"); expect(d).not.toContain("'cancelled'"); });
  it('settlement rejects NULL-currency payout', async () => {
    const lid=(await run("SELECT id FROM public.business_payouts WHERE currency IS NULL AND status='pending' LIMIT 1")).rows[0].id;
    await run("UPDATE public.business_payouts SET status='approved' WHERE id=$1",[lid]);
    await expect(run("SELECT * FROM public.confirm_manual_settlement($1,'ref',true,$2)",[lid,AID])).rejects.toThrow(/currency/i);
    await run("UPDATE public.business_payouts SET status='pending' WHERE id=$1",[lid]); });
});

/** Cumulative SQL proof only: no provider HTTP or hosted database access. */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const endpoint = new URL(process.env.TEST_DATABASE_URL || '');
if (!['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)) throw new Error('Disposable localhost PostgreSQL required');
const read = (p: string) => readFileSync(p, 'utf8');
const migration = read('supabase/migrations/503_recurring_cancellation_compatibility.sql');
const names = ['claim_paystack_billing_cycle', 'claim_recurring_billing_cycle', 'dispatch_paystack_attempt', 'finalize_paystack_recurring_charge'];
describe('M503 cumulative cancellation and accounting provenance', () => {
  const database = `cancel503_${randomUUID().replaceAll('-', '')}`;
  let control: Client, a: Client, b: Client, observer: Client, created = false;
  let beforeMetadata: unknown[];
  const scalar = async (sql: string, params: unknown[] = [], client = a) => Object.values((await client.query(sql, params)).rows[0])[0] as any;
  const metadata = async () => (await a.query(`SELECT proname, pg_get_userbyid(proowner) owner, proacl::text acl, proconfig, prosecdef, provolatile, proisstrict, proparallel, pg_get_function_identity_arguments(oid) args, pg_get_function_result(oid) result FROM pg_proc WHERE proname=ANY($1) ORDER BY proname`, [names])).rows;
  beforeAll(async () => {
    control = new Client({ connectionString: endpoint.href }); await control.connect();
    await control.query(`CREATE DATABASE ${database}`); created = true; endpoint.pathname = `/${database}`;
    [a,b,observer] = [0,1,2].map(() => new Client({ connectionString: endpoint.href, statement_timeout: 8000 }));
    await Promise.all([a.connect(),b.connect(),observer.connect()]);
    await a.query(read('lib/__tests__/fixtures/recurring-payment-provenance-schema.sql'));
    await a.query('CREATE SCHEMA extensions; ALTER EXTENSION pgcrypto SET SCHEMA extensions');
    await a.query(`CREATE TYPE subscription_tier AS ENUM('free','growth','pro'); ALTER TABLE platform_fees ADD COLUMN payment_id uuid, ADD COLUMN is_direct_transfer boolean DEFAULT false, ADD COLUMN invoice_id uuid, ADD COLUMN order_id uuid, ADD COLUMN invoiced_at timestamptz; ALTER TABLE payments ADD COLUMN invoice_id uuid,ADD COLUMN order_id uuid; CREATE TABLE platform_fee_invoices(id uuid,business_id uuid);`);
    for (const name of ['305_annual_subscriptions_loyalty','306_concurrent_finalizer_lock','334_payment_spend_marker','335_recurring_spend_finalization','337_paystack_recurring_finalization','339_stripe_recurring_finalization']) await a.query(read(`supabase/migrations/${name}.sql`));
    await a.query(read('lib/__tests__/fixtures/recurring-payment-provenance-candidate.sql'));
    const candidate = read('lib/__tests__/fixtures/legacy-accounting-hold-candidate.sql');
    const extract = (name: string) => { const start = candidate.indexOf(`CREATE FUNCTION accounting_private.${name}(`); if (start < 0) throw new Error('Missing canonical guard'); return candidate.slice(start, candidate.indexOf('END $$;', start)+7); };
    await a.query('CREATE SCHEMA accounting_private;' + extract('accounting_business_lock') + ';' + extract('guard_accounting_fee_provenance') + ';CREATE TRIGGER guard_accounting_fee_provenance BEFORE INSERT OR UPDATE OR DELETE ON platform_fees FOR EACH ROW EXECUTE FUNCTION accounting_private.guard_accounting_fee_provenance();');
    beforeMetadata = (await metadata()).map(row => row.proname === 'claim_paystack_billing_cycle' ? {...row, proconfig: ['search_path=public, extensions']} : row);
    await a.query(migration);
  }, 30000);
  afterAll(async () => { await Promise.all([a?.end(),b?.end(),observer?.end()]); if (created) await control.query(`DROP DATABASE ${database} WITH(FORCE)`); await control?.end(); });
  async function seed(gateway = 'paystack', direct = false) {
    const business = randomUUID(), sub = randomUUID();
    await a.query(`INSERT INTO businesses(id,payout_mode,trial_ends_at) VALUES($1,$2,'2020-01-01');`, [business,direct?'direct_split':'platform_managed']);
    await a.query(`INSERT INTO customer_subscriptions(id,business_id,user_id,amount,currency,status,gateway,customer_phone,next_charge_at) VALUES($1,$2,$3,50,'NGN','active',$4,'2348000000000',now()-interval '1 hour')`, [sub,business,randomUUID(),gateway]);
    return {business,sub};
  }
  async function reserve() {
    const f = await seed(); const result = await scalar('SELECT claim_paystack_billing_cycle($1)', [f.sub]); expect(result.claimed).toBe(true);
    const row = (await a.query('SELECT id,claim_token FROM paystack_billing_attempts WHERE customer_subscription_id=$1',[f.sub])).rows[0];
    return {...f,...row};
  }
  const dispatch = (f: any, client = a) => scalar('SELECT dispatch_paystack_attempt($1,$2)',[f.id,f.claim_token],client);
  const finalize = (f: any, client = a) => scalar("SELECT finalize_paystack_recurring_charge($1,5000,'NGN',$2,NULL)",[f.id,'txn-'+f.sub],client);
  async function waitForLock(pid: number) {
    for (let i=0;i<150;i++) {
      if ((await observer.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0]?.wait_event_type === 'Lock') return;
      await new Promise(resolve => setTimeout(resolve,10));
    }
    throw new Error('Expected actual PostgreSQL lock wait');
  }
  async function snapshot() { const result: Record<string,unknown> = {}; for (const table of ['bookings','payments','subscription_charges','platform_fees','payment_spend_applications','customer_profiles','paystack_billing_attempts','customer_subscriptions','processed_webhook_events']) result[table] = await scalar(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM ${table} t`); return result; }
  it('preserves metadata except the explicit claim extension path and service-only authority', async () => {
    expect(await metadata()).toEqual(beforeMetadata);
    expect(await scalar("SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pgcrypto'")).toBe('extensions');
    expect(await scalar("SELECT pg_catalog.gen_random_uuid() IS NOT NULL")).toBe(true);
    const rows = (await a.query(`SELECT proname,has_function_privilege('anon',oid,'EXECUTE') anon,has_function_privilege('authenticated',oid,'EXECUTE') authenticated,has_function_privilege('service_role',oid,'EXECUTE') service FROM pg_proc WHERE proname=ANY($1)`, [[...names,'list_cancelled_flutterwave_claims']])).rows;
    expect(rows).toHaveLength(5); for (const row of rows) expect([row.anon,row.authenticated,row.service]).toEqual([false,false,true]);
    const col = (await a.query(`SELECT is_nullable,column_default,data_type FROM information_schema.columns WHERE table_name='customer_subscriptions' AND column_name='cancellation_requested_at'`)).rows[0];
    expect(col).toEqual({is_nullable:'YES',column_default:null,data_type:'timestamp with time zone'});
  });
  for (const change of [
    'ALTER TABLE customer_subscriptions ALTER COLUMN cancellation_requested_at TYPE text',
    'ALTER TABLE customer_subscriptions ALTER COLUMN cancellation_requested_at SET DEFAULT now()',
    'ALTER TABLE customer_subscriptions ALTER COLUMN cancellation_requested_at SET NOT NULL',
    `CREATE FUNCTION public.dispatch_paystack_attempt(uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$`,
  ]) it('rejects incompatible preexisting contract: '+change, async () => {
    await a.query('BEGIN');
    try { await a.query(change); await expect(a.query(migration)).rejects.toThrow(/M503/); }
    finally { await a.query('ROLLBACK'); }
  });
  for (const change of [
    'ALTER FUNCTION public.claim_paystack_billing_cycle(uuid) SECURITY INVOKER',
    'ALTER FUNCTION public.dispatch_paystack_attempt(uuid,uuid) SET search_path=pg_catalog',
    'GRANT EXECUTE ON FUNCTION public.list_cancelled_flutterwave_claims(integer) TO PUBLIC',
    'GRANT EXECUTE ON FUNCTION public.claim_recurring_billing_cycle(uuid) TO service_role WITH GRANT OPTION',
  ]) it('final check detects metadata or ACL drift: '+change, async () => {
    await a.query('BEGIN');
    try { await a.query(change); await expect(a.query(migration.slice(migration.indexOf('DO $m503_contract$')))).rejects.toThrow(/M503/); }
    finally { await a.query('ROLLBACK'); }
  });
  for (const gateway of ['paystack','flutterwave']) {
    it(`${gateway} allows active claim and denies intent without creating new authority`, async () => {
      const f = await seed(gateway); const rpc = gateway==='paystack'?'claim_paystack_billing_cycle':'claim_recurring_billing_cycle';
      expect((await scalar(`SELECT ${rpc}($1)`,[f.sub])).claimed).toBe(true);
      const other = await seed(gateway); await a.query('UPDATE customer_subscriptions SET cancellation_requested_at=now() WHERE id=$1',[other.sub]);
      const before = await scalar("SELECT jsonb_build_object('attempts',(SELECT count(*) FROM paystack_billing_attempts),'events',(SELECT count(*) FROM processed_webhook_events))");
      expect(await scalar(`SELECT ${rpc}($1)`,[other.sub])).toMatchObject({claimed:false,reason:'cancellation_pending'});
      expect(await scalar("SELECT jsonb_build_object('attempts',(SELECT count(*) FROM paystack_billing_attempts),'events',(SELECT count(*) FROM processed_webhook_events))")).toEqual(before);
    });
  }
  it('cancellation-first blocks waiting dispatch after actual row lock', async () => {
    const f = await reserve(); const pid = await scalar('SELECT pg_backend_pid()',[],b);
    await a.query('BEGIN'); await a.query('UPDATE customer_subscriptions SET cancellation_requested_at=now() WHERE id=$1',[f.sub]);
    const pending = dispatch(f,b); try { await waitForLock(pid); } finally { await a.query('COMMIT'); }
    expect(await pending).toMatchObject({dispatched:false,reason:'cancellation_or_inactive'});
    expect(await scalar('SELECT status FROM paystack_billing_attempts WHERE id=$1',[f.id])).toBe('reserved');
  });
  it('dispatch-first allows later cancellation and truthful charged reconciliation', async () => {
    const f = await reserve(); const pid = await scalar('SELECT pg_backend_pid()',[],b);
    await a.query('BEGIN'); expect((await dispatch(f)).dispatched).toBe(true);
    const pending = b.query('UPDATE customer_subscriptions SET cancellation_requested_at=now(),status=\'cancelled\' WHERE id=$1',[f.sub]);
    try { await waitForLock(pid); } finally { await a.query('COMMIT'); } await pending;
    expect((await finalize(f)).success).toBe(true);
  });
  it('two finalizers serialize subscription-first and produce one linked fee/payment', async () => {
    const f = await reserve(); await dispatch(f); const pid = await scalar('SELECT pg_backend_pid()',[],b);
    await a.query('BEGIN'); const first = await finalize(f); const pending = finalize(f,b);
    try { await waitForLock(pid); } finally { await a.query('COMMIT'); }
    const second = await pending; expect(second).toMatchObject({success:true,already_finalized:true,payment_id:first.payment_id});
    expect((await a.query('SELECT payment_id FROM platform_fees WHERE business_id=$1',[f.business])).rows).toEqual([{payment_id:first.payment_id}]);
  });
  it('parent changed while waiting for subscription lock denies dispatch', async () => {
    const f = await reserve(), other = await seed(); const pid = await scalar('SELECT pg_backend_pid()',[],b);
    await a.query('BEGIN'); await a.query('SELECT id FROM customer_subscriptions WHERE id=$1 FOR UPDATE',[f.sub]); const pending = dispatch(f,b);
    try { await waitForLock(pid); await a.query('UPDATE paystack_billing_attempts SET customer_subscription_id=$1 WHERE id=$2',[other.sub,f.id]); } finally { await a.query('COMMIT'); }
    expect(await pending).toMatchObject({dispatched:false,reason:'attempt_changed'});
  });
  it('parent changed while finalizer waits denies without financial writes', async () => {
    const f = await reserve(), other = await seed(); await dispatch(f); const pid = await scalar('SELECT pg_backend_pid()',[],b);
    await a.query('BEGIN'); await a.query('SELECT id FROM customer_subscriptions WHERE id=$1 FOR UPDATE',[f.sub]); const pending = finalize(f,b);
    try { await waitForLock(pid); await a.query('UPDATE paystack_billing_attempts SET customer_subscription_id=$1 WHERE id=$2',[other.sub,f.id]); } finally { await a.query('COMMIT'); }
    expect(await pending).toMatchObject({success:false,reason:'attempt_changed'});
    expect(Number(await scalar('SELECT count(*) FROM payments WHERE business_id=ANY($1::uuid[])',[[f.business,other.business]]))).toBe(0);
  });
  it('claim retry reuses existing reservation and wrong gateway never creates an attempt', async () => {
    const f = await reserve(); const retry = await scalar('SELECT claim_paystack_billing_cycle($1)',[f.sub]);
    expect(retry.claimed).toBe(false); expect(Number(await scalar('SELECT count(*) FROM paystack_billing_attempts WHERE customer_subscription_id=$1',[f.sub]))).toBe(1);
    const other = await seed('stripe'); expect(await scalar('SELECT claim_paystack_billing_cycle($1)',[other.sub])).toMatchObject({claimed:false,reason:'wrong_gateway'});
  });
  it('reapplying cumulative DDL preserves populated intent and financial rows', async () => {
    const f = await seed(); await a.query('UPDATE customer_subscriptions SET cancellation_requested_at=now() WHERE id=$1',[f.sub]);
    const before = await snapshot(); await a.query(migration); expect(await snapshot()).toEqual(before); expect(await metadata()).toEqual(beforeMetadata);
  });
  it('wrong claim token and inactive subscription cannot dispatch', async () => {
    const f = await reserve(); expect(await dispatch({...f,claim_token:randomUUID()})).toMatchObject({dispatched:false,reason:'wrong_token'});
    await a.query("UPDATE customer_subscriptions SET status='cancelled' WHERE id=$1",[f.sub]); expect(await dispatch(f)).toMatchObject({dispatched:false,reason:'cancellation_or_inactive'});
  });
  it('connected provider path creates no held platform fee', async () => {
    const f = await reserve(); await a.query("UPDATE businesses SET payout_mode='direct_split' WHERE id=$1",[f.business]); await dispatch(f); expect((await finalize(f)).success).toBe(true);
    expect(Number(await scalar('SELECT count(*) FROM platform_fees WHERE business_id=$1',[f.business]))).toBe(0);
  });
  it('wrong amount/currency finalization leaves all financial state unchanged', async () => {
    const f = await reserve(); await dispatch(f); const before = await snapshot();
    expect((await scalar("SELECT finalize_paystack_recurring_charge($1,4999,'NGN','bad',NULL)",[f.id])).success).toBe(false);
    expect((await scalar("SELECT finalize_paystack_recurring_charge($1,5000,'USD','bad',NULL)",[f.id])).success).toBe(false);
    expect(await snapshot()).toEqual(before);
  });
  it('accounting provenance failure rolls back all finalizer writes', async () => {
    const f = await reserve(); await dispatch(f); await a.query(`CREATE FUNCTION fixture_corrupt_fee() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.payment_id:=gen_random_uuid(); RETURN NEW; END $$; CREATE TRIGGER aaa_fixture_corrupt_fee BEFORE INSERT ON platform_fees FOR EACH ROW EXECUTE FUNCTION fixture_corrupt_fee();`);
    const before = await snapshot(); try { await expect(finalize(f)).rejects.toThrow('accounting_fee_provenance_required'); expect(await snapshot()).toEqual(before); } finally { await a.query('DROP TRIGGER aaa_fixture_corrupt_fee ON platform_fees; DROP FUNCTION fixture_corrupt_fee()'); }
  });
  it('cancelled Flutterwave selector is bounded read-only recovery, not charge authority', async () => {
    for (let i=0;i<8;i++) { const f=await seed('flutterwave'); await a.query('UPDATE customer_subscriptions SET cancellation_requested_at=now() WHERE id=$1',[f.sub]); await a.query("INSERT INTO processed_webhook_events(event_id,gateway,event_type,status,last_error) VALUES($1,'flutterwave','token_renewal','claimed',$2)",['flw-'+f.sub+'-2026-01-01','attempt-'+i]); }
    const active = await seed('flutterwave'), wrongGateway = await seed('paystack');
    await a.query('UPDATE customer_subscriptions SET cancellation_requested_at=now() WHERE id=$1',[wrongGateway.sub]);
    for (const [ref,status] of [['flw-'+active.sub+'-2026-01-01','claimed'],['flw-'+wrongGateway.sub+'-2026-01-01','claimed'],['malformed-reference','claimed']]) await a.query("INSERT INTO processed_webhook_events(event_id,gateway,event_type,status,last_error) VALUES($1,'flutterwave','token_renewal',$2,'excluded')",[ref,status]);
    const before = await snapshot(); const rows = (await a.query('SELECT * FROM list_cancelled_flutterwave_claims(100)')).rows; expect(rows).toHaveLength(6); expect(rows.every(r=>r.claim_status==='claimed' && r.attempt_ref.startsWith('attempt-'))).toBe(true); expect(await snapshot()).toEqual(before);
  });
});

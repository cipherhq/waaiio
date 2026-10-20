import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = p => readFileSync(new URL('../'+p, import.meta.url),'utf8');
const sql=read('supabase/migrations/452_cancellation_intent_charge_gate.sql');
const pay=read('app/api/cron/retry-failed-charges/route.ts');
const flw=read('lib/payments/flutterwave-renewal.ts');
const boundary=read('lib/payments/paystack-cancellation-boundary.ts');
const cancel=read('app/api/recurring/cancel/route.ts');
const flwRecovery=read('lib/payments/flutterwave-cancellation-reconciliation.ts');
const checks=[
 ['No disallowed attempt status',()=>assert.doesNotMatch(sql,/SET status\s*=\s*'cancelled'/i)],
 ['M337 required insert columns preserved',()=>assert.match(sql,/cycle_key, scheduled_at, attempt_number,[\s\S]*?provider_reference, intended_amount_minor/i)],
 ['Paystack claim checks intent',()=>assert.match(sql,/claim_paystack_billing_cycle[\s\S]*?v_sub\.cancellation_requested_at IS NOT NULL/)],
 ['Flutterwave claim checks intent',()=>assert.match(sql,/claim_recurring_billing_cycle[\s\S]*?v_sub\.cancellation_requested_at IS NOT NULL/)],
 ['Dispatch locks parent before attempt',()=>{const f=sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.dispatch_paystack_attempt'));assert.ok(f.indexOf('customer_subscriptions WHERE id = v_parent FOR UPDATE')<f.indexOf('WHERE id = p_attempt_id FOR UPDATE'));}],
 ['Paystack invokes executable fail-closed charge boundary',()=>{assert.match(pay,/executePaystackDispatchedCharge\(/);assert.match(boundary,/subscription\.data\.cancellation_requested_at/);assert.ok(boundary.indexOf('subscription.data.cancellation_requested_at') < boundary.indexOf('outcome = await deps.charge()'));}],
 ['Flutterwave checks before external charge',()=>assert.ok(flw.indexOf('preChargeSub.cancellation_requested_at')<flw.indexOf('const result = await charge('))],
 ['Paystack preflight fails closed on read error',()=>assert.match(boundary,/if \(subscription.error \|\| !subscription.data\)/)],
 ['Flutterwave preflight fails closed on read error',()=>assert.match(flw,/preChargeError \|\| !preChargeSub/)],
 ['Cancellation intent before provider',()=>assert.ok(cancel.indexOf('update({ cancellation_requested_at:')<cancel.indexOf('cancelPaystackSub(providerCode, emailToken)'))],
 ['Reconcile after cancellation independently of past_due query',()=>assert.match(pay,/outstandingPaystack/)],
 ['Reconciliation rotates oldest unchecked attempts with CAS',()=>{assert.match(pay,/order\('verify_attempts'/);assert.match(pay,/eq\('verify_attempts', checks\)/);assert.match(pay,/Promise\.all\(/);}],
 ['Uncertain provider outcomes do not trigger another charge',()=>assert.match(boundary,/return \{ action: 'unresolved', reason: verification.status \}/)],
 ['Cancelled Flutterwave selector is service-role-only',()=>{assert.match(sql,/list_cancelled_flutterwave_claims/);assert.match(sql,/GRANT EXECUTE ON FUNCTION public\.list_cancelled_flutterwave_claims\(INTEGER\)[\s\S]*?TO service_role/);}],
 ['Cancelled Flutterwave reconciliation uses no chargeToken',()=>{assert.match(pay,/reconcileCancelledFlutterwaveClaim\(/);assert.doesNotMatch(flwRecovery,/chargeToken\(/);assert.match(flwRecovery,/finalize_token_recurring_charge/);}],
 ['Cancelled Flutterwave queue rotates by check time',()=>{assert.match(sql,/ORDER BY e.last_attempted_at NULLS FIRST/);assert.match(flwRecovery,/last_attempted_at: new Date\(\)\.toISOString\(\)/);}],
 ['No automatic refunds',()=>assert.doesNotMatch(pay+flw,/automaticRefund\(|issueRefund\(/)],
];
let failures=0;
for(const [name,fn] of checks){try{fn();console.log('PASS',name)}catch(e){failures++;console.error('FAIL',name,e.message)}}
console.log(`${checks.length-failures}/${checks.length} static checks passed`);
if(failures)process.exit(1);

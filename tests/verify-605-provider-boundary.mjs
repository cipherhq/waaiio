/** Node-only executable smoke test of actual production TypeScript helper.
 * This uses a TS transpiler (not a source-text pattern) and injects fake IO.
 * For the authoritative project suite, run the matching Vitest test file.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const req = createRequire(import.meta.url);
const tsPath = req.resolve('typescript', { paths: [process.cwd(), '/opt/nvm/versions/node/v22.16.0/lib/node_modules'] });
const ts = req(tsPath);
const source = readFileSync(new URL('../lib/payments/paystack-cancellation-boundary.ts', import.meta.url),'utf8');
const compiled = ts.transpileModule(source, { reportDiagnostics: true, compilerOptions: { target:ts.ScriptTarget.ES2022, module:ts.ModuleKind.CommonJS } });
assert.equal((compiled.diagnostics||[]).filter(d=>d.category===ts.DiagnosticCategory.Error).length,0);
const m={exports:{}};
new Function('module','exports','require',compiled.outputText)(m,m.exports,req);
const { executePaystackDispatchedCharge: execute, reconcilePaystackDispatchedAttempt: reconcile }=m.exports;
let passed=0;
async function check(name,fn){await fn();console.log('PASS',name);passed++}
function chargeDeps({state={status:'active',cancellation_requested_at:null},err=null,outcome={status:'success',reference:'ref',transactionId:'txn'},throws=false,dbError=null}={}){
 const d={calls:[],rereadSubscription:async()=>({data:state,error:err}),charge:async()=>{d.calls.push('charge');if(throws)throw Error('timeout');return outcome},recordCharged:async()=>{d.calls.push('charged');return {error:dbError}},recordDefinitiveFailure:async()=>{d.calls.push('failed');return {error:dbError}}};return d;
}
function recDeps(verifyResult={status:'success',amountMinor:5000,currency:'NGN'},opts={}){
 const d={calls:[],verify:async(ref)=>{d.calls.push('verify:'+ref);if(opts.throws)throw Error('timeout');return verifyResult},finalize:async(id)=>{d.calls.push('finalize:'+id);return {data:{success:!opts.finalizeFail,payment_id:'payment'},error:opts.dbError||null}},markDefinitiveFailure:async(id)=>{d.calls.push('failed:'+id);return {error:opts.dbError||null}}};return d;
}
const a={id:'attempt-id',provider_reference:'stable-ref',status:'dispatched'};
await check('cancelled subscription cannot call Paystack',async()=>{const d=chargeDeps({state:{status:'active',cancellation_requested_at:'2026-10-19T00:00:00Z'}});assert.equal((await execute(d)).action,'blocked');assert.deepEqual(d.calls,[])});
await check('precharge lookup error cannot call Paystack',async()=>{const d=chargeDeps({err:Error('DB offline')});assert.equal((await execute(d)).action,'blocked');assert.deepEqual(d.calls,[])});
await check('provider timeout retains unknown dispatch',async()=>{const d=chargeDeps({throws:true});assert.equal((await execute(d)).action,'unresolved');assert.deepEqual(d.calls,['charge'])});
await check('provider pending retains unknown dispatch',async()=>{const d=chargeDeps({outcome:{status:'pending',providerStatus:'processing',reference:'ref'}});assert.equal((await execute(d)).action,'unresolved');assert.deepEqual(d.calls,['charge'])});
await check('provider success DB failure remains unresolved',async()=>{const d=chargeDeps({dbError:Error('db')});assert.equal((await execute(d)).action,'unresolved');assert.deepEqual(d.calls,['charge','charged'])});
await check('definitive provider failure persisted',async()=>{const d=chargeDeps({outcome:{status:'terminal_failure',reason:'declined',reference:'ref'}});assert.equal((await execute(d)).action,'definitive_failure');assert.deepEqual(d.calls,['charge','failed'])});
await check('provider verified success finalizes existing attempt',async()=>{const d=recDeps();assert.equal((await reconcile(d,a)).action,'finalized');assert.deepEqual(d.calls,['verify:stable-ref','finalize:attempt-id'])});
for(const state of ['not_found','reversed','pending','indeterminate']){
 await check('provider '+state+' never creates new attempt',async()=>{const v=state==='pending'?{status:state,txStatus:'processing'}:state==='indeterminate'?{status:state,reason:'network'}:{status:state};const d=recDeps(v);assert.equal((await reconcile(d,a)).action,'unresolved');assert.deepEqual(d.calls,['verify:stable-ref'])});
}
await check('charged attempt conflicting failure stays unresolved',async()=>{const d=recDeps({status:'terminal_failure',reason:'conflict'});assert.equal((await reconcile(d,{...a,status:'charged'})).action,'unresolved');assert.deepEqual(d.calls,['verify:stable-ref'])});
await check('provider definitive failure can close dispatched only',async()=>{const d=recDeps({status:'terminal_failure',reason:'declined'});assert.equal((await reconcile(d,a)).action,'definitive_failure');assert.deepEqual(d.calls,['verify:stable-ref','failed:attempt-id'])});
await check('finalize database error is not success',async()=>{const d=recDeps({status:'success',amountMinor:5000,currency:'NGN'},{finalizeFail:true});assert.equal((await reconcile(d,a)).action,'unresolved')});
await check('provider verification exception is not a failure',async()=>{const d=recDeps(undefined,{throws:true});assert.equal((await reconcile(d,a)).action,'unresolved');assert.deepEqual(d.calls,['verify:stable-ref'])});
console.log(`${passed} executable Paystack provider-boundary checks passed (mock IO, no network).`);

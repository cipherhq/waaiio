import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { SECURITY_IDENTITIES, SECURITY_TARGETS, SECURITY_STORAGE_CONTRACTS, SECURITY_EVIDENCE_POLICY, SECURITY_SQL_TESTS, SECURITY_MIGRATIONS, SECURITY_LEDGER_RECIPE, securityLedgerSnapshot, observeSecurityLedger, verifySecurityPrerequisites } from '../reduced-security-policy.mjs';
import { SECURITY_POLICY, ACCOUNTING_POLICY, manifestBinding } from '../reduced-release-evidence.mjs';
import { ACCOUNTING_EVIDENCE_POLICY } from '../reduced-accounting-policy.mjs';
import { parseManifest, inspectTarget, checkDelta, TARGETS, manualAdminPolicy } from '../reduced-release-gate.mjs';
const h=(n:number)=>String(n).repeat(64), now=Date.parse('2026-11-02T10:00:00Z');
const git=(...args:string[])=>execFileSync('git',args,{encoding:'utf8'}).trim();
function fixture(){
 const manifest:any={schema_version:4,policy:SECURITY_POLICY,integration_sha:git('rev-parse','HEAD'),projects:{},storage_prerequisite:{}};
 const report:any={storage_prerequisite:{}};
 for(const kind of ['merchant','admin']){const {blobs,...identity}=SECURITY_IDENTITIES[kind];manifest.projects[kind]={...identity,source_blobs:structuredClone(blobs),project_id:TARGETS[kind].project,baseline_deployment_id:`dpl_${kind}old`};}
 for(const environment of ['staging','production']){
  const old=[{version:'100',name:'fixture',row_sha256:h(7),statement_sha256:h(1)}];
  const first={version:environment==='staging'?'491':'20261102100000',name:'private_document_storage',row_sha256:h(8),statement_sha256:environment==='staging'?'5d5d6acb547e6fe5c42ca770d3ad8844e0774d6ab4b1c27afd6bace30f80b481':h(2)};
  const second={version:'492',name:'verification_public_upload_guard',row_sha256:h(9),statement_sha256:SECURITY_MIGRATIONS[1].sha256};
  const after=[...old,first,...(environment==='staging'?[second]:[])];
  const binding={environment,project_ref:environment==='staging'?SECURITY_EVIDENCE_POLICY.staging_projects.merchant.supabase_project_ref:SECURITY_EVIDENCE_POLICY.production_project_ref,ledger_digest_recipe:SECURITY_LEDGER_RECIPE,baseline_ledger:securityLedgerSnapshot(environment==='staging'?after:old),expected_ledger:securityLedgerSnapshot(after),allowed_additions:environment==='staging'?[]:[first],security_migrations:environment==='staging'?[first,second]:[first],...(environment==='production'?{m491_envelope_sha256:h(2),m491_approval_receipt_sha256:h(3)}:{})};
  manifest.storage_prerequisite[environment]=binding;
  report.storage_prerequisite[environment]={binding:structuredClone(binding),method:'authorized-connector-read-only',raw_evidence_sha256:h(4),independent_review_reference:'fixture-review',business_mutations:0,provider_calls:0,legacy_closure_complete:false,application_phase:'not-deployed',contracts:structuredClone(SECURITY_STORAGE_CONTRACTS[environment]),observed_at:new Date(now-1000).toISOString(),ledger:observeSecurityLedger(after,environment==='staging'?[]:[first]),m492_phase:environment==='staging'?'already-installed':'deferred-until-application',m491_provenance:environment==='staging'?{kind:'historical-delimiter-reconciliation',canonical_sha256:SECURITY_MIGRATIONS[0].sha256,recorded_sha256:first.statement_sha256,canonical_execution_proven:false}:{kind:'approved-canonical-prerequisite',canonical_sha256:SECURITY_MIGRATIONS[0].sha256,executed_envelope_sha256:h(2),approval_receipt_sha256:h(3),execution_reference:'fixture-apply'}};
 }
 return {manifest,report};
}
describe('fixed security successor',()=>{
 it('binds exact identities and raw manifest while preserving accounting contracts',()=>{const {manifest}=fixture();expect(parseManifest(JSON.stringify(manifest),manifest.integration_sha)).toEqual(manifest);expect(manifestBinding(JSON.stringify(manifest),manifest).policy).toBe(SECURITY_POLICY);expect(SECURITY_EVIDENCE_POLICY.schema_contracts).toEqual(ACCOUNTING_EVIDENCE_POLICY.schema_contracts);});
 it.each(['merchant','admin'])('verifies real %s ancestry and exact blobs',kind=>{const {manifest}=fixture();expect(inspectTarget(process.cwd(),kind,manifest.projects[kind],manifest.integration_sha,manifest).sort()).toEqual([...SECURITY_TARGETS[kind].allowed].sort());});
 it.each(['baseline_sha','target_sha','target_tree'])('denies changed %s',field=>{const {manifest}=fixture();manifest.projects.merchant[field]='1'.repeat(40);expect(()=>parseManifest(JSON.stringify(manifest),manifest.integration_sha)).toThrow('fixed');});
 it('keeps v3 inventory closed and rejects an extra runtime file',()=>{const {manifest}=fixture();expect(()=>checkDelta('merchant',SECURITY_TARGETS.merchant.allowed,[],manifest)).not.toThrow();expect(()=>checkDelta('merchant',[...SECURITY_TARGETS.merchant.allowed,'lib/payment.ts'],[],manifest)).toThrow();expect(()=>checkDelta('merchant',SECURITY_TARGETS.merchant.allowed,[],{schema_version:3,policy:ACCOUNTING_POLICY})).toThrow();});
 it('retains 117 SQL controls and adds 17 storage controls',()=>expect(Object.values(SECURITY_SQL_TESTS).reduce((a,b)=>a+b,0)).toBe(134));
 it('retains all nine accounting acceptance cases',()=>expect(SECURITY_EVIDENCE_POLICY.acceptance_cases.slice(0,9)).toEqual(ACCOUNTING_EVIDENCE_POLICY.acceptance_cases));
 it('retains named manual admin policy and rejects unknown policy',()=>{const {manifest}=fixture();manifest.projects.admin.manual_alias={policy:'canonical-admin-alias-v1',preexisting_target:{id:'dpl_stale',project_id:TARGETS.admin.project,sha:'1'.repeat(40),ready_state:'READY',source:'cli',created_at:1}};expect(manualAdminPolicy(manifest)).toEqual(manifest.projects.admin.manual_alias);manifest.projects.admin.manual_alias.policy='unknown';expect(()=>manualAdminPolicy(manifest)).toThrow();});
});
describe('phase-aware observed storage prerequisite',()=>{
 it('accepts M491 before app with M492 explicitly deferred and historical stage discrepancy retained',()=>{const f=fixture();expect(verifySecurityPrerequisites(f.report,f.manifest,now)).toBe(true);});
 it.each([
  ['missing prerequisite',(f:any)=>delete f.report.storage_prerequisite.production],
  ['wrong project',(f:any)=>f.report.storage_prerequisite.production.binding.project_ref='wrong'],
  ['wrong environment',(f:any)=>f.report.storage_prerequisite.production.contracts=structuredClone(SECURITY_STORAGE_CONTRACTS.staging)],
  ['bucket public',(f:any)=>f.report.storage_prerequisite.production.contracts.buckets[4].public=true],
  ['catalog private',(f:any)=>f.report.storage_prerequisite.production.contracts.buckets[0].public=false],
  ['RLS disabled',(f:any)=>f.report.storage_prerequisite.production.contracts.objects_rls=false],
  ['service denied',(f:any)=>f.report.storage_prerequisite.production.contracts.service_role_crud.INSERT=false],
  ['extra permissive policy',(f:any)=>f.report.storage_prerequisite.production.contracts.policies.push({name:'extra'})],
  ['policy role drift',(f:any)=>f.report.storage_prerequisite.production.contracts.policies[0].roles=['authenticated']],
  ['policy expression drift',(f:any)=>f.report.storage_prerequisite.production.contracts.policies[0].using='true'],
  ['future',(f:any)=>f.report.storage_prerequisite.production.observed_at=new Date(now+1).toISOString()],
  ['stale',(f:any)=>f.report.storage_prerequisite.production.observed_at=new Date(now-900001).toISOString()],
  ['mutation',(f:any)=>f.report.storage_prerequisite.production.business_mutations=1],
  ['provider',(f:any)=>f.report.storage_prerequisite.production.provider_calls=1],
  ['claim closure',(f:any)=>f.report.storage_prerequisite.production.legacy_closure_complete=true],
  ['premature app',(f:any)=>f.report.storage_prerequisite.production.application_phase='complete'],
  ['premature M492',(f:any)=>f.report.storage_prerequisite.production.m492_phase='already-installed'],
  ['canonical stage fiction',(f:any)=>f.report.storage_prerequisite.staging.m491_provenance.canonical_execution_proven=true],
  ['stage unknown discrepancy',(f:any)=>f.report.storage_prerequisite.staging.m491_provenance.recorded_sha256=h(9)],
  ['changed old row metadata',(f:any)=>f.report.storage_prerequisite.production.ledger.baseline_sha256=h(9)],
  ['changed old ledger',(f:any)=>f.report.storage_prerequisite.production.ledger.baseline_sha256=h(9)],
  ['extra migration',(f:any)=>f.report.storage_prerequisite.production.ledger.additions.push({version:'999',name:'unrelated',row_sha256:h(8),statement_sha256:h(8)})],
  ['missing receipt',(f:any)=>f.report.storage_prerequisite.production.m491_provenance.approval_receipt_sha256=''],
  ['wrong envelope',(f:any)=>f.report.storage_prerequisite.production.m491_provenance.executed_envelope_sha256=h(8)],
  ['wrong canonical',(f:any)=>f.report.storage_prerequisite.production.m491_provenance.canonical_sha256=h(8)],
  ['missing raw',(f:any)=>f.report.storage_prerequisite.production.raw_evidence_sha256=''],
 ])('rejects %s',(_name,mutate)=>{const f=fixture();mutate(f);expect(()=>verifySecurityPrerequisites(f.report,f.manifest,now)).toThrow('prerequisite');});
 it('does not accept an approval that predates the observation',()=>{const f=fixture();expect(()=>verifySecurityPrerequisites(f.report,f.manifest,now,now-2000)).toThrow();});
 it('denies an unrelated addition even when manifest and observed additions agree',()=>{const f=fixture(),row={version:'999',name:'other',row_sha256:h(9),statement_sha256:h(9)};f.manifest.storage_prerequisite.production.allowed_additions.push(row);f.manifest.storage_prerequisite.production.expected_ledger.count++;f.report.storage_prerequisite.production.binding=structuredClone(f.manifest.storage_prerequisite.production);const ledger=f.report.storage_prerequisite.production.ledger;ledger.additions.push(row);ledger.count++;expect(()=>verifySecurityPrerequisites(f.report,f.manifest,now)).toThrow();});
 it('denies changed existing metadata even when the post-snapshot hash agrees',()=>{const f=fixture();f.manifest.storage_prerequisite.production.expected_ledger.sha256=h(9);f.report.storage_prerequisite.production.binding=structuredClone(f.manifest.storage_prerequisite.production);Object.assign(f.report.storage_prerequisite.production.ledger,{sha256:h(9),baseline_sha256:h(9)});expect(()=>verifySecurityPrerequisites(f.report,f.manifest,now)).toThrow();});
 it.each([
  ['wrong exclusion version',(x:any)=>x.ledger.excluded_rows[0].version='999'],
  ['wrong exclusion row',(x:any)=>x.ledger.excluded_rows[0].row_sha256=h(7)],
  ['deleted baseline row',(x:any)=>x.ledger.baseline_count--],
  ['extra baseline row',(x:any)=>x.ledger.baseline_count++],
  ['duplicate version',(x:any)=>x.ledger.duplicate_versions=1],
  ['total mismatch',(x:any)=>x.ledger.count++],
  ['null canonical statement',(x:any)=>x.ledger.security_migrations[0].statement_sha256=null],
  ['unexpected M492',(x:any)=>x.ledger.security_migrations.push({version:'492',name:'verification_public_upload_guard',statement_sha256:SECURITY_MIGRATIONS[1].sha256,row_sha256:h(9)})],
 ])('denies %s',(_name,mutate)=>{const f=fixture();mutate(f.report.storage_prerequisite.production);expect(()=>verifySecurityPrerequisites(f.report,f.manifest,now)).toThrow();});

});

import { vi, afterEach } from 'vitest';
import { deployReduced } from '../reduced-release-gate.mjs';
import { digest } from '../reduced-release-evidence.mjs';
import { ACCOUNTING_SCHEMA_PROFILES } from '../reduced-accounting-policy.mjs';
function completeEvidence(){
 const f=fixture(),m=f.manifest,r=f.report,p=SECURITY_EVIDENCE_POLICY;
 m.accounting_activation={};r.accounting_activation={};
 for(const[i,environment]of ['staging','production'].entries()){
  const profile=ACCOUNTING_SCHEMA_PROFILES[environment],binding={environment,project_ref:environment==='staging'?p.staging_projects.merchant.supabase_project_ref:p.production_project_ref,actor_id:'11111111-1111-1111-1111-111111111111',approved_manifest_sha256:h(1),executed_envelope_sha256:h(2),cohort_sha256:h(3),approval_receipt_sha256:h(i+4),counts:{holds:0,memberships:0,audit_rows:0,preserved_pending_payments:0},preserved_pending_rows_sha256:h(6)};
  m.accounting_activation[environment]=binding;
  r.accounting_activation[environment]={binding:structuredClone(binding),owner_approval_reference:'fixture',independent_review_reference:'fixture',method:'authorized-connector-read-only',active:true,installation_only:false,schema_contract_sha256:profile.schema_contract_sha256,contracts:profile.schema_contracts,canonical_installers:p.schema_contracts.canonical_sources.filter(x=>/^50[01]_/.test(x.name)),raw_evidence_sha256:h(7),audit_rows_sha256:h(8),hold_rows_sha256:h(8),membership_rows_sha256:h(8),existing_financial_rows_changed:0,provider_calls:0,observed_at:new Date(now-1000).toISOString(),committed_at:new Date(now-2000).toISOString(),counts:binding.counts,preserved_pending_rows_sha256:h(6)};
 }
 Object.assign(r,{schema_version:4,binding:manifestBinding(JSON.stringify(m),m),code_verification:{run_id:'123',run_attempt:1},independent_review:{reviewer:'fixture',reference:'fixture'},owner_acceptance_reference:'fixture',production_schema:{observed_at:new Date(now-1000).toISOString(),project_ref:p.production_project_ref,contract_sha256:p.schema_contract_sha256,contracts:p.schema_contracts,business_mutations:0,provider_calls:0,method:'authorized-connector-read-only',raw_evidence_sha256:h(7),payout_cron:{enabled:false,project_flag:'disabled',runtime_flag:'disabled',build_flag:'disabled',serving_deployment_id:m.projects.merchant.baseline_deployment_id,evidence_sha256:h(8)}},production_baselines:Object.fromEntries(Object.entries(m.projects).map(([k,v]:any)=>[k,{project_id:v.project_id,sha:v.baseline_sha,deployment_id:v.baseline_deployment_id}])),staging_acceptance:{started_at:new Date(now-3000).toISOString(),completed_at:new Date(now-2000).toISOString(),runner:{name:'fixture',command:'fixture',run_id:'fixture'},business_mutations:0,provider_calls:0,failed:0,skipped:0,security_state_writes:0,passed:p.acceptance_cases.length,cases:p.acceptance_cases.map(x=>({...x,outcome:'passed',evidence_sha256:h(8)})),deployments:Object.fromEntries(Object.entries(m.projects).map(([k,v]:any)=>[k,{...p.staging_projects[k],sha:v.target_sha,tree:v.target_tree,deployment_id:`dpl_${k}fixture`,identity_evidence_sha256:h(8)}]))}});
 return { ...f, env:()=>{const bytes=JSON.stringify(r);return{VERCEL_TOKEN:'synthetic-never-sent',GITHUB_TOKEN:'synthetic-never-sent',REDUCED_RELEASE_MANIFEST:JSON.stringify(m),PRIVATE_RELEASE_ACCEPTANCE_REPORT:bytes,PRIVATE_RELEASE_ACCEPTANCE_SHA256:digest(bytes),PRIVATE_RELEASE_RECEIPT:JSON.stringify({schema_version:4,binding:r.binding,acceptance_artifact_sha256:digest(bytes),owner_approval_reference:'fixture',code_verification:r.code_verification,approved_at:new Date(now).toISOString()})};} };
}
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
describe('actual deploy entrypoint security prerequisite ordering',()=>{
 it.each(['storage','accounting','approval','digest'])('stops %s failure before any network or CLI',async kind=>{
  vi.useFakeTimers();vi.setSystemTime(now);const fetch=vi.fn();vi.stubGlobal('fetch',fetch);const f=completeEvidence();
  if(kind==='storage')f.report.storage_prerequisite.production.contracts.objects_rls=false;
  if(kind==='accounting')f.report.accounting_activation.production.existing_financial_rows_changed=1;
  const env=f.env();if(kind==='approval'){const r=JSON.parse(env.PRIVATE_RELEASE_RECEIPT);r.approved_at=new Date(now-6000).toISOString();env.PRIVATE_RELEASE_RECEIPT=JSON.stringify(r);}
  if(kind==='digest')env.PRIVATE_RELEASE_ACCEPTANCE_SHA256=h(9);
  await expect(deployReduced(f.manifest,'/nonexistent-control',{},'123',1,env)).rejects.toThrow(kind==='storage'?'Security':kind==='accounting'?'Accounting':kind==='approval'?'unapproved':'digest');expect(fetch).not.toHaveBeenCalled();
 });
 it('accepts complete security/accounting evidence and proceeds to control checkout verification only',async()=>{
  vi.useFakeTimers();vi.setSystemTime(now);const fetch=vi.fn();vi.stubGlobal('fetch',fetch);const f=completeEvidence();
  await expect(deployReduced(f.manifest,'/nonexistent-control',{},'123',1,f.env())).rejects.toThrow('Trusted protected-main control checkout');expect(fetch).not.toHaveBeenCalled();
 });
});


describe('complete ledger aggregation transport',()=>{
 const row=(version:string,statement:string|null=h(1))=>({version,name:'synthetic',statement_sha256:statement,row_sha256:h(2)});
 it('uses deterministic lexical ordering and preserves legitimate NULL history through full-row hashes',()=>{
  const a=[row('2',null),row('10')];expect(securityLedgerSnapshot(a)).toEqual(securityLedgerSnapshot([...a].reverse()));
  expect(securityLedgerSnapshot(a).sha256).toBe(digest(JSON.stringify([{version:'10',row_sha256:h(2)},{version:'2',row_sha256:h(2)}])));
 });
 it.each(['duplicate','changed','wrong-version'])('rejects %s exclusion without hiding any row',kind=>{
  const addition={...row('491'),name:'private_document_storage'};const all=[row('100',null),addition],pin=structuredClone(addition);
  if(kind==='duplicate')all.push(structuredClone(addition));if(kind==='changed')pin.row_sha256=h(3);if(kind==='wrong-version')pin.version='999';
  expect(()=>observeSecurityLedger(all,[pin])).toThrow();
 });
 it('fits full source manifest and large historical inventories below the secret bound',()=>{
  const f=fixture();for(const [environment,count,nullCount] of [['staging',512,400],['production',384,40]] as const){
   const existing=Array.from({length:count},(_,i)=>row(String(i+1000),i<nullCount?null:h(1))),b=f.manifest.storage_prerequisite[environment];
   const current=environment==='staging'?existing:[...existing,...b.allowed_additions];
   b.baseline_ledger=securityLedgerSnapshot(existing);b.expected_ledger=securityLedgerSnapshot(current);
   expect(securityLedgerSnapshot(existing).count).toBe(count);
  }
  expect(Buffer.byteLength(JSON.stringify(f.manifest))).toBeLessThan(48*1024);
 });
});

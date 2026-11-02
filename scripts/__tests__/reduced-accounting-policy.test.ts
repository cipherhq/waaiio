import { describe, expect, it } from 'vitest';
import { ACCOUNTING_TARGETS, ACCOUNTING_EVIDENCE_POLICY as policy, ACCOUNTING_SQL_TESTS, verifyAccountingActivation } from '../reduced-accounting-policy.mjs';
import { ACCOUNTING_POLICY, PAYOUT_POLICY, manifestBinding } from '../reduced-release-evidence.mjs';
import { PAYOUT_TARGETS } from '../reduced-payout-policy.mjs';
import { checkDelta, parseManifest, TARGETS } from '../reduced-release-gate.mjs';
const now=Date.parse('2026-11-02T01:00:00Z'),h=(n:number)=>String(n).repeat(64),sha=(n:number)=>String(n).repeat(40);
function fixture(){
 const manifest:any={schema_version:3,policy:ACCOUNTING_POLICY,integration_sha:sha(1),projects:Object.fromEntries(['merchant','admin'].map((k,i)=>[k,{project_id:TARGETS[k].project,baseline_sha:sha(2),target_sha:sha(i+3),target_tree:sha(5),baseline_deployment_id:'dpl_'+k+'old'}])),accounting_activation:{}};
 const report:any={accounting_activation:{}};
 for(const [i,environment] of ['staging','production'].entries()){
  const binding={environment,project_ref:environment==='staging'?policy.staging_projects.merchant.supabase_project_ref:policy.production_project_ref,actor_id:'11111111-1111-1111-1111-111111111111',approved_manifest_sha256:h(1),executed_envelope_sha256:h(2),cohort_sha256:h(3),approval_receipt_sha256:h(i+4),counts:{holds:i+1,memberships:i,audit_rows:2*i+1,preserved_pending_payments:i+3},preserved_pending_rows_sha256:h(6)};
  manifest.accounting_activation[environment]=binding;
  report.accounting_activation[environment]={binding:structuredClone(binding),owner_approval_reference:'synthetic-owner',independent_review_reference:'synthetic-review',method:'authorized-connector-read-only',active:true,installation_only:false,schema_contract_sha256:policy.schema_contract_sha256,contracts:structuredClone(policy.schema_contracts),canonical_installers:policy.schema_contracts.canonical_sources.filter(x=>/^50[01]_/.test(x.name)),raw_evidence_sha256:h(7),audit_rows_sha256:h(8),hold_rows_sha256:h(8),membership_rows_sha256:h(8),existing_financial_rows_changed:0,provider_calls:0,observed_at:new Date(now-1000).toISOString(),committed_at:new Date(now-60000).toISOString(),counts:structuredClone(binding.counts),preserved_pending_rows_sha256:h(6)};
 }
 return {manifest,report};
}
describe('accounting activation fixed policy',()=>{
 it('recognizes the named manifest and binds exact raw bytes',()=>{const {manifest}=fixture();expect(parseManifest(JSON.stringify(manifest),manifest.integration_sha)).toEqual(manifest);expect(manifestBinding(JSON.stringify(manifest),manifest).policy).toBe(ACCOUNTING_POLICY);});
 it('keeps v2 inventory closed while requiring complete v3 inventory',()=>{expect(()=>checkDelta('merchant',ACCOUNTING_TARGETS.merchant.allowed,[],{schema_version:3,policy:ACCOUNTING_POLICY})).not.toThrow();expect(()=>checkDelta('merchant',ACCOUNTING_TARGETS.merchant.allowed,[],{schema_version:2,policy:PAYOUT_POLICY})).toThrow();expect(()=>checkDelta('merchant',PAYOUT_TARGETS.merchant.allowed,[],{schema_version:3,policy:ACCOUNTING_POLICY})).toThrow();});
 it('excludes M430, force-settle and unrelated full-main source',()=>{const allowed=ACCOUNTING_TARGETS.merchant.allowed;expect(allowed.some(x=>x.includes('430_')||x.includes('force-settle'))).toBe(false);expect(allowed).toHaveLength(52);});
 it('requires every new source blob and the unchanged admin four-file contract',()=>{expect(Object.keys(ACCOUNTING_TARGETS.merchant.blobs).sort()).toEqual([...ACCOUNTING_TARGETS.merchant.allowed].sort());expect(ACCOUNTING_TARGETS.admin.allowed).toEqual(PAYOUT_TARGETS.admin.allowed);expect(Object.keys(ACCOUNTING_TARGETS.admin.blobs)).toHaveLength(4);});
 it('requires installation, hold and recurring SQL proofs as well as original CAS/currency cases',()=>{expect(Object.values(ACCOUNTING_SQL_TESTS).reduce((a,b)=>a+b,0)).toBe(117);expect(ACCOUNTING_SQL_TESTS['lib/__tests__/legacy-accounting-hold.pg.test.ts']).toBe(42);});
 it('pins active dispatcher and private function definitions instead of simultaneously requiring old M472',()=>{const names=policy.schema_contracts.accounting_active.functions.map(x=>x.name);expect(names).toContain('finalize_refund_execution');expect(names).toContain('guard_accounting_held_payout');expect(policy.schema_contracts.functions.some(x=>x.proname==='finalize_refund_execution')).toBe(false);expect(policy.schema_contracts.accounting_active.installation_is_activation).toBe(false);});
 it('accepts distinct, exactly bound stage and production activation read-backs',()=>{const f=fixture();expect(verifyAccountingActivation(f.report,f.manifest,now)).toBe(true);});
 it.each([
  ['missing',(f:any)=>delete f.report.accounting_activation.production],
  ['install-only',(f:any)=>f.report.accounting_activation.staging.installation_only=true],
  ['inactive',(f:any)=>f.report.accounting_activation.production.active=false],
  ['wrong-environment',(f:any)=>f.manifest.accounting_activation.production.environment='staging'],
  ['wrong-project',(f:any)=>f.manifest.accounting_activation.staging.project_ref='other'],
  ['wrong-actor',(f:any)=>f.report.accounting_activation.production.binding.actor_id='22222222-2222-2222-2222-222222222222'],
  ['wrong-envelope',(f:any)=>f.report.accounting_activation.production.binding.executed_envelope_sha256=h(9)],
  ['cohort-drift',(f:any)=>f.report.accounting_activation.production.binding.cohort_sha256=h(9)],
  ['counts-reused',(f:any)=>f.report.accounting_activation.production.counts=f.report.accounting_activation.staging.counts],
  ['pending-changed',(f:any)=>f.report.accounting_activation.staging.preserved_pending_rows_sha256=h(9)],
  ['business-write',(f:any)=>f.report.accounting_activation.production.existing_financial_rows_changed=1],
  ['provider-call',(f:any)=>f.report.accounting_activation.production.provider_calls=1],
  ['stale',(f:any)=>f.report.accounting_activation.production.observed_at=new Date(now-16*60000).toISOString()],
  ['future',(f:any)=>f.report.accounting_activation.production.observed_at=new Date(now+1).toISOString()],
  ['wrong-source',(f:any)=>f.report.accounting_activation.production.canonical_installers=[]],
  ['wrong-observed-contract',(f:any)=>f.report.accounting_activation.staging.contracts.accounting_active.functions[0].body_sha256=h(9)],
  ['wrong-schema',(f:any)=>f.report.accounting_activation.production.schema_contract_sha256=h(9)],
  ['missing-approval',(f:any)=>f.report.accounting_activation.production.owner_approval_reference=''],
  ['invalid-count',(f:any)=>f.manifest.accounting_activation.production.counts.holds=-1],
 ])('rejects %s activation evidence',(_name,mutate)=>{const f=fixture();mutate(f);expect(()=>verifyAccountingActivation(f.report,f.manifest,now)).toThrow('activation');});
});

// The reviewed target commits are ordinary ancestors of this integration tree.
// This is a real Git/blob check; no filesystem stand-in for target source.
import { execFileSync } from 'node:child_process';
import { inspectTarget, hash } from '../reduced-release-gate.mjs';
describe('actual reviewed accounting target ancestry',()=>{
 it('verifies both exact target trees and every fixed source blob against real Git',()=>{
  const git=(...args:string[])=>execFileSync('git',args,{encoding:'utf8'}).trim();
  const integration=git('rev-parse','HEAD');
  const targets={merchant:['d5641bfc60eb56c510da41a2702660a899b3cb63','f95c6146f2206c8dafed20dbecec6d28b0280555'],admin:['25eaafdf416ff3eeb008e24618386b7b3881e49d','09fbcbdf406e18a5ce4f249df57ed4be488a9cd2']};
  const manifest:any={schema_version:3,policy:ACCOUNTING_POLICY,integration_sha:integration,projects:{}};
  for(const [kind,[baseline_sha,target_sha]] of Object.entries(targets)){
   const source_blobs=Object.fromEntries(ACCOUNTING_TARGETS[kind].allowed.map(file=>[file,hash(execFileSync('git',['show',`${target_sha}:${file}`]))]));
   manifest.projects[kind]={baseline_sha,target_sha,target_tree:git('rev-parse',`${target_sha}^{tree}`),source_blobs};
   expect(inspectTarget(process.cwd(),kind,manifest.projects[kind],integration,manifest).sort()).toEqual([...ACCOUNTING_TARGETS[kind].allowed].sort());
   manifest.projects[kind].source_blobs={...source_blobs,[ACCOUNTING_TARGETS[kind].allowed[0]]:h(9)};
   expect(()=>inspectTarget(process.cwd(),kind,manifest.projects[kind],integration,manifest)).toThrow('blob');
  }
 }, 30000);
});

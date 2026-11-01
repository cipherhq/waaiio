import { describe, expect, it } from 'vitest';
import { PAYOUT_POLICY, SCHEMA_MAX_AGE_MS, digest, manifestBinding, verifyPrivateEvidence, deploymentEnvironment } from '../reduced-release-evidence.mjs';
const I='1'.repeat(40),B='2'.repeat(40),M='3'.repeat(40),A='4'.repeat(40),T='5'.repeat(40),H='6'.repeat(64);
const now=Date.parse('2026-11-01T12:00:00Z');
function fixture(){
 const manifest={schema_version:2,policy:PAYOUT_POLICY,integration_sha:I,projects:{
  merchant:{project_id:'merchant',baseline_sha:B,baseline_deployment_id:'dpl_merchantold',target_sha:M,target_tree:T},
  admin:{project_id:'admin',baseline_sha:B,baseline_deployment_id:'dpl_adminold',target_sha:A,target_tree:T},
 }};
 const rawManifest=JSON.stringify(manifest),binding=manifestBinding(rawManifest,manifest);
 const policy={id:PAYOUT_POLICY,production_project_ref:'production-fixture',schema_contract_sha256:H,schema_contracts:{m498:'fixed-reviewed-function-and-acl'},
  staging_projects:{merchant:{project_id:'stage-merchant',supabase_project_ref:'stage-fixture'},admin:{project_id:'stage-admin',supabase_project_ref:'stage-fixture'}},
  acceptance_cases:[{id:'business-write-intercepted',observed:{intercepted:true,status:200}}]};
 const code_verification={run_id:'123',run_attempt:1};
 const report={schema_version:2,binding,code_verification,independent_review:{reviewer:'fixture',reference:'private-review'},owner_acceptance_reference:'private-owner',
  production_baselines:Object.fromEntries(Object.entries(binding.projects).map(([k,p]:any)=>[k,{project_id:p.project_id,sha:p.baseline_sha,deployment_id:p.baseline_deployment_id}])),
  production_schema:{observed_at:new Date(now-60000).toISOString(),project_ref:'production-fixture',contract_sha256:H,contracts:policy.schema_contracts,business_mutations:0,provider_calls:0,method:'authorized-connector-read-only',raw_evidence_sha256:H},
  staging_acceptance:{started_at:new Date(now-120000).toISOString(),completed_at:new Date(now-90000).toISOString(),runner:{name:'fixture',command:'fixture-command',run_id:'fixture-run'},
   business_mutations:0,provider_calls:0,security_state_writes:0,passed:1,failed:0,skipped:0,
   deployments:Object.fromEntries(Object.entries(binding.projects).map(([k,p]:any)=>[k,{project_id:`stage-${k}`,supabase_project_ref:'stage-fixture',sha:p.target_sha,tree:p.target_tree,deployment_id:`dpl_${k}stage`,identity_evidence_sha256:H}])),
   cases:[{id:'business-write-intercepted',outcome:'passed',observed:{intercepted:true,status:200},evidence_sha256:H}]}};
 const receipt={schema_version:2,binding,code_verification,approved_at:new Date(now-30000).toISOString(),owner_approval_reference:'private-owner',acceptance_artifact_sha256:''};
 return {manifest,rawManifest,policy,report,receipt};
}
function args(f=fixture()){
 const reportBytes=JSON.stringify(f.report),approvedHash=digest(reportBytes);
 return {...f,reportBytes,approvedHash,receiptBytes:JSON.stringify({...f.receipt,acceptance_artifact_sha256:approvedHash}),now};
}
describe('independently approved reduced release evidence',()=>{
 it('accepts exactly bound private stage evidence and fresh readonly schema snapshot',()=>{
  const result=verifyPrivateEvidence(args());expect(result.verification).toEqual({run_id:'123',run_attempt:1});expect(result.schema_observed_at).toBe(now-60000);
 });
 it('hashes raw manifest bytes rather than normalized JSON',()=>{
  const f=fixture();f.rawManifest=JSON.stringify(f.manifest,null,2);expect(()=>verifyPrivateEvidence(args(f))).toThrow('binding');
 });
 it('rejects a manifest that embeds acceptance hash circularly',()=>{
  const f:any=fixture();f.manifest.acceptance_sha256=H;f.rawManifest=JSON.stringify(f.manifest);expect(()=>verifyPrivateEvidence(args(f))).toThrow('immutable');
 });
 it('rejects tampered report even when receipt shape is valid',()=>{const a=args();a.reportBytes+=' ';expect(()=>verifyPrivateEvidence(a)).toThrow('digest');});
 it('rejects changed independently approved digest',()=>{const a=args();a.approvedHash='0'.repeat(64);expect(()=>verifyPrivateEvidence(a)).toThrow('digest');});
 it.each([
  ['target',(f:any)=>{f.report.binding.projects.merchant.target_sha=A;}],
  ['tree',(f:any)=>{f.report.binding.projects.admin.target_tree=B;}],
  ['integration',(f:any)=>{f.report.binding.integration_sha=M;}],
  ['baseline-id',(f:any)=>{f.report.production_baselines.merchant.deployment_id='dpl_replacement';}],
  ['report-review',(f:any)=>{delete f.report.independent_review.reference;}],
  ['owner-approval',(f:any)=>{delete f.receipt.owner_approval_reference;}],
  ['attempt',(f:any)=>{f.receipt.code_verification={run_id:'123',run_attempt:2};}],
  ['schema-contract',(f:any)=>{f.report.production_schema.contracts={m498:'name-only'};}],
  ['schema-project',(f:any)=>{f.report.production_schema.project_ref='other';}],
  ['schema-write',(f:any)=>{f.report.production_schema.business_mutations=1;}],
  ['schema-source',(f:any)=>{f.report.production_schema.method='unreviewed-report';}],
  ['stage-source',(f:any)=>{f.report.staging_acceptance.deployments.admin.sha=M;}],
  ['stage-project',(f:any)=>{f.report.staging_acceptance.deployments.admin.project_id='production';}],
  ['stage-ref',(f:any)=>{f.report.staging_acceptance.deployments.merchant.supabase_project_ref='production';}],
  ['business-write',(f:any)=>{f.report.staging_acceptance.business_mutations=1;}],
  ['provider-call',(f:any)=>{f.report.staging_acceptance.provider_calls=1;}],
  ['skipped',(f:any)=>{f.report.staging_acceptance.skipped=1;}],
  ['case-missing',(f:any)=>{f.report.staging_acceptance.cases=[];}],
  ['case-observation',(f:any)=>{f.report.staging_acceptance.cases[0].observed.intercepted=false;}],
  ['case-hash',(f:any)=>{delete f.report.staging_acceptance.cases[0].evidence_sha256;}],
  ['security-write',(f:any)=>{f.report.staging_acceptance.security_state_writes=1;}],
 ])('rejects independently rehashed but incompatible %s evidence',(_name,mutate)=>{
  const f=fixture();mutate(f);expect(()=>verifyPrivateEvidence(args(f))).toThrow();
 });
 it('rejects schema age at every later mutation, without pretending to query the DB',()=>{
  const a=args();expect(()=>verifyPrivateEvidence({...a,now:now+SCHEMA_MAX_AGE_MS})).toThrow('snapshot');
 });
 it('rejects future schema observations or approval predating observation',()=>{
  const f=fixture();f.report.production_schema.observed_at=new Date(now+1).toISOString();expect(()=>verifyPrivateEvidence(args(f))).toThrow('snapshot');
  f.report.production_schema.observed_at=new Date(now-1000).toISOString();expect(()=>verifyPrivateEvidence(args(f))).toThrow('snapshot');
 });
 it('permits only explicitly authorized Auth-only security writes',()=>{
  const f:any=fixture();f.report.staging_acceptance.security_state_writes='owner-authorized-auth-only';f.report.staging_acceptance.security_write_authorization='private-authorized-scope';expect(()=>verifyPrivateEvidence(args(f))).not.toThrow();
 });
 it('does not pass private evidence, database credentials or control SHA to deployment CLI',()=>{
  const child=deploymentEnvironment({PATH:'/bin',HOME:'/fixture',VERCEL_TOKEN:'synthetic-vercel',GITHUB_TOKEN:'synthetic-github',SUPABASE_ACCESS_TOKEN:'private',PRIVATE_RELEASE_ACCEPTANCE_REPORT:'private',REDUCED_RELEASE_MANIFEST:'private',GITHUB_SHA:I},'merchant','team',M);
  expect(child.GITHUB_SHA).toBe(M);expect(child.VERCEL_GIT_COMMIT_SHA).toBe(M);expect(child.VERCEL_TOKEN).toBe('synthetic-vercel');
  for(const key of ['GITHUB_TOKEN','SUPABASE_ACCESS_TOKEN','PRIVATE_RELEASE_ACCEPTANCE_REPORT','REDUCED_RELEASE_MANIFEST'])expect(child).not.toHaveProperty(key);
 });
});

describe('bounded cron and approval chronology',()=>{
 it('accepts a disabled cron observation for the exact original serving deployment',()=>{
  const f:any=fixture();f.policy.require_disabled_payout_cron=true;f.report.production_schema.payout_cron={enabled:false,project_flag:'disabled',runtime_flag:'disabled',build_flag:'disabled',serving_deployment_id:f.manifest.projects.merchant.baseline_deployment_id,evidence_sha256:H};expect(()=>verifyPrivateEvidence(args(f))).not.toThrow();
 });
 it.each(['missing','enabled','different-serving-deployment','unreadable-runtime'])('rejects %s cron evidence',(kind)=>{
  const f:any=fixture();f.policy.require_disabled_payout_cron=true;const cron={enabled:false,project_flag:'disabled',runtime_flag:'disabled',build_flag:'disabled',serving_deployment_id:f.manifest.projects.merchant.baseline_deployment_id,evidence_sha256:H};
  if(kind==='enabled')cron.enabled=true;if(kind==='different-serving-deployment')cron.serving_deployment_id='dpl_latestignored';if(kind==='unreadable-runtime')cron.runtime_flag='unreadable';if(kind!=='missing')f.report.production_schema.payout_cron=cron;
  expect(()=>verifyPrivateEvidence(args(f))).toThrow('cron');
 });
 it('rejects approval that predates completed acceptance',()=>{const f=fixture();f.report.staging_acceptance.completed_at=new Date(now-10000).toISOString();expect(()=>verifyPrivateEvidence(args(f))).toThrow('acceptance');});
});

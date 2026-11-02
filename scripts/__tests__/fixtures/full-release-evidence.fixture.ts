// Synthetic metadata only. This helper is not an observation or approval.
import {readFileSync} from 'node:fs';
import {FULL_ACCOUNTING_SCHEMA_PROFILES,FULL_CATALOG_CONTRACTS,fullKnownComponentProjection} from '../../full-release-evidence.mjs';
import {ACCOUNTING_EVIDENCE_POLICY as accountingPolicy} from '../../reduced-accounting-policy.mjs';
import {securityLedgerSnapshot,SECURITY_LEDGER_RECIPE} from '../../reduced-security-policy.mjs';
import {projectCatalog,catalogObjectsDigest} from '../../full-release-catalog.mjs';
const clone=x=>structuredClone(x);
export const FIXTURE_NOW=Date.parse('2026-11-02T01:00:00Z');
const now=FIXTURE_NOW,h=(n:number)=>String(n).repeat(64),sha=(n:number)=>String(n).repeat(40);
const base=[{version:'1',name:'original',statement_sha256:null,row_sha256:'a'.repeat(64)}];
const fixedSchema=JSON.parse(readFileSync('scripts/full-release-schema-contract.json','utf8'));
export function accountingFixture(){
 const manifest:any={schema_version:5,policy:'full-source-v1',integration_sha:sha(1),projects:Object.fromEntries(['merchant','admin'].map((k,i)=>[k,{project_id:'fixture-project',baseline_sha:sha(2),target_sha:sha(i+3),target_tree:sha(5),baseline_deployment_id:'dpl_'+k+'old'}])),accounting_activation:{}};
 const report:any={accounting_activation:{}};
 for(const [i,environment] of ['staging','production'].entries()){
  const profile=FULL_ACCOUNTING_SCHEMA_PROFILES[environment];
  const binding={environment,project_ref:environment==='staging'?accountingPolicy.staging_projects.merchant.supabase_project_ref:accountingPolicy.production_project_ref,actor_id:'11111111-1111-1111-1111-111111111111',approved_manifest_sha256:h(1),executed_envelope_sha256:h(2),cohort_sha256:h(3),approval_receipt_sha256:h(i+4),counts:{holds:i+1,memberships:i,audit_rows:2*i+1,preserved_pending_payments:i+3},preserved_pending_rows_sha256:h(6)};
  manifest.accounting_activation[environment]=binding;
  report.accounting_activation[environment]={binding:structuredClone(binding),owner_approval_reference:'synthetic-owner',independent_review_reference:'synthetic-review',method:'authorized-connector-read-only',active:true,installation_only:false,schema_contract_sha256:profile.schema_contract_sha256,contracts:structuredClone(profile.schema_contracts),canonical_installers:accountingPolicy.schema_contracts.canonical_sources.filter(x=>/^50[01]_/.test(x.name)),raw_evidence_sha256:h(7),audit_rows_sha256:h(8),hold_rows_sha256:h(8),membership_rows_sha256:h(8),existing_financial_rows_changed:0,provider_calls:0,observed_at:new Date(now-1000).toISOString(),committed_at:new Date(now-60000).toISOString(),counts:structuredClone(binding.counts),preserved_pending_rows_sha256:h(6)};
 }
 return {manifest,report};
}

export function preparedFixture(){
 const f=accountingFixture();f.report.full_release={};f.manifest.full_release={};
 for(const environment of ['staging','production']){
  const fixed=fixedSchema.profiles[environment],phases=FULL_CATALOG_CONTRACTS.profiles[environment].phases;
  const sequence=environment==='staging'?[phases.pre_app,phases.post_app]:[phases.pre_app];
  const phase=sequence.at(-1).phase, map=new Map(phases.pre_app.required_before.map(id=>[id,{fixture_preserved:true}]));
  const added=new Set(phases.pre_app.patches.filter(p=>p.operation==='add').map(p=>p.identity));
  for(const p of sequence.flatMap(p=>p.patches))if(p.operation!=='add'&&!added.has(p.identity)){
   const value:any={...(map.get(p.identity)||{}),...p.preconditions};for(const [k,v]of Object.entries(p.fields||{}))value[k]=clone(v);map.set(p.identity,value);
  }
  const before=[...map].map(([identity,value])=>({identity,value}));let after=before;for(const p of sequence)after=projectCatalog(after,p);
  const catalogBinding={environment,phase,query_sha256:phases.pre_app.query_sha256,before_catalog_sha256:catalogObjectsDigest(before)};
  const additions=fixed.ledger_additions.map((x,i)=>({...x,version:String(i+2),row_sha256:h(i%8+1)}));
  const binding={environment,project_ref:fixed.project_ref,catalog:catalogBinding,allowed_additions:additions,ledger_digest_recipe:SECURITY_LEDGER_RECIPE,baseline_ledger:securityLedgerSnapshot(base),expected_ledger:securityLedgerSnapshot([...base,...additions]),storage_closure:{legacy_verification_references:0,legacy_verification_objects:0,preserved_object_rows_sha256:h(4),preserved_reference_rows_sha256:h(5)}};
  f.manifest.full_release[environment]=binding;
  f.report.full_release[environment]={environment,project_ref:fixed.project_ref,binding:clone(binding),observed_at:new Date(now-1000).toISOString(),method:'authorized-connector-read-only',raw_evidence_sha256:h(7),independent_review_reference:'synthetic-only-review',business_mutations:0,provider_calls:0,catalog:{...catalogBinding,before,after,after_catalog_sha256:catalogObjectsDigest(after)},components:fullKnownComponentProjection(environment,phase),runtime_controls:clone(fixed.runtime_controls),migration_dispositions:clone(fixed.migration_dispositions),ledger_rows:[...clone(base),...clone(additions)],storage_closure:{status:'existing-legacy-scope-preserved-deferred',...clone(binding.storage_closure)}};
 }
 return f;
}

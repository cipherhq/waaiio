import {accountingFixture,preparedFixture} from './fixtures/full-release-evidence.fixture';
import { describe, it, expect } from 'vitest';
import { FULL_COMPONENT_CONTRACTS, FULL_ACCOUNTING_SCHEMA_PROFILES, verifyFullAccountingActivation, verifyFullKnownComponents, verifyFullLedger, verifyFullReleaseEvidence } from '../full-release-evidence.mjs';
import { ACCOUNTING_SCHEMA_PROFILES, ACCOUNTING_EVIDENCE_POLICY as accountingPolicy } from '../reduced-accounting-policy.mjs';
import { securityLedgerSnapshot, SECURITY_LEDGER_RECIPE } from '../reduced-security-policy.mjs';
const clone = x => structuredClone(x);
const base = [{version:'1',name:'original',statement_sha256:null,row_sha256:'a'.repeat(64)}];
const addition = {version:'2',name:'reviewed_forward',statement_sha256:'b'.repeat(64),row_sha256:'c'.repeat(64)};
const rules = [{name:addition.name,statement_sha256:addition.statement_sha256}];
const binding = () => ({allowed_additions:[clone(addition)],ledger_digest_recipe:SECURITY_LEDGER_RECIPE,baseline_ledger:securityLedgerSnapshot(base),expected_ledger:securityLedgerSnapshot([...base,addition])});
describe('full release observed component contracts',()=>{
  it.each(['staging','production'])('accepts only the exact %s component projection',environment=>expect(verifyFullKnownComponents(environment,clone(FULL_COMPONENT_CONTRACTS.projections[environment]))).toBe(true));
  it('rejects environment substitution (including retained hotel and function differences)',()=>expect(()=>verifyFullKnownComponents('production',FULL_COMPONENT_CONTRACTS.projections.staging)).toThrow());
  it.each(['owner','config','definer','acl','body_sha256','identity'])('rejects financial function %s drift',field=>{const x=clone(FULL_COMPONENT_CONTRACTS.projections.production);x.financial_functions[0][field]='changed';expect(()=>verifyFullKnownComponents('production',x)).toThrow();});
  it('pins all five cumulative recurring function identities and the corrected claim search path',()=>{
    const rows=FULL_COMPONENT_CONTRACTS.projections.production.recurring_functions;
    expect(rows).toHaveLength(5);
    expect(rows.find(x=>x.proname==='claim_paystack_billing_cycle').proconfig).toEqual(['search_path=public, extensions']);
    for(const field of ['defaults','proconfig','prosecdef','owner','acl','body_sha256']) {
      const x=clone(FULL_COMPONENT_CONTRACTS.projections.production);x.recurring_functions[0][field]='changed';
      expect(()=>verifyFullKnownComponents('production',x)).toThrow();
    }
  });
  it('rejects extra or omitted function records',()=>{for(const delta of ['extra','missing']){const x=clone(FULL_COMPONENT_CONTRACTS.projections.production);if(delta==='extra')x.financial_functions.push(clone(x.financial_functions[0]));else x.financial_functions.pop();expect(()=>verifyFullKnownComponents('production',x)).toThrow();}});
  it.each(['missing','extra'])('rejects %s business category enum labels',change=>{const x=clone(FULL_COMPONENT_CONTRACTS.projections.production);if(change==='missing')x.category_enum_labels.pop();else x.category_enum_labels.push('unreviewed_label');expect(()=>verifyFullKnownComponents('production',x)).toThrow();});
  it('rejects category order/group/flow changes rather than allowing just a count',()=>{for(const field of ['sort_order','category_group','flow_type']){const x=clone(FULL_COMPONENT_CONTRACTS.projections.production);x.category_reference[0][field]='changed';expect(()=>verifyFullKnownComponents('production',x)).toThrow();}});
  it('rejects removed restrictive storage policy or made-public private bucket',()=>{for(const change of ['policy','bucket']){const x=clone(FULL_COMPONENT_CONTRACTS.projections.production);if(change==='policy')x.storage.policies.pop();else x.storage.buckets.find(b=>b.id==='verification-documents').public=true;expect(()=>verifyFullKnownComponents('production',x)).toThrow();}});
  it('does not treat partial known components as a frozen complete catalog',()=>expect(()=>verifyFullReleaseEvidence({components:FULL_COMPONENT_CONTRACTS.projections},{schema_version:5,policy:'full-source-v1'})).toThrow());
});
describe('complete full-release ledger reconciliation',()=>{
  it('allows exact reviewed addition while preserving a NULL historical statement through its full row hash',()=>expect(verifyFullLedger([...base,addition],binding(),rules)).toBe(true));
  it.each(['modified','removed','extra','duplicate'])('rejects %s baseline row',kind=>{let rows=clone([...base,addition]);if(kind==='modified')rows[0].row_sha256='d'.repeat(64);if(kind==='removed')rows.shift();if(kind==='extra')rows.push({...base[0],version:'3'});if(kind==='duplicate')rows.push(clone(rows[0]));expect(()=>verifyFullLedger(rows,binding(),rules)).toThrow();});
  it('rejects mismatched excluded version and whole-row hash',()=>{for(const key of ['version','row_sha256']){const b=binding();b.allowed_additions[0][key]=key==='version'?'3':'d'.repeat(64);expect(()=>verifyFullLedger([...base,addition],b,rules)).toThrow();}});
  it('rejects an addition not named and hashed by trusted rules',()=>{const b=binding();b.allowed_additions[0].name='another_migration';expect(()=>verifyFullLedger([base[0],b.allowed_additions[0]],b,rules)).toThrow();});
  it('rejects null canonical statement even when the envelope binds it',()=>{const b=binding();b.allowed_additions[0].statement_sha256=null;expect(()=>verifyFullLedger([base[0],b.allowed_additions[0]],b,rules)).toThrow();});
  it('rejects a baseline count mismatch',()=>{const b=binding();b.baseline_ledger.count++;expect(()=>verifyFullLedger([...base,addition],b,rules)).toThrow();});
});

const now=Date.parse('2026-11-02T01:00:00Z'),h=(n:number)=>String(n).repeat(64),sha=(n:number)=>String(n).repeat(40);

describe('cumulative accounting evidence preserves prior controls',()=>{
 it('changes only the reviewed finalizer body in each prior environment profile',()=>{
  for(const environment of ['staging','production']) {
   const original=clone(ACCOUNTING_SCHEMA_PROFILES[environment].schema_contracts);
   original.accounting_active.functions.find(fn=>fn.schema==='public'&&fn.name==='finalize_paystack_recurring_charge').body_sha256=FULL_COMPONENT_CONTRACTS.accounting_finalizer_patch.body_sha256;
   expect(FULL_ACCOUNTING_SCHEMA_PROFILES[environment].schema_contracts).toEqual(original);
  }
 });
 it('accepts exact cumulative profiles with distinct genuine-shaped synthetic bindings',()=>{const f=accountingFixture();expect(verifyFullAccountingActivation(f.report,f.manifest,now)).toBe(true);});
 it.each(['old-body','unknown-grant','changed-count','stale','pending-drift','missing-approval'])('rejects %s',kind=>{
  const f=accountingFixture(),a=f.report.accounting_activation.production;
  if(kind==='old-body')a.contracts=clone(ACCOUNTING_SCHEMA_PROFILES.production.schema_contracts);
  if(kind==='unknown-grant')a.contracts.accounting_active.functions[0].acl.push({grantee:'unknown',grantor:'postgres',privilege:'EXECUTE',grantable:false});
  if(kind==='changed-count')a.counts.holds++;
  if(kind==='stale')a.observed_at=new Date(now-16*60000).toISOString();
  if(kind==='pending-drift')a.preserved_pending_rows_sha256=h(9);
  if(kind==='missing-approval')a.owner_approval_reference='';
  expect(()=>verifyFullAccountingActivation(f.report,f.manifest,now)).toThrow();
 });
});

import {readFileSync} from 'node:fs';
import {FULL_CATALOG_CONTRACTS,fullKnownComponentProjection,verifyFullPreparedEvidence} from '../full-release-evidence.mjs';
import {projectCatalog,catalogObjectsDigest} from '../full-release-catalog.mjs';
const fixedSchema=JSON.parse(readFileSync('scripts/full-release-schema-contract.json','utf8'));

describe('complete fixed full evidence core; Owner and authenticated CI gates remain separate',()=>{
 it('accepts exact staged post-app and production pre-app synthetic evidence',()=>{const f=preparedFixture();expect(verifyFullPreparedEvidence(f.report,f.manifest,now,now)).toBe(true);expect(verifyFullReleaseEvidence(f.report,f.manifest,now,now)).toBe(true)});
 it.each(['staging-pre-only','production-post','stale','future','unapproved','channel','jobs','signup','ledger-extra','ledger-null','catalog-missing','catalog-grant','category','storage-scope','writes','provider'])('rejects %s before any deployment work',kind=>{
  const f=preparedFixture(),a=f.report.full_release.production;
  if(kind==='staging-pre-only')f.report.full_release.staging.catalog.phase='pre_app';
  if(kind==='production-post')a.catalog.phase='post_app';
  if(kind==='stale')a.observed_at=new Date(now-16*60000).toISOString();
  if(kind==='future')a.observed_at=new Date(now+1000).toISOString();
  if(kind==='unapproved')a.independent_review_reference='';
  if(kind==='channel')a.runtime_controls.channel_operations.project=true;
  if(kind==='jobs')a.runtime_controls.scheduled_jobs_paused=false;
  if(kind==='signup')a.runtime_controls.signup_open=true;
  if(kind==='ledger-extra')a.ledger_rows.push({...base[0],version:'9999'});
  if(kind==='ledger-null')a.ledger_rows[1].statement_sha256=null;
  if(kind==='catalog-missing')a.catalog.after.pop();
  if(kind==='catalog-grant'){const fn=a.catalog.after.find(x=>x.identity.startsWith('function:')&&x.value.acl);fn.value.acl.push({grantee:'PUBLIC',grantor:'postgres',privilege:'EXECUTE',grantable:true})}
  if(kind==='category')a.components.category_reference[0].flow_type='other';
  if(kind==='storage-scope')a.storage_closure.legacy_verification_objects++;
  if(kind==='writes')a.business_mutations=1;if(kind==='provider')a.provider_calls=1;
  expect(()=>verifyFullPreparedEvidence(f.report,f.manifest,now,now)).toThrow();
 });
});

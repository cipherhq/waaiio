import {readFileSync} from 'node:fs';
import {isDeepStrictEqual as equal} from 'node:util';
import {POSTLAUNCH_POLICY, digest, SCHEMA_MAX_AGE_MS} from './reduced-release-evidence.mjs';
import {FULL_TARGETS,FULL_EVIDENCE_POLICY,requireFrozenFullRelease} from './full-release-policy.mjs';
import {FULL_CATALOG_CONTRACTS,verifyFullKnownComponents,verifyFullLedger} from './full-release-evidence.mjs';
import {verifyCatalogSequence,catalogObjectsDigest} from './full-release-catalog.mjs';
const completion=JSON.parse(readFileSync(new URL('./postlaunch-catalog-completion.json',import.meta.url),'utf8'));
export function postlaunchCatalogPhases(environment){
 const phases=structuredClone(FULL_CATALOG_CONTRACTS.profiles[environment].phases);
 if(environment==='production'){
  if(digest(readFileSync(new URL('../supabase/migrations/'+completion.source,import.meta.url)))!==completion.source_sha256)throw Error('Postlaunch catalog completion source changed');
  phases.post_app.patches.push(...completion.production_post_app_patches);
  for(const p of completion.production_post_app_patches){
   if(!phases.post_app.required_before.includes(p.identity))phases.post_app.required_before.push(p.identity);
   phases.post_app.required_after=phases.post_app.required_after.filter(id=>id!==p.identity);
  }
 }
 return phases;
}
export const isPostlaunchRelease=m=>m?.schema_version===6&&m.policy===POSTLAUNCH_POLICY;
export const POSTLAUNCH_IDENTITIES=JSON.parse(readFileSync(new URL('./postlaunch-release-targets.json',import.meta.url),'utf8'));
export const postlaunchInventoryDigest=kind=>digest(JSON.stringify({blobs:POSTLAUNCH_IDENTITIES[kind].blobs,deleted_blobs:POSTLAUNCH_IDENTITIES[kind].deleted_blobs}));
const deltaTests={merchant:{'lib/__tests__/admin-business-saves.test.ts':70,'lib/__tests__/homepage-452.test.ts':47,'lib/__tests__/launch-strip-navbar-469.test.ts':14,'lib/__tests__/homepage-announcement-live.test.tsx':3,'lib/__tests__/signup-plan-choice.test.tsx':4,'lib/__tests__/console-error-cleanup.test.ts':12,'lib/__tests__/onboarding-free-defaults-component.test.ts':5,'lib/__tests__/onboarding-navigation.test.ts':12,'lib/__tests__/onboarding-pricing-failclosed.test.ts':16,'lib/__tests__/onboarding-wizard-pricing-lifecycle.test.ts':6,'lib/__tests__/public-pricing-projection.test.ts':33,'lib/__tests__/marketing-country-pricing.test.tsx':1,'lib/__tests__/issue-496-qr-production.test.tsx':6,'app/dashboard/queue/__tests__/queue-share-qr.test.tsx':16},admin:{'src/__tests__/businesses-financial-capabilities-762.test.tsx':24,'src/__tests__/businesses-resource-parity-762.test.tsx':31,'src/__tests__/businesses-save-truth.test.tsx':16,'src/__tests__/launch-credits-regression.test.tsx':2,'src/__tests__/users-null-email-search-833.test.tsx':3}};
export const POSTLAUNCH_TARGETS=Object.fromEntries(Object.entries(POSTLAUNCH_IDENTITIES).map(([kind,id])=>[kind,{allowed:Object.keys(id.blobs).sort(),blobs:id.blobs,deleted_blobs:id.deleted_blobs,suites:[...FULL_TARGETS[kind].suites,{tz:'UTC',files:deltaTests[kind]}]}]));
export const POSTLAUNCH_EVIDENCE_POLICY={...FULL_EVIDENCE_POLICY,id:POSTLAUNCH_POLICY,acceptance_cases:[...FULL_EVIDENCE_POLICY.acceptance_cases,
 {id:'owner-email-bearer-authority',observed:{real_bearer_no_cookie:true,authoritative_owner_email:true,no_business_write:true}},
 {id:'postlaunch-credits-views',observed:{merchant_admin_views:true,read_only:true}},
 {id:'postlaunch-launch-list',observed:{rendered:true,preview_token_write_blocked:true}},
 {id:'postlaunch-signup-plan-navigation',observed:{free_paid_choice:true,back_preserves_choice:true,pricing_fixture:true,real_ui:true,no_signup_write:true}},
 {id:'postlaunch-marketing-navigation',observed:{navbar:true,announcement:true}},
 {id:'postlaunch-pricing-countries',observed:{all_active_countries_listed:true,prices_from_public_api:true,real_ui:true,read_only:true}},
 {id:'postlaunch-admin-users-list',observed:{list_loads:true,null_email_search_safe:true,read_only:true}},
 {id:'postlaunch-qr-assigned-channel',observed:{unassigned_shows_not_connected:true,assigned_shared_no_warning:true,read_only:true}},
]};
const fail=()=>{throw Error('Postlaunch app-only evidence is incomplete, stale, or differs from fixed policy');};
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const text=x=>typeof x==='string'&&x.trim().length>0;
export function requireFixedPostlaunch(){
 requireFrozenFullRelease();
 for(const x of Object.values(POSTLAUNCH_IDENTITIES))if(x.baseline_sha!=='b741c7cf9e2f969520f8d4ca1aa05a6582d16fac'||x.target_sha!=='5e3204d9334e171bce3475fffa179d5d23f4cc1d'||x.target_tree!=='7ef94107ca7d33b72a65e153b30c60939b888a62'||Object.keys(x.deleted_blobs).length||Object.keys(x.blobs).some(p=>(p.endsWith('.sql')&&p!=='scripts/full-release-catalog-query.sql')||p.startsWith('supabase/')))fail();
}
export function verifyPostlaunchEvidence(report,manifest,now=Date.now(),approvedAt=now){
 requireFixedPostlaunch();if(!isPostlaunchRelease(manifest))fail();
 for(const env of ['staging','production']){
  const expected=manifest.postlaunch?.[env],actual=report.postlaunch?.[env];
  const ref=env==='production'?POSTLAUNCH_EVIDENCE_POLICY.production_project_ref:POSTLAUNCH_EVIDENCE_POLICY.staging_projects.merchant.supabase_project_ref;
  if(!expected||!actual||expected.environment!==env||actual.environment!==env||expected.project_ref!==ref||actual.project_ref!==ref||!equal(actual.binding,expected))fail();
  const at=Date.parse(actual.observed_at);
  if(!Number.isFinite(at)||!Number.isFinite(now)||!Number.isFinite(approvedAt)||at>now||now-at>SCHEMA_MAX_AGE_MS||approvedAt<at||approvedAt>now||actual.method!=='authorized-connector-read-only'||!hash(actual.raw_evidence_sha256)||!text(actual.independent_review_reference)||actual.business_mutations!==0||actual.provider_calls!==0)fail();
  const p=postlaunchCatalogPhases(env);
  verifyCatalogSequence(actual.catalog,expected.catalog,[p.pre_app,p.post_app]);
  if(!hash(expected.current_catalog_sha256)||catalogObjectsDigest(actual.catalog.after)!==expected.current_catalog_sha256)fail();
  verifyFullKnownComponents(env,actual.components,'post_app');
  // Current complete ledger is the immutable app-only baseline. No addition,
  // deletion, schema execution or old financial-row replay is authorized here.
  verifyFullLedger(actual.ledger_rows,expected,[]);
  const controls={channel_operations:{project:false,build:false,runtime:false},scheduled_jobs_paused:true,signup_open:env==='production'};
  if(!equal(actual.runtime_controls,controls))fail();
  const storage=actual.storage_closure,baseline=expected.storage_closure;
  if(!storage||!baseline||storage.status!=='existing-legacy-scope-preserved-deferred'||!equal(storage,baseline)||!hash(storage.preserved_object_rows_sha256)||!hash(storage.preserved_reference_rows_sha256)||!Number.isSafeInteger(storage.legacy_verification_references)||storage.legacy_verification_references<0||!Number.isSafeInteger(storage.legacy_verification_objects)||storage.legacy_verification_objects<0)fail();
 }
 return true;
}

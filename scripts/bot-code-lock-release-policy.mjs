// Schema 9: the release of #841 (short merchant links) and #842 (app side of
// M508), 73377818 -> bdc007a8, with exactly one reviewed migration (M508)
// that the Owner approved and applied to staging and production BEFORE the
// manifest is built (database first). Everything schema 7 proves is still
// proven: the shared per-environment verifier, the M507 function contract and
// M430 absence in production. This profile adds only:
//  - the M508 ledger rule (exact reviewed file bytes);
//  - one final catalog phase with exactly the three M508 catalog changes.
// Release Process V3 (#843) will replace per-release profiles; this is the
// last one, by Owner decision 2026-11-03.
import {readFileSync} from 'node:fs';
import {isDeepStrictEqual as equal} from 'node:util';
import {BOT_CODE_LOCK_POLICY, digest} from './reduced-release-evidence.mjs';
import {requireFrozenFullRelease} from './full-release-policy.mjs';
import {POSTLAUNCH_EVIDENCE_POLICY,postlaunchCatalogPhases,verifyPostlaunchEnvironment} from './postlaunch-release-policy.mjs';
import {FIRST_ASSIGNMENT_CONTRACTS,FIRST_ASSIGNMENT_TARGETS,FIRST_ASSIGNMENT_MAIN_SQL_TESTS,FIRST_ASSIGNMENT_SQL_TESTS,FIRST_ASSIGNMENT_CANONICAL_SOURCES,FIRST_ASSIGNMENT_EVIDENCE_POLICY} from './first-assignment-release-policy.mjs';
const read=name=>readFileSync(new URL(name,import.meta.url));
export const isBotCodeLockRelease=m=>m?.schema_version===9&&m.policy===BOT_CODE_LOCK_POLICY;
export const BOT_CODE_LOCK_IDENTITIES=JSON.parse(read('./bot-code-lock-release-targets.json'));
export const BOT_CODE_LOCK_CONTRACTS=JSON.parse(read('./bot-code-lock-contracts.json'));
const M508=BOT_CODE_LOCK_CONTRACTS.migration;
// Ledger rule: the applied statement must be the exact reviewed file bytes.
export const BOT_CODE_LOCK_LEDGER_RULES=[{name:M508.ledger_name,statement_sha256:M508.sha256}];
export const botCodeLockInventoryDigest=kind=>digest(JSON.stringify({blobs:BOT_CODE_LOCK_IDENTITIES[kind].blobs,deleted_blobs:BOT_CODE_LOCK_IDENTITIES[kind].deleted_blobs}));
// New merchant suites from #841/#842. lib/__tests__/permanent-merchant-links.test.ts
// is not pinned here: it expects the production app URL and the gate runs with
// NEXT_PUBLIC_APP_URL=https://example.invalid (same Owner decision as #838).
// It still runs in Main App CI.
const deltaTests={merchant:{'lib/__tests__/channel-candidate-system.test.ts':41,'lib/__tests__/p0-table-exposure.test.ts':73,'lib/channels/__tests__/resolver-owned-channel-pointer.test.ts':5,'app/get-started/steps/__tests__/promotionGuidance.test.tsx':44,'app/get-started/steps/__tests__/success-qr-permanent-link.test.tsx':3,'app/api/reseller/accounts/__tests__/reseller-status-server-write.test.ts':7,'app/dashboard/settings/tabs/__tests__/business-tab-bot-code-locked.test.tsx':2},admin:{}};
export const BOT_CODE_LOCK_TARGETS=Object.fromEntries(Object.entries(BOT_CODE_LOCK_IDENTITIES).map(([kind,id])=>[kind,{allowed:Object.keys(id.blobs).sort(),blobs:id.blobs,deleted_blobs:id.deleted_blobs,
 suites:[...FIRST_ASSIGNMENT_TARGETS[kind].suites,...(Object.keys(deltaTests[kind]).length?[{tz:'UTC',files:deltaTests[kind]}]:[])]}]));
// Disposable-PostgreSQL proof of M508 (applies 442 -> 507 -> 508 from disk).
const M508_PG={'lib/__tests__/business-control-columns-508.pg.test.ts':36};
export const BOT_CODE_LOCK_MAIN_SQL_TESTS={...FIRST_ASSIGNMENT_MAIN_SQL_TESTS,...M508_PG};
export const BOT_CODE_LOCK_SQL_TESTS={...FIRST_ASSIGNMENT_SQL_TESTS,...M508_PG};
export const BOT_CODE_LOCK_CANONICAL_SOURCES=[...FIRST_ASSIGNMENT_CANONICAL_SOURCES,{name:M508.path.replace('supabase/migrations/',''),sha256:M508.sha256}];
export const BOT_CODE_LOCK_EVIDENCE_POLICY={...POSTLAUNCH_EVIDENCE_POLICY,id:BOT_CODE_LOCK_POLICY,acceptance_cases:[...FIRST_ASSIGNMENT_EVIDENCE_POLICY.acceptance_cases,
 {id:'bot-code-lock-m508-contract',observed:{staging_catalog_delta_exact:true,production_catalog_delta_exact:true,single_ledger_addition:true,m430_absent_in_production:true,read_only:true}},
 {id:'short-merchant-links',observed:{short_link_resolves:true,uuid_link_still_resolves:true,qr_uses_uuid_link:true,real_ui:true,read_only:true}},
 {id:'bot-code-read-only-settings',observed:{bot_code_shown_not_editable:true,ordinary_fields_still_save:true,real_ui:true,no_business_write:true}},
]};
const fail=()=>{throw Error('Bot-code-lock release evidence is incomplete, stale, or differs from fixed policy');};
// One final catalog phase per environment: exactly the three M508 changes,
// from the checked-in contract (never from the manifest or the report).
export function botCodeLockCatalogPhase(env){
 const c=BOT_CODE_LOCK_CONTRACTS.catalog[env],p=postlaunchCatalogPhases(env).post_app;
 if(!c)fail();
 return {phase:p.phase,environment:p.environment,query_sha256:p.query_sha256,patches:structuredClone(c.patches),required_before:[...c.required_before],required_after:[...c.required_after]};
}
export function requireFixedBotCodeLock(){
 requireFrozenFullRelease();
 if(digest(readFileSync(new URL('../'+M508.path,import.meta.url)))!==M508.sha256)fail();
 for(const env of ['staging','production']){
  const c=BOT_CODE_LOCK_CONTRACTS.catalog[env];
  if(!c||c.patches.length!==3||c.patches.some(p=>p.source_sha256!==M508.sha256))fail();
 }
 for(const x of Object.values(BOT_CODE_LOCK_IDENTITIES)){
  if(x.baseline_sha!=='73377818e16b02bdcbc2b8251445354b2e26877c'||x.target_sha!=='bdc007a8f93febeee8ce054d075d48894afd37bb'||x.target_tree!=='45d2cfe5e92db3fd6716c076fefced06d9adba66'||Object.keys(x.deleted_blobs).length)fail();
  // The only admitted SQL is the reviewed M508 file, by exact bytes.
  for(const [path,sha] of Object.entries(x.blobs)){
   const sql=path.endsWith('.sql')&&path!=='scripts/full-release-catalog-query.sql';
   if((sql||path.startsWith('supabase/'))&&(path!==M508.path||sha!==M508.sha256))fail();
  }
  if(x.blobs[M508.path]!==M508.sha256)fail();
 }
}
// The schema 7 function readout still applies: the M507 functions are
// unchanged and M430 must stay absent from production.
function verifyFunctions(env,actual){
 const observed=actual.first_assignment_functions;
 if(!observed||!equal(observed.functions,FIRST_ASSIGNMENT_CONTRACTS.functions))fail();
 if(env==='production'&&!equal(observed.present_function_names,[]))fail();
 if(env==='production'&&!equal(observed.checked_absent_function_names,FIRST_ASSIGNMENT_CONTRACTS.production_absent_function_names))fail();
}
export function verifyBotCodeLockEvidence(report,manifest,now=Date.now(),approvedAt=now){
 requireFixedBotCodeLock();if(!isBotCodeLockRelease(manifest))fail();
 for(const env of ['staging','production']){
  verifyPostlaunchEnvironment(env,report,manifest,now,approvedAt,BOT_CODE_LOCK_LEDGER_RULES,[botCodeLockCatalogPhase(env)]);
  verifyFunctions(env,report.postlaunch[env]);
 }
 return true;
}

// Schema 7: the postlaunch app-only release plus exactly one reviewed
// migration (M507), applied separately with Owner approval before the
// manifest is built. Everything schema 6 proves is still proven through the
// same per-environment verifier; this profile adds only the M507 ledger rule,
// an exact contract for the two functions M507 installs, and proof that the
// broad M430 allocator is absent from production.
import {readFileSync} from 'node:fs';
import {isDeepStrictEqual as equal} from 'node:util';
import {FIRST_ASSIGNMENT_POLICY, digest} from './reduced-release-evidence.mjs';
import {requireFrozenFullRelease,FULL_MAIN_SQL_TESTS,FULL_SQL_TESTS} from './full-release-policy.mjs';
import {POSTLAUNCH_TARGETS,POSTLAUNCH_EVIDENCE_POLICY,verifyPostlaunchEnvironment} from './postlaunch-release-policy.mjs';
const read=name=>readFileSync(new URL(name,import.meta.url));
export const isFirstAssignmentRelease=m=>m?.schema_version===7&&m.policy===FIRST_ASSIGNMENT_POLICY;
export const FIRST_ASSIGNMENT_IDENTITIES=JSON.parse(read('./first-assignment-release-targets.json'));
export const FIRST_ASSIGNMENT_CONTRACTS=JSON.parse(read('./first-assignment-function-contracts.json'));
const M507=FIRST_ASSIGNMENT_CONTRACTS.migration;
// Ledger rule: the applied statement must be the exact reviewed file bytes.
export const FIRST_ASSIGNMENT_LEDGER_RULES=[{name:M507.ledger_name,statement_sha256:M507.sha256}];
export const firstAssignmentInventoryDigest=kind=>digest(JSON.stringify({blobs:FIRST_ASSIGNMENT_IDENTITIES[kind].blobs,deleted_blobs:FIRST_ASSIGNMENT_IDENTITIES[kind].deleted_blobs}));
const deltaTests={merchant:{'lib/__tests__/first-shared-assignment-admission.test.ts':35,'lib/__tests__/onboarding-655-flow-callback-fallback.test.ts':3,'lib/__tests__/hide-inactive-countries-marketing.test.tsx':4},admin:{}};
export const FIRST_ASSIGNMENT_TARGETS=Object.fromEntries(Object.entries(FIRST_ASSIGNMENT_IDENTITIES).map(([kind,id])=>[kind,{allowed:Object.keys(id.blobs).sort(),blobs:id.blobs,deleted_blobs:id.deleted_blobs,
 suites:[...POSTLAUNCH_TARGETS[kind].suites,...(Object.keys(deltaTests[kind]).length?[{tz:'UTC',files:deltaTests[kind]}]:[])]}]));
// Disposable-PostgreSQL proof of M507 runs in the existing integration job.
const M507_PG={'lib/__tests__/first-shared-assignment-507.pg.test.ts':24};
export const FIRST_ASSIGNMENT_MAIN_SQL_TESTS={...FULL_MAIN_SQL_TESTS,...M507_PG};
export const FIRST_ASSIGNMENT_SQL_TESTS={...FULL_SQL_TESTS,...M507_PG};
export const FIRST_ASSIGNMENT_CANONICAL_SOURCES=[{name:M507.path.replace('supabase/migrations/',''),sha256:M507.sha256}];
export const FIRST_ASSIGNMENT_EVIDENCE_POLICY={...POSTLAUNCH_EVIDENCE_POLICY,id:FIRST_ASSIGNMENT_POLICY,acceptance_cases:[...POSTLAUNCH_EVIDENCE_POLICY.acceptance_cases,
 {id:'first-assignment-m507-contract',observed:{staging_contract_exact:true,production_contract_exact:true,single_ledger_addition:true,m430_absent_in_production:true,read_only:true}},
 {id:'first-assignment-admission',observed:{switch_off_unchanged:true,assigns_first_number:true,never_replaces_assignment:true,broad_operations_stay_off:true,disposable_pg_proof:true}},
 {id:'marketing-inactive-country-hidden',observed:{footer_no_inactive_country:true,pricing_card_active_only:true,llms_no_inactive_country:true,real_ui:true,read_only:true}},
]};
const fail=()=>{throw Error('First-assignment release evidence is incomplete, stale, or differs from fixed policy');};
export function requireFixedFirstAssignment(){
 requireFrozenFullRelease();
 if(digest(readFileSync(new URL('../'+M507.path,import.meta.url)))!==M507.sha256)fail();
 for(const x of Object.values(FIRST_ASSIGNMENT_IDENTITIES)){
  if(x.baseline_sha!=='5e3204d9334e171bce3475fffa179d5d23f4cc1d'||x.target_sha!=='73377818e16b02bdcbc2b8251445354b2e26877c'||x.target_tree!=='208b1ba83474b3361ab1b01b1681476e22e8e3db'||Object.keys(x.deleted_blobs).length)fail();
  // The only admitted SQL is the reviewed M507 file, by exact bytes.
  for(const [path,sha] of Object.entries(x.blobs)){
   const sql=path.endsWith('.sql')&&path!=='scripts/full-release-catalog-query.sql';
   if((sql||path.startsWith('supabase/'))&&(path!==M507.path||sha!==M507.sha256))fail();
  }
  if(x.blobs[M507.path]!==M507.sha256)fail();
 }
}
// Exact contract readout per environment, in the fixed order of the policy.
function verifyFunctions(env,actual){
 const observed=actual.first_assignment_functions;
 if(!observed||!equal(observed.functions,FIRST_ASSIGNMENT_CONTRACTS.functions))fail();
 if(env==='production'&&!equal(observed.present_function_names,[]))fail();
 if(env==='production'&&!equal(observed.checked_absent_function_names,FIRST_ASSIGNMENT_CONTRACTS.production_absent_function_names))fail();
}
export function verifyFirstAssignmentEvidence(report,manifest,now=Date.now(),approvedAt=now){
 requireFixedFirstAssignment();if(!isFirstAssignmentRelease(manifest))fail();
 for(const env of ['staging','production']){
  verifyPostlaunchEnvironment(env,report,manifest,now,approvedAt,FIRST_ASSIGNMENT_LEDGER_RULES);
  verifyFunctions(env,report.postlaunch[env]);
 }
 return true;
}

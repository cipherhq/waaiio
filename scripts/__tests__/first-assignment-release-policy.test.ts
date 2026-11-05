import {describe,it,expect,vi,afterEach,beforeAll,afterAll} from 'vitest';
import {readFileSync,mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {FIRST_ASSIGNMENT_IDENTITIES as IDS,firstAssignmentInventoryDigest,verifyFirstAssignmentEvidence,FIRST_ASSIGNMENT_EVIDENCE_POLICY as POLICY,FIRST_ASSIGNMENT_CONTRACTS as C,FIRST_ASSIGNMENT_TARGETS,FIRST_ASSIGNMENT_MAIN_SQL_TESTS,FIRST_ASSIGNMENT_SQL_TESTS,FIRST_ASSIGNMENT_CANONICAL_SOURCES,requireFixedFirstAssignment} from '../first-assignment-release-policy.mjs';
import {postlaunchCatalogPhases,verifyPostlaunchEvidence,POSTLAUNCH_TARGETS,POSTLAUNCH_EVIDENCE_POLICY} from '../postlaunch-release-policy.mjs';
import {parseManifest,inspectTarget,checkDelta,deployReduced,TARGETS} from '../reduced-release-gate.mjs';
import {projectCatalog,catalogObjectsDigest} from '../full-release-catalog.mjs';
import {fullKnownComponentProjection} from '../full-release-evidence.mjs';
import {FULL_MAIN_SQL_TESTS} from '../full-release-policy.mjs';
import {securityLedgerSnapshot,SECURITY_LEDGER_RECIPE} from '../reduced-security-policy.mjs';
import {manifestBinding,digest} from '../reduced-release-evidence.mjs';
const NOW=Date.parse('2026-11-04T00:00:00Z'),H='a'.repeat(64),clone=x=>structuredClone(x);
const M507=C.migration;
const base={version:'1',name:'complete-current-fixture',statement_sha256:null,row_sha256:H};
const addition={version:'20261103190000',name:M507.ledger_name,statement_sha256:M507.sha256,row_sha256:'c'.repeat(64)};
function fixture(){
 const manifest:any={schema_version:7,policy:'postlaunch-first-assignment-v1',integration_sha:IDS.merchant.target_sha,projects:{},postlaunch:{}};
 for(const k of ['merchant','admin'])manifest.projects[k]={baseline_sha:IDS[k].baseline_sha,target_sha:IDS[k].target_sha,target_tree:IDS[k].target_tree,project_id:TARGETS[k].project,baseline_deployment_id:'dpl_'+k+'old',source_inventory_sha256:firstAssignmentInventoryDigest(k)};
 manifest.projects.admin.manual_alias={policy:'canonical-admin-alias-v1',preexisting_target:{id:'dpl_oldcandidate',project_id:TARGETS.admin.project,sha:IDS.admin.baseline_sha,ready_state:'READY',source:'cli',created_at:1}};
 const report:any={postlaunch:{}};
 for(const env of ['staging','production']){
  const phases=postlaunchCatalogPhases(env),sequence=[phases.pre_app,phases.post_app],map=new Map(phases.pre_app.required_before.map(id=>[id,{fixture_preserved:true}]));
  const adds=new Set(phases.pre_app.patches.filter(p=>p.operation==='add').map(p=>p.identity));
  for(const p of sequence.flatMap(p=>p.patches))if(p.operation!=='add'&&!adds.has(p.identity)){const v:any={...(map.get(p.identity)||{}),...p.preconditions};for(const[k,x]of Object.entries(p.fields||{}))v[k]=clone(x);map.set(p.identity,v)}
  const before=[...map].map(([identity,value])=>({identity,value}));let after=before;for(const p of sequence)after=projectCatalog(after,p);
  const catalog={environment:env,phase:'post_app',query_sha256:phases.pre_app.query_sha256,before_catalog_sha256:catalogObjectsDigest(before)};
  const rows=[clone(base),clone(addition)];
  const storage={status:'existing-legacy-scope-preserved-deferred',legacy_verification_references:0,legacy_verification_objects:0,preserved_object_rows_sha256:H,preserved_reference_rows_sha256:H};
  const binding={environment:env,project_ref:env==='production'?POLICY.production_project_ref:POLICY.staging_projects.merchant.supabase_project_ref,catalog,current_catalog_sha256:catalogObjectsDigest(after),allowed_additions:[clone(addition)],ledger_digest_recipe:SECURITY_LEDGER_RECIPE,baseline_ledger:securityLedgerSnapshot([base]),expected_ledger:securityLedgerSnapshot(rows),storage_closure:storage};
  const functions={functions:clone(C.functions),present_function_names:env==='production'?[]:['public.allocate_shared_channel','public.reassign_shared_channel'],checked_absent_function_names:clone(C.production_absent_function_names)};
  manifest.postlaunch[env]=binding;report.postlaunch[env]={environment:env,project_ref:binding.project_ref,binding:clone(binding),observed_at:new Date(NOW-1000).toISOString(),method:'authorized-connector-read-only',raw_evidence_sha256:H,independent_review_reference:'synthetic',business_mutations:0,provider_calls:0,catalog:{...catalog,before,after,after_catalog_sha256:catalogObjectsDigest(after)},components:fullKnownComponentProjection(env,'post_app'),runtime_controls:{channel_operations:{project:false,build:false,runtime:false},scheduled_jobs_paused:true,signup_open:env==='production'},ledger_rows:clone(rows),storage_closure:storage,first_assignment_functions:functions};
 }
 const rawManifest=JSON.stringify(manifest),binding=manifestBinding(rawManifest,manifest),code_verification={run_id:'123',run_attempt:1};
 Object.assign(report,{schema_version:7,binding,code_verification,independent_review:{reviewer:'synthetic',reference:'synthetic'},owner_acceptance_reference:'synthetic',production_baselines:Object.fromEntries(Object.entries(binding.projects).map(([k,p]:any)=>[k,{project_id:p.project_id,sha:p.baseline_sha,deployment_id:p.baseline_deployment_id}])),production_schema:{observed_at:new Date(NOW-1000).toISOString(),project_ref:POLICY.production_project_ref,contract_sha256:POLICY.schema_contract_sha256,contracts:POLICY.schema_contracts,business_mutations:0,provider_calls:0,method:'authorized-connector-read-only',raw_evidence_sha256:H,payout_cron:{enabled:false,project_flag:'disabled',runtime_flag:'disabled',build_flag:'disabled',serving_deployment_id:manifest.projects.merchant.baseline_deployment_id,evidence_sha256:H}},staging_acceptance:{started_at:new Date(NOW-3000).toISOString(),completed_at:new Date(NOW-2000).toISOString(),runner:{name:'synthetic',command:'synthetic',run_id:'synthetic'},business_mutations:0,provider_calls:0,security_state_writes:0,passed:POLICY.acceptance_cases.length,failed:0,skipped:0,deployments:Object.fromEntries(Object.entries(binding.projects).map(([k,p]:any)=>[k,{...POLICY.staging_projects[k],sha:p.target_sha,tree:p.target_tree,deployment_id:'dpl_'+k+'stage',identity_evidence_sha256:H}])),cases:POLICY.acceptance_cases.map(c=>({...c,outcome:'passed',evidence_sha256:H}))}});
 const env:any={VERCEL_TOKEN:'synthetic',GITHUB_TOKEN:'synthetic',REDUCED_RELEASE_MANIFEST:rawManifest};
 const encode=()=>{const bytes=JSON.stringify(report),chunks=gzipSync(bytes).toString('base64').match(/.{1,40960}/g)!;chunks.forEach((c,i)=>env['PRIVATE_RELEASE_ACCEPTANCE_CHUNK_'+(i+1)]=c);env.PRIVATE_RELEASE_ACCEPTANCE_REPORT=JSON.stringify({transport_version:2,encoding:'gzip-base64',chunk_count:chunks.length,chunk_sha256:chunks.map(digest),decoded_sha256:digest(bytes)});env.PRIVATE_RELEASE_ACCEPTANCE_SHA256=digest(bytes);env.PRIVATE_RELEASE_RECEIPT=JSON.stringify({schema_version:7,binding,code_verification,approved_at:new Date(NOW).toISOString(),owner_approval_reference:'synthetic',acceptance_artifact_sha256:digest(bytes)})};encode();
 return{manifest,report,env,encode};
}
// Function bodies as PostgreSQL stores them (prosrc): the text between the dollar quotes.
const migration=readFileSync(M507.path,'utf8');
const body=(tag:string)=>{const m=migration.match(new RegExp('AS \\$'+tag+'\\$([\\s\\S]*?)\\$'+tag+'\\$'));if(!m)throw Error('missing body');return digest(m[1]);};
let directory:string,control:string;
beforeAll(()=>{const b=resolve('scripts/__tests__/.first-assignment');mkdirSync(b,{recursive:true});directory=mkdtempSync(join(b,'case-'));control=join(directory,'control');execFileSync('git',['clone','--shared','--no-checkout','--quiet',process.cwd(),control]);execFileSync('git',['-C',control,'checkout','--quiet',IDS.merchant.target_sha]);execFileSync('git',['-C',control,'update-ref','refs/remotes/origin/main',IDS.merchant.target_sha]);},30000);
afterAll(()=>rmSync(directory,{recursive:true,force:true}));afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals()});
describe('schema7 first-assignment successor (M507 only)',()=>{
 it('admits the fixed pin and evidence with exactly the M507 ledger addition',()=>{const f=fixture();expect(parseManifest(f.env.REDUCED_RELEASE_MANIFEST,f.manifest.integration_sha)).toEqual(f.manifest);expect(verifyFirstAssignmentEvidence(f.report,f.manifest,NOW,NOW)).toBe(true)});
 it.each(['merchant','admin'])('verifies actual Git ancestry, tree and every reviewed blob for %s',k=>{const f=fixture();expect(inspectTarget(process.cwd(),k,f.manifest.projects[k],f.manifest.integration_sha,f.manifest)).toHaveLength(Object.keys(IDS[k].blobs).length)});
 it('pins the reviewed migration bytes and admits no other SQL',()=>{expect(()=>requireFixedFirstAssignment()).not.toThrow();expect(digest(readFileSync(M507.path))).toBe(M507.sha256);for(const k of ['merchant','admin']){const sql=Object.keys(IDS[k].blobs).filter(p=>p.startsWith('supabase/')||(p.endsWith('.sql')&&p!=='scripts/full-release-catalog-query.sql'));expect(sql).toEqual([M507.path]);expect(IDS[k].blobs[M507.path]).toBe(M507.sha256)}});
 it('rejects an extra SQL path, a deletion or a missing reviewed blob',()=>{const f=fixture(),paths=Object.keys(IDS.merchant.blobs);for(const [changed,deleted]of [[paths.concat('supabase/migrations/508_other.sql'),[]],[paths,[paths[0]]],[paths.filter(p=>p!==M507.path),[]]])expect(()=>checkDelta('merchant',changed,deleted,f.manifest)).toThrow()});
 it('binds the function contracts to the dollar-quoted bodies of the pinned migration',()=>{const [assign,bot]=C.functions;expect(assign.signature).toBe('public.assign_first_shared_channel(uuid)');expect(assign.body_sha256).toBe(body(''));expect(bot.signature).toBe('public.get_bot_context(text,uuid)');expect(bot.body_sha256).toBe(body('function'));for(const fn of C.functions){expect(fn.acl.map((a:any)=>a.grantee)).toEqual(['postgres','service_role']);expect([fn.anon_execute,fn.authenticated_execute,fn.service_execute]).toEqual([false,false,true]);expect(fn.definer).toBe(true)}});
 it('runs the M507 disposable-PostgreSQL proof and pins its source in the integration job',()=>{expect(FIRST_ASSIGNMENT_MAIN_SQL_TESTS).toEqual({...FULL_MAIN_SQL_TESTS,'lib/__tests__/first-shared-assignment-507.pg.test.ts':24});expect(FIRST_ASSIGNMENT_SQL_TESTS['lib/__tests__/first-shared-assignment-507.pg.test.ts']).toBe(24);expect(FIRST_ASSIGNMENT_CANONICAL_SOURCES).toEqual([{name:'507_first_shared_channel_assignment.sql',sha256:M507.sha256}])});
 it('keeps every schema6 suite and case and adds the first-assignment ones',()=>{expect(FIRST_ASSIGNMENT_TARGETS.merchant.suites.slice(0,-1)).toEqual(POSTLAUNCH_TARGETS.merchant.suites);expect(FIRST_ASSIGNMENT_TARGETS.merchant.suites.at(-1)).toEqual({tz:'UTC',files:{'lib/__tests__/first-shared-assignment-admission.test.ts':35,'lib/__tests__/onboarding-655-flow-callback-fallback.test.ts':3,'lib/__tests__/hide-inactive-countries-marketing.test.tsx':4}});expect(FIRST_ASSIGNMENT_TARGETS.admin.suites).toEqual(POSTLAUNCH_TARGETS.admin.suites);expect(POLICY.acceptance_cases.slice(0,POSTLAUNCH_EVIDENCE_POLICY.acceptance_cases.length)).toEqual(POSTLAUNCH_EVIDENCE_POLICY.acceptance_cases);expect(POLICY.acceptance_cases.map((c:any)=>c.id).slice(-3)).toEqual(['first-assignment-m507-contract','first-assignment-admission','marketing-inactive-country-hidden'])});
 it('does not cross-admit schema6 and schema7',()=>{const f=fixture();expect(()=>verifyPostlaunchEvidence(f.report,f.manifest,NOW,NOW)).toThrow();const six={...clone(f.manifest),schema_version:6,policy:'postlaunch-app-only-v1'};expect(()=>verifyFirstAssignmentEvidence(f.report,six,NOW,NOW)).toThrow()});
 it.each([
  ['no ledger addition',(f:any)=>{for(const e of ['staging','production'])f.report.postlaunch[e].ledger_rows=[base]}],
  ['second unreviewed addition',(f:any)=>f.report.postlaunch.production.ledger_rows.push({version:'20261103190001',name:'508_other',statement_sha256:H,row_sha256:H})],
  ['addition with other statement bytes',(f:any)=>{for(const x of [f.manifest.postlaunch.production,f.report.postlaunch.production.binding])x.allowed_additions[0].statement_sha256=H;f.report.postlaunch.production.ledger_rows[1].statement_sha256=H}],
  ['addition under another name',(f:any)=>{for(const x of [f.manifest.postlaunch.production,f.report.postlaunch.production.binding])x.allowed_additions[0].name='507_other';f.report.postlaunch.production.ledger_rows[1].name='507_other'}],
  ['changed addition row',(f:any)=>f.report.postlaunch.production.ledger_rows[1].row_sha256='d'.repeat(64)],
  ['assign body drift',(f:any)=>f.report.postlaunch.production.first_assignment_functions.functions[0].body_sha256=H],
  ['bot context body drift',(f:any)=>f.report.postlaunch.staging.first_assignment_functions.functions[1].body_sha256=H],
  ['anon execute',(f:any)=>f.report.postlaunch.production.first_assignment_functions.functions[0].anon_execute=true],
  ['extra grant',(f:any)=>f.report.postlaunch.production.first_assignment_functions.functions[0].acl.push({grantee:'authenticated',privilege:'EXECUTE',grantable:false})],
  ['search path',(f:any)=>f.report.postlaunch.production.first_assignment_functions.functions[0].config=['search_path=public']],
  ['not definer',(f:any)=>f.report.postlaunch.staging.first_assignment_functions.functions[0].definer=false],
  ['missing function',(f:any)=>f.report.postlaunch.production.first_assignment_functions.functions.pop()],
  ['M430 present in production',(f:any)=>f.report.postlaunch.production.first_assignment_functions.present_function_names=['public.allocate_shared_channel']],
  ['M430 check list altered',(f:any)=>f.report.postlaunch.production.first_assignment_functions.checked_absent_function_names=[]],
  ['missing readout',(f:any)=>delete f.report.postlaunch.staging.first_assignment_functions],
  ['channel operations enabled',(f:any)=>f.report.postlaunch.production.runtime_controls.channel_operations.runtime=true],
 ])('rejects %s',(_name,mutate)=>{const f=fixture();mutate(f);expect(()=>verifyFirstAssignmentEvidence(f.report,f.manifest,NOW,NOW)).toThrow()});
 it.each(['assign-body','m430','ledger-extra'])('deploy denies %s before external access',async k=>{vi.spyOn(Date,'now').mockReturnValue(NOW);const f=fixture(),a=f.report.postlaunch.production;const fetch=vi.fn(()=>{throw Error('network forbidden')});vi.stubGlobal('fetch',fetch);if(k==='assign-body')a.first_assignment_functions.functions[0].body_sha256=H;if(k==='m430')a.first_assignment_functions.present_function_names=['public.reassign_shared_channel'];if(k==='ledger-extra')a.ledger_rows.push({version:'2',name:'x',statement_sha256:H,row_sha256:H});f.encode();await expect(deployReduced(f.manifest,control,{},'123',1,f.env)).rejects.toThrow();expect(fetch).not.toHaveBeenCalled()});
 it('validates original approval bytes then reaches existing protected-main GET denial only',async()=>{vi.spyOn(Date,'now').mockReturnValue(NOW);const f=fixture(),fetch=vi.fn(async()=>new Response('{}',{status:403}));vi.stubGlobal('fetch',fetch);await expect(deployReduced(f.manifest,control,{},'123',1,f.env)).rejects.toThrow('403');expect(fetch).toHaveBeenCalledTimes(1)});
});

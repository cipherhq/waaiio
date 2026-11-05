import {describe,it,expect,vi,afterEach,beforeAll,afterAll} from 'vitest';
import {readFileSync,mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {BOT_CODE_LOCK_IDENTITIES as IDS,botCodeLockInventoryDigest,verifyBotCodeLockEvidence,BOT_CODE_LOCK_EVIDENCE_POLICY as POLICY,BOT_CODE_LOCK_CONTRACTS as C,BOT_CODE_LOCK_TARGETS,BOT_CODE_LOCK_MAIN_SQL_TESTS,BOT_CODE_LOCK_SQL_TESTS,BOT_CODE_LOCK_CANONICAL_SOURCES,requireFixedBotCodeLock,botCodeLockCatalogPhase} from '../bot-code-lock-release-policy.mjs';
import {FIRST_ASSIGNMENT_CONTRACTS as C7,FIRST_ASSIGNMENT_TARGETS,FIRST_ASSIGNMENT_EVIDENCE_POLICY,FIRST_ASSIGNMENT_MAIN_SQL_TESTS,verifyFirstAssignmentEvidence} from '../first-assignment-release-policy.mjs';
import {postlaunchCatalogPhases,verifyPostlaunchEvidence} from '../postlaunch-release-policy.mjs';
import {parseManifest,inspectTarget,checkDelta,deployReduced,TARGETS} from '../reduced-release-gate.mjs';
import {projectCatalog,catalogObjectsDigest} from '../full-release-catalog.mjs';
import {fullKnownComponentProjection} from '../full-release-evidence.mjs';
import {securityLedgerSnapshot,SECURITY_LEDGER_RECIPE} from '../reduced-security-policy.mjs';
import {manifestBinding,digest} from '../reduced-release-evidence.mjs';
const NOW=Date.parse('2026-11-04T00:00:00Z'),H='a'.repeat(64),clone=x=>structuredClone(x);
const M508=C.migration;
const G='function:public.guard_server_managed_columns()',F='function:public.guard_business_insert()',TR='trigger:public.businesses.trg_guard_business_insert';
const OLD_GUARD_BODY='1ccbfd4c4f68d5ae1685b197e84ac8d4ed37b657759fafcd93bd54ef7471743f';
const base={version:'1',name:'complete-current-fixture',statement_sha256:null,row_sha256:H};
const addition={version:'20261103223154',name:M508.ledger_name,statement_sha256:M508.sha256,row_sha256:'c'.repeat(64)};
function fixture(){
 const manifest:any={schema_version:9,policy:'postlaunch-bot-code-lock-v1',integration_sha:IDS.merchant.target_sha,projects:{},postlaunch:{}};
 for(const k of ['merchant','admin'])manifest.projects[k]={baseline_sha:IDS[k].baseline_sha,target_sha:IDS[k].target_sha,target_tree:IDS[k].target_tree,project_id:TARGETS[k].project,baseline_deployment_id:'dpl_'+k+'old',source_inventory_sha256:botCodeLockInventoryDigest(k)};
 manifest.projects.admin.manual_alias={policy:'canonical-admin-alias-v1',preexisting_target:{id:'dpl_oldcandidate',project_id:TARGETS.admin.project,sha:IDS.admin.baseline_sha,ready_state:'READY',source:'cli',created_at:1}};
 const report:any={postlaunch:{}};
 for(const env of ['staging','production']){
  const phases=postlaunchCatalogPhases(env),sequence=[phases.pre_app,phases.post_app,botCodeLockCatalogPhase(env)],map=new Map(phases.pre_app.required_before.map(id=>[id,{fixture_preserved:true}]));
  const adds=new Set(sequence.flatMap(p=>p.patches).filter(p=>p.operation==='add').map(p=>p.identity));
  for(const p of [phases.pre_app,phases.post_app].flatMap(p=>p.patches))if(p.operation!=='add'&&!adds.has(p.identity)){const v:any={...(map.get(p.identity)||{}),...p.preconditions};for(const[k,x]of Object.entries(p.fields||{}))v[k]=clone(x);map.set(p.identity,v)}
  // Where the guard already exists before the release (staging), it carries the pre-M508 body.
  if(map.has(G))map.set(G,{...(map.get(G) as any),body_sha256:OLD_GUARD_BODY});
  const before=[...map].map(([identity,value])=>({identity,value}));let after=before;for(const p of sequence)after=projectCatalog(after,p);
  const catalog={environment:env,phase:'post_app',query_sha256:phases.pre_app.query_sha256,before_catalog_sha256:catalogObjectsDigest(before)};
  const rows=[clone(base),clone(addition)];
  const storage={status:'existing-legacy-scope-preserved-deferred',legacy_verification_references:0,legacy_verification_objects:0,preserved_object_rows_sha256:H,preserved_reference_rows_sha256:H};
  const binding={environment:env,project_ref:env==='production'?POLICY.production_project_ref:POLICY.staging_projects.merchant.supabase_project_ref,catalog,current_catalog_sha256:catalogObjectsDigest(after),allowed_additions:[clone(addition)],ledger_digest_recipe:SECURITY_LEDGER_RECIPE,baseline_ledger:securityLedgerSnapshot([base]),expected_ledger:securityLedgerSnapshot(rows),storage_closure:storage};
  const functions={functions:clone(C7.functions),present_function_names:env==='production'?[]:['public.allocate_shared_channel','public.reassign_shared_channel'],checked_absent_function_names:clone(C7.production_absent_function_names)};
  manifest.postlaunch[env]=binding;report.postlaunch[env]={environment:env,project_ref:binding.project_ref,binding:clone(binding),observed_at:new Date(NOW-1000).toISOString(),method:'authorized-connector-read-only',raw_evidence_sha256:H,independent_review_reference:'synthetic',business_mutations:0,provider_calls:0,catalog:{...catalog,before,after,after_catalog_sha256:catalogObjectsDigest(after)},components:fullKnownComponentProjection(env,'post_app'),runtime_controls:{channel_operations:{project:false,build:false,runtime:false},scheduled_jobs_paused:true,signup_open:env==='production'},ledger_rows:clone(rows),storage_closure:storage,first_assignment_functions:functions};
 }
 const rawManifest=JSON.stringify(manifest),binding=manifestBinding(rawManifest,manifest),code_verification={run_id:'123',run_attempt:1};
 Object.assign(report,{schema_version:9,binding,code_verification,independent_review:{reviewer:'synthetic',reference:'synthetic'},owner_acceptance_reference:'synthetic',production_baselines:Object.fromEntries(Object.entries(binding.projects).map(([k,p]:any)=>[k,{project_id:p.project_id,sha:p.baseline_sha,deployment_id:p.baseline_deployment_id}])),production_schema:{observed_at:new Date(NOW-1000).toISOString(),project_ref:POLICY.production_project_ref,contract_sha256:POLICY.schema_contract_sha256,contracts:POLICY.schema_contracts,business_mutations:0,provider_calls:0,method:'authorized-connector-read-only',raw_evidence_sha256:H,payout_cron:{enabled:false,project_flag:'disabled',runtime_flag:'disabled',build_flag:'disabled',serving_deployment_id:manifest.projects.merchant.baseline_deployment_id,evidence_sha256:H}},staging_acceptance:{started_at:new Date(NOW-3000).toISOString(),completed_at:new Date(NOW-2000).toISOString(),runner:{name:'synthetic',command:'synthetic',run_id:'synthetic'},business_mutations:0,provider_calls:0,security_state_writes:0,passed:POLICY.acceptance_cases.length,failed:0,skipped:0,deployments:Object.fromEntries(Object.entries(binding.projects).map(([k,p]:any)=>[k,{...POLICY.staging_projects[k],sha:p.target_sha,tree:p.target_tree,deployment_id:'dpl_'+k+'stage',identity_evidence_sha256:H}])),cases:POLICY.acceptance_cases.map(c=>({...c,outcome:'passed',evidence_sha256:H}))}});
 const env:any={VERCEL_TOKEN:'synthetic',GITHUB_TOKEN:'synthetic',REDUCED_RELEASE_MANIFEST:rawManifest};
 const encode=()=>{const bytes=JSON.stringify(report),chunks=gzipSync(bytes).toString('base64').match(/.{1,40960}/g)!;chunks.forEach((c,i)=>env['PRIVATE_RELEASE_ACCEPTANCE_CHUNK_'+(i+1)]=c);env.PRIVATE_RELEASE_ACCEPTANCE_REPORT=JSON.stringify({transport_version:2,encoding:'gzip-base64',chunk_count:chunks.length,chunk_sha256:chunks.map(digest),decoded_sha256:digest(bytes)});env.PRIVATE_RELEASE_ACCEPTANCE_SHA256=digest(bytes);env.PRIVATE_RELEASE_RECEIPT=JSON.stringify({schema_version:9,binding,code_verification,approved_at:new Date(NOW).toISOString(),owner_approval_reference:'synthetic',acceptance_artifact_sha256:digest(bytes)})};encode();
 return{manifest,report,env,encode};
}
// Function bodies as PostgreSQL stores them (prosrc): the text between the dollar quotes, in file order.
const migration=readFileSync(M508.path,'utf8');
const bodies=[...migration.matchAll(/AS \$\$([\s\S]*?)\$\$;/g)].map(m=>digest(m[1]));
// Re-project an observed "after" catalog with one object changed.
const mutateAfter=(f:any,env:string,fn:(m:Map<string,any>)=>void)=>{const c=f.report.postlaunch[env].catalog,m=new Map(c.after.map((o:any)=>[o.identity,clone(o.value)]));fn(m);c.after=[...m].map(([identity,value])=>({identity,value}));};
let directory:string,control:string;
beforeAll(()=>{const b=resolve('scripts/__tests__/.bot-code-lock');mkdirSync(b,{recursive:true});directory=mkdtempSync(join(b,'case-'));control=join(directory,'control');execFileSync('git',['clone','--shared','--no-checkout','--quiet',process.cwd(),control]);execFileSync('git',['-C',control,'checkout','--quiet',IDS.merchant.target_sha]);execFileSync('git',['-C',control,'update-ref','refs/remotes/origin/main',IDS.merchant.target_sha]);},30000);
afterAll(()=>rmSync(directory,{recursive:true,force:true}));afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals()});
describe('schema9 bot-code-lock release (M508 only, applied database first)',()=>{
 it('admits the fixed pin and evidence with exactly the M508 ledger addition and catalog delta',()=>{const f=fixture();expect(parseManifest(f.env.REDUCED_RELEASE_MANIFEST,f.manifest.integration_sha)).toEqual(f.manifest);expect(verifyBotCodeLockEvidence(f.report,f.manifest,NOW,NOW)).toBe(true)});
 it.each(['merchant','admin'])('verifies actual Git ancestry, tree and every reviewed blob for %s',k=>{const f=fixture();expect(inspectTarget(process.cwd(),k,f.manifest.projects[k],f.manifest.integration_sha,f.manifest)).toHaveLength(Object.keys(IDS[k].blobs).length)});
 it('pins the reviewed migration bytes and admits no other SQL',()=>{expect(()=>requireFixedBotCodeLock()).not.toThrow();expect(digest(readFileSync(M508.path))).toBe(M508.sha256);expect(M508.sha256).toBe('dcaedb07da65a543d2b4bd5ca6b6a17d2890f559c07a022a1787149b12cf9e11');for(const k of ['merchant','admin']){const sql=Object.keys(IDS[k].blobs).filter(p=>p.startsWith('supabase/')||(p.endsWith('.sql')&&p!=='scripts/full-release-catalog-query.sql'));expect(sql).toEqual([M508.path]);expect(IDS[k].blobs[M508.path]).toBe(M508.sha256)}});
 it('pins baseline 73377818 to target bdc007a8 with no deletions',()=>{for(const k of ['merchant','admin']){expect(IDS[k].baseline_sha).toBe('73377818e16b02bdcbc2b8251445354b2e26877c');expect(IDS[k].target_sha).toBe('bdc007a8f93febeee8ce054d075d48894afd37bb');expect(IDS[k].deleted_blobs).toEqual({})}});
 it('rejects an extra SQL path, a deletion or a missing reviewed blob',()=>{const f=fixture(),paths=Object.keys(IDS.merchant.blobs);for(const [changed,deleted]of [[paths.concat('supabase/migrations/509_other.sql'),[]],[paths,[paths[0]]],[paths.filter(p=>p!==M508.path),[]]])expect(()=>checkDelta('merchant',changed,deleted,f.manifest)).toThrow()});
 it('binds the catalog delta to the dollar-quoted bodies of the pinned migration',()=>{expect(bodies).toHaveLength(2);for(const env of ['staging','production']){const [g,fn,tr]=C.catalog[env].patches;expect([g.identity,fn.identity,tr.identity]).toEqual([G,F,TR]);expect(g.operation).toBe('fields');expect(g.fields).toEqual({body_sha256:bodies[0]});expect(g.before).toEqual({body_sha256:[OLD_GUARD_BODY]});expect(fn.operation).toBe('add');expect(fn.value.body_sha256).toBe(bodies[1]);expect(fn.value.definer).toBe(false);expect(fn.value.owner).toBe('postgres');expect(fn.value.config).toEqual(['search_path=public, pg_temp']);expect(fn.value.acl.map((a:any)=>a.grantee)).toEqual(['postgres','service_role']);expect(tr.value).toEqual({enabled:'O',definition:'CREATE TRIGGER trg_guard_business_insert BEFORE INSERT ON businesses FOR EACH ROW EXECUTE FUNCTION guard_business_insert()'});for(const p of C.catalog[env].patches)expect(p.source_sha256).toBe(M508.sha256)}expect(C.catalog.staging).toEqual(C.catalog.production)});
 it('runs the M508 disposable-PostgreSQL proof and pins both migration sources',()=>{expect(BOT_CODE_LOCK_MAIN_SQL_TESTS).toEqual({...FIRST_ASSIGNMENT_MAIN_SQL_TESTS,'lib/__tests__/business-control-columns-508.pg.test.ts':36});expect(BOT_CODE_LOCK_SQL_TESTS['lib/__tests__/business-control-columns-508.pg.test.ts']).toBe(36);expect(BOT_CODE_LOCK_CANONICAL_SOURCES.map((s:any)=>s.name)).toEqual(['507_first_shared_channel_assignment.sql','508_business_control_columns_guard.sql'])});
 it('keeps every schema7 suite and case and adds the bot-code-lock ones',()=>{expect(BOT_CODE_LOCK_TARGETS.merchant.suites.slice(0,-1)).toEqual(FIRST_ASSIGNMENT_TARGETS.merchant.suites);expect(Object.keys(BOT_CODE_LOCK_TARGETS.merchant.suites.at(-1).files)).not.toContain('lib/__tests__/permanent-merchant-links.test.ts');expect(BOT_CODE_LOCK_TARGETS.admin.suites).toEqual(FIRST_ASSIGNMENT_TARGETS.admin.suites);expect(POLICY.acceptance_cases.slice(0,FIRST_ASSIGNMENT_EVIDENCE_POLICY.acceptance_cases.length)).toEqual(FIRST_ASSIGNMENT_EVIDENCE_POLICY.acceptance_cases);expect(POLICY.acceptance_cases.map((c:any)=>c.id).slice(-3)).toEqual(['bot-code-lock-m508-contract','short-merchant-links','bot-code-read-only-settings'])});
 it('does not cross-admit schema 6, 7 and 9',()=>{const f=fixture();expect(()=>verifyPostlaunchEvidence(f.report,f.manifest,NOW,NOW)).toThrow();expect(()=>verifyFirstAssignmentEvidence(f.report,f.manifest,NOW,NOW)).toThrow();const seven={...clone(f.manifest),schema_version:7,policy:'postlaunch-first-assignment-v1'};expect(()=>verifyBotCodeLockEvidence(f.report,seven,NOW,NOW)).toThrow()});
 it.each([
  ['no ledger addition',(f:any)=>{for(const e of ['staging','production'])f.report.postlaunch[e].ledger_rows=[base]}],
  ['second unreviewed addition',(f:any)=>f.report.postlaunch.production.ledger_rows.push({version:'20261103230000',name:'509_other',statement_sha256:H,row_sha256:H})],
  ['addition with other statement bytes',(f:any)=>{for(const x of [f.manifest.postlaunch.production,f.report.postlaunch.production.binding])x.allowed_additions[0].statement_sha256=H;f.report.postlaunch.production.ledger_rows[1].statement_sha256=H}],
  ['addition under another name',(f:any)=>{for(const x of [f.manifest.postlaunch.production,f.report.postlaunch.production.binding])x.allowed_additions[0].name='508_other';f.report.postlaunch.production.ledger_rows[1].name='508_other'}],
  ['changed addition row',(f:any)=>f.report.postlaunch.production.ledger_rows[1].row_sha256='d'.repeat(64)],
  ['M508 not applied (old guard body)',(f:any)=>mutateAfter(f,'production',m=>m.set(G,{...m.get(G),body_sha256:OLD_GUARD_BODY}))],
  ['other guard body',(f:any)=>mutateAfter(f,'staging',m=>m.set(G,{...m.get(G),body_sha256:H}))],
  ['insert trigger missing',(f:any)=>mutateAfter(f,'production',m=>m.delete(TR))],
  ['insert guard function missing',(f:any)=>mutateAfter(f,'staging',m=>m.delete(F))],
  ['insert guard granted to authenticated',(f:any)=>mutateAfter(f,'production',m=>m.set(F,{...m.get(F),acl:[...m.get(F).acl,{grantee:'authenticated',grantor:'postgres',grantable:false,privilege:'EXECUTE'}]}))],
  ['insert guard made SECURITY DEFINER',(f:any)=>mutateAfter(f,'production',m=>m.set(F,{...m.get(F),definer:true}))],
  ['trigger disabled',(f:any)=>mutateAfter(f,'production',m=>m.set(TR,{...m.get(TR),enabled:'D'}))],
  ['extra unreviewed catalog object',(f:any)=>mutateAfter(f,'production',m=>m.set('function:public.unreviewed()',{owner:'postgres'}))],
  ['M507 assign body drift',(f:any)=>f.report.postlaunch.production.first_assignment_functions.functions[0].body_sha256=H],
  ['M430 present in production',(f:any)=>f.report.postlaunch.production.first_assignment_functions.present_function_names=['public.allocate_shared_channel']],
  ['M430 check list altered',(f:any)=>f.report.postlaunch.production.first_assignment_functions.checked_absent_function_names=[]],
  ['missing function readout',(f:any)=>delete f.report.postlaunch.staging.first_assignment_functions],
  ['channel operations enabled',(f:any)=>f.report.postlaunch.production.runtime_controls.channel_operations.runtime=true],
  ['scheduled jobs running',(f:any)=>f.report.postlaunch.production.runtime_controls.scheduled_jobs_paused=false],
 ])('rejects %s',(_name,mutate)=>{const f=fixture();mutate(f);expect(()=>verifyBotCodeLockEvidence(f.report,f.manifest,NOW,NOW)).toThrow()});
 it.each(['guard-body','m430','ledger-extra'])('deploy denies %s before external access',async k=>{vi.spyOn(Date,'now').mockReturnValue(NOW);const f=fixture(),a=f.report.postlaunch.production;const fetch=vi.fn(()=>{throw Error('network forbidden')});vi.stubGlobal('fetch',fetch);if(k==='guard-body')mutateAfter(f,'production',m=>m.set(G,{...m.get(G),body_sha256:OLD_GUARD_BODY}));if(k==='m430')a.first_assignment_functions.present_function_names=['public.reassign_shared_channel'];if(k==='ledger-extra')a.ledger_rows.push({version:'2',name:'x',statement_sha256:H,row_sha256:H});f.encode();await expect(deployReduced(f.manifest,control,{},'123',1,f.env)).rejects.toThrow();expect(fetch).not.toHaveBeenCalled()});
 it('validates original approval bytes then reaches existing protected-main GET denial only',async()=>{vi.spyOn(Date,'now').mockReturnValue(NOW);const f=fixture(),fetch=vi.fn(async()=>new Response('{}',{status:403}));vi.stubGlobal('fetch',fetch);await expect(deployReduced(f.manifest,control,{},'123',1,f.env)).rejects.toThrow('403');expect(fetch).toHaveBeenCalledTimes(1)});
});

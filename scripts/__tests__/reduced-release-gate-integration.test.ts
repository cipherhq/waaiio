import { beforeEach,afterEach,describe,it,expect,vi } from 'vitest';
import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync,chmodSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve,join } from 'node:path';
import { execFileSync,spawnSync } from 'node:child_process';
import { TARGETS,hash,inspectTarget,testTarget,testIntegration,validateIntegrationReceipt,preflight,deployReduced } from '../reduced-release-gate.mjs';
import { PAYOUT_TARGETS, PAYOUT_EVIDENCE_POLICY, INTEGRATION_SQL_TESTS } from '../reduced-payout-policy.mjs';
import { PAYOUT_POLICY, manifestBinding, digest, SCHEMA_MAX_AGE_MS } from '../reduced-release-evidence.mjs';
// Orchestration uses a synthetic canonical SQL contract. Real SQL runs only in
// the separately bound PostgreSQL workflow; no historical/local claim is made here.
vi.mock('../reduced-payout-policy.mjs', async(importOriginal)=>{
 const actual:any=await importOriginal();const {createHash}=await import('node:crypto');
 const bytes='// fixture';
 return {...actual,PAYOUT_EVIDENCE_POLICY:{...actual.PAYOUT_EVIDENCE_POLICY,schema_contracts:{...actual.PAYOUT_EVIDENCE_POLICY.schema_contracts,canonical_sources:[{name:'498_manual_settlement_rejection_guard.sql',sha256:createHash('sha256').update(bytes).digest('hex')}]}}};
});
let v2=false;
const configFor=(kind:string)=>v2?{...TARGETS[kind],...PAYOUT_TARGETS[kind]}:TARGETS[kind];
const tempParent=resolve('scripts/__tests__/.reduced-integration');
let dir:string,controlPath:string,sourcePaths:any,manifest:any,state:any,env:any,receipts:any,artifacts:any,zipBytes:any,requests:any[];
let options:any;
const git=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
const persist=()=>writeFileSync(join(dir,'state.json'),JSON.stringify(state));
function receipt(kind:string){const c=configFor(kind),e=manifest.projects[kind];return{schema_version:1,kind,integration_sha:manifest.integration_sha,target_sha:e.target_sha,target_tree:e.target_tree,run_id:'123',run_attempt:1,build:'passed',commands:[['npm','ci'],...c.suites.map(s=>['npm','exec','--','vitest','run',...Object.keys(s.files),'--reporter=json']),['npm','run','build']],suites:c.suites.map(s=>({tz:s.tz,files:Object.fromEntries(Object.entries(s.files).map(([f,n])=>[f,{passed:n,failed:0,skipped:0}]))}))};}
function archive(kind:string,extra=false){if(v2)receipts[kind].manifest_sha256=digest(JSON.stringify(manifest));const folder=join(dir,'archive-'+kind);mkdirSync(folder,{recursive:true});writeFileSync(join(folder,'receipt.json'),JSON.stringify(receipts[kind]));if(extra)writeFileSync(join(folder,'unexpected.txt'),'extra');const path=join(dir,kind+'.zip');if(existsSync(path))rmSync(path);execFileSync('zip',['-q',path,...(extra?['receipt.json','unexpected.txt']:['receipt.json'])],{cwd:folder});zipBytes[kind]=readFileSync(path);artifacts[kind].digest='sha256:'+hash(zipBytes[kind]);}
beforeEach(()=>{
 v2=expect.getState().currentTestName?.includes('payout v2')||false;
 mkdirSync(tempParent,{recursive:true});dir=mkdtempSync(join(tempParent,'case-'));controlPath=join(dir,'control');mkdirSync(controlPath);git(controlPath,'init','-q','-b','main');git(controlPath,'config','user.name','Fixture');git(controlPath,'config','user.email','fixture@example.invalid');writeFileSync(join(controlPath,'base'),'fixture');if(v2){mkdirSync(join(controlPath,'supabase/migrations'),{recursive:true});writeFileSync(join(controlPath,'supabase/migrations/498_manual_settlement_rejection_guard.sql'),'-- baseline');for(const file of Object.keys(INTEGRATION_SQL_TESTS)){mkdirSync(resolve(controlPath,file,'..'),{recursive:true});writeFileSync(join(controlPath,file),'// synthetic SQL test');}}git(controlPath,'add','.');git(controlPath,'commit','-qm','base');const base=git(controlPath,'rev-parse','HEAD');
 git(controlPath,'checkout','-qb','merchant');for(const file of v2?PAYOUT_TARGETS.merchant.allowed:['lib/utils/calendar-date.ts']){mkdirSync(resolve(controlPath,file,'..'),{recursive:true});writeFileSync(join(controlPath,file),'// fixture');}git(controlPath,'add','.');git(controlPath,'commit','-qm','merchant');const merchant=git(controlPath,'rev-parse','HEAD'),merchantTree=git(controlPath,'rev-parse','HEAD^{tree}');
 git(controlPath,'checkout','-qb','admin',base);for(const file of v2?PAYOUT_TARGETS.admin.allowed:['admin/src/pages/Payouts.tsx']){mkdirSync(resolve(controlPath,file,'..'),{recursive:true});writeFileSync(join(controlPath,file),'// fixture');}git(controlPath,'add','.');git(controlPath,'commit','-qm','admin');const admin=git(controlPath,'rev-parse','HEAD'),adminTree=git(controlPath,'rev-parse','HEAD^{tree}');
 git(controlPath,'checkout','main');git(controlPath,'merge','--no-ff','-qm','integrate merchant',merchant);git(controlPath,'merge','--no-ff','-qm','integrate admin',admin);const integration=git(controlPath,'rev-parse','HEAD');git(controlPath,'update-ref','refs/remotes/origin/main',integration);
 manifest={schema_version:1,integration_sha:integration,projects:{merchant:{project_id:TARGETS.merchant.project,baseline_sha:base,target_sha:merchant,target_tree:merchantTree},admin:{project_id:TARGETS.admin.project,baseline_sha:base,target_sha:admin,target_tree:adminTree}}};
 if(v2){manifest.schema_version=2;manifest.policy=PAYOUT_POLICY;for(const kind of ['merchant','admin']){manifest.projects[kind].baseline_deployment_id='dpl_'+kind+'old';manifest.projects[kind].source_blobs=Object.fromEntries(PAYOUT_TARGETS[kind].allowed.map(file=>[file,hash('// fixture')]));}vi.stubEnv('REDUCED_RELEASE_MANIFEST',JSON.stringify(manifest));}
 sourcePaths={};state={};receipts={};zipBytes={};artifacts={};requests=[];options={};
 for(const [index,kind] of ['merchant','admin'].entries()){
  sourcePaths[kind]=join(dir,kind);git(dir,'clone','-q','--shared','--no-checkout',controlPath,sourcePaths[kind]);git(sourcePaths[kind],'checkout','-q',manifest.projects[kind].target_sha);
  state[kind]={id:'dpl_'+kind+'old',sha:base};receipts[kind]=receipt(kind);artifacts[kind]={id:201+index,name:`reduced-code-${kind}-123-1`,expired:false,workflow_run:{id:123,head_sha:integration},digest:''};archive(kind);
 }
 if(v2){receipts.integration=integrationReceipt();artifacts.integration={id:203,name:'reduced-code-integration-123-1',expired:false,workflow_run:{id:123,head_sha:integration},digest:''};archive('integration');}
 persist();mkdirSync(join(dir,'bin'));
 const program=`#!/usr/bin/env node\nconst fs=require('fs');const p=${JSON.stringify(join(dir,'state.json'))};const s=JSON.parse(fs.readFileSync(p));const kind=process.env.VERCEL_PROJECT_ID===${JSON.stringify(TARGETS.merchant.project)}?'merchant':'admin';fs.appendFileSync(${JSON.stringify(join(dir,'cli.log'))},JSON.stringify({args:process.argv.slice(2),kind,cwd:process.cwd(),sha:process.env.GITHUB_SHA,env:process.env})+'\\n');if(s.failAdmin&&kind==='admin')process.exit(1);s[kind]={id:'dpl_'+kind+'new',sha:process.env.GITHUB_SHA,env:process.env};fs.writeFileSync(p,JSON.stringify(s));console.log('https://'+kind+'-fixture.vercel.app');\n`;
 writeFileSync(join(dir,'bin/vercel'),program);chmodSync(join(dir,'bin/vercel'),0o755);
 env={PATH:join(dir,'bin')+':'+process.env.PATH,HOME:dir,GITHUB_TOKEN:'fixture-github',VERCEL_TOKEN:'fixture-vercel'};
 if(v2) attachPrivateEvidence();
 vi.stubGlobal('fetch',async(url:any,init:any={})=>{
  const u=String(url);requests.push({url:u,method:init.method||'GET',headers:init.headers});
  if(options.apiFailure&&u.includes(options.apiFailure))return new Response('{}',{status:503});
  const json=(data:any)=>new Response(JSON.stringify(data),{status:200});
  if(u.includes('/actions/workflows/ci.yml/runs?'))return json({workflow_runs:[{id:1,head_sha:integration,head_branch:'main',event:'push',status:'completed',conclusion:options.badMainCI?'failure':'success'}]});
  if(u.endsWith('/actions/runs/123/attempts/1'))return json({id:123,run_attempt:1,repository:{full_name:'cipherhq/waaiio'},actor:{login:'cipherhq'},triggering_actor:{login:'cipherhq'},head_sha:options.staleRun?base:integration,path:'.github/workflows/verify-reduced-release.yml',event:'workflow_dispatch',status:'completed',conclusion:'success'});
  if(u.includes('/attempts/1/jobs?')){const jobs=['merchant','admin'].map(kind=>({name:`Verify ${kind} target`,conclusion:'success',steps:['Verify exact target source, tests, and build','Upload code evidence'].map(name=>({name,status:'completed',conclusion:options.skipAdmin&&kind==='admin'?'skipped':'success'}))}));if(v2)jobs.push({name:'Verify integration SQL prerequisites',conclusion:options.skipIntegration?'skipped':'success',steps:['Verify canonical SQL prerequisites','Upload integration SQL evidence'].map(name=>({name,status:'completed',conclusion:'success'}))});return json({total_count:jobs.length,jobs});}
  if(u.includes('/actions/runs/123/artifacts?')){const list=Object.values(artifacts);return json({total_count:list.length,artifacts:list});}
  if(v2&&u.endsWith('/actions/artifacts/203/zip'))return new Response(null,{status:302,headers:{location:'https://fixture.invalid/integration.zip'}});
  if(v2&&u==='https://fixture.invalid/integration.zip')return new Response(zipBytes.integration);
  for(const kind of ['merchant','admin']){
   const config=TARGETS[kind];const current=JSON.parse(readFileSync(join(dir,'state.json'),'utf8'))[kind];
   if(u.endsWith(`/actions/artifacts/${artifacts[kind]?.id}/zip`))return new Response(null,{status:302,headers:{location:`https://fixture.invalid/${kind}.zip`}});
   if(u===`https://fixture.invalid/${kind}.zip`){expect(init.headers?.Authorization).toBeUndefined();return new Response(zipBytes[kind]);}
   if(u.includes(`/v9/projects/${config.project}?`))return json({rootDirectory:options.wrongRoot?'wrong':config.root,targets:{production:{id:options.ignoredLatest?'dpl_ignored'+kind:current.id}}});
   if(u.includes('/v13/deployments/dpl_ignored'+kind+'?'))return json({id:'dpl_ignored'+kind,projectId:options.latestProject||config.project,readyState:options.latestState||'CANCELED',source:options.latestSource||'git',errorLink:options.latestReason===undefined?'https://vercel.com/docs/project-configuration/git-settings#ignored-build-step':options.latestReason});
   if(u.includes(`/v13/deployments/${current.id}?`)||u.includes(`/v13/deployments/${kind}-fixture.vercel.app?`))return json({id:current.id,projectId:config.project,readyState:'READY',meta:{githubCommitSha:current.sha}});
   if(u.includes(`/v4/aliases/${config.alias}?`))return json({deploymentId:options.wrongAlias&&kind==='admin'?'dpl_other':current.id});
   if(u===`https://${config.alias}/login`||u===`https://${config.alias}/api/health`)return new Response('',{status:200});
   if(u===`https://${config.alias}/api/release-identity`){if(options.expireAfterMerchant)vi.spyOn(Date,'now').mockReturnValue(Date.now()+SCHEMA_MAX_AGE_MS+1);return json({sha:current.sha,projectId:config.project,deploymentId:current.id,vercelEnv:'production'});}
  }
  throw new Error('Unmocked network forbidden: '+u);
 });
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();vi.unstubAllGlobals();rmSync(dir,{recursive:true,force:true});});
const prepare=()=>preflight(manifest,controlPath,sourcePaths,'123',1,env);
describe('actual reduced orchestration with local Git, ZIPs and mocked external boundaries',()=>{
 it('proves both exact source ancestry and authentic artifact chains without mutation',async()=>{await prepare();expect(existsSync(join(dir,'cli.log'))).toBe(false);expect(requests.every(r=>r.method==='GET')).toBe(true);});
 it('rejects dirty target before any deployment',async()=>{writeFileSync(join(sourcePaths.merchant,'unexpected'),'dirty');await expect(prepare()).rejects.toThrow('clean target');expect(existsSync(join(dir,'cli.log'))).toBe(false);});
 it('rejects target tree mismatch',async()=>{manifest.projects.admin.target_tree='a'.repeat(40);await expect(prepare()).rejects.toThrow('tree');});
 it('rejects a target that is not ancestor of integration',async()=>{git(controlPath,'checkout','-qb','outside');writeFileSync(join(controlPath,'new'),'outside');git(controlPath,'add','.');git(controlPath,'commit','-qm','outside');const outside=git(controlPath,'rev-parse','HEAD');git(controlPath,'checkout','main');manifest.projects.admin.target_sha=outside;await expect(prepare()).rejects.toThrow('lineage');});
 it('rejects fresh main CI failure',async()=>{options.badMainCI=true;await expect(prepare()).rejects.toThrow('CI');});
 it('rejects stale authenticated run',async()=>{options.staleRun=true;await expect(prepare()).rejects.toThrow('verification run');});
 it('rejects skipped admin verification step',async()=>{options.skipAdmin=true;await expect(prepare()).rejects.toThrow('step');});
 it('rejects API failures without falling back',async()=>{options.apiFailure='/artifacts?';await expect(prepare()).rejects.toThrow('503');});
 it('rejects missing admin artifact',async()=>{delete artifacts.admin;await expect(prepare()).rejects.toThrow('artifact');});
 it('rejects tampered archive digest',async()=>{artifacts.merchant.digest='sha256:'+'a'.repeat(64);await expect(prepare()).rejects.toThrow('digest');});
 it('rejects unexpected archive contents even with valid archive digest',async()=>{archive('merchant',true);await expect(prepare()).rejects.toThrow('contents');});
 it('rejects forged target receipt inside authenticated artifact',async()=>{receipts.admin.target_sha=manifest.projects.merchant.target_sha;archive('admin');await expect(prepare()).rejects.toThrow('receipt');});
 it('rejects a project alias mismatch before first mutation',async()=>{options.wrongAlias=true;await expect(prepare()).rejects.toThrow('identity');expect(existsSync(join(dir,'cli.log'))).toBe(false);});
 it('rejects partial release replay without resetting baseline',async()=>{state.merchant.sha=manifest.projects.merchant.target_sha;persist();await expect(prepare()).rejects.toThrow('identity');expect(existsSync(join(dir,'cli.log'))).toBe(false);});
 it('runs actual deployment orchestrator against fake CLI, separately pinned source targets',async()=>{
  const logged=vi.spyOn(console,'log').mockImplementation(()=>{});
  try {
    const result=await deployReduced(manifest,controlPath,sourcePaths,'123',1,env);
    const calls=readFileSync(join(dir,'cli.log'),'utf8').trim().split('\n').map(JSON.parse);expect(calls).toHaveLength(2);
    for(const [index,kind] of ['merchant','admin'].entries()){
      const target=manifest.projects[kind].target_sha,args=calls[index].args;
      expect(calls[index].kind).toBe(kind);expect(calls[index].cwd).toBe(sourcePaths[kind]);
      expect(calls[index].sha).toBe(target);expect(result.deployed[kind].sha).toBe(target);
      for(const flag of ['--env','--build-env']){
        expect(args.filter((arg:string)=>arg===flag)).toHaveLength(1);
        expect(args[args.indexOf(flag)+1]).toBe(`VERCEL_GIT_COMMIT_SHA=${target}`);
      }
      expect(args).not.toContain(`VERCEL_GIT_COMMIT_SHA=${manifest.integration_sha}`);
      expect(args).not.toContain(`VERCEL_GIT_COMMIT_SHA=${manifest.projects[kind==='merchant'?'admin':'merchant'].target_sha}`);
    }
    const output=JSON.stringify(logged.mock.calls);
    expect(output).not.toContain(env.VERCEL_TOKEN);expect(output).not.toContain(env.GITHUB_TOKEN);
    expect(requests.some(r=>r.method!=='GET')).toBe(false);
  } finally {logged.mockRestore();}
 });
 it('keeps new acceptance inputs empty in the actual v1 CLI environment',async()=>{
  const workflow=createRequire(import.meta.url)('js-yaml').load(readFileSync(resolve('.github/workflows/deploy-reduced-release.yml'),'utf8'));
  expect(workflow.jobs.plan.outputs.payout_policy).toBe('${{ steps.plan.outputs.payout_policy }}');
  const step=workflow.jobs.deploy.steps.find(s=>s.name==='Verify both evidence chains and deploy exact clean targets');
  const keys=['PRIVATE_RELEASE_RECEIPT','PRIVATE_RELEASE_ACCEPTANCE_REPORT','PRIVATE_RELEASE_ACCEPTANCE_SHA256'];
  for(const key of keys){expect(step.env[key]).toBe("${{ needs.plan.outputs.payout_policy == 'true' && secrets."+key+" || '' }}");env[key]='';}
  await deployReduced(manifest,controlPath,sourcePaths,'123',1,env);
  const calls=readFileSync(join(dir,'cli.log'),'utf8').trim().split('\n').map(JSON.parse);expect(calls).toHaveLength(2);
  for(const call of calls)for(const key of keys)expect(call.env[key]).toBe('');
 });
 it('stops on second-project failure with no automatic rollback',async()=>{state.failAdmin=true;persist();await expect(deployReduced(manifest,controlPath,sourcePaths,'123',1,env)).rejects.toThrow();const calls=readFileSync(join(dir,'cli.log'),'utf8').trim().split('\n').map(JSON.parse);expect(calls).toHaveLength(2);expect(calls.every(c=>c.args[0]==='deploy')).toBe(true);expect(JSON.parse(readFileSync(join(dir,'state.json'),'utf8')).merchant.sha).toBe(manifest.projects.merchant.target_sha);});
});

describe('trusted target command runner',()=>{
 function fakeNpm(){
  const code=`#!/usr/bin/env node\nconst fs=require('fs');fs.appendFileSync(${JSON.stringify(join(dir,'npm.log'))},JSON.stringify({args:process.argv.slice(2),env:process.env})+'\\n');if(process.argv[2]==='exec'){const files=process.argv.slice(6).filter(x=>!x.startsWith('--'));const counts=${JSON.stringify(Object.fromEntries(Object.values(TARGETS).flatMap((c:any)=>c.suites.flatMap((s:any)=>Object.entries(s.files)))))};console.log(JSON.stringify({testResults:files.map(name=>({name:require('path').resolve(name),status:'passed',assertionResults:Array.from({length:counts[name]},()=>({status:'passed'}))}))}));}\n`;
  writeFileSync(join(dir,'bin/npm'),code);chmodSync(join(dir,'bin/npm'),0o755);
 }
 it('executes exact target install/tests/build and excludes credentials/private manifest from target children',async()=>{
  fakeNpm();const testEnv={...env,VERCEL_TOKEN:undefined,GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',REDUCED_RELEASE_MANIFEST:'private-fixture',GITHUB_TOKEN:'private-fixture'};
  const receipt=await testTarget(manifest,'merchant',controlPath,sourcePaths.merchant,join(dir,'out'),testEnv);
  expect(receipt.target_sha).toBe(manifest.projects.merchant.target_sha);expect(receipt.suites).toHaveLength(2);
  const calls=readFileSync(join(dir,'npm.log'),'utf8').trim().split('\n').map(JSON.parse);expect(calls).toHaveLength(4);
  for(const call of calls){expect(call.env.GITHUB_TOKEN).toBeUndefined();expect(call.env.REDUCED_RELEASE_MANIFEST).toBeUndefined();expect(call.env.VERCEL_TOKEN).toBeUndefined();}
 });
 it('rejects production credentials before invoking target code',async()=>{fakeNpm();await expect(testTarget(manifest,'merchant',controlPath,sourcePaths.merchant,join(dir,'out'),env)).rejects.toThrow('credentials');expect(existsSync(join(dir,'npm.log'))).toBe(false);});
});

describe('actual reduced CLI Owner-rerun authorization',()=>{
 function planAs(triggeringActor:string){
  const preload=join(dir,'owner-guard-preload.mjs');
  const marker=join(dir,'owner-guard-fetch.log');
  writeFileSync(preload,`import {appendFileSync} from 'node:fs';
    globalThis.fetch=async(url)=>{
      appendFileSync(${JSON.stringify(marker)},String(url)+'\\n');
      if(!String(url).includes('/actions/workflows/ci.yml/runs?'))throw new Error('Unmocked network forbidden');
      return new Response(JSON.stringify({workflow_runs:[{id:1,head_sha:${JSON.stringify(manifest.integration_sha)},head_branch:'main',event:'push',status:'completed',conclusion:'success'}]}),{status:200});
    };`);
  const output=join(dir,'owner-guard-output');
  const result=spawnSync(process.execPath,['--import',preload,resolve('scripts/reduced-release-gate.mjs'),'plan'],{
    cwd:controlPath,encoding:'utf8',env:{PATH:process.env.PATH,HOME:dir,
      GITHUB_ACTOR:'cipherhq',GITHUB_TRIGGERING_ACTOR:triggeringActor,GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REPOSITORY:'cipherhq/waaiio',
      GITHUB_SHA:manifest.integration_sha,GITHUB_TOKEN:'synthetic-only',CONTROL_PATH:controlPath,
      REDUCED_RELEASE_MANIFEST:JSON.stringify(manifest),GITHUB_OUTPUT:output},
  });
  return {result,marker,output};
 }
 it('allows Owner original actor and Owner triggering actor to execute the real plan gate',()=>{
  const {result,marker,output}=planAs('cipherhq');expect(result.status,result.stderr).toBe(0);
  expect(existsSync(marker)).toBe(true);expect(readFileSync(output,'utf8')).toContain('merchant_target='+manifest.projects.merchant.target_sha);
 },15000);
 it('rejects another triggering actor before external evidence or target outputs',()=>{
  const {result,marker,output}=planAs('other-collaborator');expect(result.status).toBe(1);
  expect(existsSync(marker)).toBe(false);expect(existsSync(output)).toBe(false);
 },15000);
});

function integrationReceipt(){return {schema_version:2,kind:'integration-sql',manifest_sha256:digest(JSON.stringify(manifest)),integration_sha:manifest.integration_sha,merchant_target_sha:manifest.projects.merchant.target_sha,merchant_target_tree:manifest.projects.merchant.target_tree,run_id:'123',run_attempt:1,commands:[['npm','ci'],['npm','exec','--','vitest','run',...Object.keys(INTEGRATION_SQL_TESTS),'--no-file-parallelism','--reporter=json']],sources:{runtime:{'lib/admin-step-up.ts':digest('// fixture')},sql:{'supabase/migrations/498_manual_settlement_rejection_guard.sql':digest('// fixture')},tests:Object.fromEntries(Object.keys(INTEGRATION_SQL_TESTS).map(file=>[file,digest('// synthetic SQL test')]))},files:Object.fromEntries(Object.entries(INTEGRATION_SQL_TESTS).map(([file,count])=>[file,{passed:count,failed:0,skipped:0}]))};}
function attachPrivateEvidence(){
 const now=Date.now(),rawManifest=JSON.stringify(manifest),binding=manifestBinding(rawManifest,manifest),code_verification={run_id:'123',run_attempt:1};
 const policy=PAYOUT_EVIDENCE_POLICY,H='a'.repeat(64);
 const report={schema_version:2,binding,code_verification,independent_review:{reviewer:'fixture',reference:'private'},owner_acceptance_reference:'private',
 production_baselines:Object.fromEntries(Object.entries(binding.projects).map(([k,p]:any)=>[k,{project_id:p.project_id,sha:p.baseline_sha,deployment_id:p.baseline_deployment_id}])),
 production_schema:{observed_at:new Date(now-1000).toISOString(),project_ref:policy.production_project_ref,contract_sha256:policy.schema_contract_sha256,contracts:policy.schema_contracts,business_mutations:0,provider_calls:0,method:'authorized-connector-read-only',raw_evidence_sha256:H,payout_cron:{enabled:false,project_flag:'disabled',runtime_flag:'disabled',build_flag:'disabled',serving_deployment_id:manifest.projects.merchant.baseline_deployment_id,evidence_sha256:H}},
 staging_acceptance:{started_at:new Date(now-3000).toISOString(),completed_at:new Date(now-2000).toISOString(),runner:{name:'fixture',command:'fixture',run_id:'fixture'},business_mutations:0,provider_calls:0,security_state_writes:0,passed:policy.acceptance_cases.length,failed:0,skipped:0,
 deployments:Object.fromEntries(Object.entries(binding.projects).map(([k,p]:any)=>[k,{...policy.staging_projects[k],sha:p.target_sha,tree:p.target_tree,deployment_id:'dpl_'+k+'stage',identity_evidence_sha256:H}])),cases:policy.acceptance_cases.map(c=>({...c,outcome:'passed',evidence_sha256:H}))}};
 const reportBytes=JSON.stringify(report),approvedHash=digest(reportBytes);
 Object.assign(env,{REDUCED_RELEASE_MANIFEST:rawManifest,PRIVATE_RELEASE_ACCEPTANCE_REPORT:reportBytes,PRIVATE_RELEASE_ACCEPTANCE_SHA256:approvedHash,PRIVATE_RELEASE_RECEIPT:JSON.stringify({schema_version:2,binding,code_verification,approved_at:new Date(now).toISOString(),owner_approval_reference:'private',acceptance_artifact_sha256:approvedHash})});
}
// Actual Git/blob/ZIP checks can exceed the default5s under shared-runner load.
describe('payout v2 actual deployment orchestration',{timeout:15000},()=>{
 function integrationNpm(skip=false){const file=join(dir,'bin/npm');writeFileSync(file,`#!/usr/bin/env node\nconst fs=require('fs');fs.appendFileSync(${JSON.stringify(join(dir,'integration-npm.log'))},JSON.stringify({args:process.argv.slice(2),env:process.env})+'\\n');if(process.argv[2]==='exec'){const counts=${JSON.stringify(INTEGRATION_SQL_TESTS)};console.log(JSON.stringify({testResults:Object.entries(counts).map(([file,count])=>({name:require('path').resolve(file),status:'passed',assertionResults:Array.from({length:count},()=>({status:${JSON.stringify(skip?'skipped':'passed')}}))}))}));}`);chmodSync(file,0o755);}
 it('executes trusted integration commands with localhost PG only and validates exact SQL/source receipt',async()=>{
  integrationNpm();const testEnv={...env,VERCEL_TOKEN:undefined,GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',TEST_DATABASE_URL:'must-not-be-used'};
  const r=await testIntegration(manifest,controlPath,join(dir,'integration-out'),testEnv);validateIntegrationReceipt(r,manifest,'123',1,env.REDUCED_RELEASE_MANIFEST,controlPath);
  const calls=readFileSync(join(dir,'integration-npm.log'),'utf8').trim().split('\n').map(JSON.parse);expect(calls).toHaveLength(2);
  expect(calls[1].args).toContain('--no-file-parallelism');
  const parallelReceipt=structuredClone(r);parallelReceipt.commands[1]=parallelReceipt.commands[1].filter(arg=>arg!=='--no-file-parallelism');expect(()=>validateIntegrationReceipt(parallelReceipt,manifest,'123',1,env.REDUCED_RELEASE_MANIFEST,controlPath)).toThrow('receipt');
  expect(calls[0].env.TEST_DATABASE_URL).toBeUndefined();expect(calls[1].env.REQUIRE_PG_TESTS).toBe('true');expect(calls[1].env.TEST_DATABASE_URL).toBe('postgresql://postgres:postgres@127.0.0.1:5432/postgres');
  for(const c of calls){expect(c.env.GITHUB_TOKEN).toBeUndefined();expect(c.env.REDUCED_RELEASE_MANIFEST).toBeUndefined();expect(c.env.PRIVATE_RELEASE_ACCEPTANCE_REPORT).toBeUndefined();}
 });
 it('refuses skipped integration SQL cases and writes no receipt',async()=>{integrationNpm(true);await expect(testIntegration(manifest,controlPath,join(dir,'integration-out'),{...env,VERCEL_TOKEN:undefined,GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1'})).rejects.toThrow('skipped');expect(existsSync(join(dir,'integration-out/receipt.json'))).toBe(false);});

 it('accepts ignored canceled Git target while deploying exact canonical baseline, with sanitized child env',async()=>{
  options.ignoredLatest=true;await deployReduced(manifest,controlPath,sourcePaths,'123',1,env);
  const calls=readFileSync(join(dir,'cli.log'),'utf8').trim().split('\n').map(JSON.parse);expect(calls).toHaveLength(2);
  for(const c of calls){expect(c.env.PRIVATE_RELEASE_RECEIPT).toBeUndefined();expect(c.env.REDUCED_RELEASE_MANIFEST).toBeUndefined();expect(c.env.GITHUB_TOKEN).toBeUndefined();expect(c.env.VERCEL_GIT_COMMIT_SHA).toBe(manifest.projects[c.kind].target_sha);}
 });
 it.each(['READY','BUILDING','QUEUED'])('rejects divergent latest target state %s before any mutation',async(state)=>{
  options.ignoredLatest=true;options.latestState=state;await expect(deployReduced(manifest,controlPath,sourcePaths,'123',1,env)).rejects.toThrow('divergence');expect(existsSync(join(dir,'cli.log'))).toBe(false);
 });
 it('rejects a canceled latest target with an unrelated reason',async()=>{options.ignoredLatest=true;options.latestReason='other';await expect(deployReduced(manifest,controlPath,sourcePaths,'123',1,env)).rejects.toThrow('divergence');expect(existsSync(join(dir,'cli.log'))).toBe(false);});
 it.each([['latestProject','other-project'],['latestSource','cli'],['latestReason',null]])('rejects ambiguous canceled Git metadata %s',async(key,value)=>{options.ignoredLatest=true;options[key]=value;await expect(deployReduced(manifest,controlPath,sourcePaths,'123',1,env)).rejects.toThrow('divergence');expect(existsSync(join(dir,'cli.log'))).toBe(false);});
 it('rejects skipped integration SQL job before mutation',async()=>{options.skipIntegration=true;await expect(deployReduced(manifest,controlPath,sourcePaths,'123',1,env)).rejects.toThrow('integration SQL');expect(existsSync(join(dir,'cli.log'))).toBe(false);});
 it('rejects tampered canonical SQL receipt even inside authenticated archive',async()=>{receipts.integration.sources.sql['supabase/migrations/498_manual_settlement_rejection_guard.sql']='0'.repeat(64);archive('integration');await expect(deployReduced(manifest,controlPath,sourcePaths,'123',1,env)).rejects.toThrow('SQL receipt');expect(existsSync(join(dir,'cli.log'))).toBe(false);});
 it('rejects wrong project root before mutation',async()=>{options.wrongRoot=true;await expect(deployReduced(manifest,controlPath,sourcePaths,'123',1,env)).rejects.toThrow('root');expect(existsSync(join(dir,'cli.log'))).toBe(false);});
 it('rejects changed canonical baseline before mutation',async()=>{state.merchant.sha=manifest.projects.merchant.target_sha;persist();await expect(deployReduced(manifest,controlPath,sourcePaths,'123',1,env)).rejects.toThrow('identity');expect(existsSync(join(dir,'cli.log'))).toBe(false);});
 it('rejects missing private acceptance before external calls',async()=>{delete env.PRIVATE_RELEASE_ACCEPTANCE_REPORT;await expect(deployReduced(manifest,controlPath,sourcePaths,'123',1,env)).rejects.toThrow('digest');expect(requests).toHaveLength(0);expect(existsSync(join(dir,'cli.log'))).toBe(false);});
 it('stops before second mutation when schema snapshot expires after first deployment',async()=>{options.expireAfterMerchant=true;await expect(deployReduced(manifest,controlPath,sourcePaths,'123',1,env)).rejects.toThrow('stale');const calls=readFileSync(join(dir,'cli.log'),'utf8').trim().split('\n').map(JSON.parse);expect(calls).toHaveLength(1);expect(calls[0].kind).toBe('merchant');});
});

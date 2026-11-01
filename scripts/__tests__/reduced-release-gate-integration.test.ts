import { beforeEach,afterEach,describe,it,expect,vi } from 'vitest';
import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync,chmodSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { execFileSync,spawnSync } from 'node:child_process';
import { TARGETS,hash,inspectTarget,testTarget,preflight,deployReduced } from '../reduced-release-gate.mjs';
const tempParent=resolve('scripts/__tests__/.reduced-integration');
let dir:string,controlPath:string,sourcePaths:any,manifest:any,state:any,env:any,receipts:any,artifacts:any,zipBytes:any,requests:any[];
let options:any;
const git=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
const persist=()=>writeFileSync(join(dir,'state.json'),JSON.stringify(state));
function receipt(kind:string){const c=TARGETS[kind],e=manifest.projects[kind];return{schema_version:1,kind,integration_sha:manifest.integration_sha,target_sha:e.target_sha,target_tree:e.target_tree,run_id:'123',run_attempt:1,build:'passed',commands:[['npm','ci'],...c.suites.map(s=>['npm','exec','--','vitest','run',...Object.keys(s.files),'--reporter=json']),['npm','run','build']],suites:c.suites.map(s=>({tz:s.tz,files:Object.fromEntries(Object.entries(s.files).map(([f,n])=>[f,{passed:n,failed:0,skipped:0}]))}))};}
function archive(kind:string,extra=false){const folder=join(dir,'archive-'+kind);mkdirSync(folder,{recursive:true});writeFileSync(join(folder,'receipt.json'),JSON.stringify(receipts[kind]));if(extra)writeFileSync(join(folder,'unexpected.txt'),'extra');const path=join(dir,kind+'.zip');if(existsSync(path))rmSync(path);execFileSync('zip',['-q',path,...(extra?['receipt.json','unexpected.txt']:['receipt.json'])],{cwd:folder});zipBytes[kind]=readFileSync(path);artifacts[kind].digest='sha256:'+hash(zipBytes[kind]);}
beforeEach(()=>{
 mkdirSync(tempParent,{recursive:true});dir=mkdtempSync(join(tempParent,'case-'));controlPath=join(dir,'control');mkdirSync(controlPath);git(controlPath,'init','-q','-b','main');git(controlPath,'config','user.name','Fixture');git(controlPath,'config','user.email','fixture@example.invalid');writeFileSync(join(controlPath,'base'),'fixture');git(controlPath,'add','.');git(controlPath,'commit','-qm','base');const base=git(controlPath,'rev-parse','HEAD');
 git(controlPath,'checkout','-qb','merchant');mkdirSync(join(controlPath,'lib/utils'),{recursive:true});writeFileSync(join(controlPath,'lib/utils/calendar-date.ts'),'// fixture');git(controlPath,'add','.');git(controlPath,'commit','-qm','merchant');const merchant=git(controlPath,'rev-parse','HEAD'),merchantTree=git(controlPath,'rev-parse','HEAD^{tree}');
 git(controlPath,'checkout','-qb','admin',base);mkdirSync(join(controlPath,'admin/src/pages'),{recursive:true});writeFileSync(join(controlPath,'admin/src/pages/Payouts.tsx'),'// fixture');git(controlPath,'add','.');git(controlPath,'commit','-qm','admin');const admin=git(controlPath,'rev-parse','HEAD'),adminTree=git(controlPath,'rev-parse','HEAD^{tree}');
 git(controlPath,'checkout','main');git(controlPath,'merge','--no-ff','-qm','integrate merchant',merchant);git(controlPath,'merge','--no-ff','-qm','integrate admin',admin);const integration=git(controlPath,'rev-parse','HEAD');git(controlPath,'update-ref','refs/remotes/origin/main',integration);
 manifest={schema_version:1,integration_sha:integration,projects:{merchant:{project_id:TARGETS.merchant.project,baseline_sha:base,target_sha:merchant,target_tree:merchantTree},admin:{project_id:TARGETS.admin.project,baseline_sha:base,target_sha:admin,target_tree:adminTree}}};
 sourcePaths={};state={};receipts={};zipBytes={};artifacts={};requests=[];options={};
 for(const [index,kind] of ['merchant','admin'].entries()){
  sourcePaths[kind]=join(dir,kind);git(dir,'clone','-q','--shared','--no-checkout',controlPath,sourcePaths[kind]);git(sourcePaths[kind],'checkout','-q',manifest.projects[kind].target_sha);
  state[kind]={id:'dpl_'+kind+'old',sha:base};receipts[kind]=receipt(kind);artifacts[kind]={id:201+index,name:`reduced-code-${kind}-123-1`,expired:false,workflow_run:{id:123,head_sha:integration},digest:''};archive(kind);
 }
 persist();mkdirSync(join(dir,'bin'));
 const program=`#!/usr/bin/env node\nconst fs=require('fs');const p=${JSON.stringify(join(dir,'state.json'))};const s=JSON.parse(fs.readFileSync(p));const kind=process.env.VERCEL_PROJECT_ID===${JSON.stringify(TARGETS.merchant.project)}?'merchant':'admin';fs.appendFileSync(${JSON.stringify(join(dir,'cli.log'))},JSON.stringify({args:process.argv.slice(2),kind,cwd:process.cwd(),sha:process.env.GITHUB_SHA})+'\\n');if(s.failAdmin&&kind==='admin')process.exit(1);s[kind]={id:'dpl_'+kind+'new',sha:process.env.GITHUB_SHA};fs.writeFileSync(p,JSON.stringify(s));console.log('https://'+kind+'-fixture.vercel.app');\n`;
 writeFileSync(join(dir,'bin/vercel'),program);chmodSync(join(dir,'bin/vercel'),0o755);
 env={PATH:join(dir,'bin')+':'+process.env.PATH,HOME:dir,GITHUB_TOKEN:'fixture-github',VERCEL_TOKEN:'fixture-vercel'};
 vi.stubGlobal('fetch',async(url:any,init:any={})=>{
  const u=String(url);requests.push({url:u,method:init.method||'GET',headers:init.headers});
  if(options.apiFailure&&u.includes(options.apiFailure))return new Response('{}',{status:503});
  const json=(data:any)=>new Response(JSON.stringify(data),{status:200});
  if(u.includes('/actions/workflows/ci.yml/runs?'))return json({workflow_runs:[{id:1,head_sha:integration,head_branch:'main',event:'push',status:'completed',conclusion:options.badMainCI?'failure':'success'}]});
  if(u.endsWith('/actions/runs/123/attempts/1'))return json({id:123,run_attempt:1,repository:{full_name:'cipherhq/waaiio'},actor:{login:'cipherhq'},triggering_actor:{login:'cipherhq'},head_sha:options.staleRun?base:integration,path:'.github/workflows/verify-reduced-release.yml',event:'workflow_dispatch',status:'completed',conclusion:'success'});
  if(u.includes('/attempts/1/jobs?'))return json({total_count:2,jobs:['merchant','admin'].map(kind=>({name:`Verify ${kind} target`,conclusion:'success',steps:['Verify exact target source, tests, and build','Upload code evidence'].map(name=>({name,status:'completed',conclusion:options.skipAdmin&&kind==='admin'?'skipped':'success'}))}))});
  if(u.includes('/actions/runs/123/artifacts?')){const list=Object.values(artifacts);return json({total_count:list.length,artifacts:list});}
  for(const kind of ['merchant','admin']){
   const config=TARGETS[kind];const current=JSON.parse(readFileSync(join(dir,'state.json'),'utf8'))[kind];
   if(u.endsWith(`/actions/artifacts/${artifacts[kind]?.id}/zip`))return new Response(null,{status:302,headers:{location:`https://fixture.invalid/${kind}.zip`}});
   if(u===`https://fixture.invalid/${kind}.zip`){expect(init.headers?.Authorization).toBeUndefined();return new Response(zipBytes[kind]);}
   if(u.includes(`/v9/projects/${config.project}?`))return json({rootDirectory:config.root,targets:{production:{id:current.id}}});
   if(u.includes(`/v13/deployments/${current.id}?`)||u.includes(`/v13/deployments/${kind}-fixture.vercel.app?`))return json({id:current.id,projectId:config.project,readyState:'READY',meta:{githubCommitSha:current.sha}});
   if(u.includes(`/v4/aliases/${config.alias}?`))return json({deploymentId:options.wrongAlias&&kind==='admin'?'dpl_other':current.id});
   if(u===`https://${config.alias}/login`||u===`https://${config.alias}/api/health`)return new Response('',{status:200});
   if(u===`https://${config.alias}/api/release-identity`)return json({sha:current.sha,projectId:config.project,deploymentId:current.id,vercelEnv:'production'});
  }
  throw new Error('Unmocked network forbidden: '+u);
 });
});
afterEach(()=>{vi.unstubAllGlobals();rmSync(dir,{recursive:true,force:true});});
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

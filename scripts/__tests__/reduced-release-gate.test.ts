import { describe,it,expect } from 'vitest';
import { TARGETS,parseManifest,checkDelta,summarizeTests,validateCodeReceipt,validateVerificationRun,selectArtifact,validateLive,validateMainCI,waitForServing } from '../reduced-release-gate.mjs';
const M='a'.repeat(40), A='b'.repeat(40), I='c'.repeat(40), B='d'.repeat(40), T='e'.repeat(40);
function manifest(){return {schema_version:1,integration_sha:I,projects:{merchant:{project_id:TARGETS.merchant.project,baseline_sha:B,target_sha:M,target_tree:T},admin:{project_id:TARGETS.admin.project,baseline_sha:B,target_sha:A,target_tree:T}}};}
function receipt(kind='merchant'){
 const config=TARGETS[kind];return {schema_version:1,kind,integration_sha:I,target_sha:manifest().projects[kind].target_sha,target_tree:T,run_id:'123',run_attempt:1,build:'passed',
 commands:[['npm','ci'],...config.suites.map(s=>['npm','exec','--','vitest','run',...Object.keys(s.files),'--reporter=json']),['npm','run','build']],
 suites:config.suites.map(s=>({tz:s.tz,files:Object.fromEntries(Object.entries(s.files).map(([f,n])=>[f,{passed:n,failed:0,skipped:0}]))}))};
}
function run(){return {id:123,run_attempt:1,repository:{full_name:'cipherhq/waaiio'},actor:{login:'cipherhq'},triggering_actor:{login:'cipherhq'},head_sha:I,path:'.github/workflows/verify-reduced-release.yml',event:'workflow_dispatch',status:'completed',conclusion:'success'};}
function jobs(){return {total_count:2,jobs:['merchant','admin'].map(kind=>({name:`Verify ${kind} target`,conclusion:'success',steps:['Verify exact target source, tests, and build','Upload code evidence'].map(name=>({name,status:'completed',conclusion:'success'}))}))};}
function artifact(){return {id:456,name:'reduced-code-merchant-123-1',expired:false,digest:'sha256:'+'a'.repeat(64),workflow_run:{id:123,head_sha:I}};}
function live(){return {id:'dpl_fixture',activeId:'dpl_fixture',aliasId:'dpl_fixture',projectId:TARGETS.admin.project,sha:A,readyState:'READY'};}
describe('bounded project-specific source manifest',()=>{
 it('accepts two distinct pinned targets',()=>expect(parseManifest(JSON.stringify(manifest()),I).projects.admin.target_sha).toBe(A));
 it('rejects other integration',()=>expect(()=>parseManifest(JSON.stringify(manifest()),B)).toThrow('identity'));
 it('rejects project substitution',()=>{const m=manifest();m.projects.admin.project_id=TARGETS.merchant.project;expect(()=>parseManifest(JSON.stringify(m),I)).toThrow('admin');});
 it('rejects target equal to baseline',()=>{const m=manifest();m.projects.admin.target_sha=B;expect(()=>parseManifest(JSON.stringify(m),I)).toThrow('identity');});
 it('rejects a single full-main target for both projects',()=>{const m=manifest();m.projects.admin.target_sha=M;expect(()=>parseManifest(JSON.stringify(m),I)).toThrow('Project-specific');});
 it('accepts merchant allowlist only',()=>expect(()=>checkDelta('merchant',TARGETS.merchant.allowed,[])).not.toThrow());
 it.each(['supabase/migrations/999.sql','app/api/payments/route.ts','lib/payments/finalize.ts','.github/workflows/ci.yml','package.json'])('rejects forbidden delta %s',file=>expect(()=>checkDelta('merchant',[file],[])).toThrow('unapproved'));
 it('rejects admin file in merchant target',()=>expect(()=>checkDelta('merchant',TARGETS.admin.allowed,[])).toThrow());
 it('rejects rename/delete and empty delta',()=>{expect(()=>checkDelta('admin',TARGETS.admin.allowed,['old.ts'])).toThrow();expect(()=>checkDelta('admin',[],[])).toThrow();});
});
describe('exact source test and CI evidence',()=>{
 it('accepts exact receipt for each project',()=>{for(const kind of ['merchant','admin'])expect(()=>validateCodeReceipt(receipt(kind),kind,manifest(),'123',1)).not.toThrow();});
 it('rejects control SHA presented as target tested SHA',()=>{const r=receipt();r.target_sha=I;expect(()=>validateCodeReceipt(r,'merchant',manifest(),'123',1)).toThrow('receipt');});
 it('rejects receipt from another attempt',()=>expect(()=>validateCodeReceipt(receipt(),'merchant',manifest(),'123',2)).toThrow('receipt'));
 it('rejects receipt missing command provenance',()=>{const r=receipt();r.commands=[];expect(()=>validateCodeReceipt(r,'merchant',manifest(),'123',1)).toThrow('receipt');});
 it('rejects skipped test file even with build success',()=>{const r=receipt();Object.values(r.suites[0].files)[0].skipped=1;expect(()=>validateCodeReceipt(r,'merchant',manifest(),'123',1)).toThrow('per-file');});
 it('summarizes actual runner assertion outcomes',()=>{const report={testResults:[{name:'/source/a.test.ts',status:'passed',assertionResults:[{status:'passed'}]}]};expect(summarizeTests(report,{'a.test.ts':1},'/source')).toEqual({'a.test.ts':{passed:1,failed:0,skipped:0}});});
 it('rejects zero/missing assertion evidence',()=>expect(()=>summarizeTests({testResults:[]},{'a.test.ts':1},'/source')).toThrow('test files'));
 it('rejects skipped actual assertions',()=>expect(()=>summarizeTests({testResults:[{name:'/source/a.test.ts',status:'passed',assertionResults:[{status:'pending'}]}]},{'a.test.ts':1},'/source')).toThrow('failed or skipped'));
 it('accepts authenticated exact run and both successful jobs',()=>expect(()=>validateVerificationRun(run(),jobs(),manifest(),'123',1)).not.toThrow());
 it('rejects forged repo and actor',()=>{const r=run();r.repository.full_name='other/repo';expect(()=>validateVerificationRun(r,jobs(),manifest(),'123',1)).toThrow();r.repository.full_name='cipherhq/waaiio';r.triggering_actor.login='other';expect(()=>validateVerificationRun(r,jobs(),manifest(),'123',1)).toThrow();});
 it('rejects stale integration SHA',()=>{const r=run();r.head_sha=B;expect(()=>validateVerificationRun(r,jobs(),manifest(),'123',1)).toThrow();});
 it('rejects skipped admin build step',()=>{const j=jobs();j.jobs[1].steps[0].conclusion='skipped';expect(()=>validateVerificationRun(run(),j,manifest(),'123',1)).toThrow('step');});
 it('rejects absent admin verification job',()=>{const j=jobs();j.jobs.pop();j.total_count=1;expect(()=>validateVerificationRun(run(),j,manifest(),'123',1)).toThrow('job');});
 it('requires latest exact main CI success rather than an older green run',()=>expect(()=>validateMainCI({workflow_runs:[{id:1,head_sha:I,head_branch:'main',event:'push',status:'completed',conclusion:'success'},{id:2,head_sha:I,head_branch:'main',event:'push',status:'in_progress',conclusion:null}]},I)).toThrow('CI'));
});
describe('artifact and live identity checks',()=>{
 it('selects uniquely authenticated artifact',()=>expect(selectArtifact({total_count:1,artifacts:[artifact()]},'merchant',manifest(),'123',1).id).toBe(456));
 it('rejects missing, duplicate and expired artifact',()=>{expect(()=>selectArtifact({total_count:0,artifacts:[]},'merchant',manifest(),'123',1)).toThrow();expect(()=>selectArtifact({total_count:2,artifacts:[artifact(),artifact()]},'merchant',manifest(),'123',1)).toThrow();const a=artifact();a.expired=true;expect(()=>selectArtifact({total_count:1,artifacts:[a]},'merchant',manifest(),'123',1)).toThrow();});
 it('rejects artifact for another control SHA',()=>{const a=artifact();a.workflow_run.head_sha=B;expect(()=>selectArtifact({total_count:1,artifacts:[a]},'merchant',manifest(),'123',1)).toThrow();});
 it('accepts only matching project, alias and source',()=>expect(()=>validateLive('admin',live(),A,'dpl_fixture')).not.toThrow());
 it('rejects old admin after merchant deployment',()=>expect(()=>validateLive('admin',live(),M)).toThrow('identity'));
 it('rejects same-SHA deployment-ID substitution',()=>expect(()=>validateLive('admin',live(),A,'dpl_other')).toThrow('identity'));
 it('rejects alias mismatch',()=>{const l=live();l.aliasId='dpl_other';expect(()=>validateLive('admin',l,A)).toThrow('identity');});
 it('rejects partial release replay as baseline',()=>expect(()=>validateLive('admin',live(),B)).toThrow('identity'));
});

describe('bounded read-only serving convergence',()=>{
 it('waits for alias propagation without issuing another deployment',async()=>{
  let reads=0,pauses=0,healthChecks=0;const current=live();
  const result=await waitForServing('admin',A,'dpl_fixture','fixture',{read:async()=>{reads++;return reads===1?{...current,aliasId:'dpl_old'}:current;},health:async()=>{healthChecks++;},pause:async()=>{pauses++;},attempts:3});
  expect(result.id).toBe('dpl_fixture');expect(reads).toBe(2);expect(pauses).toBe(1);expect(healthChecks).toBe(1);
 });
 it('stops after the bound without mutating recovery state',async()=>{
  let reads=0;await expect(waitForServing('admin',A,'dpl_fixture','fixture',{read:async()=>{reads++;return {...live(),aliasId:'dpl_old'};},health:async()=>{},pause:async()=>{},attempts:2})).rejects.toThrow('identity');expect(reads).toBe(2);
 });
 it('does not retry permission errors',async()=>{
  let reads=0;await expect(waitForServing('admin',A,'dpl_fixture','fixture',{read:async()=>{reads++;throw new Error('Deployment verification failed (403)');},pause:async()=>{},attempts:3})).rejects.toThrow('403');expect(reads).toBe(1);
 });
});

it('does not retry a public-health permission denial',async()=>{
 let reads=0,healthChecks=0;await expect(waitForServing('admin',A,'dpl_fixture','fixture',{read:async()=>{reads++;return live();},health:async()=>{healthChecks++;throw new Error('Reduced deployment public health failed (403)');},pause:async()=>{},attempts:3})).rejects.toThrow('403');expect(reads).toBe(1);expect(healthChecks).toBe(1);
});

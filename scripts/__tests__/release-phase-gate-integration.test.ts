import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { hash, POST_FILE, POST_HASH, PROJECTS, ACCEPTANCE_CASES } from '../release-phase-gate.mjs';
import yaml from 'js-yaml';

const root = process.cwd();
const parent = resolve('scripts/__tests__/.phase-integration');
const source = pathToFileURL(resolve('scripts/release-phase-gate.mjs')).href;
const postBytes = readFileSync(POST_FILE);
const PRE = 'supabase/migrations/001_example.sql';
let dir: string, base: string, target: string;
let data: any;
function git(...args: string[]) { return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
function commit() { git('add', '.'); git('commit', '-qm', 'fixture'); target = git('rev-parse', 'HEAD'); git('update-ref', 'refs/remotes/origin/main', target); }
function writeManifest(mutator: (m: any) => void) {
  const p=join(dir,'.release/phase-manifest.json'); const m=JSON.parse(readFileSync(p,'utf8')); mutator(m); writeFileSync(p,JSON.stringify(m)); commit(); data.target=target; data.manifest=readFileSync(p,'utf8');
}
beforeEach(() => {
  mkdirSync(parent,{recursive:true}); dir=mkdtempSync(join(parent,'case-'));
  git('init','-q','-b','main'); git('config','user.name','Fixture'); git('config','user.email','fixture@example.invalid');
  writeFileSync(join(dir,'baseline'),'base'); git('add','.'); git('commit','-qm','baseline'); base=git('rev-parse','HEAD');
  mkdirSync(join(dir,'supabase/migrations'),{recursive:true}); mkdirSync(join(dir,'.release'));
  writeFileSync(join(dir,PRE),'-- fixture\n'); writeFileSync(join(dir,POST_FILE),postBytes);
  writeFileSync(join(dir,'.release/phase-manifest.json'),JSON.stringify({schema_version:1,baseline_sha:base,migrations:{
    [PRE]:{phase:'pre',sha256:hash('-- fixture\n'),ledger_name:'example',ledger_version:'1'},
    [POST_FILE]:{phase:'post',sha256:POST_HASH,ledger_name:'492_verification_public_upload_guard'},
  }})); commit();
  data={target,base,manifest:readFileSync(join(dir,'.release/phase-manifest.json'),'utf8'),projects:PROJECTS,mode:'prepare',ledger:[{version:'1',name:'example',applied_sha256:hash('-- fixture\n'),stmt_count:1}]};
});
afterEach(() => { rmSync(dir,{recursive:true,force:true}); });

function execute(mode='prepare') {
  data.mode=mode;
  writeFileSync(join(dir,'mock.json'),JSON.stringify(data));
  writeFileSync(join(dir,'run.mjs'), `
import {readFileSync,appendFileSync} from 'node:fs';
const d=JSON.parse(readFileSync('mock.json','utf8'));
globalThis.fetch=async(url,options={})=>{
 appendFileSync('requests.jsonl',JSON.stringify({url,method:options.method||'GET',body:options.body})+'\\n');
 if(d.apiError && String(url).includes(d.apiError)) return new Response('{}',{status:503});
 const answer=x=>new Response(JSON.stringify(x),{status:200});
 if(String(url).includes('/jobs?')) return answer({total_count:1,jobs:[{name:'Deploy exact SHA to production',conclusion:'success',steps:['Deploy exact SHA to production project','Deploy exact SHA to admin production project','Verify both apps before postdeployment migration'].map(name=>({name,status:'completed',conclusion:d.skippedPrepare?'skipped':'success'}))}]});
 if(String(url).includes('/actions/runs/')) return answer({id:123,run_attempt:1,repository:{full_name:'cipherhq/waaiio'},actor:{login:d.wrongPrepareActor?'other':'cipherhq'},path:'.github/workflows/deploy-production.yml',head_sha:d.target,event:'workflow_dispatch',status:'completed',conclusion:'success'});
 if(String(url).startsWith('https://api.github.com/')) return answer(d.malformedCI?{}:{workflow_runs:[{id:1,head_sha:d.target,head_branch:'main',event:'push',status:'completed',conclusion:d.failedCI?'failure':'success'}]});
 if(String(url).startsWith('https://api.supabase.com/')) return answer(d.malformedLedger?{}:d.ledger);
 for(const [kind,p] of Object.entries(d.projects)){
  const id='dpl_'+kind;
  if(String(url).includes('/v9/projects/'+p.id)) return answer({rootDirectory:kind==='admin'?'admin':null,targets:{production:{id}}});
  if(String(url).includes('/v13/deployments/'+id)) return answer({id,projectId:p.id,readyState:'READY',meta:{githubCommitSha:d.wrongAdmin&&kind==='admin'?d.base:d.mode==='prepare'?d.base:d.target}});
  if(String(url).includes('/v4/aliases/'+p.alias)) return answer({deploymentId:d.wrongAlias&&kind==='admin'?'dpl_wrong':id});
  if(String(url)==='https://'+p.alias+'/api/release-identity') return answer({sha:d.target,projectId:p.id,deploymentId:id,vercelEnv:'production',supabaseProjectRef:'cxcmiqotkowhxinjbytg'});
  if(String(url)==='https://'+p.alias+'/login') return answer({});
 }
 throw new Error('Unmocked network request forbidden: '+url);
};
const {runGate}=await import(${JSON.stringify(source)});
try{await runGate(d.mode,d.target)}catch(error){console.error(error.message);process.exitCode=1}
`);
  return spawnSync(process.execPath,['run.mjs'],{cwd:dir,encoding:'utf8',env:{...process.env,VERCEL_TOKEN:'fixture',SUPABASE_ACCESS_TOKEN:'fixture',GITHUB_TOKEN:'fixture',GITHUB_ENV:join(dir,'env'),PRIVATE_RELEASE_MANIFEST:data.manifest ?? '',PRIVATE_RELEASE_RECEIPT:data.receipt?JSON.stringify(data.receipt):'',PRIVATE_RELEASE_ACCEPTANCE_REPORT:data.report?JSON.stringify(data.report):'',PRIVATE_RELEASE_ACCEPTANCE_SHA256:data.reportHash||''}});
}
function acceptance() {
  data.report={schema_version:1,baseline_sha:base,target_sha:target,manifest_sha256:hash(data.manifest),deployments:{merchant:'dpl_merchant',admin:'dpl_admin'},prepare_run_id:'123',prepare_run_attempt:1,
    started_at:'2026-01-01T00:00:00Z',completed_at:'2026-01-01T00:01:00Z',suite:'SYNTHETIC INTEGRATION ONLY',runner:{name:'synthetic',version:'1',command:'fixture',run_id:'unit-1',source_sha:target},
    independent_review:{reviewer:'synthetic',reference:'unit-only'},owner_acceptance_reference:'unit-only',network:{fixture_writes_intercepted:true,business_mutations:0,provider_calls:0},summary:{passed:6,failed:0,skipped:0},
    cases:Object.entries(ACCEPTANCE_CASES).map(([id,expected])=>({id,expected,observed:id==='merchant_other_tenant_denied'?{route:'/api/verification/document',status:403,document_disclosed:false,redirect:false}:expected,outcome:'passed',evidence_sha256:'a'.repeat(64)}))};
  data.reportHash=hash(JSON.stringify(data.report));
  data.receipt={schema_version:1,baseline_sha:base,target_sha:target,manifest_sha256:data.report.manifest_sha256,deployments:data.report.deployments,prepare_run_id:'123',prepare_run_attempt:1,acceptance_artifact_sha256:data.reportHash};
}
function post() { data.ledger.push({version:'20000102000000',name:'492_verification_public_upload_guard',applied_sha256:POST_HASH,stmt_count:1}); }
describe('runGate with real Git and blocked live network',()=>{
  it('uses original Git delta and verifies prepare against mocked APIs',()=>{const r=execute();expect(r.status,r.stderr).toBe(0);expect(JSON.parse(r.stdout).pendingCount).toBe(1);});
  it('rejects a missing private manifest even when a valid file is checked in',()=>{delete data.manifest;const r=execute();expect(r.status).toBe(1);expect(r.stderr).toContain('private release manifest is required');});
  it('rejects a malformed private manifest without revealing its bytes',()=>{data.manifest='{private-fixture-detail';const r=execute();expect(r.status).toBe(1);expect(r.stderr).toContain('Malformed private release manifest');expect(r.stderr).not.toContain('private-fixture-detail');});
  it('uses the private manifest instead of a conflicting checked-in file',()=>{writeFileSync(join(dir,'.release/phase-manifest.json'),'{"schema_version":999}');commit();data.target=target;const r=execute();expect(r.status,r.stderr).toBe(0);});
  it('cannot replace an invalid private manifest with a valid checked-in file',()=>{const m=JSON.parse(data.manifest);delete m.migrations[PRE];data.manifest=JSON.stringify(m);const r=execute();expect(r.status).toBe(1);expect(r.stderr).toContain('accounted for');});
  it('refuses failed exact protected-main CI before ledger access',()=>{data.failedCI=true;const r=execute();expect(r.status).toBe(1);expect(r.stderr).toContain('CI');expect(readFileSync(join(dir,'requests.jsonl'),'utf8')).not.toContain('supabase');});
  it('refuses malformed CI evidence',()=>{data.malformedCI=true;expect(execute().status).toBe(1);});
  it('requires target ancestry in protected-main ref',()=>{git('update-ref','refs/remotes/origin/main',base);const r=execute();expect(r.status).toBe(1);expect(r.stderr).toContain('protected main');});
  it('rejects read-only API failure',()=>{data.apiError='api.supabase.com';const r=execute();expect(r.status).toBe(1);expect(r.stderr).toContain('503');});
  it('rejects malformed ledger evidence',()=>{data.malformedLedger=true;const r=execute();expect(r.status).toBe(1);expect(r.stderr).toContain('ledger response');});
  it('rejects unknown entry without skipping original delta',()=>{writeManifest(m=>{delete m.migrations[PRE]});const r=execute();expect(r.status).toBe(1);expect(r.stderr).toContain('accounted for');});
  it('rejects unsafe post phase through actual CLI',()=>{writeManifest(m=>{m.migrations[PRE].phase='post'});const r=execute();expect(r.status).toBe(1);expect(r.stderr).toContain('Only the reviewed');});
  it('rejects admin old code before postdeploy gate',()=>{data.wrongAdmin=true;const r=execute('ready-for-post');expect(r.status).toBe(1);expect(r.stderr).toContain('admin is not serving');});
  it('rejects wrong alias even for exact SHA',()=>{data.wrongAlias=true;const r=execute('ready-for-post');expect(r.status).toBe(1);expect(r.stderr).toContain('alias');});
  it('finalize verifies original predeploy delta after both live apps changed',()=>{post();data.ledger[0].applied_sha256='c'.repeat(64);const r=execute('finalize');expect(r.status).toBe(1);expect(r.stderr).toContain('Ledger SQL mismatch');});
  it('finalize cannot certify without actual postdeploy ledger',()=>{const r=execute('finalize');expect(r.status).toBe(1);expect(r.stderr).toContain('Missing or ambiguous');});
  it('does not overwrite original recovery identifiers after app switch',()=>{
    writeFileSync(join(dir,'env'),'PREV_DEPLOYMENT_ID=dpl_original\n');const r=execute('ready-for-post');expect(r.status,r.stderr).toBe(0);expect(readFileSync(join(dir,'env'),'utf8')).toBe('PREV_DEPLOYMENT_ID=dpl_original\n');
  });
  it('finalizes with fully bound Owner-provisioned synthetic receipt/report and verified prepare run',()=>{post();acceptance();const r=execute('finalize');expect(r.status,r.stderr).toBe(0);expect(JSON.parse(r.stdout).state).toBe('complete');expect(r.stdout).not.toContain('unit-only');expect(r.stdout).not.toContain('ledger');});
  it('rejects finalize run passed off as prepare when deploy steps skipped',()=>{post();acceptance();data.skippedPrepare=true;const r=execute('finalize');expect(r.status).toBe(1);expect(r.stderr).toContain('prepare deployment steps');});
  it('rejects another actor prepare provenance',()=>{post();acceptance();data.wrongPrepareActor=true;const r=execute('finalize');expect(r.status).toBe(1);expect(r.stderr).toContain('workflow identity');});
  it('rejects missing independently reviewed report despite valid receipt',()=>{post();acceptance();delete data.report;const r=execute('finalize');expect(r.status).toBe(1);expect(r.stderr).toContain('report digest');});
  it('only sends read-only catalog SQL and GETs, never deployment calls',()=>{
    post();const r=execute('finalize');expect(r.status).toBe(1);expect(r.stderr).toContain('private release receipt');
    const requests=readFileSync(join(dir,'requests.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    for(const req of requests){if(req.method==='POST')expect(JSON.parse(req.body).query).toMatch(/^SELECT /);else expect(req.method).toBe('GET');}
    expect(requests.some(r=>r.url.includes('/v13/deployments/'))).toBe(true);
  });
});

describe('actual admin workflow shell with fake CLI/control plane',()=>{
  function adminStep(message: string, projectId=PROJECTS.admin.id) {
    const workflow:any=yaml.load(readFileSync(join(root,'.github/workflows/deploy-production.yml'),'utf8'));
    const step=workflow.jobs['deploy-production'].steps.find((s:any)=>s.name==='Deploy exact SHA to admin production project');
    mkdirSync(join(dir,'bin'));
    writeFileSync(join(dir,'bin/vercel'),'#!/bin/bash\nif [ "$1" = deploy ]; then echo "https://admin-fixture.vercel.app"; exit 0; fi\necho "$FIXTURE_PROMOTE_MESSAGE"; exit 1\n');chmodSync(join(dir,'bin/vercel'),0o755);
    writeFileSync(join(dir,'bin/curl'),'#!/bin/bash\nprintf \'%s\\n\' "$FIXTURE_INSPECT"\n');chmodSync(join(dir,'bin/curl'),0o755);
    return spawnSync('bash',['-e','-o','pipefail','-c',step.run],{cwd:dir,encoding:'utf8',env:{...process.env,PATH:join(dir,'bin')+':'+process.env.PATH,VERCEL_TOKEN:'fixture',VERCEL_ORG_ID:'team_fixture',VERCEL_PROJECT_ID:PROJECTS.admin.id,TARGET_SHA:target,GITHUB_ENV:join(dir,'env'),FIXTURE_PROMOTE_MESSAGE:message,FIXTURE_INSPECT:JSON.stringify({id:'dpl_admin',projectId,readyState:'READY',meta:{githubCommitSha:target}})}});
  }
  it('accepts already-active response only for the exact inspected deployment',()=>expect(adminStep('dpl_admin already the current production deployment').status).toBe(0));
  it('rejects already-active response for another deployment',()=>expect(adminStep('dpl_unrelated already the current production deployment').status).toBe(1));
  it('rejects an ID substring match',()=>expect(adminStep('dpl_adminOTHER already the current production deployment').status).toBe(1));
  it('rejects wrong project before promotion',()=>expect(adminStep('dpl_admin already the current production deployment','prj_wrong').status).toBe(1));
});

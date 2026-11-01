import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { PAYOUT_TARGETS } from '../reduced-payout-policy.mjs';
import { PAYOUT_POLICY, digest } from '../reduced-release-evidence.mjs';
import { TARGETS, parseManifest, checkDelta, inspectTarget, testTarget } from '../reduced-release-gate.mjs';
let dir: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {cwd, encoding:'utf8', stdio:['pipe','pipe','pipe']}).trim();
afterEach(() => { if (dir) rmSync(dir,{recursive:true,force:true}); });
function fixture() {
 const parent=resolve('scripts/__tests__/.reduced-integration'); mkdirSync(parent,{recursive:true}); dir=mkdtempSync(join(parent,'payout-'));
 const repo=join(dir,'repo');mkdirSync(repo);git(repo,'init','-q','-b','main');git(repo,'config','user.name','Fixture');git(repo,'config','user.email','fixture@example.invalid');
 writeFileSync(join(repo,'base'),'fixture');git(repo,'add','.');git(repo,'commit','-qm','base');const baseline=git(repo,'rev-parse','HEAD');
 const projects:any={};
 for (const kind of ['merchant','admin']) {
  git(repo,'checkout','-qb',kind,baseline);const source_blobs:any={};
  for(const file of PAYOUT_TARGETS[kind].allowed){const bytes='// synthetic '+file+'\n';mkdirSync(dirname(join(repo,file)),{recursive:true});writeFileSync(join(repo,file),bytes);source_blobs[file]=digest(bytes);}
  git(repo,'add','.');git(repo,'commit','-qm',kind);projects[kind]={project_id:TARGETS[kind].project,baseline_sha:baseline,baseline_deployment_id:'dpl_'+kind+'old',target_sha:git(repo,'rev-parse','HEAD'),target_tree:git(repo,'rev-parse','HEAD^{tree}'),source_blobs};
 }
 git(repo,'checkout','main');for(const kind of ['merchant','admin'])git(repo,'merge','--no-ff','-qm','integrate '+kind,projects[kind].target_sha);
 const manifest={schema_version:2,policy:PAYOUT_POLICY,integration_sha:git(repo,'rev-parse','HEAD'),projects};
 const source=join(dir,'source');git(dir,'clone','-q','--shared',repo,source);git(source,'checkout','-q',projects.merchant.target_sha);
 return {repo,source,manifest};
}
describe('fixed payout policy source and command contract',()=>{
 it('accepts exact reviewed inventory and rejects subsets, extras, deletions and M430',()=>{
  const manifest={schema_version:2,policy:PAYOUT_POLICY};
  expect(()=>checkDelta('merchant',PAYOUT_TARGETS.merchant.allowed,[],manifest)).not.toThrow();
  for(const files of [PAYOUT_TARGETS.merchant.allowed.slice(1),[...PAYOUT_TARGETS.merchant.allowed,'supabase/migrations/430_unapproved.sql']])expect(()=>checkDelta('merchant',files,[],manifest)).toThrow();
  expect(()=>checkDelta('merchant',PAYOUT_TARGETS.merchant.allowed,['lib/admin-auth.ts'],manifest)).toThrow();
 });
 it('checks real Git ancestry, exact changed blobs and raw versioned manifest',()=>{
  const {repo,manifest}=fixture();expect(parseManifest(JSON.stringify(manifest),manifest.integration_sha)).toEqual(manifest);
  expect(inspectTarget(repo,'merchant',manifest.projects.merchant,manifest.integration_sha,manifest)).toEqual(PAYOUT_TARGETS.merchant.allowed);
  manifest.projects.merchant.source_blobs['lib/admin-auth.ts']='0'.repeat(64);
  expect(()=>inspectTarget(repo,'merchant',manifest.projects.merchant,manifest.integration_sha,manifest)).toThrow('blob');
 },15000);
 it('runs actual fixed commands; only mandatory PG suite receives disposable database credentials',async()=>{
  const {repo,source,manifest}=fixture();const bin=join(dir,'bin');mkdirSync(bin);const log=join(dir,'npm.jsonl');
  const counts=Object.assign({},...PAYOUT_TARGETS.merchant.suites.map(s=>s.files));
  writeFileSync(join(bin,'npm'),`#!/usr/bin/env node\nconst fs=require('fs');fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args:process.argv.slice(2),env:process.env})+'\\n');if(process.argv[2]==='exec'){const files=process.argv.slice(6).filter(x=>!x.startsWith('--'));const counts=${JSON.stringify(counts)};console.log(JSON.stringify({testResults:files.map(name=>({name:require('path').resolve(name),status:'passed',assertionResults:Array.from({length:counts[name]},()=>({status:'passed'}))}))}));}`);chmodSync(join(bin,'npm'),0o755);
  const raw=JSON.stringify(manifest);const receipt=await testTarget(manifest,'merchant',repo,source,join(dir,'out'),{PATH:bin+':'+process.env.PATH,HOME:dir,REDUCED_RELEASE_MANIFEST:raw,GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',PRIVATE_RELEASE_RECEIPT:'must-not-reach-child',GITHUB_TOKEN:'must-not-reach-child'});
  expect(receipt.manifest_sha256).toBe(digest(raw));
  const calls=readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);expect(calls).toHaveLength(6);
  for(const call of calls){expect(call.env.GITHUB_TOKEN).toBeUndefined();expect(call.env.REDUCED_RELEASE_MANIFEST).toBeUndefined();expect(call.env.PRIVATE_RELEASE_RECEIPT).toBeUndefined();const pg=call.args.includes('lib/__tests__/manual-payout-reject-race.pg.test.ts');expect(call.env.REQUIRE_PG_TESTS).toBe(pg?'true':undefined);expect(call.env.TEST_DATABASE_URL).toBe(pg?'postgresql://postgres:postgres@127.0.0.1:5432/postgres':undefined);}
  expect(Object.values(receipt.suites[3].files)).toEqual([{passed:5,failed:0,skipped:0}]);
 },15000);
});

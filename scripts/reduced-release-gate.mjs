import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const REPO = 'cipherhq/waaiio';
const TEAM = 'team_AEcg69CktrGEptXDznpae8Rp';
const OWNER = 'cipherhq';
const SHA = /^[a-f0-9]{40}$/;
const NUM = /^[0-9]+$/;
const fail = message => { throw new Error(message); };
export const hash = value => createHash('sha256').update(value).digest('hex');
export const TARGETS = Object.freeze({
  merchant: {
    project: 'prj_QkvBTiDA905GHTwX5DQCJVyZzd9d', alias: 'www.waaiio.com', root: '',
    allowed: ['app/dashboard/payouts/page.tsx', 'app/dashboard/payouts/history/page.tsx', 'lib/utils/calendar-date.ts', 'lib/__tests__/calendar-date.test.ts', 'app/dashboard/payouts/__tests__/calendar-period-display.test.tsx'],
    suites: [
      { tz: 'UTC', files: { 'lib/__tests__/calendar-date.test.ts': 6, 'app/dashboard/payouts/__tests__/calendar-period-display.test.tsx': 2 } },
      { tz: 'America/New_York', files: { 'lib/__tests__/calendar-date.test.ts': 6, 'app/dashboard/payouts/__tests__/calendar-period-display.test.tsx': 2 } },
    ],
  },
  admin: {
    project: 'prj_jr7l0grIW2xE6FxVTy5RwRec1rFt', alias: 'admin.waaiio.com', root: 'admin',
    allowed: ['admin/src/pages/Payouts.tsx', 'admin/src/__tests__/payout-generation-feedback.test.tsx'],
    suites: [{ tz: 'UTC', files: { 'src/__tests__/payout-generation-feedback.test.tsx': 4, 'src/__tests__/payouts-held-review-620.test.tsx': 19 } }],
  },
});
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const ancestor = (cwd, before, after) => { try { git(cwd, 'merge-base', '--is-ancestor', before, after); return true; } catch { return false; } };
export function parseManifest(raw, integration) {
  let manifest;
  try { manifest = JSON.parse(raw); } catch { fail('Malformed private reduced manifest'); }
  if (manifest?.schema_version !== 1 || !SHA.test(integration) || manifest.integration_sha !== integration
    || Object.keys(manifest.projects || {}).sort().join(',') !== 'admin,merchant') fail('Invalid reduced release identity');
  for (const kind of Object.keys(TARGETS)) {
    const entry = manifest.projects[kind];
    if (!entry || !SHA.test(entry.baseline_sha) || !SHA.test(entry.target_sha) || !SHA.test(entry.target_tree)
      || entry.baseline_sha === entry.target_sha || entry.project_id !== TARGETS[kind].project) fail(`Invalid ${kind} target identity`);
  }
  if (manifest.projects.admin.target_sha === manifest.projects.merchant.target_sha) fail('Project-specific source targets are required');
  return manifest;
}
export function checkDelta(kind, changed, deleted) {
  const allowed = TARGETS[kind]?.allowed;
  if (!allowed || deleted.length || !changed.length || new Set(changed).size !== changed.length
    || changed.some(file => !allowed.includes(file))) fail('Reduced release contains an unapproved source delta');
}
export function inspectTarget(repository, kind, entry, integration) {
  if (!TARGETS[kind]) fail('Unknown project');
  if (!ancestor(repository, entry.baseline_sha, entry.target_sha) || !ancestor(repository, entry.target_sha, integration)) fail('Reduced source lineage is unproven');
  if (git(repository, 'rev-parse', `${entry.target_sha}^{tree}`) !== entry.target_tree) fail('Reduced target tree mismatch');
  const changed = git(repository, 'diff', '--name-only', entry.baseline_sha, entry.target_sha).split('\n').filter(Boolean);
  const deleted = git(repository, 'diff', '--name-only', '--no-renames', '--diff-filter=D', entry.baseline_sha, entry.target_sha).split('\n').filter(Boolean);
  checkDelta(kind, changed, deleted);
  return changed;
}
function cleanCheckout(repository, target, tree) {
  if (git(repository, 'rev-parse', 'HEAD') !== target || git(repository, 'rev-parse', 'HEAD^{tree}') !== tree
    || git(repository, 'status', '--porcelain')) fail('Source checkout is not the exact clean target');
}
async function api(path, token, options = {}) {
  const response = await fetch(`https://api.github.com/repos/${REPO}${path}`, { ...options, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } });
  if (!response.ok) fail(`Code evidence API failed (${response.status})`);
  return response.json();
}
export function validateMainCI(payload, integration) {
  const runs = Array.isArray(payload?.workflow_runs) ? payload.workflow_runs.filter(run => run.head_sha === integration && run.head_branch === 'main' && run.event === 'push').sort((a,b) => b.id-a.id) : [];
  if (!runs.length || runs[0].status !== 'completed' || runs[0].conclusion !== 'success') fail('Fresh exact protected-main CI is required');
}
async function control(manifest, repository, token) {
  if (!token || !ancestor(repository, manifest.integration_sha, 'origin/main') || git(repository, 'rev-parse', 'HEAD') !== manifest.integration_sha) fail('Trusted protected-main control checkout required');
  validateMainCI(await api(`/actions/workflows/ci.yml/runs?head_sha=${manifest.integration_sha}&event=push&branch=main&per_page=100`, token), manifest.integration_sha);
  for (const kind of Object.keys(TARGETS)) inspectTarget(repository, kind, manifest.projects[kind], manifest.integration_sha);
}
export function summarizeTests(report, expected, sourceRoot) {
  if (!Array.isArray(report?.testResults) || report.testResults.length !== Object.keys(expected).length) fail('Missing exact-target test files');
  const results = {};
  for (const [file, count] of Object.entries(expected)) {
    const cases = report.testResults.filter(result => resolve(result.name) === resolve(sourceRoot, file));
    if (cases.length !== 1 || !Array.isArray(cases[0].assertionResults) || cases[0].assertionResults.length !== count
      || cases[0].status !== 'passed' || cases[0].assertionResults.some(test => test.status !== 'passed')) fail('Exact-target tests failed or skipped');
    results[file] = { passed: count, failed: 0, skipped: 0 };
  }
  return results;
}
function expectedCommands(kind) {
  return [ ['npm','ci'], ...TARGETS[kind].suites.map(suite => ['npm','exec','--','vitest','run', ...Object.keys(suite.files), '--reporter=json']), ['npm','run','build'] ];
}
export async function testTarget(manifest, kind, controlPath, sourcePath, outputPath, environment = process.env) {
  const config = TARGETS[kind], entry = manifest.projects[kind];
  if (!config || environment.VERCEL_TOKEN || environment.SUPABASE_SERVICE_ROLE_KEY || environment.STRIPE_SECRET_KEY || environment.PAYSTACK_SECRET_KEY) fail('Production/provider credentials forbidden in code verification');
  inspectTarget(controlPath, kind, entry, manifest.integration_sha);
  cleanCheckout(sourcePath, entry.target_sha, entry.target_tree);
  const cwd = resolve(sourcePath, config.root);
  const env = { PATH: environment.PATH, HOME: environment.HOME, CI: 'true', TZ: 'UTC', NODE_OPTIONS: '--max-old-space-size=4096',
    NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'dummy', NEXT_PUBLIC_APP_URL: 'https://example.invalid',
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_dummy', NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY: 'pk_test_dummy', NEXT_PUBLIC_POSTHOG_KEY: 'dummy',
    VITE_SUPABASE_URL: 'https://example.supabase.co', VITE_SUPABASE_ANON_KEY: 'dummy', VITE_API_URL: 'https://example.invalid', HUSKY: '0' };
  execFileSync('npm',['ci'],{cwd,env,stdio:'inherit'});
  const suites = [];
  for (const suite of config.suites) {
    const report = execFileSync('npm',['exec','--','vitest','run',...Object.keys(suite.files),'--reporter=json'],{cwd,env:{...env,TZ:suite.tz},encoding:'utf8',maxBuffer:20*1024*1024,stdio:['ignore','pipe','inherit']});
    let parsed; try { parsed=JSON.parse(report); } catch { fail('Invalid exact-target test report'); }
    suites.push({ tz: suite.tz, files: summarizeTests(parsed,suite.files,cwd) });
  }
  execFileSync('npm',['run','build'],{cwd,env,stdio:'inherit'});
  cleanCheckout(sourcePath,entry.target_sha,entry.target_tree);
  if (!NUM.test(environment.GITHUB_RUN_ID || '') || !NUM.test(environment.GITHUB_RUN_ATTEMPT || '')) fail('Authenticated CI run identity required');
  const receipt = { schema_version:1, kind, integration_sha:manifest.integration_sha, target_sha:git(sourcePath,'rev-parse','HEAD'), target_tree:git(sourcePath,'rev-parse','HEAD^{tree}'),
    run_id:environment.GITHUB_RUN_ID, run_attempt:Number(environment.GITHUB_RUN_ATTEMPT), commands:expectedCommands(kind), suites, build:'passed' };
  mkdirSync(outputPath,{recursive:true});writeFileSync(join(outputPath,'receipt.json'),JSON.stringify(receipt));
  return receipt;
}
export function validateCodeReceipt(receipt, kind, manifest, runId, attempt) {
  const entry=manifest.projects[kind], config=TARGETS[kind];
  if (!receipt || receipt.schema_version!==1 || receipt.kind!==kind || receipt.integration_sha!==manifest.integration_sha || receipt.target_sha!==entry.target_sha
    || receipt.target_tree!==entry.target_tree || receipt.run_id!==runId || receipt.run_attempt!==attempt || receipt.build!=='passed' || !isDeepStrictEqual(receipt.commands,expectedCommands(kind))) fail('Exact-target code receipt mismatch');
  const suites=config.suites.map(suite=>({tz:suite.tz,files:Object.fromEntries(Object.entries(suite.files).map(([file,count])=>[file,{passed:count,failed:0,skipped:0}]))}));
  if (!isDeepStrictEqual(receipt.suites,suites)) fail('Exact-target per-file test evidence missing or skipped');
}
export function validateVerificationRun(run, jobs, manifest, runId, attempt) {
  if (String(run?.id)!==runId || run.run_attempt!==attempt || run.repository?.full_name!==REPO || run.actor?.login!==OWNER || run.triggering_actor?.login!==OWNER
    || run.head_sha!==manifest.integration_sha || run.path!=='.github/workflows/verify-reduced-release.yml' || run.event!=='workflow_dispatch' || run.status!=='completed' || run.conclusion!=='success') fail('Untrusted exact-target verification run');
  if (!Array.isArray(jobs?.jobs) || jobs.total_count!==jobs.jobs.length) fail('Verification job evidence incomplete');
  for (const kind of Object.keys(TARGETS)) {
    const matches=jobs.jobs.filter(job=>job.name===`Verify ${kind} target`);
    if (matches.length!==1 || matches[0].conclusion!=='success') fail('Missing exact-target verification job');
    for (const name of ['Verify exact target source, tests, and build','Upload code evidence']) {
      const steps=(matches[0].steps||[]).filter(step=>step.name===name);
      if(steps.length!==1||steps[0].status!=='completed'||steps[0].conclusion!=='success') fail('Exact-target verification step failed or skipped');
    }
  }
}
export function selectArtifact(list, kind, manifest, runId, attempt) {
  if(!Array.isArray(list?.artifacts)||list.total_count!==list.artifacts.length)fail('Code artifact inventory incomplete');
  const name=`reduced-code-${kind}-${runId}-${attempt}`;
  const found=list.artifacts.filter(item=>item.name===name);
  if(found.length!==1||found[0].expired||found[0].workflow_run?.id!==Number(runId)||found[0].workflow_run?.head_sha!==manifest.integration_sha
    ||!Number.isSafeInteger(found[0].id)||!/^sha256:[0-9a-f]{64}$/.test(found[0].digest||''))fail('Missing, stale, or ambiguous code artifact');
  return found[0];
}
async function downloadReceipt(artifact, token) {
  const response=await fetch(`https://api.github.com/repos/${REPO}/actions/artifacts/${artifact.id}/zip`,{redirect:'manual',headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json'}});
  const location=response.headers.get('location');
  if(response.status!==302||!location||new URL(location).protocol!=='https:')fail('Invalid authenticated artifact download');
  // Never forward the GitHub credential to the signed storage URL.
  const zipResponse=await fetch(location,{redirect:'error'});
  if(!zipResponse.ok)fail('Code artifact download failed');
  const bytes=Buffer.from(await zipResponse.arrayBuffer());
  if(bytes.length>1024*1024||`sha256:${hash(bytes)}`!==artifact.digest)fail('Code artifact archive digest mismatch');
  const temporary=mkdtempSync(join(tmpdir(),'reduced-code-evidence-'));
  try {
    const archive=join(temporary,'evidence.zip');writeFileSync(archive,bytes);
    const names=execFileSync('unzip',['-Z1',archive],{encoding:'utf8'}).trim().split('\n');
    if(!isDeepStrictEqual(names,['receipt.json']))fail('Unexpected code artifact contents');
    return JSON.parse(execFileSync('unzip',['-p',archive,'receipt.json'],{encoding:'utf8',maxBuffer:1024*1024}));
  } finally {rmSync(temporary,{recursive:true,force:true});}
}
async function codeEvidence(manifest,runId,attempt,token){
  if(!NUM.test(runId)||!Number.isSafeInteger(attempt)||attempt<1)fail('Verification run and attempt required');
  const run=await api(`/actions/runs/${runId}/attempts/${attempt}`,token);
  const jobs=await api(`/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`,token);
  validateVerificationRun(run,jobs,manifest,runId,attempt);
  const artifacts=await api(`/actions/runs/${runId}/artifacts?per_page=100`,token);
  for(const kind of Object.keys(TARGETS))validateCodeReceipt(await downloadReceipt(selectArtifact(artifacts,kind,manifest,runId,attempt),token),kind,manifest,runId,attempt);
}
async function vercel(path,token){
  const response=await fetch(`https://api.vercel.com${path}${path.includes('?')?'&':'?'}teamId=${TEAM}`,{headers:{Authorization:`Bearer ${token}`}});
  if(!response.ok)fail(`Deployment verification failed (${response.status})`);
  return response.json();
}
export function validateLive(kind, evidence, expectedSha, expectedId) {
  const config=TARGETS[kind];
  if(!evidence||evidence.projectId!==config.project||evidence.sha!==expectedSha||evidence.readyState!=='READY'||!/^dpl_[A-Za-z0-9]+$/.test(evidence.id||'')
    ||evidence.activeId!==evidence.id||evidence.aliasId!==evidence.id||(expectedId&&evidence.id!==expectedId))fail(`Unverified ${kind} live identity`);
}
async function live(kind,token){
  const config=TARGETS[kind],project=await vercel(`/v9/projects/${config.project}`,token);
  if((project.rootDirectory||'')!==config.root)fail('Deployment project root mismatch');
  const id=project.targets?.production?.id;if(!/^dpl_[A-Za-z0-9]+$/.test(id||''))fail('Missing live deployment');
  const deployment=await vercel(`/v13/deployments/${id}`,token),alias=await vercel(`/v4/aliases/${config.alias}`,token);
  return {id:deployment.id,projectId:deployment.projectId,sha:deployment.meta?.githubCommitSha,readyState:deployment.readyState,activeId:id,aliasId:alias.deploymentId??alias.deployment?.id};
}
async function serving(kind,evidence){
  const config=TARGETS[kind];
  const health=await fetch(`https://${config.alias}/${kind==='merchant'?'api/health':'login'}`,{redirect:'error',cache:'no-store'});
  if(health.status!==200)fail(`Reduced deployment public health failed (${health.status})`);
  if(kind==='merchant'){
    const response=await fetch(`https://${config.alias}/api/release-identity`,{redirect:'error',cache:'no-store'});
    if(response.status!==200)fail(`Merchant runtime identity unavailable (${response.status})`);
    const identity=await response.json();
    if(identity.sha!==evidence.sha||identity.projectId!==config.project||identity.deploymentId!==evidence.id||identity.vercelEnv!=='production')fail('Merchant serving identity mismatch');
  }
}
export async function waitForServing(kind,expectedSha,expectedId,token,{read=live,health=serving,pause=()=>new Promise(resolve=>setTimeout(resolve,2000)),attempts=30}={}){
  if(!Number.isSafeInteger(attempts)||attempts<1||attempts>30)fail('Invalid readiness bound');
  for(let attempt=0;attempt<attempts;attempt++){
    try {const current=await read(kind,token);validateLive(kind,current,expectedSha,expectedId);await health(kind,current);return current;}
    catch(error){
      // Permission failures are not propagation delays. Never retry them or
      // switch credentials. Other checks get bounded read-only convergence.
      if(/\((401|403)\)/.test(String(error?.message))||attempt===attempts-1)throw error;
      await pause();
    }
  }
  fail('Deployment readiness did not converge');
}
export async function preflight(manifest,controlPath,sourcePaths,runId,attempt,env=process.env){
  await control(manifest,controlPath,env.GITHUB_TOKEN);
  for(const kind of Object.keys(TARGETS))cleanCheckout(sourcePaths[kind],manifest.projects[kind].target_sha,manifest.projects[kind].target_tree);
  await codeEvidence(manifest,runId,attempt,env.GITHUB_TOKEN);
  const before={};
  for(const kind of Object.keys(TARGETS)){before[kind]=await live(kind,env.VERCEL_TOKEN);validateLive(kind,before[kind],manifest.projects[kind].baseline_sha);}
  return before;
}
export async function deployReduced(manifest,controlPath,sourcePaths,runId,attempt,env=process.env){
  if(!env.VERCEL_TOKEN)fail('Deployment credential required');
  const before=await preflight(manifest,controlPath,sourcePaths,runId,attempt,env),deployed={};
  for(const kind of Object.keys(TARGETS)){
    // Recheck both projects before each mutation; partial releases never replay
    // by redefining their baseline as the newly deployed target.
    for(const check of Object.keys(TARGETS)){const current=await live(check,env.VERCEL_TOKEN);validateLive(check,current,deployed[check]?manifest.projects[check].target_sha:manifest.projects[check].baseline_sha,deployed[check]?.id??before[check].id);}
    const entry=manifest.projects[kind];cleanCheckout(sourcePaths[kind],entry.target_sha,entry.target_tree);
    const output=execFileSync('vercel',['deploy','--prod','--yes','--token',env.VERCEL_TOKEN,'--meta',`githubCommitSha=${entry.target_sha}`],{cwd:sourcePaths[kind],env:{...env,VERCEL_ORG_ID:TEAM,VERCEL_PROJECT_ID:TARGETS[kind].project,GITHUB_SHA:entry.target_sha,VERCEL_GIT_COMMIT_SHA:entry.target_sha},encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:10*1024*1024});
    const urls=output.match(/https:\/\/[a-zA-Z0-9-]+\.vercel\.app/g);if(!urls?.length)fail('Deployment URL missing; stop for private recovery review');
    const deployment=await vercel(`/v13/deployments/${new URL(urls.at(-1)).hostname}`,env.VERCEL_TOKEN);
    if(deployment.projectId!==TARGETS[kind].project||deployment.meta?.githubCommitSha!==entry.target_sha||deployment.readyState!=='READY'||!/^dpl_[A-Za-z0-9]+$/.test(deployment.id||''))fail('Created deployment identity mismatch');
    deployed[kind]=await waitForServing(kind,entry.target_sha,deployment.id,env.VERCEL_TOKEN);
  }
  for(const kind of Object.keys(TARGETS))validateLive(kind,await live(kind,env.VERCEL_TOKEN),manifest.projects[kind].target_sha,deployed[kind].id);
  console.log('Reduced code release verified for both projects.');return {before,deployed};
}
async function main(){
  if(process.env.GITHUB_ACTOR!==OWNER||process.env.GITHUB_TRIGGERING_ACTOR!==OWNER||process.env.GITHUB_EVENT_NAME!=='workflow_dispatch'||process.env.GITHUB_REPOSITORY!==REPO)fail('Owner dispatch on the trusted repository required');
  const command=process.argv[2],controlPath=resolve(process.env.CONTROL_PATH||'.'),integration=process.env.GITHUB_SHA;
  const manifest=parseManifest(process.env.REDUCED_RELEASE_MANIFEST,integration);
  if(command==='plan'){
    await control(manifest,controlPath,process.env.GITHUB_TOKEN);
    if(process.env.GITHUB_OUTPUT)for(const kind of Object.keys(TARGETS))appendFileSync(process.env.GITHUB_OUTPUT,`${kind}_target=${manifest.projects[kind].target_sha}\n`);
  }else if(command==='test'){
    await testTarget(manifest,process.argv[3],controlPath,resolve(process.argv[4]),resolve(process.argv[5]));
  }else if(command==='deploy'){
    await deployReduced(manifest,controlPath,{merchant:resolve(process.argv[3]),admin:resolve(process.argv[4])},process.env.VERIFY_RUN_ID,Number(process.env.VERIFY_RUN_ATTEMPT));
  }else fail('Unknown reduced release command');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.error('Reduced release gate failed; inspect private evidence. No automatic rollback.');process.exitCode=1;});

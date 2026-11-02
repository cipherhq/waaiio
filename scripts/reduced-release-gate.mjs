import { createHash } from 'node:crypto';
import { decodePrivateReport } from './private-report-transport.mjs';
import { decodeFullReportTransport } from './full-report-transport.mjs';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { PAYOUT_POLICY, ACCOUNTING_POLICY, SECURITY_POLICY, manifestBinding, verifyPrivateEvidence, deploymentEnvironment } from './reduced-release-evidence.mjs';
import { PAYOUT_TARGETS, PAYOUT_EVIDENCE_POLICY, INTEGRATION_SQL_TESTS, INTEGRATION_RUNTIME_SOURCES } from './reduced-payout-policy.mjs';

import { ACCOUNTING_TARGETS, ACCOUNTING_EVIDENCE_POLICY, ACCOUNTING_SQL_TESTS, ACCOUNTING_RUNTIME_SOURCES, verifyAccountingActivation } from './reduced-accounting-policy.mjs';

import { SECURITY_IDENTITIES, SECURITY_TARGETS, SECURITY_EVIDENCE_POLICY, SECURITY_SQL_TESTS, SECURITY_STORAGE_TESTS, SECURITY_RUNTIME_SOURCES, SECURITY_MIGRATIONS, verifySecurityPrerequisites } from './reduced-security-policy.mjs';
import { isFullRelease as full, FULL_IDENTITIES, FULL_SCHEMA_CONTRACT, fullInventoryDigest, FULL_TARGETS, FULL_EVIDENCE_POLICY, FULL_MAIN_SQL_TESTS, FULL_SQL_TESTS, FULL_RUNTIME_SOURCES, requireFrozenFullRelease } from './full-release-policy.mjs';
import { verifyFullReleaseEvidence } from './full-release-evidence.mjs';
const security = manifest => manifest?.schema_version === 4 && manifest.policy === SECURITY_POLICY;
const accounting = manifest => (manifest?.schema_version === 3 && manifest.policy === ACCOUNTING_POLICY) || security(manifest) || full(manifest);
const policyFor = manifest => full(manifest) ? FULL_EVIDENCE_POLICY : security(manifest) ? SECURITY_EVIDENCE_POLICY : accounting(manifest) ? ACCOUNTING_EVIDENCE_POLICY : PAYOUT_EVIDENCE_POLICY;
const sqlTestsFor = manifest => full(manifest) ? FULL_SQL_TESTS : security(manifest) ? SECURITY_SQL_TESTS : accounting(manifest) ? ACCOUNTING_SQL_TESTS : INTEGRATION_SQL_TESTS;
const runtimeFor = manifest => full(manifest) ? FULL_RUNTIME_SOURCES : security(manifest) ? SECURITY_RUNTIME_SOURCES : accounting(manifest) ? ACCOUNTING_RUNTIME_SOURCES : INTEGRATION_RUNTIME_SOURCES;
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
const payout = manifest => (manifest?.schema_version === 2 && manifest.policy === PAYOUT_POLICY) || accounting(manifest);
function targetConfig(manifest, kind) {
  if (!payout(manifest)) return TARGETS[kind];
  const config = (full(manifest) ? FULL_TARGETS : security(manifest) ? SECURITY_TARGETS : accounting(manifest) ? ACCOUNTING_TARGETS : PAYOUT_TARGETS)[kind];
  if (!config?.suites.length) fail('Payout policy execution contract is not frozen');
  return { ...TARGETS[kind], ...config };
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const ancestor = (cwd, before, after) => { try { git(cwd, 'merge-base', '--is-ancestor', before, after); return true; } catch { return false; } };
// Optional, named v3-only manual-admin contract. Operational IDs stay in the
// private manifest, whose exact bytes are already bound by CI and approval.
export function manualAdminPolicy(manifest) {
  if (manifest?.projects?.merchant?.manual_alias !== undefined) fail('Manual alias policy is admin-only');
  const policy = manifest?.projects?.admin?.manual_alias;
  if (policy === undefined) return null;
  const pin = policy?.preexisting_target;
  if (!accounting(manifest) || policy?.policy !== 'canonical-admin-alias-v1'
    || Object.keys(policy).sort().join(',') !== 'policy,preexisting_target'
    || !pin || Object.keys(pin).sort().join(',') !== 'created_at,id,project_id,ready_state,sha,source'
    || !/^dpl_[A-Za-z0-9]+$/.test(pin.id || '') || pin.id === manifest.projects.admin.baseline_deployment_id
    || pin.project_id !== TARGETS.admin.project || !SHA.test(pin.sha || '')
    || pin.ready_state !== 'READY' || pin.source !== 'cli'
    || !Number.isSafeInteger(pin.created_at) || pin.created_at <= 0) fail('Invalid manual admin alias policy');
  return policy;
}
const deploymentDescriptor = d => ({ id:d.id, project_id:d.projectId, sha:d.meta?.githubCommitSha,
  ready_state:d.readyState, source:d.source, created_at:d.createdAt });
function candidateMatches(deployment, candidate, manifest) {
  return deployment.id === candidate.id && deployment.projectId === TARGETS.admin.project
    && deployment.meta?.githubCommitSha === manifest.projects.admin.target_sha && deployment.readyState === 'READY'
    && deployment.createdAt === candidate.createdAt && deployment.target === 'production' && deployment.source === 'cli';
}
export function parseManifest(raw, integration) {
  let manifest;
  try { manifest = JSON.parse(raw); } catch { fail('Malformed private reduced manifest'); }
  if ((manifest?.schema_version !== 1 && !payout(manifest)) || !SHA.test(integration) || manifest.integration_sha !== integration
    || Object.keys(manifest.projects || {}).sort().join(',') !== 'admin,merchant') fail('Invalid reduced release identity');
  for (const kind of Object.keys(TARGETS)) {
    const entry = manifest.projects[kind];
    if (!entry || !SHA.test(entry.baseline_sha) || !SHA.test(entry.target_sha) || !SHA.test(entry.target_tree)
      || entry.baseline_sha === entry.target_sha || entry.project_id !== TARGETS[kind].project) fail(`Invalid ${kind} target identity`);
  }
  if (!full(manifest) && manifest.projects.admin.target_sha === manifest.projects.merchant.target_sha) fail('Project-specific source targets are required');
  if (security(manifest) || full(manifest)) for (const kind of Object.keys(TARGETS)) {
    const expected = (full(manifest) ? FULL_IDENTITIES : SECURITY_IDENTITIES)[kind];
    for (const field of ['baseline_sha', 'target_sha', 'target_tree']) if (manifest.projects[kind][field] !== expected[field]) fail('Security source identity differs from fixed reviewed target');
    if (full(manifest) && manifest.projects[kind].source_inventory_sha256 !== fullInventoryDigest(kind)) fail('Full release source inventory binding mismatch');
  }
  manualAdminPolicy(manifest);
  if (payout(manifest)) manifestBinding(raw, manifest);
  return manifest;
}
export function checkDelta(kind, changed, deleted, manifest) {
  const allowed = targetConfig(manifest, kind)?.allowed;
  if (payout(manifest) && !isDeepStrictEqual([...changed].sort(), [...allowed].sort())) fail('Payout release requires the exact reviewed source inventory');
  if (full(manifest) && !isDeepStrictEqual([...deleted].sort(), Object.keys(FULL_IDENTITIES[kind].deleted_blobs).sort())) fail('Full release deletion inventory mismatch');
  if (!allowed || (!full(manifest) && deleted.length) || !changed.length || new Set(changed).size !== changed.length
    || changed.some(file => !allowed.includes(file))) fail('Reduced release contains an unapproved source delta');
}
// Full targets contain many files. Read exact Git blob bytes in one bounded
// batch rather than spawning one process per file; never hash working-tree data.
function fullBlobDigests(repository, revision, paths) {
  if (paths.some(path => /[\r\n]/.test(path))) fail('Invalid full source path');
  const bytes = execFileSync('git', ['cat-file', '--batch'], { cwd: repository,
    input: paths.map(path => `${revision}:${path}\n`).join(''), maxBuffer: 128 * 1024 * 1024 });
  const result = {}; let offset = 0;
  for (const path of paths) {
    const end = bytes.indexOf(10, offset);
    const header = bytes.subarray(offset, end).toString('ascii');
    const match = /^([a-f0-9]{40}) blob ([0-9]+)$/.exec(header);
    if (end < offset || !match) fail('Missing full source blob');
    const size = Number(match[2]); offset = end + 1;
    if (!Number.isSafeInteger(size) || offset + size >= bytes.length || bytes[offset + size] !== 10) fail('Invalid full source blob framing');
    result[path] = hash(bytes.subarray(offset, offset + size)); offset += size + 1;
  }
  if (offset !== bytes.length) fail('Unexpected full source blob data');
  return result;
}
export function inspectTarget(repository, kind, entry, integration, manifest) {
  if (!TARGETS[kind]) fail('Unknown project');
  if (full(manifest) && (entry.source_inventory_sha256 !== fullInventoryDigest(kind) || entry.source_blobs !== undefined || entry.deleted_blobs !== undefined)) fail('Full release source inventory binding mismatch');
  if (!ancestor(repository, entry.baseline_sha, entry.target_sha) || !ancestor(repository, entry.target_sha, integration)) fail('Reduced source lineage is unproven');
  if (git(repository, 'rev-parse', `${entry.target_sha}^{tree}`) !== entry.target_tree) fail('Reduced target tree mismatch');
  const changed = git(repository, 'diff', '--name-only', ...(full(manifest) ? ['--no-renames'] : []), entry.baseline_sha, entry.target_sha).split('\n').filter(Boolean);
  const deleted = git(repository, 'diff', '--name-only', '--no-renames', '--diff-filter=D', entry.baseline_sha, entry.target_sha).split('\n').filter(Boolean);
  checkDelta(kind, changed, deleted, manifest);
  if (payout(manifest)) {
    const present = changed.filter(file => !deleted.includes(file));
    const blobs = full(manifest) ? fullBlobDigests(repository, entry.target_sha, present) : Object.fromEntries(present.map(file => [file, hash(execFileSync('git', ['show', `${entry.target_sha}:${file}`], { cwd: repository }))]));
    if (accounting(manifest) && !isDeepStrictEqual(blobs, targetConfig(manifest, kind).blobs)) fail('Accounting source differs from fixed reviewed blobs');
    if (full(manifest)) {
      const deletedBlobs = fullBlobDigests(repository, entry.baseline_sha, deleted);
      if (!isDeepStrictEqual(deletedBlobs, FULL_IDENTITIES[kind].deleted_blobs)) fail('Full release deleted baseline blob mismatch');
    }
    if (full(manifest)) {
      if (entry.source_inventory_sha256 !== fullInventoryDigest(kind) || entry.source_blobs !== undefined || entry.deleted_blobs !== undefined) fail('Full release source inventory binding mismatch');
    } else if (!isDeepStrictEqual(entry.source_blobs, blobs)) fail('Private manifest source blob mismatch');
  }
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
  for (const kind of Object.keys(TARGETS)) inspectTarget(repository, kind, manifest.projects[kind], manifest.integration_sha, manifest);
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
function expectedCommands(kind, manifest) {
  return [ ['npm','ci'], ...targetConfig(manifest, kind).suites.map(suite => ['npm','exec','--','vitest','run', ...Object.keys(suite.files), '--reporter=json']), ['npm','run','build'] ];
}
export async function testTarget(manifest, kind, controlPath, sourcePath, outputPath, environment = process.env) {
  const config = targetConfig(manifest, kind), entry = manifest.projects[kind];
  if (!config || environment.VERCEL_TOKEN || environment.SUPABASE_SERVICE_ROLE_KEY || environment.STRIPE_SECRET_KEY || environment.PAYSTACK_SECRET_KEY) fail('Production/provider credentials forbidden in code verification');
  inspectTarget(controlPath, kind, entry, manifest.integration_sha, manifest);
  cleanCheckout(sourcePath, entry.target_sha, entry.target_tree);
  const cwd = resolve(sourcePath, config.root);
  const env = { PATH: environment.PATH, HOME: environment.HOME, CI: 'true', TZ: 'UTC', NODE_OPTIONS: '--max-old-space-size=4096',
    NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'dummy', NEXT_PUBLIC_APP_URL: 'https://example.invalid',
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_dummy', NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY: 'pk_test_dummy', NEXT_PUBLIC_POSTHOG_KEY: 'dummy',
    VITE_SUPABASE_URL: 'https://example.supabase.co', VITE_SUPABASE_ANON_KEY: 'dummy', VITE_API_URL: 'https://example.invalid', HUSKY: '0' };
  execFileSync('npm',['ci'],{cwd,env,stdio:'inherit'});
  const suites = [];
  for (const suite of config.suites) {
    const report = execFileSync('npm',['exec','--','vitest','run',...Object.keys(suite.files),'--reporter=json'],{cwd,env:{...env,TZ:suite.tz,...(suite.postgres ? { TEST_DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5432/postgres', REQUIRE_PG_TESTS: 'true' } : {})},encoding:'utf8',maxBuffer:20*1024*1024,stdio:['ignore','pipe','inherit']});
    let parsed; try { parsed=JSON.parse(report); } catch { fail('Invalid exact-target test report'); }
    suites.push({ tz: suite.tz, files: summarizeTests(parsed,suite.files,cwd) });
  }
  execFileSync('npm',['run','build'],{cwd,env,stdio:'inherit'});
  cleanCheckout(sourcePath,entry.target_sha,entry.target_tree);
  if (!NUM.test(environment.GITHUB_RUN_ID || '') || !NUM.test(environment.GITHUB_RUN_ATTEMPT || '')) fail('Authenticated CI run identity required');
  const receipt = { schema_version:1, kind, integration_sha:manifest.integration_sha, target_sha:git(sourcePath,'rev-parse','HEAD'), target_tree:git(sourcePath,'rev-parse','HEAD^{tree}'),
    run_id:environment.GITHUB_RUN_ID, run_attempt:Number(environment.GITHUB_RUN_ATTEMPT), commands:expectedCommands(kind, manifest), suites, build:'passed' };
  if (payout(manifest)) receipt.manifest_sha256 = manifestBinding(environment.REDUCED_RELEASE_MANIFEST, manifest).manifest_sha256;
  mkdirSync(outputPath,{recursive:true});writeFileSync(join(outputPath,'receipt.json'),JSON.stringify(receipt));
  return receipt;
}
export function validateCodeReceipt(receipt, kind, manifest, runId, attempt, rawManifest = process.env.REDUCED_RELEASE_MANIFEST) {
  const entry=manifest.projects[kind], config=targetConfig(manifest, kind);
  if (!receipt || receipt.schema_version!==1 || receipt.kind!==kind || receipt.integration_sha!==manifest.integration_sha || receipt.target_sha!==entry.target_sha
    || receipt.target_tree!==entry.target_tree || receipt.run_id!==runId || receipt.run_attempt!==attempt || receipt.build!=='passed' || !isDeepStrictEqual(receipt.commands,expectedCommands(kind, manifest))) fail('Exact-target code receipt mismatch');
  if (payout(manifest) && receipt.manifest_sha256 !== manifestBinding(rawManifest, manifest).manifest_sha256) fail('Code receipt manifest bytes mismatch');
  const suites=config.suites.map(suite=>({tz:suite.tz,files:Object.fromEntries(Object.entries(suite.files).map(([file,count])=>[file,{passed:count,failed:0,skipped:0}]))}));
  if (!isDeepStrictEqual(receipt.suites,suites)) fail('Exact-target per-file test evidence missing or skipped');
}
function integrationCommands(manifest) {
  const commands = [['npm', 'ci'], ['npm', 'exec', '--', 'vitest', 'run', ...Object.keys(full(manifest) ? FULL_MAIN_SQL_TESTS : security(manifest) ? ACCOUNTING_SQL_TESTS : sqlTestsFor(manifest)), '--no-file-parallelism', '--reporter=json']];
  if (security(manifest) || full(manifest)) commands.push(['node', 'scripts/reduced-security-storage-tests.mjs']);
  return commands;
}
function integrationSources(repository, integration, manifest) {
  const sql = {};
  for (const entry of [...(full(manifest) ? FULL_SCHEMA_CONTRACT : policyFor(manifest).schema_contracts).canonical_sources, ...(security(manifest) ? SECURITY_MIGRATIONS : [])]) {
    const file = `supabase/migrations/${entry.name}`;
    const actual = hash(execFileSync('git', ['show', `${integration}:${file}`], { cwd: repository }));
    if (actual !== entry.sha256) fail('Canonical integration SQL differs from reviewed prerequisite');
    sql[file] = actual;
  }
  const tests = Object.fromEntries(Object.keys(sqlTestsFor(manifest)).map(file =>
    [file, hash(execFileSync('git', ['show', `${integration}:${file}`], { cwd: repository }))]));
  const runtime = Object.fromEntries(runtimeFor(manifest).map(file => [file, hash(execFileSync('git', ['show', `${integration}:${file}`], { cwd: repository }))]));
  return { sql, tests, runtime };
}
export function validateIntegrationReceipt(receipt, manifest, runId, attempt, rawManifest, repository) {
  if (!payout(manifest)) fail('Integration SQL evidence is only defined for payout policy');
  const expected = {
    schema_version: 2, kind: 'integration-sql', manifest_sha256: manifestBinding(rawManifest, manifest).manifest_sha256,
    integration_sha: manifest.integration_sha, merchant_target_sha: manifest.projects.merchant.target_sha,
    merchant_target_tree: manifest.projects.merchant.target_tree, run_id: runId, run_attempt: attempt,
    commands: integrationCommands(manifest), sources: integrationSources(repository, manifest.integration_sha, manifest),
    files: Object.fromEntries(Object.entries(sqlTestsFor(manifest)).map(([file, count]) => [file, { passed: count, failed: 0, skipped: 0 }])),
  };
  if (!isDeepStrictEqual(receipt, expected)) fail('Integration SQL receipt/source evidence mismatch');
}
export async function testIntegration(manifest, sourcePath, outputPath, environment = process.env) {
  if (!payout(manifest) || environment.VERCEL_TOKEN || environment.SUPABASE_SERVICE_ROLE_KEY || environment.STRIPE_SECRET_KEY || environment.PAYSTACK_SECRET_KEY) fail('Isolated integration SQL verification required');
  cleanCheckout(sourcePath, manifest.integration_sha, git(sourcePath, 'rev-parse', `${manifest.integration_sha}^{tree}`));
  const sources = integrationSources(sourcePath, manifest.integration_sha, manifest);
  const env = { PATH:environment.PATH, HOME:environment.HOME, CI:'true', HUSKY:'0', TZ:'UTC', NODE_OPTIONS:'--max-old-space-size=4096' };
  execFileSync('npm', ['ci'], { cwd:sourcePath, env, stdio:'inherit' });
  const output = execFileSync('npm', integrationCommands(manifest)[1].slice(1), { cwd:sourcePath,
    env:{...env, TEST_DATABASE_URL:'postgresql://postgres:postgres@127.0.0.1:5432/postgres', REQUIRE_PG_TESTS:'true'},
    encoding:'utf8', maxBuffer:20*1024*1024, stdio:['ignore','pipe','inherit'] });
  let report; try { report=JSON.parse(output); } catch { fail('Invalid integration SQL test report'); }
  const files=summarizeTests(report, full(manifest) ? FULL_MAIN_SQL_TESTS : security(manifest) ? ACCOUNTING_SQL_TESTS : sqlTestsFor(manifest), sourcePath);
  if (security(manifest) || full(manifest)) {
    const storageOutput = execFileSync('node', ['scripts/reduced-security-storage-tests.mjs'], { cwd: sourcePath, env, encoding: 'utf8', maxBuffer: 20*1024*1024, stdio: ['ignore','pipe','inherit'] });
    let storageReport; try { storageReport=JSON.parse(storageOutput); } catch { fail('Invalid storage SQL test report'); }
    Object.assign(files, summarizeTests(storageReport, SECURITY_STORAGE_TESTS, sourcePath));
  }
  cleanCheckout(sourcePath, manifest.integration_sha, git(sourcePath, 'rev-parse', `${manifest.integration_sha}^{tree}`));
  if (!NUM.test(environment.GITHUB_RUN_ID||'') || !NUM.test(environment.GITHUB_RUN_ATTEMPT||'')) fail('Authenticated integration run identity required');
  const receipt={schema_version:2,kind:'integration-sql',manifest_sha256:manifestBinding(environment.REDUCED_RELEASE_MANIFEST,manifest).manifest_sha256,
    integration_sha:manifest.integration_sha,merchant_target_sha:manifest.projects.merchant.target_sha,merchant_target_tree:manifest.projects.merchant.target_tree,
    run_id:environment.GITHUB_RUN_ID,run_attempt:Number(environment.GITHUB_RUN_ATTEMPT),commands:integrationCommands(manifest),sources,files};
  mkdirSync(outputPath,{recursive:true});writeFileSync(join(outputPath,'receipt.json'),JSON.stringify(receipt));return receipt;
}
export function validateVerificationRun(run, jobs, manifest, runId, attempt) {
  if (String(run?.id)!==runId || run.run_attempt!==attempt || run.repository?.full_name!==REPO || run.actor?.login!==OWNER || run.triggering_actor?.login!==OWNER
    || run.head_sha!==manifest.integration_sha || run.path!=='.github/workflows/verify-reduced-release.yml' || run.event!=='workflow_dispatch' || run.status!=='completed' || run.conclusion!=='success') fail('Untrusted exact-target verification run');
  if (!Array.isArray(jobs?.jobs) || jobs.total_count!==jobs.jobs.length) fail('Verification job evidence incomplete');
  if (payout(manifest)) {
    const matches=jobs.jobs.filter(job=>job.name==='Verify integration SQL prerequisites');
    if(matches.length!==1||matches[0].conclusion!=='success')fail('Missing integration SQL verification job');
    for(const name of ['Verify canonical SQL prerequisites','Upload integration SQL evidence']) {
      const steps=(matches[0].steps||[]).filter(step=>step.name===name);
      if(steps.length!==1||steps[0].status!=='completed'||steps[0].conclusion!=='success')fail('Integration SQL verification step failed or skipped');
    }
  }
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
async function codeEvidence(manifest,runId,attempt,token,rawManifest,repository){
  if(!NUM.test(runId)||!Number.isSafeInteger(attempt)||attempt<1)fail('Verification run and attempt required');
  const run=await api(`/actions/runs/${runId}/attempts/${attempt}`,token);
  const jobs=await api(`/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`,token);
  validateVerificationRun(run,jobs,manifest,runId,attempt);
  const artifacts=await api(`/actions/runs/${runId}/artifacts?per_page=100`,token);
  for(const kind of Object.keys(TARGETS))validateCodeReceipt(await downloadReceipt(selectArtifact(artifacts,kind,manifest,runId,attempt),token),kind,manifest,runId,attempt,rawManifest);
  if(payout(manifest))validateIntegrationReceipt(await downloadReceipt(selectArtifact(artifacts,'integration',manifest,runId,attempt),token),manifest,runId,attempt,rawManifest,repository);
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
export async function live(kind,token,manifest,candidate){
  const config=TARGETS[kind],project=await vercel(`/v9/projects/${config.project}`,token);
  if((project.rootDirectory||'')!==config.root)fail('Deployment project root mismatch');
  const manual=manualAdminPolicy(manifest);
  if(manual && (project.id!==config.project || project.framework!==(kind==='admin'?'vite':'nextjs')
    || project.autoAssignCustomDomains!==(kind!=='admin') || project.buildCommand!==null
    || project.installCommand!==null || project.outputDirectory!==null
    || project.commandForIgnoringBuildStep!==(kind==='admin'?null:'exit 0'))) fail('Unexpected deployment project policy');
  if (payout(manifest)) {
    const alias = await vercel(`/v4/aliases/${config.alias}`, token);
    const id = alias.deploymentId ?? alias.deployment?.id;
    if (!/^dpl_[A-Za-z0-9]+$/.test(id || '')) fail('Missing canonical alias deployment');
    const deployment = await vercel(`/v13/deployments/${id}`, token);
    const latestId = project.targets?.production?.id;
    if (!/^dpl_[A-Za-z0-9]+$/.test(latestId || '')) fail('Missing latest production target evidence');
    if (manual && kind==='admin') {
      const entry=manifest.projects.admin, pin=manual.preexisting_target;
      if (id!==entry.baseline_deployment_id && id!==candidate?.id) fail('Unapproved manual admin serving identity');
      const baseline=id===entry.baseline_deployment_id?deployment:await vercel(`/v13/deployments/${entry.baseline_deployment_id}`,token);
      if(baseline.id!==entry.baseline_deployment_id || baseline.projectId!==config.project || baseline.meta?.githubCommitSha!==entry.baseline_sha
        || baseline.readyState!=='READY' || !Number.isSafeInteger(baseline.createdAt) || pin.created_at>=baseline.createdAt) fail('Invalid manual admin baseline chronology');
      const latest=latestId===id?deployment:await vercel(`/v13/deployments/${latestId}`,token);
      if (latestId===pin.id) {
        if(!isDeepStrictEqual(deploymentDescriptor(latest),pin)) fail('Pinned manual admin target changed');
      } else if (!candidate || latestId!==candidate.id || !candidateMatches(latest,candidate,manifest)) fail('Unapproved manual admin latest target');
      if(id===candidate?.id && !candidateMatches(deployment,candidate,manifest)) fail('Manual admin candidate changed');
    } else if (latestId !== id) {
      const latest = await vercel(`/v13/deployments/${latestId}`, token);
      if (latest.id !== latestId || latest.projectId !== config.project || latest.readyState !== 'CANCELED'
        || latest.source !== 'git' || latest.errorLink !== 'https://vercel.com/docs/project-configuration/git-settings#ignored-build-step') fail('Unapproved latest-target divergence');
    }
    return { id:deployment.id, projectId:deployment.projectId, sha:deployment.meta?.githubCommitSha, readyState:deployment.readyState, activeId:id, aliasId:id };
  }
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
  await codeEvidence(manifest,runId,attempt,env.GITHUB_TOKEN,env.REDUCED_RELEASE_MANIFEST,controlPath);
  const before={};
  for(const kind of Object.keys(TARGETS)){before[kind]=await live(kind,env.VERCEL_TOKEN,manifest);validateLive(kind,before[kind],manifest.projects[kind].baseline_sha,payout(manifest)?manifest.projects[kind].baseline_deployment_id:undefined);}
  return before;
}
function privateEvidence(manifest, runId, attempt, env) {
  if (full(manifest)) requireFrozenFullRelease();
  if (!payout(manifest)) return;
  const reportBytes = full(manifest) ? decodeFullReportTransport(env.PRIVATE_RELEASE_ACCEPTANCE_REPORT, env) : decodePrivateReport(env.PRIVATE_RELEASE_ACCEPTANCE_REPORT);
  const evidence = verifyPrivateEvidence({ rawManifest: env.REDUCED_RELEASE_MANIFEST, manifest, receiptBytes: env.PRIVATE_RELEASE_RECEIPT, reportBytes, approvedHash: env.PRIVATE_RELEASE_ACCEPTANCE_SHA256, policy: policyFor(manifest) });
  if (full(manifest)) verifyFullReleaseEvidence(JSON.parse(reportBytes), manifest, Date.now(), Date.parse(JSON.parse(env.PRIVATE_RELEASE_RECEIPT).approved_at));
  else if (accounting(manifest)) verifyAccountingActivation(JSON.parse(reportBytes), manifest, Date.now(), Date.parse(JSON.parse(env.PRIVATE_RELEASE_RECEIPT).approved_at));
  if (security(manifest)) verifySecurityPrerequisites(JSON.parse(reportBytes), manifest, Date.now(), Date.parse(JSON.parse(env.PRIVATE_RELEASE_RECEIPT).approved_at));
  if (evidence.verification.run_id !== runId || evidence.verification.run_attempt !== attempt) fail('Approved private evidence refers to a different code verification');
}
export async function deployReduced(manifest,controlPath,sourcePaths,runId,attempt,env=process.env){
  if(!env.VERCEL_TOKEN)fail('Deployment credential required');
  const manual=manualAdminPolicy(manifest);
  privateEvidence(manifest,runId,attempt,env);
  const before=await preflight(manifest,controlPath,sourcePaths,runId,attempt,env),deployed={};
  let adminCandidate;
  for(const kind of Object.keys(TARGETS)){
    // Recheck both projects before each mutation; partial releases never replay
    // by redefining their baseline as the newly deployed target.
    for(const check of Object.keys(TARGETS)){const current=await live(check,env.VERCEL_TOKEN,manifest,check==='admin'?adminCandidate:undefined);validateLive(check,current,deployed[check]?manifest.projects[check].target_sha:manifest.projects[check].baseline_sha,deployed[check]?.id??before[check].id);}
    privateEvidence(manifest,runId,attempt,env);
    const entry=manifest.projects[kind];cleanCheckout(sourcePaths[kind],entry.target_sha,entry.target_tree);
    const output=execFileSync('vercel',['deploy','--prod',...(manual&&kind==='admin'?['--skip-domain']:[]),'--yes','--token',env.VERCEL_TOKEN,'--meta',`githubCommitSha=${entry.target_sha}`,'--env',`VERCEL_GIT_COMMIT_SHA=${entry.target_sha}`,'--build-env',`VERCEL_GIT_COMMIT_SHA=${entry.target_sha}`],{cwd:sourcePaths[kind],env:payout(manifest)?deploymentEnvironment(env,TARGETS[kind].project,TEAM,entry.target_sha):{...env,VERCEL_ORG_ID:TEAM,VERCEL_PROJECT_ID:TARGETS[kind].project,GITHUB_SHA:entry.target_sha,VERCEL_GIT_COMMIT_SHA:entry.target_sha},encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:10*1024*1024});
    const urls=output.match(/https:\/\/[a-zA-Z0-9-]+\.vercel\.app/g);if(!urls?.length)fail('Deployment URL missing; stop for private recovery review');
    const deployment=await vercel(`/v13/deployments/${new URL(urls.at(-1)).hostname}`,env.VERCEL_TOKEN);
    if(deployment.projectId!==TARGETS[kind].project||deployment.meta?.githubCommitSha!==entry.target_sha||deployment.readyState!=='READY'||!/^dpl_[A-Za-z0-9]+$/.test(deployment.id||''))fail('Created deployment identity mismatch');
    if(manual && kind==='admin') {
      if(deployment.target!=='production' || deployment.source!=='cli' || deployment.id===entry.baseline_deployment_id || deployment.id===manual.preexisting_target.id
        || deployment.id===deployed.merchant?.id || !Number.isSafeInteger(deployment.createdAt)) fail('Admin candidate is not newly identified');
      adminCandidate={id:deployment.id,createdAt:deployment.createdAt};
      // Preserve the created candidate on any later failure. No automatic
      // rollback or mutation retry, including uncertain alias POST outcomes.
      for(const check of Object.keys(TARGETS)) {
        const current=await live(check,env.VERCEL_TOKEN,manifest,check==='admin'?adminCandidate:undefined);
        validateLive(check,current,deployed[check]?manifest.projects[check].target_sha:manifest.projects[check].baseline_sha,deployed[check]?.id??before[check].id);
      }
      const currentCandidate=await vercel(`/v13/deployments/${adminCandidate.id}`,env.VERCEL_TOKEN);
      if(!candidateMatches(currentCandidate,adminCandidate,manifest)) fail('Admin candidate changed before alias assignment');
      privateEvidence(manifest,runId,attempt,env);
      const assigned=await fetch(`https://api.vercel.com/v2/deployments/${adminCandidate.id}/aliases?teamId=${TEAM}`,{
        method:'POST',headers:{Authorization:`Bearer ${env.VERCEL_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({alias:TARGETS.admin.alias})});
      if(!assigned.ok)fail(`Admin alias assignment failed (${assigned.status}); retain candidate for private recovery review`);
    }
    deployed[kind]=await waitForServing(kind,entry.target_sha,deployment.id,env.VERCEL_TOKEN,{read:(k,t)=>live(k,t,manifest,k==='admin'?adminCandidate:undefined)});
  }
  for(const kind of Object.keys(TARGETS))validateLive(kind,await live(kind,env.VERCEL_TOKEN,manifest,kind==='admin'?adminCandidate:undefined),manifest.projects[kind].target_sha,deployed[kind].id);
  console.log('Reduced code release verified for both projects.');return {before,deployed};
}
async function main(){
  if(process.env.GITHUB_ACTOR!==OWNER||process.env.GITHUB_TRIGGERING_ACTOR!==OWNER||process.env.GITHUB_EVENT_NAME!=='workflow_dispatch'||process.env.GITHUB_REPOSITORY!==REPO)fail('Owner dispatch on the trusted repository required');
  const command=process.argv[2],controlPath=resolve(process.env.CONTROL_PATH||'.'),integration=process.env.GITHUB_SHA;
  const manifest=parseManifest(process.env.REDUCED_RELEASE_MANIFEST,integration);
  if(command==='plan'){
    await control(manifest,controlPath,process.env.GITHUB_TOKEN);
    if(process.env.GITHUB_OUTPUT)appendFileSync(process.env.GITHUB_OUTPUT,`payout_policy=${payout(manifest)}\nfull_release_policy=${full(manifest)}\n`);
    if(process.env.GITHUB_OUTPUT)for(const kind of Object.keys(TARGETS))appendFileSync(process.env.GITHUB_OUTPUT,`${kind}_target=${manifest.projects[kind].target_sha}\n`);
  }else if(command==='test-integration'){
    await testIntegration(manifest,controlPath,resolve(process.argv[3]));
  }else if(command==='test'){
    await testTarget(manifest,process.argv[3],controlPath,resolve(process.argv[4]),resolve(process.argv[5]));
  }else if(command==='deploy'){
    await deployReduced(manifest,controlPath,{merchant:resolve(process.argv[3]),admin:resolve(process.argv[4])},process.env.VERIFY_RUN_ID,Number(process.env.VERIFY_RUN_ATTEMPT));
  }else fail('Unknown reduced release command');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.error('Reduced release gate failed; inspect private evidence. No automatic rollback.');process.exitCode=1;});

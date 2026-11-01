import { createHash } from 'node:crypto';
import { readFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export const POST_FILE = 'supabase/migrations/492_verification_public_upload_guard.sql';
export const POST_HASH = '18377b0c9e8ebb890a8a5fa1b640781c9ec3894ff3738673a4af8a3d8ba353dc';
export const ENGAGE_BUNDLE = Object.freeze({
  files: Object.freeze(['supabase/migrations/431_engage_segments.sql', 'supabase/migrations/432_engage_segments_acl.sql']),
  name: '431_432_engage_segments_with_acl',
  sha256: 'b1ae596192ec1ac85097e5ec257d80cfae078a6ffaf8bf3aec5a53a398d4278e',
});
export const PROJECTS = Object.freeze({
  merchant: { id: 'prj_QkvBTiDA905GHTwX5DQCJVyZzd9d', alias: 'www.waaiio.com' },
  admin: { id: 'prj_jr7l0grIW2xE6FxVTy5RwRec1rFt', alias: 'admin.waaiio.com' },
});
const SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const VERSION = /^[0-9]{1,20}$/;
const NAME = /^[a-z0-9_]+$/;
const fail = message => { throw new Error(message); };
export const hash = data => createHash('sha256').update(data).digest('hex');

// Pure verification shared by the real workflow and executable negative tests.
// Deployment and ledger evidence is fetched fresh by runGate; it is never taken
// from a caller-supplied attestation or a previous workflow's success badge.
export function verifyRelease({ mode, target, manifest, changed, removed, files, ledger, deployments, baselineIsAncestor }) {
  if (!['prepare', 'ready-for-post', 'finalize'].includes(mode)) fail('Unknown release phase');
  if (!SHA.test(target) || !manifest || manifest.schema_version !== 1 || !SHA.test(manifest.baseline_sha)) fail('Invalid release identity');
  if (manifest.baseline_sha === target || !baselineIsAncestor) fail('Original baseline must be a strict ancestor');
  if (!manifest.migrations || Array.isArray(manifest.migrations) || typeof manifest.migrations !== 'object') fail('Missing migration manifest');
  if (removed.length) fail('Deleted/renamed migrations are forbidden');
  if (!changed.length || new Set(changed).size !== changed.length) fail('Empty or duplicate original migration delta');
  if (Object.keys(manifest.migrations).sort().join('\n') !== [...changed].sort().join('\n')) fail('Every original migration must be accounted for exactly');
  if (!Array.isArray(ledger)) fail('Invalid ledger response');
  for (const [kind, project] of Object.entries(PROJECTS)) {
    const deployment = deployments[kind];
    if (!deployment || deployment.projectId !== project.id || deployment.readyState !== 'READY' || !SHA.test(deployment.sha)
      || !/^dpl_[a-zA-Z0-9]+$/.test(deployment.id) || deployment.activeId !== deployment.id || deployment.aliasId !== deployment.id) fail(`Unverified ${kind} deployment/alias`);
    if (mode !== 'prepare' && deployment.sha !== target) fail(`${kind} is not serving target`);
  }
  if (mode === 'prepare' && deployments.merchant.sha !== manifest.baseline_sha) fail('Live merchant baseline changed; do not replay prepare');
  const pending = [];
  const verified = [];
  for (const file of changed) {
    const entry = manifest.migrations[file];
    if (!/^supabase\/migrations\/[a-zA-Z0-9_]+\.sql$/.test(file) || !entry || !HASH.test(entry.sha256) || !NAME.test(entry.ledger_name || '')) fail(`Malformed entry: ${file}`);
    if (hash(files[file] ?? '') !== entry.sha256) fail(`File hash mismatch: ${file}`);
    if (!['pre', 'post'].includes(entry.phase)) fail(`Invalid phase: ${file}`);
    if (entry.phase === 'post' && (file !== POST_FILE || entry.sha256 !== POST_HASH)) fail('Only the reviewed M492 bytes may be postdeploy');
    if (entry.phase === 'pre' && file === POST_FILE) fail('M492 is application-first');
    if (entry.phase === 'pre' && !VERSION.test(entry.ledger_version || '')) fail(`Missing valid ledger version: ${file}`);
    // Postdeploy version does not yet exist at code-review time. Its exact name
    // and SQL bytes are pinned, and exactly one real ledger row must match.
    let expectedSqlHash = entry.sha256;
    if (entry.bundle !== undefined) {
      if (entry.bundle !== '431_432' || !ENGAGE_BUNDLE.files.includes(file) || entry.phase !== 'pre'
        || entry.ledger_name !== ENGAGE_BUNDLE.name) fail('Unsupported historical bundle');
      for (const member of ENGAGE_BUNDLE.files) {
        const companion = manifest.migrations[member];
        if (!changed.includes(member) || !companion || companion.bundle !== '431_432' || companion.phase !== 'pre'
          || companion.ledger_version !== entry.ledger_version || companion.ledger_name !== ENGAGE_BUNDLE.name
          || hash(files[member] ?? '') !== companion.sha256) fail('Incomplete historical bundle');
      }
      const composed = Buffer.concat([Buffer.from('BEGIN;\n'), Buffer.from(files[ENGAGE_BUNDLE.files[0]]), Buffer.from('\n'), Buffer.from(files[ENGAGE_BUNDLE.files[1]]), Buffer.from('\nCOMMIT;')]);
      if (hash(composed) !== ENGAGE_BUNDLE.sha256) fail('Historical bundle bytes changed');
      expectedSqlHash = ENGAGE_BUNDLE.sha256;
    }
    const matches = ledger.filter(row => entry.phase === 'pre' ? row.version === entry.ledger_version : row.name === entry.ledger_name);
    if (entry.phase === 'post' && mode === 'prepare' && matches.length) fail('Postdeploy migration already present; reconcile before another deploy');
    if (entry.phase === 'post' && mode !== 'finalize' && matches.length === 0) { pending.push(file); continue; }
    if (matches.length !== 1) fail(`Missing or ambiguous ledger row: ${file}`);
    const row = matches[0];
    if (!VERSION.test(row.version) || row.name !== entry.ledger_name || row.stmt_count !== 1 || row.applied_sha256 !== expectedSqlHash) fail(`Ledger SQL mismatch: ${file}`);
    verified.push({ file, version: row.version, name: row.name, sha256: row.applied_sha256 });
  }
  return { state: mode === 'finalize' ? 'awaiting-private-acceptance-verification' : 'awaiting-postdeployment-verification', baseline: manifest.baseline_sha, target, verified, pending };
}

// Shape and identity validation is necessary, but does not establish that an
// acceptance run occurred. Report bytes and an independently approved digest
// are separately provisioned as Owner-managed GitHub secrets; never generated
// from synthetic unit-test fixtures or from this deployment workflow.
export function verifyReceiptBinding(receipt, { baseline, target, manifestHash, deployments }) {
  if (!receipt || receipt.schema_version !== 1 || receipt.baseline_sha !== baseline || receipt.target_sha !== target
    || receipt.manifest_sha256 !== manifestHash || !HASH.test(receipt.manifest_sha256 || '')) fail('Private receipt release binding mismatch');
  if (!/^[0-9]+$/.test(receipt.prepare_run_id || '') || !Number.isSafeInteger(receipt.prepare_run_attempt) || receipt.prepare_run_attempt < 1
    || !HASH.test(receipt.acceptance_artifact_sha256 || '')) fail('Private receipt lacks immutable run/acceptance identity');
  for (const kind of Object.keys(PROJECTS)) {
    if (receipt.deployments?.[kind] !== deployments[kind]?.id) fail(`Private receipt ${kind} deployment mismatch`);
  }
  return receipt;
}

export const ACCEPTANCE_CASES = Object.freeze({
  merchant_owner_allowed: { route: '/api/verification/document', status: 307 },
  merchant_other_tenant_denied: { route: '/api/verification/document', allowed_statuses: [403, 404], document_disclosed: false, redirect: false },
  full_admin_aal2_allowed: { route: '/api/admin/verification/document', status: 200 },
  admin_password_only_denied: { route: '/api/admin/verification/document', status: 403 },
  private_uploader_path: { route: '/api/verification/upload', method: 'POST', intercepted: true, bucket: 'verification-documents', locatorScheme: 'storage:' },
  public_catalog_compatible: { bucket: 'business-documents', status: 200, classification: 'catalog-media' },
});
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
export function verifyReviewedAcceptance(reportBytes, approvedHash, receipt, binding) {
  verifyReceiptBinding(receipt, binding);
  if (!nonempty(reportBytes) || !HASH.test(approvedHash || '') || hash(reportBytes) !== approvedHash
    || approvedHash !== receipt.acceptance_artifact_sha256) fail('Private acceptance report digest mismatch');
  let report;
  try { report = JSON.parse(reportBytes); } catch { fail('Malformed private acceptance report JSON'); }
  if (report.schema_version !== 1 || report.baseline_sha !== binding.baseline || report.target_sha !== binding.target
    || report.manifest_sha256 !== binding.manifestHash || !isDeepStrictEqual(report.deployments, receipt.deployments)
    || report.prepare_run_id !== receipt.prepare_run_id || report.prepare_run_attempt !== receipt.prepare_run_attempt) fail('Private acceptance identity mismatch');
  const started = Date.parse(report.started_at), completed = Date.parse(report.completed_at);
  if (!Number.isFinite(started) || !Number.isFinite(completed) || started > completed || completed > Date.now() + 300000
    || !nonempty(report.suite) || !nonempty(report.runner?.name) || !nonempty(report.runner?.version)
    || !nonempty(report.runner?.command) || !nonempty(report.runner?.run_id) || report.runner?.source_sha !== binding.target
    || !nonempty(report.independent_review?.reviewer) || !nonempty(report.independent_review?.reference)
    || !nonempty(report.owner_acceptance_reference)) fail('Private acceptance provenance incomplete');
  if (report.network?.fixture_writes_intercepted !== true || report.network?.business_mutations !== 0 || report.network?.provider_calls !== 0
    || report.summary?.failed !== 0 || report.summary?.skipped !== 0 || !Array.isArray(report.cases)
    || report.summary?.passed !== report.cases.length || report.cases.length !== Object.keys(ACCEPTANCE_CASES).length) fail('Private acceptance run is incomplete or exceeds mutation scope');
  for (const [id, expected] of Object.entries(ACCEPTANCE_CASES)) {
    const matches = report.cases.filter(item => item?.id === id);
    if (matches.length !== 1 || matches[0].outcome !== 'passed' || !HASH.test(matches[0].evidence_sha256 || '')
      || !isDeepStrictEqual(matches[0].expected, expected)) fail(`Private acceptance case failed: ${id}`);
    const observed = matches[0].observed;
    if (id === 'merchant_other_tenant_denied') {
      if (!expected.allowed_statuses.includes(observed?.status) || !isDeepStrictEqual(observed, { route: expected.route, status: observed.status, document_disclosed: false, redirect: false })) fail(`Private acceptance case failed: ${id}`);
    } else if (!isDeepStrictEqual(observed, expected)) fail(`Private acceptance case failed: ${id}`);
  }
  return { passed: report.cases.length, failed: 0, skipped: 0 };
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
async function request(url, token, options = {}) {
  const response = await fetch(url, { ...options, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers } });
  if (!response.ok) fail(`Read-only verification API failed: ${response.status}`);
  return response.json();
}

export async function runGate(mode, target) {
  if (!process.env.VERCEL_TOKEN || !process.env.SUPABASE_ACCESS_TOKEN || !process.env.GITHUB_TOKEN) fail('Missing read-only verification credentials');
  if (!SHA.test(target) || git('rev-parse', 'HEAD') !== target) fail('Checkout does not match target');
  try { execFileSync('git', ['merge-base', '--is-ancestor', target, 'origin/main']); }
  catch { fail('Target must belong to protected main'); }
  const runs = await request(`https://api.github.com/repos/cipherhq/waaiio/actions/workflows/ci.yml/runs?head_sha=${target}&event=push&branch=main&per_page=100`, process.env.GITHUB_TOKEN);
  const exactRuns = (runs.workflow_runs || []).filter(run => run.head_sha === target && run.head_branch === 'main' && run.event === 'push').sort((a, b) => b.id - a.id);
  if (!exactRuns.length || exactRuns[0].status !== 'completed' || exactRuns[0].conclusion !== 'success') fail('Latest exact protected-main CI is not successful');
  const manifestBytes = process.env.PRIVATE_RELEASE_MANIFEST;
  if (!nonempty(manifestBytes)) fail('Owner-managed private release manifest is required');
  let manifest;
  try { manifest = JSON.parse(manifestBytes); } catch { fail('Malformed private release manifest JSON'); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('Malformed private release manifest JSON');
  if (!SHA.test(manifest.baseline_sha)) fail('Invalid original baseline');
  let baselineIsAncestor = false;
  try { execFileSync('git', ['merge-base', '--is-ancestor', manifest.baseline_sha, target]); baselineIsAncestor = true; } catch { /* fail closed below */ }
  const changed = git('diff', '--name-only', manifest.baseline_sha, target, '--', 'supabase/migrations').split('\n').filter(Boolean);
  const removed = git('diff', '--name-only', '--no-renames', '--diff-filter=D', manifest.baseline_sha, target, '--', 'supabase/migrations').split('\n').filter(Boolean);
  const files = Object.fromEntries(changed.map(file => [file, readFileSync(file)]));
  const ledger = await request('https://api.supabase.com/v1/projects/cxcmiqotkowhxinjbytg/database/query', process.env.SUPABASE_ACCESS_TOKEN, {
    method: 'POST', body: JSON.stringify({ query: "SELECT version,name,encode(extensions.digest(statements[1],'sha256'),'hex') AS applied_sha256,array_length(statements,1) AS stmt_count FROM supabase_migrations.schema_migrations" }),
  });
  const deployments = {};
  const api = 'https://api.vercel.com';
  const team = 'team_AEcg69CktrGEptXDznpae8Rp';
  for (const [kind, config] of Object.entries(PROJECTS)) {
    const project = await request(`${api}/v9/projects/${config.id}?teamId=${team}`, process.env.VERCEL_TOKEN);
    if (kind === 'admin' && project.rootDirectory !== 'admin') fail('Admin project must build admin/ from the exact repository checkout');
    const activeId = project.targets?.production?.id;
    if (!/^dpl_[a-zA-Z0-9]+$/.test(activeId || '')) fail(`Missing ${kind} active target`);
    const deployment = await request(`${api}/v13/deployments/${activeId}?teamId=${team}`, process.env.VERCEL_TOKEN);
    if (mode === 'prepare') {
      const liveSha = deployment.meta?.githubCommitSha;
      if (!SHA.test(liveSha || '')) fail('Missing live Git identity');
      try { execFileSync('git', ['merge-base', '--is-ancestor', liveSha, target]); }
      catch { fail(`${kind} live revision is not an ancestor of target`); }
    }
    const alias = await request(`${api}/v4/aliases/${config.alias}?teamId=${team}`, process.env.VERCEL_TOKEN);
    deployments[kind] = { id: deployment.id, projectId: deployment.projectId, readyState: deployment.readyState, sha: deployment.meta?.githubCommitSha, activeId, aliasId: alias.deploymentId ?? alias.deployment?.id };
    if (mode !== 'prepare') {
      const response = await fetch(`https://${config.alias}/${kind === 'merchant' ? 'api/release-identity' : 'login'}`, { redirect: 'error', cache: 'no-store' });
      if (response.status !== 200) fail(`${kind} serving check failed`);
      if (kind === 'merchant') {
        const identity = await response.json();
        if (identity.sha !== target || identity.projectId !== config.id || identity.deploymentId !== deployment.id || identity.vercelEnv !== 'production' || identity.supabaseProjectRef !== 'cxcmiqotkowhxinjbytg') fail('Merchant runtime identity mismatch');
      }
    }
  }
  const result = verifyRelease({ mode, target, manifest, changed, removed, files, ledger, deployments, baselineIsAncestor });
  if (mode === 'finalize') {
    if (!process.env.PRIVATE_RELEASE_RECEIPT) fail('Trusted private release receipt is required');
    let privateReceipt;
    try { privateReceipt = JSON.parse(process.env.PRIVATE_RELEASE_RECEIPT); } catch { fail('Malformed private release receipt JSON'); }
    const receipt = verifyReceiptBinding(privateReceipt, {
      baseline: manifest.baseline_sha, target, manifestHash: hash(manifestBytes), deployments,
    });
    const prepareRun = await request(`https://api.github.com/repos/cipherhq/waaiio/actions/runs/${receipt.prepare_run_id}/attempts/${receipt.prepare_run_attempt}`, process.env.GITHUB_TOKEN);
    if (prepareRun.repository?.full_name !== 'cipherhq/waaiio' || prepareRun.actor?.login !== 'cipherhq' || prepareRun.head_sha !== target || prepareRun.run_attempt !== receipt.prepare_run_attempt || prepareRun.path !== '.github/workflows/deploy-production.yml'
      || prepareRun.event !== 'workflow_dispatch' || prepareRun.status !== 'completed' || prepareRun.conclusion !== 'success') fail('Private receipt prepare workflow identity mismatch');
    const attemptJobs = await request(`https://api.github.com/repos/cipherhq/waaiio/actions/runs/${receipt.prepare_run_id}/attempts/${receipt.prepare_run_attempt}/jobs?per_page=100`, process.env.GITHUB_TOKEN);
    if (!Array.isArray(attemptJobs.jobs) || attemptJobs.total_count !== attemptJobs.jobs.length) fail('Prepare attempt jobs evidence incomplete');
    const jobs = attemptJobs.jobs.filter(job => job.name === 'Deploy exact SHA to production');
    if (jobs.length !== 1 || jobs[0].conclusion !== 'success') fail('Prepare deployment job not successful');
    for (const stepName of ['Deploy exact SHA to production project', 'Deploy exact SHA to admin production project', 'Verify both apps before postdeployment migration']) {
      const steps = (jobs[0].steps || []).filter(step => step.name === stepName);
      if (steps.length !== 1 || steps[0].status !== 'completed' || steps[0].conclusion !== 'success') fail('Referenced run did not complete prepare deployment steps');
    }
    verifyReviewedAcceptance(process.env.PRIVATE_RELEASE_ACCEPTANCE_REPORT,
      process.env.PRIVATE_RELEASE_ACCEPTANCE_SHA256, receipt,
      { baseline: manifest.baseline_sha, target, manifestHash: hash(manifestBytes), deployments });
    result.state = 'complete';
  }
  if (mode === 'prepare' && process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `PREV_DEPLOYMENT_ID=${deployments.merchant.id}\nPREV_ADMIN_DEPLOYMENT_ID=${deployments.admin.id}\nLIVE_GIT_SHA=${manifest.baseline_sha}\n`);
  console.log(JSON.stringify({ state: result.state, verifiedCount: result.verified.length, pendingCount: result.pending.length }));
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runGate(process.argv[2], process.argv[3]).catch(error => { console.error(error.message); process.exitCode = 1; });
}

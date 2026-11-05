// Release Process V3 reusable production release gate (manifest schema 8).
// RELEASE_GATE_V2.md §9. Docs: docs/RELEASE_V3_GATE.md.
//
//   prepare  Owner-dispatched. Reads production and staging (read-only), derives
//            the release from facts, classifies the lane and writes the packet.
//            Deploys nothing.
//   deploy   Owner-dispatched with the approved packet sha256 and its recorded
//            approval. Re-reads production before every mutation and stops on
//            any difference. Merchant first, then admin. No retry, no rollback.
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { fail, sha256, canonicalJson, canonicalDigest, byteCompare, GateError, SHA, HASH, OWNER, REPO } from './release-v3/common.mjs';
import { catalogAggregate } from './release-v3/catalog-oracle.mjs';
import { classifyChanges, collectChanges, targetReader, isPaymentPath } from './release-v3/classify.mjs';
import { observeDatabase } from './release-v3/db-observe.mjs';
import { loadLock, loadLockMap, loadM430, postBootstrapMigrations, admitDatabase } from './release-v3/admission.mjs';
import { PROJECTS, TEAM, vercelClient, githubClient, observeProject, checkProductionConsistency, observeHoldFlags, checkServing,
  validateMainCI, validateJobs, hashId, descriptor, REQUIRED_CI_JOBS } from './release-v3/platform.mjs';
import { buildPacket, packetBytes, packetDigest, acceptPacket, parseCommentUrl, verifyRecordComment, APPROVAL_LINE, STAGING_ACCEPTANCE_LINE,
  verifyPullRequestReviews, verifySingleUse } from './release-v3/packet.mjs';
import { deploymentEnvironment } from './reduced-release-evidence.mjs';

const KINDS = ['merchant', 'admin'];
const PREPARE_WORKFLOW = '.github/workflows/release-prepare.yml';
const DEPLOY_WORKFLOW = '.github/workflows/release-deploy.yml';
// Gate rules: deploy refuses to run if any of these differ from the prepare run.
export const GATE_PATHS = ['scripts/release-gate-v3.mjs', 'scripts/release-v3', 'scripts/reduced-release-evidence.mjs',
  'supabase/catalog-deltas', PREPARE_WORKFLOW, DEPLOY_WORKFLOW];

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export const isAncestor = (cwd, a, b) => { try { git(cwd, 'merge-base', '--is-ancestor', a, b); return true; } catch { return false; } };

export function requireOwnerDispatch(env) {
  if (env.GITHUB_ACTOR !== OWNER || env.GITHUB_TRIGGERING_ACTOR !== OWNER || env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
    || env.GITHUB_REPOSITORY !== REPO || env.GITHUB_REF !== 'refs/heads/main' || !SHA.test(env.GITHUB_SHA || '')) fail('Owner dispatch from protected main on the trusted repository required');
}
function requireTrustedCheckout(control, gateSha) {
  if (git(control, 'rev-parse', 'HEAD') !== gateSha || git(control, 'status', '--porcelain') || !isAncestor(control, gateSha, 'origin/main')) fail('Trusted gate checkout must be the clean protected-main commit');
}
function requireCleanSource(source, sha, tree) {
  if (git(source, 'rev-parse', 'HEAD') !== sha || git(source, 'rev-parse', 'HEAD^{tree}') !== tree || git(source, 'status', '--porcelain')) fail('Source checkout is not the exact clean target');
}

// ---------- certified baseline (§9.5) ----------
async function listRuns(gh, workflowFile, query) {
  const runs = [];
  for (let page = 1; page <= 20; page++) {
    const result = await gh(`/actions/workflows/${workflowFile}/runs?${query}&per_page=100&page=${page}`);
    if (!Array.isArray(result?.workflow_runs)) fail('Run history unavailable');
    runs.push(...result.workflow_runs);
    if (runs.length >= result.total_count || !result.workflow_runs.length) return { total_count: result.total_count, workflow_runs: runs };
  }
  fail('Run history too long to verify');
}
export async function downloadArtifactFile(artifact, token, fileName, fetchImpl = fetch, maxBytes = 8 * 1024 * 1024) {
  const response = await fetchImpl(`https://api.github.com/repos/${REPO}/actions/artifacts/${artifact.id}/zip`, { redirect: 'manual', headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } });
  const location = response.headers.get('location');
  if (response.status !== 302 || !location || new URL(location).protocol !== 'https:') fail('Invalid authenticated artifact download');
  // Never forward the GitHub credential to the signed storage URL.
  const zip = await fetchImpl(location, { redirect: 'error' });
  if (!zip.ok) fail('Artifact download failed');
  const bytes = Buffer.from(await zip.arrayBuffer());
  if (bytes.length > maxBytes || `sha256:${sha256(bytes)}` !== artifact.digest) fail('Artifact archive digest mismatch');
  const dir = mkdtempSync(join(tmpdir(), 'release-v3-'));
  try {
    const archive = join(dir, 'a.zip'); writeFileSync(archive, bytes);
    const names = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).trim().split('\n');
    if (names.length !== 1 || names[0] !== fileName) fail('Unexpected artifact contents');
    return execFileSync('unzip', ['-p', archive, fileName], { maxBuffer: maxBytes });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
function oneArtifact(list, name, runId) {
  if (!Array.isArray(list?.artifacts) || list.total_count !== list.artifacts.length) fail('Artifact inventory incomplete');
  const found = list.artifacts.filter(a => a.name === name);
  if (found.length !== 1 || found[0].expired || String(found[0].workflow_run?.id) !== String(runId) || !/^sha256:[0-9a-f]{64}$/.test(found[0].digest || '')) fail(`Missing, expired or ambiguous artifact ${name}`);
  return found[0];
}
export function validateDispatchRun(run, workflowPath) {
  if (run?.repository?.full_name !== REPO || run.path !== workflowPath || run.event !== 'workflow_dispatch' || run.head_branch !== 'main'
    || run.actor?.login !== OWNER || run.triggering_actor?.login !== OWNER || run.status !== 'completed' || run.conclusion !== 'success' || !SHA.test(run.head_sha || '')) fail(`Untrusted ${workflowPath} run`);
  return run;
}
// The last certified release: the newest successful production deploy run's
// record, or the Owner-approved lock if no V3 deploy has ever succeeded.
export async function certifiedBaseline(gh, token, lock, fetchImpl = fetch) {
  const runs = await listRuns(gh, 'release-deploy.yml', 'status=success&event=workflow_dispatch&branch=main');
  const trusted = runs.workflow_runs.filter(r => r.path === DEPLOY_WORKFLOW && r.conclusion === 'success').sort((a, b) => b.id - a.id);
  if (!trusted.length) return { source: 'lock', merchant: { sha: lock.certified.merchant, deployment_sha256: null }, admin: { sha: lock.certified.admin, deployment_sha256: null } };
  const run = validateDispatchRun(await gh(`/actions/runs/${trusted[0].id}`), DEPLOY_WORKFLOW);
  const artifact = oneArtifact(await gh(`/actions/runs/${run.id}/artifacts?per_page=100`), `release-record-${run.id}-${run.run_attempt}`, run.id);
  const record = JSON.parse((await downloadArtifactFile(artifact, token, 'record.json', fetchImpl)).toString('utf8'));
  if (record?.schema_version !== 1 || !SHA.test(record.target_sha || '') || !HASH.test(record.merchant_deployment_sha256 || '') || !HASH.test(record.admin_deployment_sha256 || '')) fail('Release record is invalid');
  return { source: `release-deploy run ${run.id}`, merchant: { sha: record.target_sha, deployment_sha256: record.merchant_deployment_sha256 },
    admin: { sha: record.target_sha, deployment_sha256: record.admin_deployment_sha256 } };
}

// ---------- included pull requests and their review records (§9.3) ----------
async function includedPullRequests(gh, control, baseline, target, reviewedPrs) {
  const commits = git(control, 'rev-list', '--first-parent', '--reverse', `${baseline}..${target}`).split('\n').filter(Boolean);
  const prs = [];
  for (const sha of commits) {
    const pulls = (await gh(`/commits/${sha}/pulls`)).filter(p => p.merge_commit_sha === sha && p.base?.ref === 'main' && p.merged_at);
    if (pulls.length !== 1) fail(`Commit ${sha} on main has no single merged pull request`);
    const lane = classifyChanges(collectChanges(control, git(control, 'rev-parse', `${sha}^1`), sha), { readTarget: targetReader(control, sha) });
    const pr = { number: pulls[0].number, merge_sha: sha, head_sha: pulls[0].head.sha, lane: lane.lane, governance: lane.governance, required_reviews: lane.required_reviews };
    const comments = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await gh(`/issues/${pr.number}/comments?per_page=100&page=${page}`);
      comments.push(...batch);
      if (batch.length < 100) break;
    }
    prs.push(verifyPullRequestReviews(pr, comments, reviewedPrs));
  }
  return prs;
}

// ---------- prepare ----------
export async function prepare({ env = process.env, control, now = Date.now(), fetchImpl = fetch, observe = observeDatabase } = {}) {
  requireOwnerDispatch(env);
  requireTrustedCheckout(control, env.GITHUB_SHA);
  const target = env.TARGET_SHA || env.GITHUB_SHA;
  if (!SHA.test(target) || !isAncestor(control, target, 'origin/main')) fail('Target must be a protected-main commit');
  if (!['', 'full'].includes(env.RAISE_LANE || '')) fail('A lane can only be raised to full, never lowered');
  const gh = githubClient(env.GITHUB_TOKEN, fetchImpl), vercel = vercelClient(env.VERCEL_TOKEN, fetchImpl);
  const lock = loadLock(readFileSync(join(control, 'scripts/release-v3/lock.json'), 'utf8'));

  // Target: green exact push-main CI, every job successful.
  const ci = validateMainCI(await gh(`/actions/workflows/ci.yml/runs?head_sha=${target}&event=push&branch=main&per_page=100`), target);
  const jobs = validateJobs(await gh(`/actions/runs/${ci.run_id}/attempts/${ci.run_attempt}/jobs?per_page=100`));

  // Baseline: what production serves, which must be the certified release.
  const certified = await certifiedBaseline(gh, env.GITHUB_TOKEN, lock, fetchImpl);
  const production = {};
  for (const kind of KINDS) {
    production[kind] = await observeProject(vercel, 'production', kind);
    checkProductionConsistency(production[kind]);
    const serving = production[kind].serving;
    if (serving.sha !== certified[kind].sha || (certified[kind].deployment_sha256 && hashId(serving.id) !== certified[kind].deployment_sha256)) fail(`Production ${kind} is not serving the last certified release (stale or uncertified baseline)`);
    if (!isAncestor(control, serving.sha, target)) fail(`Production ${kind} baseline is not an ancestor of the target`);
  }
  // Single-SHA provenance: both projects release from one baseline to one target.
  // The one exception is an Owner-approved lock re-certification after a partial
  // deploy (docs: "Recovery"): then the release counts every change since the
  // older baseline, so nothing either project lacks goes unreviewed.
  const merchantSha = production.merchant.serving.sha, adminSha = production.admin.serving.sha;
  let baseline = merchantSha;
  if (merchantSha !== adminSha) {
    if (certified.source !== 'lock') fail('Merchant and admin baselines differ');
    if (isAncestor(control, adminSha, merchantSha)) baseline = adminSha;
    else if (!isAncestor(control, merchantSha, adminSha)) fail('Merchant and admin baselines are not on one line of history');
  }
  if (baseline === target) fail('Target is already in production');

  const changes = collectChanges(control, baseline, target);
  const lane = classifyChanges(changes, { raiseTo: env.RAISE_LANE || '', readTarget: targetReader(control, target) });
  const changedPaths = changes.map(c => c.path);
  const pullRequests = await includedPullRequests(gh, control, baseline, target, lock.reviewed_prs);
  if (lane.lane === 'standard' && pullRequests.some(pr => pr.lane !== 'standard')) fail('Lane mismatch between the release and its pull requests');

  // Database: production and staging, read-only, against lock + reviewed deltas.
  const migrations = postBootstrapMigrations(control, target, lock, changedPaths);
  const m430 = loadM430(readFileSync(join(control, 'scripts/release-v3/m430-identities.json'), 'utf8'), readFileSync(join(control, 'supabase/migrations/430_shared_number_tenant_isolation.sql')));
  const database = {};
  for (const environment of ['production', 'staging']) {
    const observation = observe(environment, env);
    database[environment] = admitDatabase({ observation, lock, migrations, lockMap: loadLockMap(lock.environments[environment], pathToFileURL(`${control}/`)), m430 });
    database[environment].observed_at = observation.observed_at;
  }

  // Staging must already serve the exact target (git auto-deploy of main).
  const staging = {};
  for (const kind of KINDS) {
    const observed = await observeProject(vercel, 'staging', kind);
    if (observed.serving.sha !== target) fail(`Staging ${kind} does not serve the target`);
    await checkServing('staging', kind, observed.serving, fetchImpl, env);
    staging[kind] = { sha: observed.serving.sha, deployment_sha256: hashId(observed.serving.id) };
  }
  const holds = await Promise.all(KINDS.map(kind => observeHoldFlags(vercel, kind)));
  if (holds.some(h => !h.hold_flags_absent)) fail('Payout or channel-operation hold flag is set in production');

  const packet = buildPacket({
    prepare: { run_id: env.GITHUB_RUN_ID, run_attempt: Number(env.GITHUB_RUN_ATTEMPT), gate_sha: env.GITHUB_SHA },
    target: { sha: target, tree: git(control, 'rev-parse', `${target}^{tree}`), ci: { run_id: ci.run_id, run_attempt: ci.run_attempt, jobs } },
    baseline: Object.fromEntries(KINDS.map(k => [k, { sha: production[k].serving.sha, deployment_sha256: hashId(production[k].serving.id), certified_by: certified.source }])),
    admin_pin: { deployment_sha256: hashId(production.admin.target.id), descriptor_sha256: canonicalDigest(production.admin.target) },
    lane: { ...lane, raised_by_reviewer: env.RAISE_LANE === 'full' },
    changes: { count: changedPaths.length, files_sha256: sha256(changedPaths.join('\n')), files: changedPaths, payment_paths: changedPaths.filter(isPaymentPath) },
    pull_requests: pullRequests,
    migrations: migrations.map(m => ({ name: m.name, sha256: m.sha256, delta_changes: m.delta.changes.length })),
    database, staging,
    permanent_checks: { m430_absent: database.production.m430.present === 0, m430_identities_checked: database.production.m430.checked, hold_flags_absent: true,
      hold_flags: holds, payment_regression: { required_ci_jobs: [...REQUIRED_CI_JOBS], all_successful_on_target: true, payment_paths_changed: changedPaths.some(isPaymentPath) } },
    lock_sha256: sha256(readFileSync(join(control, 'scripts/release-v3/lock.json'))),
  }, now);
  return packet;
}

// ---------- one-time lock catalog map ----------
// Captures the per-object digests of the approved lock state so later releases
// can apply catalog deltas. Only valid while the live catalog still equals the
// lock exactly (before the first post-bootstrap migration reaches that
// environment). Output is committed by a reviewed PR; it holds digests only.
export async function captureLockMaps({ env = process.env, control, observe = observeDatabase } = {}) {
  requireOwnerDispatch(env);
  requireTrustedCheckout(control, env.GITHUB_SHA);
  const lock = loadLock(readFileSync(join(control, 'scripts/release-v3/lock.json'), 'utf8'));
  const maps = {};
  for (const environment of ['production', 'staging']) {
    const observation = observe(environment, env);
    const lockEnv = lock.environments[environment];
    if (observation.catalog.size !== lockEnv.catalog.count || catalogAggregate(observation.catalog) !== lockEnv.catalog.sha256) fail(`${environment} catalog no longer equals the lock; the map cannot be captured`);
    maps[environment] = { schema_version: 1, environment, query_sha256: lock.catalog_query_sha256, lock_catalog_sha256: lockEnv.catalog.sha256,
      objects: Object.fromEntries([...observation.catalog.entries()].sort(([a], [b]) => byteCompare(a, b))) };
  }
  return maps;
}

// ---------- deploy ----------
async function loadApprovedPacket({ gh, env, control, fetchImpl, now }) {
  const runId = env.PREPARE_RUN_ID;
  if (!/^[0-9]+$/.test(runId || '')) fail('Prepare run ID required');
  const run = validateDispatchRun(await gh(`/actions/runs/${runId}`), PREPARE_WORKFLOW);
  // The rules that produced the packet must be the rules deploying it.
  try { git(control, 'diff', '--quiet', run.head_sha, env.GITHUB_SHA, '--', ...GATE_PATHS); } catch { fail('Gate rules changed since the packet was prepared; prepare a new packet'); }
  const artifact = oneArtifact(await gh(`/actions/runs/${runId}/artifacts?per_page=100`), `release-packet-${runId}-${run.run_attempt}`, runId);
  const packet = acceptPacket(await downloadArtifactFile(artifact, env.GITHUB_TOKEN, 'packet.json', fetchImpl), env.PACKET_SHA256, now);
  if (String(packet.prepare.run_id) !== String(runId) || packet.prepare.run_attempt !== run.run_attempt || packet.prepare.gate_sha !== run.head_sha) fail('Packet does not belong to this prepare run');
  if (!isAncestor(control, packet.target.sha, 'origin/main')) fail('Packet target is not on protected main');
  if (sha256(readFileSync(join(control, 'scripts/release-v3/lock.json'))) !== packet.lock_sha256) fail('Release lock changed since the packet was prepared');
  return packet;
}

// Production state before a mutation. `expected` holds the deployment hash each
// project must serve and the admin production-target descriptor hashes allowed.
async function recheckProduction({ vercel, env, control, packet, lock, migrations, m430, expected, observe }) {
  const observation = observe('production', env);
  const admitted = admitDatabase({ observation, lock, migrations, lockMap: loadLockMap(lock.environments.production, pathToFileURL(`${control}/`)), m430 });
  const recorded = packet.database.production;
  if (admitted.ledger.sha256 !== recorded.ledger.sha256 || admitted.catalog.sha256 !== recorded.catalog.sha256 || admitted.m430.present !== 0) fail('Production database changed since the packet was approved');
  for (const kind of KINDS) {
    const observed = await observeProject(vercel, 'production', kind);
    if (hashId(observed.serving.id) !== expected[kind].serving) fail(`Production ${kind} serving deployment changed`);
    if (kind === 'admin' && !expected.admin.targets.includes(canonicalDigest(observed.target))) fail('Admin production target changed');
    if (kind === 'merchant' && !expected.merchantDeployed) checkProductionConsistency(observed);
  }
  const holds = await Promise.all(KINDS.map(kind => observeHoldFlags(vercel, kind)));
  if (holds.some(h => !h.hold_flags_absent)) fail('Payout or channel-operation hold flag is set in production');
}

async function waitForServing(vercel, kind, created, fetchImpl, pause, attempts = 30) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const observed = await observeProject(vercel, 'production', kind);
      if (observed.serving.id !== created.id || observed.serving.sha !== created.sha) fail(`Production ${kind} is not serving the new deployment yet`);
      await checkServing('production', kind, observed.serving, fetchImpl);
      return observed;
    } catch (error) {
      // Permission failures are not propagation delays: never retry them.
      if (/\((401|403)\)/.test(String(error?.message)) || attempt === attempts - 1) throw error;
      await pause();
    }
  }
  fail('Deployment did not start serving');
}

export async function deploy({ env = process.env, control, sources, now = Date.now(), fetchImpl = fetch, observe = observeDatabase,
  run = execFileSync, pause = () => new Promise(r => setTimeout(r, 2000)) } = {}) {
  requireOwnerDispatch(env);
  requireTrustedCheckout(control, env.GITHUB_SHA);
  if (!env.VERCEL_TOKEN) fail('Deployment credential required');
  const gh = githubClient(env.GITHUB_TOKEN, fetchImpl), vercel = vercelClient(env.VERCEL_TOKEN, fetchImpl);
  const packet = await loadApprovedPacket({ gh, env, control, fetchImpl, now });
  if (env.TARGET_SHA !== packet.target.sha) fail('Checked-out target differs from the approved packet target');
  verifySingleUse(await listRuns(gh, 'release-deploy.yml', 'event=workflow_dispatch'), env.PACKET_SHA256, env.GITHUB_RUN_ID, Number(env.GITHUB_RUN_ATTEMPT));
  const comment = async (url, line, label) => verifyRecordComment(await gh(`/issues/comments/${parseCommentUrl(url)}`), line, env.PACKET_SHA256, label);
  const approval = await comment(env.APPROVAL_COMMENT_URL, APPROVAL_LINE, 'Owner release approval');
  if (Date.parse(approval.created_at) < Date.parse(packet.created_at)) fail('Approval record predates the packet');
  if (packet.lane.lane === 'full') await comment(env.STAGING_ACCEPTANCE_COMMENT_URL, STAGING_ACCEPTANCE_LINE, 'Owner staging acceptance');

  const lock = loadLock(readFileSync(join(control, 'scripts/release-v3/lock.json'), 'utf8'));
  const migrations = postBootstrapMigrations(control, packet.target.sha, lock, packet.changes.files);
  const m430 = loadM430(readFileSync(join(control, 'scripts/release-v3/m430-identities.json'), 'utf8'), readFileSync(join(control, 'supabase/migrations/430_shared_number_tenant_isolation.sql')));
  for (const kind of KINDS) requireCleanSource(sources[kind], packet.target.sha, packet.target.tree);

  // Staging first: still serving the exact target, database still admitted.
  for (const kind of KINDS) {
    const observed = await observeProject(vercel, 'staging', kind);
    if (observed.serving.sha !== packet.target.sha || hashId(observed.serving.id) !== packet.staging[kind].deployment_sha256) fail(`Staging ${kind} changed since the packet was approved`);
    await checkServing('staging', kind, observed.serving, fetchImpl, env);
  }
  const stagingDb = admitDatabase({ observation: observe('staging', env), lock, migrations, lockMap: loadLockMap(lock.environments.staging, pathToFileURL(`${control}/`)), m430 });
  if (stagingDb.ledger.sha256 !== packet.database.staging.ledger.sha256 || stagingDb.catalog.sha256 !== packet.database.staging.catalog.sha256) fail('Staging database changed since the packet was approved');

  const expected = { merchant: { serving: packet.baseline.merchant.deployment_sha256 }, admin: { serving: packet.baseline.admin.deployment_sha256, targets: [packet.admin_pin.descriptor_sha256] }, merchantDeployed: false };
  const context = { vercel, env, control, packet, lock, migrations, m430, expected, observe };
  const created = {};
  for (const kind of KINDS) {
    await recheckProduction(context);
    const config = PROJECTS.production[kind];
    const output = run('vercel', ['deploy', '--prod', ...(kind === 'admin' ? ['--skip-domain'] : []), '--yes', '--token', env.VERCEL_TOKEN,
      '--meta', `githubCommitSha=${packet.target.sha}`, '--env', `VERCEL_GIT_COMMIT_SHA=${packet.target.sha}`, '--build-env', `VERCEL_GIT_COMMIT_SHA=${packet.target.sha}`],
    { cwd: sources[kind], env: deploymentEnvironment(env, config.project, TEAM, packet.target.sha), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024 });
    const urls = String(output).match(/https:\/\/[a-zA-Z0-9-]+\.vercel\.app/g);
    if (!urls?.length) fail('Deployment URL missing; stop for Owner recovery review');
    const deployment = descriptor(await vercel(`/v13/deployments/${new URL(urls.at(-1)).hostname}`));
    if (deployment.project_id !== config.project || deployment.sha !== packet.target.sha || deployment.ready_state !== 'READY' || deployment.target !== 'production'
      || deployment.source !== 'cli' || !Number.isSafeInteger(deployment.created_at)
      || [packet.baseline[kind].deployment_sha256, packet.admin_pin.deployment_sha256].includes(hashId(deployment.id))) fail(`Created ${kind} deployment is not a new exact-target production deployment; stop for Owner recovery review`);
    created[kind] = deployment;
    if (kind === 'merchant') {
      // Merchant assigns its domains itself (autoAssignCustomDomains).
      await waitForServing(vercel, 'merchant', deployment, fetchImpl, pause);
      expected.merchant.serving = hashId(deployment.id); expected.merchantDeployed = true;
    } else {
      // `--skip-domain` does not move the admin project's production target
      // (run 41937185420: it stayed on the approved pin). Accept exactly the
      // approved pin or this new candidate; anything else is a change.
      expected.admin.targets = [packet.admin_pin.descriptor_sha256, canonicalDigest(deployment)];
      await recheckProduction(context);
      // One alias assignment. No retry, including on an uncertain outcome.
      const assigned = await fetchImpl(`https://api.vercel.com/v2/deployments/${deployment.id}/aliases?teamId=${TEAM}`, {
        method: 'POST', headers: { Authorization: `Bearer ${env.VERCEL_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ alias: config.alias }) });
      if (!assigned.ok) fail(`Admin alias assignment failed (${assigned.status}); candidate kept for Owner recovery review`);
      await waitForServing(vercel, 'admin', deployment, fetchImpl, pause);
      expected.admin.serving = hashId(deployment.id);
    }
  }
  await recheckProduction(context);
  return { schema_version: 1, packet_sha256: env.PACKET_SHA256, target_sha: packet.target.sha,
    merchant_deployment_sha256: hashId(created.merchant.id), admin_deployment_sha256: hashId(created.admin.id), completed_at: new Date().toISOString() };
}

async function main() {
  const command = process.argv[2], control = resolve(process.env.CONTROL_PATH || '.');
  if (command === 'prepare') {
    const out = resolve(process.argv[3] || 'release-packet');
    const packet = await prepare({ control });
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'packet.json'), packetBytes(packet));
    const digest = packetDigest(packet);
    const summary = [`## Release packet (schema 8)`, '', `packet sha256: \`${digest}\``, `target: \`${packet.target.sha}\``, `lane: **${packet.lane.lane}**`,
      `expires: ${packet.expires_at}`, `migrations admitted: ${packet.migrations.map(m => m.name).join(', ') || 'none'}`,
      `pull requests: ${packet.pull_requests.map(p => `#${p.number} (${p.lane})`).join(', ')}`, '',
      'The Owner approves this exact sha256. Deploy with this run ID and the recorded approval comment.'].join('\n');
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
    console.log(summary);
  } else if (command === 'lock-map') {
    const out = resolve(process.argv[3] || 'release-packet');
    mkdirSync(out, { recursive: true });
    for (const [environment, map] of Object.entries(await captureLockMaps({ control }))) writeFileSync(join(out, `lock-catalog-${environment}.json`), canonicalJson(map));
    console.log('Lock catalog maps captured; commit them with a reviewed PR and set catalog_map in scripts/release-v3/lock.json.');
  } else if (command === 'deploy') {
    const record = await deploy({ control, sources: { merchant: resolve(process.argv[3]), admin: resolve(process.argv[4]) } });
    const out = resolve(process.argv[5] || 'release-record');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'record.json'), canonicalJson(record));
    console.log(`Release ${record.target_sha} deployed and verified for merchant and admin.`);
  } else fail('Unknown command');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    // Gate errors carry no secrets; anything else is reported generically.
    console.error(error instanceof GateError ? `Release gate stopped: ${error.message}` : 'Release gate stopped on an unexpected error. No automatic rollback.');
    process.exitCode = 1;
  });
}

// Vercel, GitHub and public-health reads for the Release V3 gate.
// Every call takes an injectable fetch so tests run without network.
// Permission failures (401/403) are never retried and never switched to
// another credential.
import { fail, sha256, DEPLOYMENT_ID, SHA, REPO } from './common.mjs';

export const TEAM = 'team_AEcg69CktrGEptXDznpae8Rp';
export const PROJECTS = Object.freeze({
  production: {
    merchant: { project: 'prj_QkvBTiDA905GHTwX5DQCJVyZzd9d', alias: 'www.waaiio.com', root: '', framework: 'nextjs', health: 'api/health', identity: true, supabase: 'cxcmiqotkowhxinjbytg' },
    admin: { project: 'prj_jr7l0grIW2xE6FxVTy5RwRec1rFt', alias: 'admin.waaiio.com', root: 'admin', framework: 'vite', health: 'login', identity: false },
  },
  staging: {
    merchant: { project: 'prj_h7YmC4fvpxhn429znCy34OjLZ6se', alias: 'staging.waaiio.com', root: '', framework: 'nextjs', health: 'api/health', identity: true, supabase: 'tqjvrzopvtczxfxiwmnz' },
    admin: { project: 'prj_wLF7TDNN7BrjGFyIlen2IR8SvorM', alias: 'admin-staging.waaiio.com', root: 'admin', framework: 'vite', health: 'login', identity: false },
  },
});
// Production project configuration that the gate's deploy commands rely on.
const PRODUCTION_POLICY = {
  merchant: { framework: 'nextjs', autoAssignCustomDomains: true, buildCommand: null, installCommand: null, outputDirectory: null, commandForIgnoringBuildStep: 'exit 0' },
  admin: { framework: 'vite', autoAssignCustomDomains: false, buildCommand: null, installCommand: null, outputDirectory: null, commandForIgnoringBuildStep: null },
};
// Payout hold and channel-operation hold: these server-only switches must stay
// absent from production until a separate Owner decision.
export const HOLD_FLAGS = Object.freeze(['ENABLE_PAYOUTS', 'ENABLE_CHANNEL_ALLOCATION_OPERATIONS']);

export const hashId = id => sha256(`waaiio-deployment:${id}`);

export function vercelClient(token, fetchImpl = fetch) {
  if (!token) fail('Deployment-platform credential required');
  return async path => {
    const response = await fetchImpl(`https://api.vercel.com${path}${path.includes('?') ? '&' : '?'}teamId=${TEAM}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) fail(`Deployment platform read failed (${response.status})`);
    return response.json();
  };
}
export function githubClient(token, fetchImpl = fetch) {
  if (!token) fail('GitHub token required');
  return async path => {
    const response = await fetchImpl(`https://api.github.com${path.startsWith('/repos/') ? '' : `/repos/${REPO}`}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } });
    if (!response.ok) fail(`GitHub read failed (${response.status})`);
    return response.json();
  };
}

export const descriptor = d => ({ id: d.id, project_id: d.projectId, sha: d.meta?.githubCommitSha, ready_state: d.readyState,
  source: d.source, target: d.target ?? null, created_at: d.createdAt, error_link: d.errorLink ?? null });

// Reads one project's serving identity. The admin "pin" is ALWAYS the
// project's targets.production.id (never the newest deployment in a list;
// that mistake failed deploy run 41706465115). This function never lists
// deployments.
export async function observeProject(read, environment, kind) {
  const config = PROJECTS[environment]?.[kind];
  if (!config) fail('Unknown project');
  const project = await read(`/v9/projects/${config.project}`);
  if (project.id !== config.project || (project.rootDirectory || '') !== config.root || project.framework !== config.framework) fail(`${environment} ${kind} project configuration changed`);
  if (environment === 'production') {
    const policy = PRODUCTION_POLICY[kind];
    for (const [key, value] of Object.entries(policy)) if (project[key] !== value) fail(`Production ${kind} project policy changed (${key})`);
  }
  const alias = await read(`/v4/aliases/${config.alias}`);
  const servingId = alias.deploymentId ?? alias.deployment?.id;
  if (!DEPLOYMENT_ID.test(servingId || '')) fail(`Missing ${environment} ${kind} serving deployment`);
  const serving = await read(`/v13/deployments/${servingId}`);
  const targetId = project.targets?.production?.id;
  if (!DEPLOYMENT_ID.test(targetId || '')) fail(`Missing ${environment} ${kind} production target`);
  const target = targetId === servingId ? serving : await read(`/v13/deployments/${targetId}`);
  const s = descriptor(serving), t = descriptor(target);
  if (s.id !== servingId || s.project_id !== config.project || s.ready_state !== 'READY' || !SHA.test(s.sha || '') || !Number.isSafeInteger(s.created_at)) fail(`Unverified ${environment} ${kind} serving deployment`);
  if (t.id !== targetId || t.project_id !== config.project || !Number.isSafeInteger(t.created_at)) fail(`Unverified ${environment} ${kind} production target`);
  return { environment, kind, serving: s, target: t };
}

// Production consistency rules carried over from the reduced gate.
//  - merchant: the production target is the serving deployment, or a newer
//    same-project Git attempt canceled by the ignored-build-step.
//  - admin (manual alias): the production target is the serving deployment, or
//    an OLDER deployment (the alias was moved by the previous release). A newer
//    production target that is not serving is unapproved.
export function checkProductionConsistency(observation) {
  const { kind, serving, target } = observation;
  if (target.id === serving.id) {
    if (target.target !== 'production') fail(`Production ${kind} serving deployment is not a production target`);
    return true;
  }
  if (kind === 'merchant') {
    if (target.ready_state !== 'CANCELED' || target.source !== 'git' || target.created_at <= serving.created_at
      || target.error_link !== 'https://vercel.com/docs/project-configuration/git-settings#ignored-build-step') fail('Unapproved merchant production target divergence');
    return true;
  }
  if (target.ready_state !== 'READY' || target.source !== 'cli' || target.created_at >= serving.created_at) fail('Unapproved admin production target (newer than serving)');
  return true;
}

// Hold flags must not exist for production in the project environment.
export async function observeHoldFlags(read, kind) {
  const config = PROJECTS.production[kind];
  const result = await read(`/v10/projects/${config.project}/env`);
  if (!Array.isArray(result?.envs)) fail('Project environment listing unavailable');
  const present = result.envs.filter(e => HOLD_FLAGS.includes(e?.key) && (Array.isArray(e.target) ? e.target : [e.target]).includes('production')).map(e => e.key).sort();
  return { kind, hold_flags_absent: present.length === 0, present };
}

// Staging admin is behind Vercel's login. Only that check carries Vercel's
// automation bypass secret; production and the merchant sites never get it.
export async function checkServing(environment, kind, expected, fetchImpl = fetch, env = process.env) {
  const config = PROJECTS[environment][kind];
  const stagingAdmin = environment === 'staging' && kind === 'admin';
  const bypass = stagingAdmin ? (env.VERCEL_ADMIN_STAGING_BYPASS || '') : '';
  // Vercel's login answers with a redirect to its sign-in page (which
  // `redirect: 'error'` rejects) or a 401. Say which secret is wrong; leave
  // every other error (DNS, TLS, timeouts) as it is.
  const loginBlocked = () => fail(bypass
    ? 'staging admin rejected VERCEL_ADMIN_STAGING_BYPASS (check or rotate it)'
    : 'staging admin needs VERCEL_ADMIN_STAGING_BYPASS (Vercel login is on)');
  let health;
  try {
    health = await fetchImpl(`https://${config.alias}/${config.health}`, { redirect: 'error', cache: 'no-store', ...(bypass ? { headers: { 'x-vercel-protection-bypass': bypass } } : {}) });
  } catch (error) {
    if (stagingAdmin && /redirect/i.test(String(error?.cause?.message || ''))) loginBlocked();
    throw error;
  }
  if (health.status === 401 && stagingAdmin) loginBlocked();
  if (health.status !== 200) fail(`${environment} ${kind} public health failed (${health.status})`);
  if (!config.identity) return true;
  const response = await fetchImpl(`https://${config.alias}/api/release-identity`, { redirect: 'error', cache: 'no-store' });
  if (response.status !== 200) fail(`${environment} ${kind} runtime identity unavailable (${response.status})`);
  const identity = await response.json();
  // The database project too: a production build pointed at staging (or the
  // reverse) stops here.
  if (identity.sha !== expected.sha || identity.projectId !== config.project || identity.deploymentId !== expected.id || identity.vercelEnv !== 'production'
    || identity.supabaseProjectRef !== config.supabase) fail(`${environment} ${kind} runtime identity mismatch`);
  return true;
}

// Exact push-to-main CI on the exact SHA (newest run must be a success).
export function validateMainCI(payload, sha) {
  const runs = Array.isArray(payload?.workflow_runs) ? payload.workflow_runs.filter(r => r.head_sha === sha && r.head_branch === 'main' && r.event === 'push' && r.path === '.github/workflows/ci.yml').sort((a, b) => b.id - a.id) : [];
  if (!runs.length || runs[0].status !== 'completed' || runs[0].conclusion !== 'success') fail('Green exact push-to-main CI is required for the target');
  return { run_id: runs[0].id, run_attempt: runs[0].run_attempt };
}
// Every push-main CI job must succeed, and these must be present by name. The
// migration shards and the security ACL job run the payment-authority, payment
// confirmation and staging-payment-parity suites for both custody routes.
export const REQUIRED_CI_JOBS = Object.freeze([
  'Admin App (install, build)', 'Admin business saves (disposable PG)', 'Catalog oracle (PostgreSQL 17)', 'Dependency audit',
  'Engage segments ACL tests (disposable PG)', 'Engineering governance', 'Main App (lint, test, build)', 'Migration validation',
  'Migration validation (shard a)', 'Migration validation (shard b)', 'P0 security ACL tests (disposable PG)', 'Playwright smoke tests',
  'Private storage authorization (disposable PG)', 'Release Gate V2 Phase 1 — Tooling Self-Test', 'Secret scanning',
]);
export function validateJobs(payload) {
  if (!Array.isArray(payload?.jobs) || payload.total_count !== payload.jobs.length || !payload.jobs.length) fail('CI job evidence incomplete');
  const bad = payload.jobs.filter(j => j.conclusion !== 'success');
  if (bad.length) fail(`CI jobs not successful: ${bad.map(j => j.name).sort().join(', ')}`);
  const names = payload.jobs.map(j => j.name);
  const missing = REQUIRED_CI_JOBS.filter(name => names.filter(n => n === name).length !== 1);
  if (missing.length) fail(`Required CI jobs missing: ${missing.join(', ')}`);
  return names.sort();
}

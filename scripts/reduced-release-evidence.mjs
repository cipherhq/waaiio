import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export const PAYOUT_POLICY = 'admin-payout-mfa-v1';
export const ACCOUNTING_POLICY = 'accounting-hold-v1';
const recognized = m => (m?.schema_version === 2 && m.policy === PAYOUT_POLICY) || (m?.schema_version === 3 && m.policy === ACCOUNTING_POLICY);
export const SCHEMA_MAX_AGE_MS = 15 * 60 * 1000;
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^dpl_[A-Za-z0-9]+$/;
const fail = message => { throw new Error(message); };
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

// The manifest is immutable before acceptance. Reports bind its raw bytes;
// the manifest never contains a report digest (which would be circular).
export function manifestBinding(raw, manifest) {
  if (!nonempty(raw) || !isDeepStrictEqual(JSON.parse(raw), manifest)
    || !recognized(manifest)
    || !SHA.test(manifest.integration_sha || '')
    || 'acceptance_sha256' in manifest || 'acceptance_report_sha256' in manifest) fail('Invalid immutable release manifest');
  return {
    policy: manifest.policy, integration_sha: manifest.integration_sha,
    manifest_sha256: digest(raw),
    projects: Object.fromEntries(['merchant', 'admin'].map(kind => {
      const p = manifest.projects?.[kind];
      if (!p || !SHA.test(p.baseline_sha || '') || !SHA.test(p.target_sha || '')
        || !SHA.test(p.target_tree || '') || !ID.test(p.baseline_deployment_id || '')) fail('Incomplete release project binding');
      return [kind, { project_id: p.project_id, baseline_sha: p.baseline_sha,
        baseline_deployment_id: p.baseline_deployment_id, target_sha: p.target_sha, target_tree: p.target_tree }];
    })),
  };
}

// This validates independently approved, connector-produced evidence. It does
// not query production or claim that a snapshot is continuous observation.
// policy is imported from reviewed trusted code by the caller, never supplied
// by a manifest, workflow input, or acceptance report.
export function verifyPrivateEvidence({ rawManifest, manifest, receiptBytes, reportBytes, approvedHash, policy, now = Date.now() }) {
  const binding = manifestBinding(rawManifest, manifest);
  if (!policy || policy.id !== manifest.policy || !HASH.test(policy.schema_contract_sha256 || '')
    || !Array.isArray(policy.acceptance_cases) || !policy.acceptance_cases.length) fail('Reviewed release policy is incomplete');
  if (!nonempty(receiptBytes) || !nonempty(reportBytes) || !HASH.test(approvedHash || '')
    || digest(reportBytes) !== approvedHash) fail('Independent private report digest mismatch');
  let receipt, report;
  try { receipt = JSON.parse(receiptBytes); report = JSON.parse(reportBytes); }
  catch { fail('Malformed private release evidence'); }
  for (const value of [receipt, report]) {
    if (value.schema_version !== manifest.schema_version || !isDeepStrictEqual(value.binding, binding)) fail('Private evidence release binding mismatch');
  }
  if (receipt.acceptance_artifact_sha256 !== approvedHash
    || !nonempty(receipt.owner_approval_reference)
    || !nonempty(report.independent_review?.reviewer)
    || !nonempty(report.independent_review?.reference)
    || !nonempty(report.owner_acceptance_reference)) fail('Private evidence approval provenance incomplete');
  const verification = report.code_verification;
  if (!verification || !/^[0-9]+$/.test(verification.run_id || '')
    || !Number.isSafeInteger(verification.run_attempt) || verification.run_attempt < 1
    || !isDeepStrictEqual(receipt.code_verification, verification)) fail('Private evidence verification run mismatch');

  const schema = report.production_schema;
  const observed = Date.parse(schema?.observed_at), approved = Date.parse(receipt.approved_at);
  if (!Number.isFinite(now) || !Number.isFinite(observed) || !Number.isFinite(approved)
    || observed > now || approved > now || approved < observed || now - observed > SCHEMA_MAX_AGE_MS
    || schema.project_ref !== policy.production_project_ref
    || schema.contract_sha256 !== policy.schema_contract_sha256
    || !isDeepStrictEqual(schema.contracts, policy.schema_contracts)
    || schema.business_mutations !== 0 || schema.provider_calls !== 0
    || schema.method !== 'authorized-connector-read-only'
    || !HASH.test(schema.raw_evidence_sha256 || '')) fail('Production schema snapshot is unapproved, stale, or incompatible');
  if (policy.require_disabled_payout_cron) {
    const cron = report.production_schema.payout_cron;
    if (!cron || cron.enabled !== false || cron.project_flag !== 'disabled' || cron.runtime_flag !== 'disabled' || cron.build_flag !== 'disabled'
      || cron.serving_deployment_id !== manifest.projects.merchant.baseline_deployment_id
      || !HASH.test(cron.evidence_sha256 || '')) fail('Current serving payout cron state is unproven');
  }
  if (!isDeepStrictEqual(report.production_baselines, Object.fromEntries(Object.entries(binding.projects).map(([kind, p]) =>
    [kind, { project_id: p.project_id, sha: p.baseline_sha, deployment_id: p.baseline_deployment_id }])))) fail('Private evidence baseline identity mismatch');

  const acceptance = report.staging_acceptance;
  const start = Date.parse(acceptance?.started_at), end = Date.parse(acceptance?.completed_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || end > now || approved < end
    || !nonempty(acceptance.runner?.name) || !nonempty(acceptance.runner?.command)
    || !nonempty(acceptance.runner?.run_id)
    || acceptance.business_mutations !== 0 || acceptance.provider_calls !== 0
    || acceptance.failed !== 0 || acceptance.skipped !== 0
    || !Array.isArray(acceptance.cases) || acceptance.passed !== policy.acceptance_cases.length
    || acceptance.cases.length !== policy.acceptance_cases.length) fail('Private acceptance incomplete or outside mutation scope');
  if (acceptance.security_state_writes !== 0 &&
    (acceptance.security_state_writes !== 'owner-authorized-auth-only' || !nonempty(acceptance.security_write_authorization))) fail('Unapproved security-state writes');
  for (const [kind, project] of Object.entries(binding.projects)) {
    const stage = acceptance.deployments?.[kind], expected = policy.staging_projects?.[kind];
    if (!expected || !stage || stage.project_id !== expected.project_id
      || stage.supabase_project_ref !== expected.supabase_project_ref
      || stage.sha !== project.target_sha || stage.tree !== project.target_tree
      || !ID.test(stage.deployment_id || '') || !HASH.test(stage.identity_evidence_sha256 || '')) fail('Private acceptance source/deployment mismatch');
  }
  for (const expected of policy.acceptance_cases) {
    const matches = acceptance.cases.filter(item => item?.id === expected.id);
    if (matches.length !== 1 || matches[0].outcome !== 'passed'
      || !isDeepStrictEqual(matches[0].observed, expected.observed)
      || !HASH.test(matches[0].evidence_sha256 || '')) fail('Private acceptance case missing or failed');
  }
  return { binding, verification, schema_observed_at: observed, approved_report_sha256: approvedHash };
}

export function deploymentEnvironment(env, projectId, teamId, targetSha) {
  if (!env.VERCEL_TOKEN || !SHA.test(targetSha)) fail('Missing deployment identity or credential');
  return { PATH: env.PATH, HOME: env.HOME, CI: 'true', VERCEL_TOKEN: env.VERCEL_TOKEN,
    VERCEL_ORG_ID: teamId, VERCEL_PROJECT_ID: projectId,
    GITHUB_SHA: targetSha, VERCEL_GIT_COMMIT_SHA: targetSha };
}

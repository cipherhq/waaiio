/**
 * Release Gate V2 — Release Certificate Generator
 *
 * Generates a release certificate artifact from baseline snapshots
 * and state diffs. The certificate is the authoritative record of
 * what was verified, what changed, and what the verdict is.
 *
 * Automation produces the certificate. CTO independently reviews it.
 * Owner remains final business authority. Claude cannot self-certify.
 *
 * @see RELEASE_GATE_V2.md §5 (Exact-SHA Certification)
 */

import { randomUUID } from 'crypto';
import type {
  BaselineSnapshot,
  StateDiffResult,
  ReleaseCertificate,
} from './types';
import { getCriticalInvariants } from './invariant-registry';

export function generateCertificate(opts: {
  releaseSha: string;
  deploymentId?: string;
  preBaseline: BaselineSnapshot;
  candidateBaseline?: BaselineSnapshot;
  postBaseline?: BaselineSnapshot;
  preToCandidateDiff?: StateDiffResult;
  preToPostDiff?: StateDiffResult;
  migrationsApplied: string[];
  /** Commit actually checked out and tested */
  testedCommitSha?: string;
  /** GitHub's synthetic merge SHA (PR events only) */
  mergeSha?: string;
  /** Certificate kind — determines scope derivation */
  kind?: ReleaseCertificate['kind'];
}): ReleaseCertificate {
  const {
    releaseSha,
    deploymentId,
    preBaseline,
    candidateBaseline,
    postBaseline,
    preToCandidateDiff,
    preToPostDiff,
    migrationsApplied,
    testedCommitSha,
    mergeSha,
    kind = 'release_candidate',
  } = opts;

  // Compute invariant summary — criticality is REGISTRY-AUTHORITATIVE
  const latestBaseline = postBaseline || candidateBaseline || preBaseline;
  const invariantResults = latestBaseline.invariant_results;
  const registryCriticalIds = new Set(getCriticalInvariants().map(i => i.id));
  const invariantSummary = {
    total: invariantResults.length,
    passed: invariantResults.filter(r => r.status === 'pass').length,
    failed: invariantResults.filter(r => r.status === 'fail' || r.status === 'error').length,
    critical_failed: invariantResults.filter(r =>
      (r.status === 'fail' || r.status === 'error') && registryCriticalIds.has(r.invariant_id)
    ).length,
  };

  // Compute journey summary
  const journeyResults = latestBaseline.journey_results;
  const journeySummary = {
    total: journeyResults.length,
    passed: journeyResults.filter(r => r.status === 'pass').length,
    failed: journeyResults.filter(r => r.status === 'fail' || r.status === 'error').length,
  };

  // Determine block reasons
  const blockReasons: string[] = [];

  if (invariantSummary.critical_failed > 0) {
    blockReasons.push(`${invariantSummary.critical_failed} critical invariant(s) failed`);
  }

  if (preToCandidateDiff?.verdict === 'BLOCKED') {
    blockReasons.push(`Pre→Candidate diff BLOCKED: ${preToCandidateDiff.block_reasons.join('; ')}`);
  }

  if (preToPostDiff?.verdict === 'BLOCKED') {
    blockReasons.push(`Pre→Post diff BLOCKED: ${preToPostDiff.block_reasons.join('; ')}`);
  }

  const status = blockReasons.length > 0 ? 'BLOCKED' : 'PENDING_REVIEW';

  // Derive scope based on certificate kind
  const baseline = candidateBaseline || preBaseline;
  const scope = kind === 'self_test'
    ? {
        // Self-test: no real evidence for any surface
        functions: false,
        function_grants: false,
        table_rls: false,
        rls_policies: false,
        constraints: false,
        triggers: false,
        extensions: false,
        cron_jobs: false,
        invariants: false,
        journeys: false,
      }
    : {
        // Release candidate / post-deployment: derive from baseline data
        functions: baseline.functions.length > 0,
        function_grants: baseline.function_grants.length > 0,
        table_rls: baseline.table_rls.length > 0,
        rls_policies: false,   // Phase 2
        constraints: false,     // Phase 2
        triggers: false,        // Phase 2
        extensions: false,      // Phase 2
        cron_jobs: false,       // Phase 2
        invariants: baseline.invariant_results.length > 0,
        journeys: false,        // Phase 2
      };

  return {
    id: randomUUID(),
    issued_at: new Date().toISOString(),
    release_sha: releaseSha,
    tested_commit_sha: testedCommitSha || null,
    merge_sha: mergeSha || null,
    kind,
    deployment_id: deploymentId || null,
    pre_deployment_baseline_id: preBaseline.id,
    candidate_baseline_id: candidateBaseline?.id || null,
    post_deployment_baseline_id: postBaseline?.id || null,
    migrations_applied: migrationsApplied,
    pre_to_candidate_diff: preToCandidateDiff || null,
    pre_to_post_diff: preToPostDiff || null,
    invariant_summary: invariantSummary,
    invariant_details: invariantResults.map(r => ({
      invariant_id: r.invariant_id,
      description: r.description,
      status: r.status,
      evidence: r.evidence,
      critical: r.critical,
    })),
    journey_summary: journeySummary,
    scope,
    provider_checks: [],
    status,
    block_reasons: blockReasons,
    requires_cto_review: true,
    requires_owner_authorization: true,
    cto_review_sha: null,
    owner_authorization: null,
  };
}

/**
 * Format a certificate as a human-readable report.
 */
export function formatCertificate(cert: ReleaseCertificate): string {
  const lines: string[] = [];

  const kindLabel = {
    self_test: 'SELF-TEST (no real evidence)',
    release_candidate: 'RELEASE CANDIDATE',
    post_deployment: 'POST-DEPLOYMENT VERIFICATION',
  }[cert.kind] || cert.kind;

  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push(`RELEASE GATE V2 — RELEASE CERTIFICATE [${kindLabel}]`);
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('');
  lines.push(`Certificate ID:  ${cert.id}`);
  lines.push(`Issued:          ${cert.issued_at}`);
  lines.push(`Kind:            ${kindLabel}`);
  lines.push(`Release SHA:     ${cert.release_sha}`);
  lines.push(`Tested Commit:   ${cert.tested_commit_sha || 'N/A'}`);
  lines.push(`Merge SHA:       ${cert.merge_sha || 'N/A'}`);
  lines.push(`Deployment:      ${cert.deployment_id || 'N/A'}`);
  lines.push(`Status:          ${cert.status}`);
  lines.push('');

  lines.push('── Baselines ──');
  lines.push(`Pre-deployment:  ${cert.pre_deployment_baseline_id}`);
  lines.push(`Candidate:       ${cert.candidate_baseline_id || 'N/A'}`);
  lines.push(`Post-deployment: ${cert.post_deployment_baseline_id || 'N/A'}`);
  lines.push('');

  lines.push('── Migrations Applied ──');
  if (cert.migrations_applied.length === 0) {
    lines.push('  (none)');
  } else {
    for (const m of cert.migrations_applied) {
      lines.push(`  ${m}`);
    }
  }
  lines.push('');

  lines.push('── Verified Scope ──');
  const checkedSurfaces = Object.entries(cert.scope)
    .filter(([, v]) => v).map(([k]) => k);
  const uncheckedSurfaces = Object.entries(cert.scope)
    .filter(([, v]) => !v).map(([k]) => k);
  lines.push(`Checked:   ${checkedSurfaces.join(', ')}`);
  if (uncheckedSurfaces.length > 0) {
    lines.push(`NOT checked (Phase 2): ${uncheckedSurfaces.join(', ')}`);
  }
  lines.push('');

  lines.push('── Invariant Gate ──');
  lines.push(`Total: ${cert.invariant_summary.total}  Passed: ${cert.invariant_summary.passed}  Failed: ${cert.invariant_summary.failed}  Critical Failed: ${cert.invariant_summary.critical_failed}`);
  lines.push('');

  if (cert.invariant_details && cert.invariant_details.length > 0) {
    lines.push('── Invariant Details ──');
    for (const inv of cert.invariant_details) {
      const statusIcon = inv.status === 'pass' ? 'PASS' :
        inv.status === 'fail' ? 'FAIL' :
        inv.status === 'error' ? 'ERROR' :
        inv.status === 'skip' ? 'SKIP' :
        inv.status === 'not_applicable' ? 'N/A' : inv.status;
      const criticalTag = inv.critical ? ' [CRITICAL]' : '';
      const truncatedEvidence = inv.evidence.length > 120
        ? inv.evidence.substring(0, 117) + '...'
        : inv.evidence;
      lines.push(`  ${inv.invariant_id}: ${statusIcon}${criticalTag} — ${inv.description}`);
      lines.push(`    Evidence: ${truncatedEvidence}`);
    }
    lines.push('');
  }

  lines.push('── Journey Gate ──');
  lines.push(`Total: ${cert.journey_summary.total}  Passed: ${cert.journey_summary.passed}  Failed: ${cert.journey_summary.failed}`);
  lines.push('');

  if (cert.pre_to_candidate_diff) {
    const d = cert.pre_to_candidate_diff;
    lines.push('── State Diff: Pre → Candidate ──');
    lines.push(`Verdict: ${d.verdict}`);
    lines.push(`Total: ${d.summary.total}  Expected: ${d.summary.expected}  Unexpected: ${d.summary.unexpected}  Improved: ${d.summary.improved}  Regressions: ${d.summary.regressions}`);
    if (d.block_reasons.length > 0) {
      lines.push('Block reasons:');
      for (const r of d.block_reasons) {
        lines.push(`  ❌ ${r}`);
      }
    }
    lines.push('');
  }

  if (cert.block_reasons.length > 0) {
    lines.push('── BLOCK REASONS ──');
    for (const r of cert.block_reasons) {
      lines.push(`  ❌ ${r}`);
    }
    lines.push('');
  }

  lines.push('── Authorization ──');
  lines.push(`CTO Review Required:     ${cert.requires_cto_review ? 'YES' : 'NO'}`);
  lines.push(`CTO Review SHA:          ${cert.cto_review_sha || 'PENDING'}`);
  lines.push(`Owner Authorization:     ${cert.requires_owner_authorization ? 'REQUIRED' : 'N/A'}`);
  lines.push(`Owner Decision:          ${cert.owner_authorization || 'PENDING'}`);
  lines.push('');
  lines.push('═══════════════════════════════════════════════════════════════');

  return lines.join('\n');
}

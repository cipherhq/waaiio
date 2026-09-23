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

export function generateCertificate(opts: {
  releaseSha: string;
  deploymentId?: string;
  preBaseline: BaselineSnapshot;
  candidateBaseline?: BaselineSnapshot;
  postBaseline?: BaselineSnapshot;
  preToCandidateDiff?: StateDiffResult;
  preToPostDiff?: StateDiffResult;
  migrationsApplied: string[];
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
  } = opts;

  // Compute invariant summary from the most recent baseline
  const latestBaseline = postBaseline || candidateBaseline || preBaseline;
  const invariantResults = latestBaseline.invariant_results;
  const invariantSummary = {
    total: invariantResults.length,
    passed: invariantResults.filter(r => r.status === 'pass').length,
    failed: invariantResults.filter(r => r.status === 'fail' || r.status === 'error').length,
    critical_failed: invariantResults.filter(r =>
      (r.status === 'fail' || r.status === 'error') && r.critical
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

  return {
    id: randomUUID(),
    issued_at: new Date().toISOString(),
    release_sha: releaseSha,
    deployment_id: deploymentId || null,
    pre_deployment_baseline_id: preBaseline.id,
    candidate_baseline_id: candidateBaseline?.id || null,
    post_deployment_baseline_id: postBaseline?.id || null,
    migrations_applied: migrationsApplied,
    pre_to_candidate_diff: preToCandidateDiff || null,
    pre_to_post_diff: preToPostDiff || null,
    invariant_summary: invariantSummary,
    journey_summary: journeySummary,
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

  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('RELEASE GATE V2 — RELEASE CERTIFICATE');
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('');
  lines.push(`Certificate ID:  ${cert.id}`);
  lines.push(`Issued:          ${cert.issued_at}`);
  lines.push(`Release SHA:     ${cert.release_sha}`);
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

  lines.push('── Invariant Gate ──');
  lines.push(`Total: ${cert.invariant_summary.total}  Passed: ${cert.invariant_summary.passed}  Failed: ${cert.invariant_summary.failed}  Critical Failed: ${cert.invariant_summary.critical_failed}`);
  lines.push('');

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

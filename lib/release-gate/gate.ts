/**
 * Release Gate V2 — Gate Orchestrator
 *
 * Chains the full release gate sequence:
 *   1. Validate SHA freshness
 *   2. Capture/accept BEFORE baseline (known-good production state)
 *   3. Capture/accept CANDIDATE baseline (release candidate state)
 *   4. Compute BEFORE → CANDIDATE diff
 *   5. Apply release manifest (expected changes)
 *   6. Generate release certificate
 *   7. Return PASS / BLOCKED verdict
 *
 * Optionally: capture POST baseline after deployment and compute
 * BEFORE → POST diff to verify deployment fidelity.
 *
 * This orchestrator is the single entry point for automated release
 * certification. It produces objective evidence; CTO reviews it;
 * Owner authorizes. Claude cannot self-certify.
 *
 * @see RELEASE_GATE_V2.md §8 (State Diff & Regression Baseline)
 */

import type {
  BaselineSnapshot,
  ReleaseManifest,
  ReleaseCertificate,
  StateDiffResult,
  InvariantResult,
} from './types';
import { computeStateDiff } from './diff-engine';
import { generateCertificate, formatCertificate } from './certificate';
import { validateEvidenceChain, validateBaselineSha } from './sha-guard';
import { getCriticalInvariants } from './invariant-registry';

// ═══════════════════════════════════════════════════════════════════
// Gate Result
// ═══════════════════════════════════════════════════════════════════

export interface GateResult {
  /** Final verdict */
  verdict: 'PASS' | 'BLOCKED';
  /** Block reasons if any */
  block_reasons: string[];
  /** The generated release certificate */
  certificate: ReleaseCertificate;
  /** Formatted human-readable certificate */
  certificate_text: string;
  /** Pre → Candidate state diff */
  pre_to_candidate_diff: StateDiffResult;
  /** Pre → Post state diff (if post-deployment baseline provided) */
  pre_to_post_diff: StateDiffResult | null;
  /** Evidence chain validation result */
  evidence_chain_valid: boolean;
  evidence_chain_errors: string[];
}

// ═══════════════════════════════════════════════════════════════════
// Gate Execution
// ═══════════════════════════════════════════════════════════════════

export interface GateInput {
  /** The SHA being released */
  releaseSha: string;
  /** The SHA currently in production */
  productionSha: string;
  /** Known-good production state */
  preBaseline: BaselineSnapshot;
  /** Release candidate state (after migrations applied to composed DB) */
  candidateBaseline: BaselineSnapshot;
  /** Actual deployed state — optional, for post-deployment verification */
  postBaseline?: BaselineSnapshot;
  /** Declared expected changes */
  manifest?: ReleaseManifest;
  /** Migrations included in this release */
  migrationsApplied?: string[];
  /** Deployment ID (Vercel, etc.) */
  deploymentId?: string;
  /** Current time for staleness checks */
  now?: Date;
  /** Certificate kind — determines scope derivation */
  kind?: ReleaseCertificate['kind'];
  /** Commit actually checked out and tested */
  testedCommitSha?: string;
  /** GitHub's synthetic merge SHA (PR events only) */
  mergeSha?: string;
}

/**
 * Execute the full release gate.
 *
 * Returns a structured result with verdict, certificate, diffs,
 * and evidence chain validation.
 */
export function executeGate(input: GateInput): GateResult {
  const {
    releaseSha,
    productionSha,
    preBaseline,
    candidateBaseline,
    postBaseline,
    manifest,
    migrationsApplied = [],
    deploymentId,
  } = input;
  const now = input.now || new Date();

  const blockReasons: string[] = [];

  // ─── Step 1: Validate SHA freshness ───
  const evidenceChain = validateEvidenceChain({
    releaseSha,
    productionSha,
    preBaseline,
    candidateBaseline,
    preToCandidateDiff: undefined, // Not yet computed
    now,
  });

  if (!evidenceChain.valid) {
    blockReasons.push(...evidenceChain.errors);
  }

  // ─── Step 1b: Validate manifest SHA alignment ───
  if (manifest) {
    if (manifest.base_sha !== productionSha) {
      blockReasons.push(
        `Manifest base_sha (${manifest.base_sha}) does not match production SHA (${productionSha}). Stale manifest.`
      );
    }
    if (manifest.candidate_sha !== releaseSha) {
      blockReasons.push(
        `Manifest candidate_sha (${manifest.candidate_sha}) does not match release SHA (${releaseSha}). Stale manifest.`
      );
    }
  }

  // ─── Step 2: Compute BEFORE → CANDIDATE diff ───
  const preToCandidateDiff = computeStateDiff(preBaseline, candidateBaseline, manifest || null);

  if (preToCandidateDiff.verdict === 'BLOCKED') {
    blockReasons.push(...preToCandidateDiff.block_reasons);
  }

  // ─── Step 3: Compute BEFORE → POST diff (if post-deployment) ───
  let preToPostDiff: StateDiffResult | null = null;

  if (postBaseline) {
    // Validate post-baseline SHA matches the release and phase is 'post_deployment'
    const postValidation = validateBaselineSha(postBaseline, releaseSha, now, 'post_deployment');
    if (!postValidation.valid) {
      blockReasons.push(...postValidation.errors);
    }

    preToPostDiff = computeStateDiff(preBaseline, postBaseline, manifest || null);

    if (preToPostDiff.verdict === 'BLOCKED') {
      blockReasons.push(...preToPostDiff.block_reasons.map(r => `[POST-DEPLOY] ${r}`));
    }

    // ─── Step 3b: Verify deployment fidelity ───
    // Candidate and post baselines should be identical for catalog state.
    // Any divergence means the deployment didn't match the candidate.
    const candidateToPostDiff = computeStateDiff(candidateBaseline, postBaseline);
    const deploymentDivergence = candidateToPostDiff.entries.filter(e =>
      e.category !== 'invariant' && e.category !== 'journey'
    );
    if (deploymentDivergence.length > 0) {
      blockReasons.push(
        `Deployment divergence: ${deploymentDivergence.length} catalog difference(s) ` +
        `between candidate and post-deployment state`
      );
    }
  }

  // ─── Step 4: Check candidate invariants (registry-authoritative criticality) ───
  // Criticality comes from the REGISTRY, never from result payloads.
  // A result that says critical:false for a registry-critical invariant is
  // treated as a metadata mismatch — the registry wins.
  const criticalInvariants = getCriticalInvariants();
  const candidateInvariantMap = new Map(
    candidateBaseline.invariant_results.map(r => [r.invariant_id, r])
  );
  const certKind = input.kind || 'release_candidate';

  for (const inv of criticalInvariants) {
    const result = candidateInvariantMap.get(inv.id);

    if (!result) {
      blockReasons.push(
        `Critical invariant ${inv.id} ("${inv.description}") missing from candidate baseline — no evidence captured`
      );
      continue;
    }

    // Flag metadata mismatch (result says non-critical, registry says critical)
    if (!result.critical) {
      blockReasons.push(
        `Critical invariant ${inv.id}: result metadata says critical=false but registry says critical=true — metadata mismatch, treating as critical`
      );
    }

    // Check status — registry criticality is authoritative
    if (result.status === 'fail' || result.status === 'error') {
      blockReasons.push(`Critical invariant ${inv.id} FAILED: ${result.evidence}`);
    } else if (result.status === 'skip') {
      blockReasons.push(
        `Critical invariant ${inv.id} ("${inv.description}") has status 'skip' — critical invariants must produce real evidence`
      );
    } else if (result.status === 'not_applicable') {
      // Validate N/A against registry applicability policy
      const requiredFor = inv.required_for || ['release_candidate'];
      if (requiredFor.includes(certKind)) {
        // This invariant is REQUIRED for this certificate kind — N/A is not allowed
        const reason = (result as { na_reason?: string }).na_reason || 'no reason provided';
        blockReasons.push(
          `Critical invariant ${inv.id} ("${inv.description}") declared not_applicable but registry requires it for ${certKind} — reason: "${reason}". Not_applicable is not a valid bypass for required invariants.`
        );
      }
      // If not required for this kind, N/A is acceptable but disclosed
    }
    // pass → acceptable
  }

  // ─── Step 5: Generate certificate ───
  const certificate = generateCertificate({
    releaseSha,
    deploymentId,
    preBaseline,
    candidateBaseline,
    postBaseline,
    preToCandidateDiff,
    preToPostDiff: preToPostDiff || undefined,
    migrationsApplied,
    kind: input.kind,
    testedCommitSha: input.testedCommitSha,
    mergeSha: input.mergeSha,
  });

  // Override certificate status with our comprehensive block reasons
  if (blockReasons.length > 0) {
    (certificate as { status: string }).status = 'BLOCKED';
    (certificate as { block_reasons: string[] }).block_reasons = blockReasons;
  }

  const certificateText = formatCertificate(certificate);

  return {
    verdict: blockReasons.length > 0 ? 'BLOCKED' : 'PASS',
    block_reasons: blockReasons,
    certificate,
    certificate_text: certificateText,
    pre_to_candidate_diff: preToCandidateDiff,
    pre_to_post_diff: preToPostDiff,
    evidence_chain_valid: evidenceChain.valid,
    evidence_chain_errors: evidenceChain.errors,
  };
}

/**
 * Release Gate V2 — Exact-SHA & Stale-Evidence Guard
 *
 * Enforces that release evidence (baselines, diffs, certificates) is
 * bound to the exact SHA it was produced for and cannot be reused
 * for a different or newer SHA.
 *
 * Stale evidence is evidence whose SHA does not match the current
 * release candidate. This can happen when:
 * - New commits are pushed after CI ran
 * - A baseline was captured before a rebase
 * - A certificate was generated for a prior SHA
 *
 * @see RELEASE_GATE_V2.md §5.2 (Stale Evidence)
 */

import type { BaselineSnapshot, StateDiffResult, ReleaseCertificate } from './types';

// ═══════════════════════════════════════════════════════════════════
// Staleness detection
// ═══════════════════════════════════════════════════════════════════

export interface ShaValidation {
  valid: boolean;
  errors: string[];
}

/**
 * Maximum age for evidence before it is considered stale.
 * A baseline older than this cannot certify a release.
 */
const MAX_EVIDENCE_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Validate that a baseline was captured for the expected SHA
 * and is not too old.
 */
export function validateBaselineSha(
  baseline: BaselineSnapshot,
  expectedSha: string,
  now: Date = new Date(),
  expectedPhase?: BaselineSnapshot['phase'],
): ShaValidation {
  const errors: string[] = [];

  // SHA must match exactly
  if (baseline.git_sha !== expectedSha) {
    errors.push(
      `Baseline SHA mismatch: baseline was captured for ${baseline.git_sha}, ` +
      `but release candidate is ${expectedSha}. Evidence is stale.`
    );
  }

  // Phase must match if specified
  if (expectedPhase && baseline.phase !== expectedPhase) {
    errors.push(
      `Baseline phase mismatch: expected '${expectedPhase}', ` +
      `but baseline has phase '${baseline.phase}'. Wrong baseline type.`
    );
  }

  // Check age
  const capturedAt = new Date(baseline.captured_at);
  const ageMs = now.getTime() - capturedAt.getTime();
  if (ageMs > MAX_EVIDENCE_AGE_MS) {
    const ageHours = Math.round(ageMs / (60 * 60 * 1000));
    errors.push(
      `Baseline is ${ageHours}h old (captured ${baseline.captured_at}). ` +
      `Evidence older than 24h cannot certify a release.`
    );
  }

  if (ageMs < 0) {
    errors.push(`Baseline captured_at is in the future: ${baseline.captured_at}`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate that a state diff was computed between the expected SHAs.
 */
export function validateDiffShas(
  diff: StateDiffResult,
  expectedBeforeSha: string,
  expectedAfterSha: string,
): ShaValidation {
  const errors: string[] = [];

  if (diff.before_sha !== expectedBeforeSha) {
    errors.push(
      `Diff before-SHA mismatch: diff uses ${diff.before_sha}, ` +
      `but expected ${expectedBeforeSha}`
    );
  }

  if (diff.after_sha !== expectedAfterSha) {
    errors.push(
      `Diff after-SHA mismatch: diff uses ${diff.after_sha}, ` +
      `but expected ${expectedAfterSha}`
    );
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate that a release certificate is for the exact release SHA
 * and that its evidence chain is internally consistent.
 */
export function validateCertificateSha(
  cert: ReleaseCertificate,
  expectedReleaseSha: string,
  now: Date = new Date(),
): ShaValidation {
  const errors: string[] = [];

  // Certificate must be for the exact SHA
  if (cert.release_sha !== expectedReleaseSha) {
    errors.push(
      `Certificate SHA mismatch: certificate is for ${cert.release_sha}, ` +
      `but release candidate is ${expectedReleaseSha}. ` +
      `A certificate from a prior SHA cannot certify a newer release.`
    );
  }

  // Check certificate age
  const issuedAt = new Date(cert.issued_at);
  const ageMs = now.getTime() - issuedAt.getTime();
  if (ageMs > MAX_EVIDENCE_AGE_MS) {
    const ageHours = Math.round(ageMs / (60 * 60 * 1000));
    errors.push(
      `Certificate is ${ageHours}h old (issued ${cert.issued_at}). ` +
      `Stale certificates cannot authorize a release.`
    );
  }

  // Internal consistency: diff SHAs must align with baselines
  if (cert.pre_to_candidate_diff) {
    const diff = cert.pre_to_candidate_diff;
    if (diff.after_sha !== cert.release_sha) {
      errors.push(
        `Internal inconsistency: pre→candidate diff after-SHA (${diff.after_sha}) ` +
        `does not match certificate release SHA (${cert.release_sha})`
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

// ═══════════════════════════════════════════════════════════════════
// Convenience: full evidence chain validation
// ═══════════════════════════════════════════════════════════════════

export interface EvidenceChainValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate the full evidence chain for a release:
 * pre-baseline → candidate-baseline → diff → certificate
 * all must be internally consistent and bound to correct SHAs.
 */
export function validateEvidenceChain(opts: {
  releaseSha: string;
  productionSha: string;
  preBaseline: BaselineSnapshot;
  candidateBaseline?: BaselineSnapshot;
  preToCandidateDiff?: StateDiffResult;
  certificate?: ReleaseCertificate;
  now?: Date;
}): EvidenceChainValidation {
  const { releaseSha, productionSha, preBaseline, candidateBaseline, preToCandidateDiff, certificate } = opts;
  const now = opts.now || new Date();
  const errors: string[] = [];
  const warnings: string[] = [];

  // Pre-baseline must match production SHA and be 'pre_deployment' phase
  const preValidation = validateBaselineSha(preBaseline, productionSha, now, 'pre_deployment');
  errors.push(...preValidation.errors);

  // Candidate baseline must match release SHA and be 'candidate' phase
  if (candidateBaseline) {
    const candValidation = validateBaselineSha(candidateBaseline, releaseSha, now, 'candidate');
    errors.push(...candValidation.errors);
  }

  // Diff must connect production → release
  if (preToCandidateDiff) {
    const diffValidation = validateDiffShas(preToCandidateDiff, productionSha, releaseSha);
    errors.push(...diffValidation.errors);
  }

  // Certificate must be for release SHA
  if (certificate) {
    const certValidation = validateCertificateSha(certificate, releaseSha, now);
    errors.push(...certValidation.errors);
  }

  // Warning if no candidate baseline or diff
  if (!candidateBaseline) {
    warnings.push('No candidate baseline captured — cannot verify candidate state');
  }
  if (!preToCandidateDiff) {
    warnings.push('No pre→candidate diff computed — cannot verify delta classification');
  }

  return { valid: errors.length === 0, errors, warnings };
}

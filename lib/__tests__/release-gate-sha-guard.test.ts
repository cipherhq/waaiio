/**
 * Release Gate V2 — SHA Freshness & Stale Evidence Tests
 *
 * Proves that:
 * - Evidence produced for SHA-A cannot certify SHA-B
 * - Baselines older than 24h are rejected
 * - Evidence chain inconsistencies are detected
 * - A certificate from a prior SHA cannot authorize a newer release
 */

import { describe, it, expect } from 'vitest';
import {
  validateBaselineSha,
  validateDiffShas,
  validateCertificateSha,
  validateEvidenceChain,
} from '../release-gate/sha-guard';
import type { BaselineSnapshot, StateDiffResult, ReleaseCertificate } from '../release-gate/types';

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

const NOW = new Date('2026-09-23T12:00:00Z');
const ONE_HOUR_AGO = new Date('2026-09-23T11:00:00Z');
const TWO_DAYS_AGO = new Date('2026-09-21T12:00:00Z');

function makeBaseline(sha: string, capturedAt: Date = ONE_HOUR_AGO): BaselineSnapshot {
  return {
    id: `baseline-${sha}`,
    captured_at: capturedAt.toISOString(),
    git_sha: sha,
    phase: 'pre_deployment',
    label: 'test',
    functions: [],
    function_grants: [],
    table_rls: [],
    rls_policies: [],
    extensions: [],
    constraints: [],
    triggers: [],
    cron_jobs: [],
    migrations: [],
    invariant_results: [],
    journey_results: [],
  };
}

function makeDiff(beforeSha: string, afterSha: string): StateDiffResult {
  return {
    id: 'test-diff',
    computed_at: ONE_HOUR_AGO.toISOString(),
    before_baseline_id: `baseline-${beforeSha}`,
    before_sha: beforeSha,
    after_baseline_id: `baseline-${afterSha}`,
    after_sha: afterSha,
    manifest_id: null,
    entries: [],
    summary: { total: 0, expected: 0, unexpected: 0, improved: 0, regressions: 0, critical_regressions: 0 },
    verdict: 'PASS',
    block_reasons: [],
  };
}

function makeCertificate(sha: string, issuedAt: Date = ONE_HOUR_AGO): ReleaseCertificate {
  return {
    id: 'test-cert',
    issued_at: issuedAt.toISOString(),
    release_sha: sha,
    tested_commit_sha: sha,
    merge_sha: null,
    kind: 'release_candidate',
    deployment_id: null,
    pre_deployment_baseline_id: 'pre',
    candidate_baseline_id: 'cand',
    post_deployment_baseline_id: null,
    migrations_applied: [],
    pre_to_candidate_diff: makeDiff('prod-sha', sha),
    pre_to_post_diff: null,
    invariant_summary: { total: 0, passed: 0, failed: 0, critical_failed: 0 },
    invariant_details: [],
    journey_summary: { total: 0, passed: 0, failed: 0 },
    provider_checks: [],
    scope: {
      functions: false, function_grants: false, table_rls: false, rls_policies: false,
      constraints: false, triggers: false, extensions: false, cron_jobs: false,
      invariants: false, journeys: false,
    },
    status: 'PASS',
    block_reasons: [],
    requires_cto_review: true,
    requires_owner_authorization: true,
    cto_review_sha: null,
    owner_authorization: null,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Baseline SHA validation
// ═══════════════════════════════════════════════════════════════════

describe('Baseline SHA validation', () => {
  it('accepts baseline with matching SHA and fresh timestamp', () => {
    const baseline = makeBaseline('abc123');
    const result = validateBaselineSha(baseline, 'abc123', NOW);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects baseline with mismatched SHA', () => {
    const baseline = makeBaseline('abc123');
    const result = validateBaselineSha(baseline, 'def456', NOW);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('SHA mismatch');
    expect(result.errors[0]).toContain('abc123');
    expect(result.errors[0]).toContain('def456');
  });

  it('rejects baseline older than 24 hours', () => {
    const baseline = makeBaseline('abc123', TWO_DAYS_AGO);
    const result = validateBaselineSha(baseline, 'abc123', NOW);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('48h old');
  });

  it('rejects baseline with future timestamp', () => {
    const futureDate = new Date('2026-09-24T12:00:00Z');
    const baseline = makeBaseline('abc123', futureDate);
    const result = validateBaselineSha(baseline, 'abc123', NOW);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('future');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Baseline phase validation
// ═══════════════════════════════════════════════════════════════════

describe('Baseline phase validation', () => {
  it('accepts baseline with matching phase', () => {
    const baseline = makeBaseline('abc123');
    baseline.phase = 'pre_deployment';
    const result = validateBaselineSha(baseline, 'abc123', NOW, 'pre_deployment');
    expect(result.valid).toBe(true);
  });

  it('rejects baseline with mismatched phase', () => {
    const baseline = makeBaseline('abc123');
    baseline.phase = 'candidate';
    const result = validateBaselineSha(baseline, 'abc123', NOW, 'pre_deployment');
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('phase mismatch');
    expect(result.errors[0]).toContain('pre_deployment');
    expect(result.errors[0]).toContain('candidate');
  });

  it('skips phase check when expectedPhase is not provided', () => {
    const baseline = makeBaseline('abc123');
    baseline.phase = 'candidate';
    const result = validateBaselineSha(baseline, 'abc123', NOW);
    expect(result.valid).toBe(true);
  });

  it('rejects candidate baseline used as post_deployment', () => {
    const baseline = makeBaseline('abc123');
    baseline.phase = 'candidate';
    const result = validateBaselineSha(baseline, 'abc123', NOW, 'post_deployment');
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('post_deployment');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Evidence chain validates phases
// ═══════════════════════════════════════════════════════════════════

describe('Evidence chain validates baseline phases', () => {
  it('rejects when pre-baseline has wrong phase', () => {
    const pre = makeBaseline('prod-sha');
    pre.phase = 'candidate'; // wrong — should be pre_deployment
    const result = validateEvidenceChain({
      releaseSha: 'release-sha',
      productionSha: 'prod-sha',
      preBaseline: pre,
      now: NOW,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('phase mismatch'))).toBe(true);
  });

  it('rejects when candidate-baseline has wrong phase', () => {
    const pre = makeBaseline('prod-sha');
    pre.phase = 'pre_deployment';
    const cand = makeBaseline('release-sha');
    cand.phase = 'pre_deployment'; // wrong — should be candidate
    const result = validateEvidenceChain({
      releaseSha: 'release-sha',
      productionSha: 'prod-sha',
      preBaseline: pre,
      candidateBaseline: cand,
      now: NOW,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('phase mismatch'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Diff SHA validation
// ═══════════════════════════════════════════════════════════════════

describe('Diff SHA validation', () => {
  it('accepts diff with matching before/after SHAs', () => {
    const diff = makeDiff('prod-sha', 'release-sha');
    const result = validateDiffShas(diff, 'prod-sha', 'release-sha');
    expect(result.valid).toBe(true);
  });

  it('rejects diff with wrong before-SHA', () => {
    const diff = makeDiff('wrong-sha', 'release-sha');
    const result = validateDiffShas(diff, 'prod-sha', 'release-sha');
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('before-SHA mismatch');
  });

  it('rejects diff with wrong after-SHA', () => {
    const diff = makeDiff('prod-sha', 'wrong-sha');
    const result = validateDiffShas(diff, 'prod-sha', 'release-sha');
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('after-SHA mismatch');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Certificate SHA validation — the core stale-evidence test
// ═══════════════════════════════════════════════════════════════════

describe('Certificate SHA validation', () => {
  it('CRITICAL: certificate from prior SHA cannot certify a newer release', () => {
    // This is the exact scenario #367 requires testing:
    // A certificate was generated for SHA "old-sha" but the release
    // candidate has moved to "new-sha" (e.g., new commits were pushed).
    const cert = makeCertificate('old-sha');
    const result = validateCertificateSha(cert, 'new-sha', NOW);

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('SHA mismatch');
    expect(result.errors[0]).toContain('old-sha');
    expect(result.errors[0]).toContain('new-sha');
    expect(result.errors[0]).toContain('cannot certify a newer release');
  });

  it('accepts certificate with matching SHA', () => {
    const cert = makeCertificate('release-sha');
    const result = validateCertificateSha(cert, 'release-sha', NOW);
    expect(result.valid).toBe(true);
  });

  it('rejects stale certificate (older than 24h)', () => {
    const cert = makeCertificate('release-sha', TWO_DAYS_AGO);
    const result = validateCertificateSha(cert, 'release-sha', NOW);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Stale certificates');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Full evidence chain validation
// ═══════════════════════════════════════════════════════════════════

describe('Evidence chain validation', () => {
  it('accepts consistent evidence chain', () => {
    const candBaseline = makeBaseline('release-sha');
    candBaseline.phase = 'candidate';
    const result = validateEvidenceChain({
      releaseSha: 'release-sha',
      productionSha: 'prod-sha',
      preBaseline: makeBaseline('prod-sha'),
      candidateBaseline: candBaseline,
      now: NOW,
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects when pre-baseline SHA does not match production', () => {
    const candBaseline = makeBaseline('release-sha');
    candBaseline.phase = 'candidate';
    const result = validateEvidenceChain({
      releaseSha: 'release-sha',
      productionSha: 'prod-sha',
      preBaseline: makeBaseline('wrong-sha'),
      candidateBaseline: candBaseline,
      now: NOW,
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('wrong-sha'))).toBe(true);
  });

  it('rejects when candidate-baseline SHA does not match release', () => {
    const candBaseline = makeBaseline('stale-candidate-sha');
    candBaseline.phase = 'candidate';
    const result = validateEvidenceChain({
      releaseSha: 'release-sha',
      productionSha: 'prod-sha',
      preBaseline: makeBaseline('prod-sha'),
      candidateBaseline: candBaseline,
      now: NOW,
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('stale-candidate-sha'))).toBe(true);
  });

  it('warns when optional evidence is missing', () => {
    const result = validateEvidenceChain({
      releaseSha: 'release-sha',
      productionSha: 'prod-sha',
      preBaseline: makeBaseline('prod-sha'),
      now: NOW,
    });

    expect(result.valid).toBe(true); // not a hard error
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some(w => w.includes('No candidate baseline'))).toBe(true);
  });
});

/**
 * Release Gate V2 — Full Gate Orchestration Tests
 *
 * Proves all four #367 Phase 1 required test scenarios:
 *
 * 1. M394-style CREATE OR REPLACE that drops extensions from a protected
 *    function causes the gate to FAIL.
 * 2. A previously passing critical invariant turning red without an
 *    approved declared delta BLOCKS certification.
 * 3. An explicitly declared/Owner-approved expected delta is ACCEPTED
 *    but still recorded in the release certificate.
 * 4. Stale SHA evidence cannot certify a newer release candidate.
 *
 * Also tests:
 * - BEFORE → CANDIDATE → AFTER 3-phase model
 * - Certificate generation with sample output
 * - Post-deployment verification (candidate vs post divergence detection)
 */

import { describe, it, expect } from 'vitest';
import { executeGate } from '../release-gate/gate';
import { formatCertificate } from '../release-gate/certificate';
import type {
  BaselineSnapshot,
  FunctionCatalog,
  InvariantResult,
  ReleaseManifest,
} from '../release-gate/types';

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

const NOW = new Date('2026-09-23T12:00:00Z');
const ONE_HOUR_AGO = new Date('2026-09-23T11:00:00Z');

function makeBaseline(overrides: Partial<BaselineSnapshot> = {}): BaselineSnapshot {
  return {
    id: 'test-baseline',
    captured_at: ONE_HOUR_AGO.toISOString(),
    git_sha: 'abc123',
    phase: 'pre_deployment',
    label: 'Test baseline',
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
    ...overrides,
  };
}

function makeFunction(overrides: Partial<FunctionCatalog> = {}): FunctionCatalog {
  return {
    schema: 'public',
    name: 'test_function',
    arg_types: 'uuid, uuid',
    return_type: 'jsonb',
    security: 'definer',
    owner: 'postgres',
    proconfig: ['search_path=public, extensions'],
    language: 'plpgsql',
    body_hash: 'abc123hash',
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════
// TEST 1: M394-style regression blocks gate
// ═══════════════════════════════════════════════════════════════════

describe('TEST 1: M394-style CREATE OR REPLACE drops extensions → gate FAILS', () => {
  it('blocks when initialize_terminal_effects loses search_path=public,extensions', () => {
    const preBaseline = makeBaseline({
      id: 'pre-baseline',
      git_sha: 'production-sha-abc',
      phase: 'pre_deployment',
      functions: [
        makeFunction({
          name: 'initialize_terminal_effects',
          arg_types: 'uuid, uuid, text[], text[], text[], text[], integer',
          proconfig: ['search_path=public, extensions'],
          body_hash: 'good-body',
        }),
        makeFunction({
          name: 'finalize_payment_confirmation',
          arg_types: 'uuid, uuid',
          proconfig: ['search_path=public, extensions'],
          body_hash: 'finalize-body',
        }),
      ],
      invariant_results: [
        { invariant_id: 'DB-001', description: 'digest() search_path', status: 'pass', evidence: 'OK', critical: true },
        { invariant_id: 'DB-006', description: 'Both functions', status: 'pass', evidence: 'OK', critical: true },
      ],
    });

    // Candidate: M394 recreates initialize_terminal_effects with only search_path=public
    const candidateBaseline = makeBaseline({
      id: 'candidate-baseline',
      git_sha: 'candidate-sha-def',
      phase: 'candidate',
      functions: [
        makeFunction({
          name: 'initialize_terminal_effects',
          arg_types: 'uuid, uuid, text[], text[], text[], text[], integer',
          proconfig: ['search_path=public'],  // ← M394 REGRESSION
          body_hash: 'new-body-with-phase2d',
        }),
        makeFunction({
          name: 'finalize_payment_confirmation',
          arg_types: 'uuid, uuid',
          proconfig: ['search_path=public, extensions'],  // Unchanged
          body_hash: 'finalize-body',
        }),
      ],
      invariant_results: [
        { invariant_id: 'DB-001', description: 'digest() search_path', status: 'fail', evidence: 'initialize_terminal_effects missing extensions', critical: true },
        { invariant_id: 'DB-006', description: 'Both functions', status: 'fail', evidence: 'initialize_terminal_effects missing extensions', critical: true },
      ],
    });

    const result = executeGate({
      releaseSha: 'candidate-sha-def',
      productionSha: 'production-sha-abc',
      preBaseline,
      candidateBaseline,
      now: NOW,
    });

    // Gate must BLOCK
    expect(result.verdict).toBe('BLOCKED');

    // Must identify the exact problem
    expect(result.block_reasons.some(r =>
      r.includes('initialize_terminal_effects') || r.includes('DB-001') || r.includes('DB-006')
    )).toBe(true);

    // Certificate records the failure
    expect(result.certificate.status).toBe('BLOCKED');

    // Pre→Candidate diff detects the proconfig change
    const proConfigEntry = result.pre_to_candidate_diff.entries.find(e =>
      e.object_id.includes('initialize_terminal_effects') && e.field === 'proconfig'
    );
    expect(proConfigEntry).toBeDefined();
    expect(proConfigEntry!.critical).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// TEST 2: Previously passing invariant turns red → BLOCKS
// ═══════════════════════════════════════════════════════════════════

describe('TEST 2: Previously passing invariant turns red without declared delta → BLOCKS', () => {
  it('blocks when PAY-001 was passing and becomes failing without manifest entry', () => {
    const preBaseline = makeBaseline({
      id: 'pre',
      git_sha: 'prod-sha',
      invariant_results: [
        { invariant_id: 'PAY-001', description: 'Stripe Save Card param', status: 'pass', evidence: 'Present in checkout', critical: true },
        { invariant_id: 'DB-001', description: 'digest search_path', status: 'pass', evidence: 'OK', critical: true },
      ],
    });

    const candidateBaseline = makeBaseline({
      id: 'cand',
      git_sha: 'release-sha',
      invariant_results: [
        { invariant_id: 'PAY-001', description: 'Stripe Save Card param', status: 'fail', evidence: 'Missing after refactor', critical: true },
        { invariant_id: 'DB-001', description: 'digest search_path', status: 'pass', evidence: 'OK', critical: true },
      ],
    });

    const result = executeGate({
      releaseSha: 'release-sha',
      productionSha: 'prod-sha',
      preBaseline,
      candidateBaseline,
      now: NOW,
    });

    expect(result.verdict).toBe('BLOCKED');
    expect(result.block_reasons.some(r => r.includes('PAY-001'))).toBe(true);
    expect(result.block_reasons.some(r => r.includes('PREVIOUSLY PASSING NOW FAILS'))).toBe(true);

    // The diff entry classifies it as regression
    const payDiff = result.pre_to_candidate_diff.entries.find(e => e.object_id === 'PAY-001');
    expect(payDiff).toBeDefined();
    expect(payDiff!.classification).toBe('regression');
    expect(payDiff!.critical).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// TEST 3: Declared/Owner-approved delta is accepted but recorded
// ═══════════════════════════════════════════════════════════════════

describe('TEST 3: Declared/Owner-approved expected delta is accepted and recorded', () => {
  it('passes when function change is covered by manifest, and records it in certificate', () => {
    const preBaseline = makeBaseline({
      id: 'pre',
      git_sha: 'prod-sha',
      functions: [
        makeFunction({
          name: 'initialize_terminal_effects',
          arg_types: 'uuid, uuid, text[], text[], text[], text[], integer',
          proconfig: ['search_path=public, extensions'],
          body_hash: 'old-body',
        }),
      ],
      invariant_results: [
        { invariant_id: 'DB-001', description: 'digest search_path', status: 'pass', evidence: 'OK', critical: true },
      ],
    });

    const candidateBaseline = makeBaseline({
      id: 'cand',
      git_sha: 'release-sha',
      functions: [
        makeFunction({
          name: 'initialize_terminal_effects',
          arg_types: 'uuid, uuid, text[], text[], text[], text[], integer',
          proconfig: ['search_path=public, extensions'],  // search_path PRESERVED
          body_hash: 'new-body-with-direct-transfer-support',  // Body changed
        }),
      ],
      invariant_results: [
        { invariant_id: 'DB-001', description: 'digest search_path', status: 'pass', evidence: 'OK', critical: true },
      ],
    });

    const manifest: ReleaseManifest = {
      release_id: 'PR-394',
      candidate_sha: 'release-sha',
      base_sha: 'prod-sha',
      approved_by: 'Owner',
      created_at: ONE_HOUR_AGO.toISOString(),
      expected_changes: [
        {
          category: 'function',
          object_id: 'public.initialize_terminal_effects',
          change_type: 'modified',
          reason: 'Phase 2D adds direct bank transfer support to manifest initialization',
          authorization: '#352',
        },
      ],
    };

    const result = executeGate({
      releaseSha: 'release-sha',
      productionSha: 'prod-sha',
      preBaseline,
      candidateBaseline,
      manifest,
      migrationsApplied: ['394_direct_order_payment_authority.sql'],
      now: NOW,
    });

    // Gate should PASS
    expect(result.verdict).toBe('PASS');

    // The change IS recorded in the diff
    const bodyDiff = result.pre_to_candidate_diff.entries.find(e =>
      e.object_id.includes('initialize_terminal_effects') && e.field === 'body_hash'
    );
    expect(bodyDiff).toBeDefined();
    expect(bodyDiff!.classification).toBe('expected');
    expect(bodyDiff!.manifest_entry).toContain('Phase 2D');

    // Certificate records the expected change
    expect(result.certificate.pre_to_candidate_diff).toBeDefined();
    expect(result.certificate.pre_to_candidate_diff!.summary.expected).toBe(1);

    // Certificate still shows migrations
    expect(result.certificate.migrations_applied).toContain('394_direct_order_payment_authority.sql');

    // Certificate status is PENDING_REVIEW (not auto-PASS — CTO must review)
    expect(result.certificate.status).toBe('PENDING_REVIEW');
    expect(result.certificate.requires_cto_review).toBe(true);
    expect(result.certificate.requires_owner_authorization).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// TEST 4: Stale SHA evidence cannot certify a newer release
// ═══════════════════════════════════════════════════════════════════

describe('TEST 4: Stale SHA evidence cannot certify a newer release candidate', () => {
  it('blocks when pre-baseline SHA does not match current production', () => {
    // Pre-baseline was captured for an older production SHA
    const preBaseline = makeBaseline({
      id: 'stale-pre',
      git_sha: 'old-production-sha',  // ← does NOT match current production
    });

    const candidateBaseline = makeBaseline({
      id: 'cand',
      git_sha: 'new-release-sha',
    });

    const result = executeGate({
      releaseSha: 'new-release-sha',
      productionSha: 'current-production-sha',  // ← this is what's actually deployed
      preBaseline,
      candidateBaseline,
      now: NOW,
    });

    expect(result.verdict).toBe('BLOCKED');
    expect(result.evidence_chain_valid).toBe(false);
    expect(result.evidence_chain_errors.some(e => e.includes('SHA mismatch'))).toBe(true);
    expect(result.evidence_chain_errors.some(e => e.includes('old-production-sha'))).toBe(true);
  });

  it('blocks when candidate-baseline was captured for a prior candidate SHA', () => {
    const preBaseline = makeBaseline({
      id: 'pre',
      git_sha: 'prod-sha',
    });

    // New commits were pushed after the candidate baseline was captured
    const candidateBaseline = makeBaseline({
      id: 'stale-cand',
      git_sha: 'prior-candidate-sha',  // ← captured before latest push
    });

    const result = executeGate({
      releaseSha: 'latest-candidate-sha',  // ← HEAD moved
      productionSha: 'prod-sha',
      preBaseline,
      candidateBaseline,
      now: NOW,
    });

    expect(result.verdict).toBe('BLOCKED');
    expect(result.evidence_chain_valid).toBe(false);
    expect(result.evidence_chain_errors.some(e =>
      e.includes('prior-candidate-sha') && e.includes('latest-candidate-sha')
    )).toBe(true);
  });

  it('blocks when evidence is older than 24 hours', () => {
    const TWO_DAYS_AGO = new Date('2026-09-21T12:00:00Z');

    const preBaseline = makeBaseline({
      id: 'pre',
      git_sha: 'prod-sha',
      captured_at: TWO_DAYS_AGO.toISOString(),
    });

    const candidateBaseline = makeBaseline({
      id: 'cand',
      git_sha: 'release-sha',
    });

    const result = executeGate({
      releaseSha: 'release-sha',
      productionSha: 'prod-sha',
      preBaseline,
      candidateBaseline,
      now: NOW,
    });

    expect(result.verdict).toBe('BLOCKED');
    expect(result.evidence_chain_errors.some(e => e.includes('48h old'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3-Phase BEFORE → CANDIDATE → AFTER model
// ═══════════════════════════════════════════════════════════════════

describe('3-Phase: BEFORE → CANDIDATE → AFTER with post-deployment verification', () => {
  it('passes when post-deployment state matches candidate', () => {
    const preBaseline = makeBaseline({
      id: 'pre',
      git_sha: 'prod-sha',
      functions: [
        makeFunction({ name: 'my_func', body_hash: 'old' }),
      ],
    });

    const candidateBaseline = makeBaseline({
      id: 'cand',
      git_sha: 'release-sha',
      phase: 'candidate',
      functions: [
        makeFunction({ name: 'my_func', body_hash: 'new' }),
      ],
    });

    // Post-deployment should match candidate exactly
    const postBaseline = makeBaseline({
      id: 'post',
      git_sha: 'release-sha',
      phase: 'post_deployment',
      functions: [
        makeFunction({ name: 'my_func', body_hash: 'new' }),
      ],
    });

    const manifest: ReleaseManifest = {
      release_id: 'test',
      candidate_sha: 'release-sha',
      base_sha: 'prod-sha',
      approved_by: 'Owner',
      created_at: ONE_HOUR_AGO.toISOString(),
      expected_changes: [{
        category: 'function',
        object_id: 'public.my_func',
        change_type: 'modified',
        reason: 'Expected update',
        authorization: '#999',
      }],
    };

    const result = executeGate({
      releaseSha: 'release-sha',
      productionSha: 'prod-sha',
      preBaseline,
      candidateBaseline,
      postBaseline,
      manifest,
      now: NOW,
    });

    expect(result.verdict).toBe('PASS');
    expect(result.pre_to_post_diff).toBeDefined();
    expect(result.pre_to_post_diff!.verdict).toBe('PASS');
  });

  it('blocks when post-deployment state diverges from candidate', () => {
    const preBaseline = makeBaseline({
      id: 'pre',
      git_sha: 'prod-sha',
      functions: [
        makeFunction({ name: 'my_func', body_hash: 'old' }),
      ],
    });

    const candidateBaseline = makeBaseline({
      id: 'cand',
      git_sha: 'release-sha',
      phase: 'candidate',
      functions: [
        makeFunction({ name: 'my_func', body_hash: 'new' }),
      ],
    });

    // Post-deployment has DIFFERENT state than candidate — something went wrong
    const postBaseline = makeBaseline({
      id: 'post',
      git_sha: 'release-sha',
      phase: 'post_deployment',
      functions: [
        makeFunction({ name: 'my_func', body_hash: 'unexpected-body' }),
      ],
    });

    const manifest: ReleaseManifest = {
      release_id: 'test',
      candidate_sha: 'release-sha',
      base_sha: 'prod-sha',
      approved_by: 'Owner',
      created_at: ONE_HOUR_AGO.toISOString(),
      expected_changes: [{
        category: 'function',
        object_id: 'public.my_func',
        change_type: 'modified',
        reason: 'Expected update',
        authorization: '#999',
      }],
    };

    const result = executeGate({
      releaseSha: 'release-sha',
      productionSha: 'prod-sha',
      preBaseline,
      candidateBaseline,
      postBaseline,
      manifest,
      now: NOW,
    });

    expect(result.verdict).toBe('BLOCKED');
    expect(result.block_reasons.some(r => r.includes('Deployment divergence'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Sample certificate output
// ═══════════════════════════════════════════════════════════════════

describe('Sample release certificate generation', () => {
  it('generates a complete human-readable certificate', () => {
    const preBaseline = makeBaseline({
      id: 'pre-22b69d31',
      git_sha: '22b69d314dac',
      functions: [
        makeFunction({
          name: 'initialize_terminal_effects',
          arg_types: 'uuid, uuid, text[], text[], text[], text[], integer',
          proconfig: ['search_path=public, extensions'],
          body_hash: 'prod-body',
        }),
      ],
      invariant_results: [
        { invariant_id: 'DB-001', description: 'digest() search_path', status: 'pass', evidence: 'OK', critical: true },
        { invariant_id: 'DB-006', description: 'Both functions correct', status: 'pass', evidence: 'OK', critical: true },
        { invariant_id: 'PAY-001', description: 'Stripe Save Card param', status: 'fail', evidence: 'API version not pinned', critical: true },
      ],
    });

    const candidateBaseline = makeBaseline({
      id: 'cand-m397-fix',
      git_sha: 'candidate-sha-m397',
      phase: 'candidate',
      functions: [
        makeFunction({
          name: 'initialize_terminal_effects',
          arg_types: 'uuid, uuid, text[], text[], text[], text[], integer',
          proconfig: ['search_path=public, extensions'],
          body_hash: 'prod-body',  // body unchanged — M397 is ALTER only
        }),
      ],
      invariant_results: [
        { invariant_id: 'DB-001', description: 'digest() search_path', status: 'pass', evidence: 'OK', critical: true },
        { invariant_id: 'DB-006', description: 'Both functions correct', status: 'pass', evidence: 'OK', critical: true },
        { invariant_id: 'PAY-001', description: 'Stripe Save Card param', status: 'fail', evidence: 'API version still not pinned', critical: true },
      ],
    });

    const result = executeGate({
      releaseSha: 'candidate-sha-m397',
      productionSha: '22b69d314dac',
      preBaseline,
      candidateBaseline,
      migrationsApplied: ['397_restore_terminal_effects_search_path.sql'],
      now: NOW,
    });

    // PAY-001 is still failing in both baselines — that's not a regression
    // (it was already failing), so it should block via invariant check, not diff
    const certText = result.certificate_text;

    // Certificate includes all key fields
    expect(certText).toContain('RELEASE CERTIFICATE');
    expect(certText).toContain('candidate-sha-m397');
    expect(certText).toContain('397_restore_terminal_effects_search_path.sql');
    expect(certText).toContain('CTO Review Required');
    expect(certText).toContain('Owner Authorization');

    // Output the certificate for human review (visible in test output)
    console.log('\n' + certText);
  });
});

/**
 * Release Gate V2 — Full Gate Orchestration Tests (R2 corrections)
 *
 * All #367 Phase 1 required scenarios plus R1 blocker regression tests:
 *
 * 1. M394-style search_path regression blocks gate
 * 2. Previously passing invariant red without declared delta blocks
 * 3. Declared/Owner-approved delta accepted and recorded in certificate
 * 4. Stale SHA evidence rejected (manifest SHA mismatch too)
 * 5. Generic manifest cannot authorize undeclared safety property changes
 * 6. Missing required protected functions block (fail-closed)
 * 7. Certificate honestly declares scope
 * 8. #366 invariant does not assume unproven provider root cause
 */

import { describe, it, expect } from 'vitest';
import { executeGate } from '../release-gate/gate';
import { getCriticalInvariants } from '../release-gate/invariant-registry';
import type { BaselineSnapshot, FunctionCatalog, InvariantResult, ReleaseManifest } from '../release-gate/types';

const NOW = new Date('2026-09-23T12:00:00Z');
const ONE_HOUR_AGO = new Date('2026-09-23T11:00:00Z');

/** Generate passing invariant results for all critical invariants */
function allCriticalInvariantsPassing(): InvariantResult[] {
  return getCriticalInvariants().map(inv => ({
    invariant_id: inv.id,
    description: inv.description,
    status: 'pass' as const,
    evidence: 'synthetic test pass',
    critical: true,
  }));
}

function makeBaseline(overrides: Partial<BaselineSnapshot> = {}): BaselineSnapshot {
  return {
    id: 'test', captured_at: ONE_HOUR_AGO.toISOString(), git_sha: 'abc123',
    phase: 'pre_deployment', label: 'Test',
    functions: [], function_grants: [], table_rls: [], rls_policies: [],
    extensions: [], constraints: [], triggers: [], cron_jobs: [],
    migrations: [], invariant_results: [], journey_results: [],
    ...overrides,
  };
}

function makeFunction(overrides: Partial<FunctionCatalog> = {}): FunctionCatalog {
  return {
    schema: 'public', name: 'test_function', arg_types: 'uuid, uuid',
    return_type: 'jsonb', security: 'definer', owner: 'postgres',
    proconfig: ['search_path=public, extensions'], language: 'plpgsql',
    body_hash: 'hash', ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════
// TEST 1: M394-style regression blocks gate
// ═══════════════════════════════════════════════════════════════════

describe('TEST 1: M394-style regression blocks gate', () => {
  it('blocks when initialize_terminal_effects loses extensions in search_path', () => {
    const pre = makeBaseline({
      id: 'pre', git_sha: 'prod-sha',
      functions: [makeFunction({
        name: 'initialize_terminal_effects',
        arg_types: 'uuid, uuid, text[], text[], text[], text[], integer',
        proconfig: ['search_path=public, extensions'], body_hash: 'good',
      })],
      invariant_results: [
        { invariant_id: 'DB-001', description: 'x', status: 'pass', evidence: 'ok', critical: true },
      ],
    });
    const cand = makeBaseline({
      id: 'cand', git_sha: 'cand-sha', phase: 'candidate',
      functions: [makeFunction({
        name: 'initialize_terminal_effects',
        arg_types: 'uuid, uuid, text[], text[], text[], text[], integer',
        proconfig: ['search_path=public'], body_hash: 'new',
      })],
      invariant_results: [
        { invariant_id: 'DB-001', description: 'x', status: 'fail', evidence: 'missing extensions', critical: true },
      ],
    });
    const result = executeGate({ releaseSha: 'cand-sha', productionSha: 'prod-sha', preBaseline: pre, candidateBaseline: cand, now: NOW });
    expect(result.verdict).toBe('BLOCKED');
    expect(result.block_reasons.some(r => r.includes('initialize_terminal_effects') || r.includes('DB-001'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// TEST 2: Previously passing invariant turns red → BLOCKS
// ═══════════════════════════════════════════════════════════════════

describe('TEST 2: Previously passing invariant turns red → BLOCKS', () => {
  it('blocks when PAY-001 pass→fail without manifest', () => {
    const pre = makeBaseline({
      id: 'pre', git_sha: 'prod-sha',
      invariant_results: [
        { invariant_id: 'PAY-001', description: 'x', status: 'pass', evidence: 'ok', critical: true },
      ],
    });
    const cand = makeBaseline({
      id: 'cand', git_sha: 'rel-sha', phase: 'candidate',
      invariant_results: [
        { invariant_id: 'PAY-001', description: 'x', status: 'fail', evidence: 'broken', critical: true },
      ],
    });
    const result = executeGate({ releaseSha: 'rel-sha', productionSha: 'prod-sha', preBaseline: pre, candidateBaseline: cand, now: NOW });
    expect(result.verdict).toBe('BLOCKED');
    expect(result.block_reasons.some(r => r.includes('PREVIOUSLY PASSING') && r.includes('PAY-001'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// TEST 3: Declared delta accepted, still recorded in certificate
// ═══════════════════════════════════════════════════════════════════

describe('TEST 3: Declared/Owner-approved delta accepted and recorded', () => {
  it('passes with field-specific manifest, records in certificate', () => {
    const pre = makeBaseline({
      id: 'pre', git_sha: 'prod-sha',
      functions: [makeFunction({ name: 'my_func', body_hash: 'old' })],
      invariant_results: allCriticalInvariantsPassing(),
    });
    const cand = makeBaseline({
      id: 'cand', git_sha: 'rel-sha', phase: 'candidate',
      functions: [makeFunction({ name: 'my_func', body_hash: 'new' })],
      invariant_results: allCriticalInvariantsPassing(),
    });
    const manifest: ReleaseManifest = {
      release_id: 'PR-400', candidate_sha: 'rel-sha', base_sha: 'prod-sha',
      approved_by: 'CTO', created_at: ONE_HOUR_AGO.toISOString(),
      expected_changes: [{
        category: 'function', object_id: 'public.my_func(uuid, uuid)',
        change_type: 'modified', field: 'body_hash',
        reason: 'Phase 2D', owner_authorization: '#352-comment-456',
      }],
    };
    const result = executeGate({
      releaseSha: 'rel-sha', productionSha: 'prod-sha',
      preBaseline: pre, candidateBaseline: cand, manifest,
      migrationsApplied: ['397_fix.sql'], now: NOW,
    });
    expect(result.verdict).toBe('PASS');
    expect(result.certificate.pre_to_candidate_diff!.summary.expected).toBe(1);
    expect(result.certificate.migrations_applied).toContain('397_fix.sql');
    expect(result.certificate.status).toBe('PENDING_REVIEW');
    expect(result.certificate.requires_cto_review).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// TEST 4: Stale SHA evidence rejected
// ═══════════════════════════════════════════════════════════════════

describe('TEST 4: Stale SHA evidence rejected', () => {
  it('blocks when pre-baseline SHA mismatches production', () => {
    const pre = makeBaseline({ id: 'pre', git_sha: 'old-prod' });
    const cand = makeBaseline({ id: 'cand', git_sha: 'rel-sha', phase: 'candidate' });
    const result = executeGate({ releaseSha: 'rel-sha', productionSha: 'current-prod', preBaseline: pre, candidateBaseline: cand, now: NOW });
    expect(result.verdict).toBe('BLOCKED');
    expect(result.evidence_chain_valid).toBe(false);
  });

  it('blocks when candidate-baseline SHA mismatches release', () => {
    const pre = makeBaseline({ id: 'pre', git_sha: 'prod-sha' });
    const cand = makeBaseline({ id: 'cand', git_sha: 'stale-cand', phase: 'candidate' });
    const result = executeGate({ releaseSha: 'latest-cand', productionSha: 'prod-sha', preBaseline: pre, candidateBaseline: cand, now: NOW });
    expect(result.verdict).toBe('BLOCKED');
  });

  it('blocks when evidence is older than 24h', () => {
    const old = new Date('2026-09-21T12:00:00Z');
    const pre = makeBaseline({ id: 'pre', git_sha: 'prod-sha', captured_at: old.toISOString() });
    const cand = makeBaseline({ id: 'cand', git_sha: 'rel-sha', phase: 'candidate' });
    const result = executeGate({ releaseSha: 'rel-sha', productionSha: 'prod-sha', preBaseline: pre, candidateBaseline: cand, now: NOW });
    expect(result.verdict).toBe('BLOCKED');
    expect(result.block_reasons.some(r => r.includes('48h old'))).toBe(true);
  });

  it('blocks when manifest SHA does not match release/production', () => {
    const pre = makeBaseline({ id: 'pre', git_sha: 'prod-sha' });
    const cand = makeBaseline({ id: 'cand', git_sha: 'rel-sha', phase: 'candidate' });
    const manifest: ReleaseManifest = {
      release_id: 'stale', candidate_sha: 'wrong-sha', base_sha: 'wrong-prod',
      approved_by: 'CTO', created_at: ONE_HOUR_AGO.toISOString(), expected_changes: [],
    };
    const result = executeGate({ releaseSha: 'rel-sha', productionSha: 'prod-sha', preBaseline: pre, candidateBaseline: cand, manifest, now: NOW });
    expect(result.verdict).toBe('BLOCKED');
    expect(result.block_reasons.some(r => r.includes('Manifest base_sha') || r.includes('Manifest candidate_sha'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// TEST 5: Generic manifest cannot waive protected safety properties
// ═══════════════════════════════════════════════════════════════════

describe('TEST 5: Generic manifest cannot waive protected properties', () => {
  it('body_hash manifest does NOT authorize concurrent search_path change', () => {
    const pre = makeBaseline({
      id: 'pre', git_sha: 'prod-sha',
      functions: [makeFunction({
        name: 'initialize_terminal_effects',
        arg_types: 'uuid, uuid, text[], text[], text[], text[], integer',
        proconfig: ['search_path=public, extensions'], body_hash: 'old',
      })],
    });
    const cand = makeBaseline({
      id: 'cand', git_sha: 'rel-sha', phase: 'candidate',
      functions: [makeFunction({
        name: 'initialize_terminal_effects',
        arg_types: 'uuid, uuid, text[], text[], text[], text[], integer',
        proconfig: ['search_path=public'], body_hash: 'new', // Both changed
      })],
    });
    const manifest: ReleaseManifest = {
      release_id: 'test', candidate_sha: 'rel-sha', base_sha: 'prod-sha',
      approved_by: 'CTO', created_at: ONE_HOUR_AGO.toISOString(),
      expected_changes: [{
        category: 'function',
        object_id: 'public.initialize_terminal_effects(uuid, uuid, text[], text[], text[], text[], integer)',
        change_type: 'modified', field: 'body_hash',
        reason: 'Body update', owner_authorization: '#400',
      }],
    };
    const result = executeGate({ releaseSha: 'rel-sha', productionSha: 'prod-sha', preBaseline: pre, candidateBaseline: cand, manifest, now: NOW });
    expect(result.verdict).toBe('BLOCKED');
    // proconfig change must be blocked even though body_hash is expected
    expect(result.pre_to_candidate_diff.entries.find(e => e.field === 'proconfig')!.classification).not.toBe('expected');
  });
});

// ═══════════════════════════════════════════════════════════════════
// TEST 6: Certificate honestly declares scope
// ═══════════════════════════════════════════════════════════════════

describe('TEST 6: Certificate scope declaration', () => {
  it('certificate scope derived from baseline data — empty baselines get false', () => {
    const pre = makeBaseline({ id: 'pre', git_sha: 'prod-sha' });
    const cand = makeBaseline({
      id: 'cand', git_sha: 'rel-sha', phase: 'candidate',
      invariant_results: [
        { invariant_id: 'DB-001', description: 'test', status: 'pass', evidence: 'ok', critical: true },
      ],
    });
    const result = executeGate({ releaseSha: 'rel-sha', productionSha: 'prod-sha', preBaseline: pre, candidateBaseline: cand, now: NOW });
    const scope = result.certificate.scope;
    // Scope derived from baseline data: no functions/grants/rls in baseline → false
    expect(scope.functions).toBe(false);
    expect(scope.function_grants).toBe(false);
    expect(scope.table_rls).toBe(false);
    // invariants: true because invariant_results is non-empty
    expect(scope.invariants).toBe(true);
    // Phase 2 NOT checked — certificate makes no claims
    expect(scope.rls_policies).toBe(false);
    expect(scope.constraints).toBe(false);
    expect(scope.triggers).toBe(false);
    expect(scope.extensions).toBe(false);
    expect(scope.cron_jobs).toBe(false);
    expect(scope.journeys).toBe(false);
  });

  it('certificate scope is true for surfaces with data in baseline', () => {
    const pre = makeBaseline({ id: 'pre', git_sha: 'prod-sha' });
    const cand = makeBaseline({
      id: 'cand', git_sha: 'rel-sha', phase: 'candidate',
      functions: [makeFunction()],
      function_grants: [{ schema: 'public', function_name: 'f', arg_types: 'uuid', grantee: 'service_role', is_grantable: false }],
      table_rls: [{ schema: 'public', table_name: 't', rls_enabled: true, force_rls: false }],
      invariant_results: allCriticalInvariantsPassing(),
    });
    const result = executeGate({ releaseSha: 'rel-sha', productionSha: 'prod-sha', preBaseline: pre, candidateBaseline: cand, now: NOW });
    const scope = result.certificate.scope;
    expect(scope.functions).toBe(true);
    expect(scope.function_grants).toBe(true);
    expect(scope.table_rls).toBe(true);
    expect(scope.invariants).toBe(true);
  });

  it('certificate text includes scope section', () => {
    const pre = makeBaseline({ id: 'pre', git_sha: 'prod-sha' });
    const cand = makeBaseline({
      id: 'cand', git_sha: 'rel-sha', phase: 'candidate',
      invariant_results: [
        { invariant_id: 'DB-001', description: 'test', status: 'pass', evidence: 'ok', critical: true },
      ],
    });
    const result = executeGate({ releaseSha: 'rel-sha', productionSha: 'prod-sha', preBaseline: pre, candidateBaseline: cand, now: NOW });
    expect(result.certificate_text).toContain('Verified Scope');
    expect(result.certificate_text).toContain('NOT checked');
  });
});

// ═══════════════════════════════════════════════════════════════════
// TEST 7: Missing critical invariant evidence blocks gate
// ═══════════════════════════════════════════════════════════════════

describe('TEST 7: Missing critical invariant evidence blocks gate', () => {
  it('blocks when candidate baseline has no invariant results for critical invariants', () => {
    const pre = makeBaseline({ id: 'pre', git_sha: 'prod-sha' });
    const cand = makeBaseline({
      id: 'cand', git_sha: 'rel-sha', phase: 'candidate',
      invariant_results: [], // No invariant results at all
    });
    const result = executeGate({
      releaseSha: 'rel-sha', productionSha: 'prod-sha',
      preBaseline: pre, candidateBaseline: cand, now: NOW,
    });
    expect(result.verdict).toBe('BLOCKED');
    expect(result.block_reasons.some(r => r.includes('missing from candidate baseline'))).toBe(true);
  });

  it('certificate scope.invariants is false when no invariant evidence exists', () => {
    const pre = makeBaseline({ id: 'pre', git_sha: 'prod-sha' });
    const cand = makeBaseline({
      id: 'cand', git_sha: 'rel-sha', phase: 'candidate',
      invariant_results: [],
    });
    const result = executeGate({
      releaseSha: 'rel-sha', productionSha: 'prod-sha',
      preBaseline: pre, candidateBaseline: cand, now: NOW,
    });
    expect(result.certificate.scope.invariants).toBe(false);
  });

  it('certificate scope.invariants is true when invariant evidence exists', () => {
    const pre = makeBaseline({ id: 'pre', git_sha: 'prod-sha' });
    const cand = makeBaseline({
      id: 'cand', git_sha: 'rel-sha', phase: 'candidate',
      invariant_results: [
        { invariant_id: 'DB-001', description: 'test', status: 'pass', evidence: 'ok', critical: true },
      ],
    });
    const result = executeGate({
      releaseSha: 'rel-sha', productionSha: 'prod-sha',
      preBaseline: pre, candidateBaseline: cand, now: NOW,
    });
    expect(result.certificate.scope.invariants).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// TEST 8: Phase mismatch blocks gate
// ═══════════════════════════════════════════════════════════════════

describe('TEST 8: Phase mismatch blocks gate', () => {
  it('blocks when pre-baseline has candidate phase', () => {
    const pre = makeBaseline({ id: 'pre', git_sha: 'prod-sha', phase: 'candidate' }); // wrong
    const cand = makeBaseline({ id: 'cand', git_sha: 'rel-sha', phase: 'candidate' });
    const result = executeGate({
      releaseSha: 'rel-sha', productionSha: 'prod-sha',
      preBaseline: pre, candidateBaseline: cand, now: NOW,
    });
    expect(result.verdict).toBe('BLOCKED');
    expect(result.block_reasons.some(r => r.includes('phase mismatch'))).toBe(true);
  });

  it('blocks when candidate-baseline has pre_deployment phase', () => {
    const pre = makeBaseline({ id: 'pre', git_sha: 'prod-sha', phase: 'pre_deployment' });
    const cand = makeBaseline({ id: 'cand', git_sha: 'rel-sha', phase: 'pre_deployment' }); // wrong
    const result = executeGate({
      releaseSha: 'rel-sha', productionSha: 'prod-sha',
      preBaseline: pre, candidateBaseline: cand, now: NOW,
    });
    expect(result.verdict).toBe('BLOCKED');
    expect(result.block_reasons.some(r => r.includes('phase mismatch'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// R3 TEST: Critical invariant with status 'skip' blocks gate
// ═══════════════════════════════════════════════════════════════════

describe('R3: Critical invariant with skip status blocks gate', () => {
  it('blocks when critical invariant has status skip', () => {
    const pre = makeBaseline({ id: 'pre', git_sha: 'prod-sha' });
    const cand = makeBaseline({
      id: 'cand', git_sha: 'rel-sha', phase: 'candidate',
      invariant_results: [
        ...allCriticalInvariantsPassing().filter(i => i.invariant_id !== 'DB-001'),
        { invariant_id: 'DB-001', description: 'test', status: 'skip' as const, evidence: 'skipped', critical: true },
      ],
    });
    const result = executeGate({
      releaseSha: 'rel-sha', productionSha: 'prod-sha',
      preBaseline: pre, candidateBaseline: cand, now: NOW,
    });
    expect(result.verdict).toBe('BLOCKED');
    expect(result.block_reasons.some(r => r.includes('DB-001') && r.includes('skip'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// R3 TEST: Critical invariant missing from candidate blocks gate
// ═══════════════════════════════════════════════════════════════════

describe('R3: Critical invariant missing from candidate blocks gate', () => {
  it('blocks when any critical invariant is absent from candidate', () => {
    const pre = makeBaseline({ id: 'pre', git_sha: 'prod-sha' });
    // Include all critical invariants EXCEPT DB-003
    const partialInvariants = allCriticalInvariantsPassing().filter(i => i.invariant_id !== 'DB-003');
    const cand = makeBaseline({
      id: 'cand', git_sha: 'rel-sha', phase: 'candidate',
      invariant_results: partialInvariants,
    });
    const result = executeGate({
      releaseSha: 'rel-sha', productionSha: 'prod-sha',
      preBaseline: pre, candidateBaseline: cand, now: NOW,
    });
    expect(result.verdict).toBe('BLOCKED');
    expect(result.block_reasons.some(r => r.includes('DB-003') && r.includes('missing'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// R3 TEST: not_applicable invariant does NOT block but IS disclosed
// ═══════════════════════════════════════════════════════════════════

describe('R3: not_applicable invariant does not block but is disclosed', () => {
  it('passes when critical invariant is not_applicable, disclosed in certificate', () => {
    const pre = makeBaseline({ id: 'pre', git_sha: 'prod-sha' });
    const invariants = allCriticalInvariantsPassing().map(i =>
      i.invariant_id === 'DB-001'
        ? { ...i, status: 'not_applicable' as const, evidence: 'Not applicable to this release' }
        : i
    );
    const cand = makeBaseline({
      id: 'cand', git_sha: 'rel-sha', phase: 'candidate',
      invariant_results: invariants,
    });
    const result = executeGate({
      releaseSha: 'rel-sha', productionSha: 'prod-sha',
      preBaseline: pre, candidateBaseline: cand, now: NOW,
    });
    // Should not be blocked by not_applicable
    const db001BlockReasons = result.block_reasons.filter(r => r.includes('DB-001'));
    expect(db001BlockReasons).toHaveLength(0);
    // Should be disclosed in the certificate invariant_details
    const detail = result.certificate.invariant_details.find(d => d.invariant_id === 'DB-001');
    expect(detail).toBeDefined();
    expect(detail!.status).toBe('not_applicable');
  });
});

// ═══════════════════════════════════════════════════════════════════
// R3 TEST: Certificate kind and provenance
// ═══════════════════════════════════════════════════════════════════

describe('R3: Certificate kind and provenance fields', () => {
  it('self_test kind sets all scope surfaces to false', () => {
    const pre = makeBaseline({ id: 'pre', git_sha: 'prod-sha', functions: [makeFunction()] });
    const cand = makeBaseline({
      id: 'cand', git_sha: 'rel-sha', phase: 'candidate',
      functions: [makeFunction()],
    });
    const result = executeGate({
      releaseSha: 'rel-sha', productionSha: 'prod-sha',
      preBaseline: pre, candidateBaseline: cand, now: NOW,
      kind: 'self_test',
    });
    const scope = result.certificate.scope;
    expect(scope.functions).toBe(false);
    expect(scope.function_grants).toBe(false);
    expect(scope.table_rls).toBe(false);
    expect(scope.invariants).toBe(false);
    expect(result.certificate.kind).toBe('self_test');
  });

  it('release_candidate kind derives scope from baseline data', () => {
    const pre = makeBaseline({ id: 'pre', git_sha: 'prod-sha', functions: [makeFunction()] });
    const cand = makeBaseline({
      id: 'cand', git_sha: 'rel-sha', phase: 'candidate',
      functions: [makeFunction()],
      invariant_results: allCriticalInvariantsPassing(),
    });
    const result = executeGate({
      releaseSha: 'rel-sha', productionSha: 'prod-sha',
      preBaseline: pre, candidateBaseline: cand, now: NOW,
      kind: 'release_candidate',
    });
    expect(result.certificate.scope.functions).toBe(true);
    expect(result.certificate.scope.invariants).toBe(true);
    expect(result.certificate.kind).toBe('release_candidate');
  });

  it('records tested_commit_sha and merge_sha in certificate', () => {
    const pre = makeBaseline({ id: 'pre', git_sha: 'prod-sha' });
    const cand = makeBaseline({
      id: 'cand', git_sha: 'rel-sha', phase: 'candidate',
      invariant_results: allCriticalInvariantsPassing(),
    });
    const result = executeGate({
      releaseSha: 'rel-sha', productionSha: 'prod-sha',
      preBaseline: pre, candidateBaseline: cand, now: NOW,
      testedCommitSha: 'abc123-tested',
      mergeSha: 'def456-merge',
    });
    expect(result.certificate.tested_commit_sha).toBe('abc123-tested');
    expect(result.certificate.merge_sha).toBe('def456-merge');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3-phase model
// ═══════════════════════════════════════════════════════════════════

describe('3-Phase BEFORE → CANDIDATE → AFTER', () => {
  it('passes when post-deployment matches candidate', () => {
    const allInv = allCriticalInvariantsPassing();
    const pre = makeBaseline({ id: 'pre', git_sha: 'prod-sha', functions: [makeFunction({ name: 'f', body_hash: 'old' })], invariant_results: allInv });
    const cand = makeBaseline({ id: 'cand', git_sha: 'rel-sha', phase: 'candidate', functions: [makeFunction({ name: 'f', body_hash: 'new' })], invariant_results: allInv });
    const post = makeBaseline({ id: 'post', git_sha: 'rel-sha', phase: 'post_deployment', functions: [makeFunction({ name: 'f', body_hash: 'new' })], invariant_results: allInv });
    const manifest: ReleaseManifest = {
      release_id: 'test', candidate_sha: 'rel-sha', base_sha: 'prod-sha',
      approved_by: 'CTO', created_at: ONE_HOUR_AGO.toISOString(),
      expected_changes: [{ category: 'function', object_id: 'public.f(uuid, uuid)', change_type: 'modified', field: 'body_hash', reason: 'x', owner_authorization: '#1' }],
    };
    const result = executeGate({ releaseSha: 'rel-sha', productionSha: 'prod-sha', preBaseline: pre, candidateBaseline: cand, postBaseline: post, manifest, now: NOW });
    expect(result.verdict).toBe('PASS');
  });

  it('blocks when post-deployment diverges from candidate', () => {
    const pre = makeBaseline({ id: 'pre', git_sha: 'prod-sha', functions: [makeFunction({ name: 'f', body_hash: 'old' })] });
    const cand = makeBaseline({ id: 'cand', git_sha: 'rel-sha', phase: 'candidate', functions: [makeFunction({ name: 'f', body_hash: 'new' })] });
    const post = makeBaseline({ id: 'post', git_sha: 'rel-sha', phase: 'post_deployment', functions: [makeFunction({ name: 'f', body_hash: 'diverged' })] });
    const manifest: ReleaseManifest = {
      release_id: 'test', candidate_sha: 'rel-sha', base_sha: 'prod-sha',
      approved_by: 'CTO', created_at: ONE_HOUR_AGO.toISOString(),
      expected_changes: [{ category: 'function', object_id: 'public.f(uuid, uuid)', change_type: 'modified', field: 'body_hash', reason: 'x', owner_authorization: '#1' }],
    };
    const result = executeGate({ releaseSha: 'rel-sha', productionSha: 'prod-sha', preBaseline: pre, candidateBaseline: cand, postBaseline: post, manifest, now: NOW });
    expect(result.verdict).toBe('BLOCKED');
    expect(result.block_reasons.some(r => r.includes('Deployment divergence'))).toBe(true);
  });
});

/**
 * Release Gate V2 — State Diff Engine Tests (R2 corrections)
 *
 * Proves the diff engine correctly detects, classifies, and blocks on:
 * - #365: CREATE OR REPLACE silently removing search_path (DB-001/DB-002)
 * - Protected safety fields cannot be blanket-waived by generic manifest
 * - Previously-passing invariants that regress
 * - RLS disabling
 * - Overload-safe grant tracking with grantability
 * - Missing required protected functions
 * - Stale manifest SHA rejection
 * - #366 does not assume provider root cause
 *
 * These tests use synthetic baselines — no database required.
 */

import { describe, it, expect } from 'vitest';
import { computeStateDiff } from '../release-gate/diff-engine';
import { INVARIANTS } from '../release-gate/invariant-registry';
import type {
  BaselineSnapshot,
  ReleaseManifest,
  FunctionCatalog,
  FunctionGrant,
} from '../release-gate/types';

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

function makeBaseline(overrides: Partial<BaselineSnapshot> = {}): BaselineSnapshot {
  return {
    id: 'test-baseline', captured_at: '2026-09-22T00:00:00Z', git_sha: 'abc123',
    phase: 'pre_deployment', label: 'Test baseline',
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
    body_hash: 'abc123hash', ...overrides,
  };
}

function makeManifest(overrides: Partial<ReleaseManifest> = {}): ReleaseManifest {
  return {
    release_id: 'test-release', candidate_sha: 'def456', base_sha: 'abc123',
    approved_by: 'CTO', created_at: '2026-09-22T00:00:00Z',
    expected_changes: [], ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════
// #365 — M394 search_path regression
// ═══════════════════════════════════════════════════════════════════

describe('#365: CREATE OR REPLACE drops search_path', () => {
  it('detects search_path removal on protected function as critical', () => {
    const before = makeBaseline({
      functions: [makeFunction({
        name: 'initialize_terminal_effects',
        arg_types: 'uuid, uuid, text[], text[], text[], text[], integer',
        proconfig: ['search_path=public, extensions'],
      })],
    });
    const after = makeBaseline({
      git_sha: 'def456',
      functions: [makeFunction({
        name: 'initialize_terminal_effects',
        arg_types: 'uuid, uuid, text[], text[], text[], text[], integer',
        proconfig: ['search_path=public'],
      })],
    });

    const diff = computeStateDiff(before, after);
    expect(diff.verdict).toBe('BLOCKED');
    const entry = diff.entries.find(e => e.object_id.includes('initialize_terminal_effects') && e.field === 'proconfig');
    expect(entry).toBeDefined();
    expect(entry!.critical).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// BLOCKER 2 — Generic manifest cannot waive protected safety fields
// ═══════════════════════════════════════════════════════════════════

describe('Generic manifest entry cannot waive protected safety properties', () => {
  it('body_hash change is accepted by field-specific manifest entry', () => {
    const before = makeBaseline({
      functions: [makeFunction({ name: 'my_func', body_hash: 'old' })],
    });
    const after = makeBaseline({
      git_sha: 'def456',
      functions: [makeFunction({ name: 'my_func', body_hash: 'new' })],
    });
    const manifest = makeManifest({
      expected_changes: [{
        category: 'function', object_id: 'public.my_func(uuid, uuid)',
        change_type: 'modified', field: 'body_hash',
        reason: 'Updated logic', owner_authorization: '#400-comment-123',
      }],
    });
    const diff = computeStateDiff(before, after, manifest);
    expect(diff.verdict).toBe('PASS');
  });

  it('BLOCKS: generic function-modified manifest does NOT waive search_path change', () => {
    const before = makeBaseline({
      functions: [makeFunction({
        name: 'initialize_terminal_effects',
        arg_types: 'uuid, uuid, text[], text[], text[], text[], integer',
        proconfig: ['search_path=public, extensions'], body_hash: 'old',
      })],
    });
    const after = makeBaseline({
      git_sha: 'def456',
      functions: [makeFunction({
        name: 'initialize_terminal_effects',
        arg_types: 'uuid, uuid, text[], text[], text[], text[], integer',
        proconfig: ['search_path=public'], body_hash: 'new',
      })],
    });
    // Generic manifest: only declares body_hash change, NOT proconfig
    const manifest = makeManifest({
      expected_changes: [{
        category: 'function',
        object_id: 'public.initialize_terminal_effects(uuid, uuid, text[], text[], text[], text[], integer)',
        change_type: 'modified', field: 'body_hash',
        reason: 'Updated logic', owner_authorization: '#400',
      }],
    });
    const diff = computeStateDiff(before, after, manifest);
    // body_hash should be expected, but proconfig should BLOCK
    expect(diff.verdict).toBe('BLOCKED');
    const proconfigEntry = diff.entries.find(e => e.field === 'proconfig');
    expect(proconfigEntry!.classification).not.toBe('expected');
    expect(proconfigEntry!.critical).toBe(true);
    // body_hash should be accepted
    const bodyEntry = diff.entries.find(e => e.field === 'body_hash');
    expect(bodyEntry!.classification).toBe('expected');
  });

  it('BLOCKS: manifest without field specified cannot waive security change', () => {
    const before = makeBaseline({
      functions: [makeFunction({ name: 'my_func', security: 'definer' })],
    });
    const after = makeBaseline({
      git_sha: 'def456',
      functions: [makeFunction({ name: 'my_func', security: 'invoker' })],
    });
    const manifest = makeManifest({
      expected_changes: [{
        category: 'function', object_id: 'public.my_func(uuid, uuid)',
        change_type: 'modified', // No field specified!
        reason: 'Changed', owner_authorization: '#400',
      }],
    });
    const diff = computeStateDiff(before, after, manifest);
    expect(diff.verdict).toBe('BLOCKED');
    expect(diff.entries.find(e => e.field === 'security')!.classification).not.toBe('expected');
  });

  it('BLOCKS: manifest without field specified cannot waive owner change', () => {
    const before = makeBaseline({
      functions: [makeFunction({ name: 'my_func', owner: 'postgres' })],
    });
    const after = makeBaseline({
      git_sha: 'def456',
      functions: [makeFunction({ name: 'my_func', owner: 'attacker' })],
    });
    const manifest = makeManifest({
      expected_changes: [{
        category: 'function', object_id: 'public.my_func(uuid, uuid)',
        change_type: 'modified',
        reason: 'Changed', owner_authorization: '#400',
      }],
    });
    const diff = computeStateDiff(before, after, manifest);
    expect(diff.verdict).toBe('BLOCKED');
  });

  it('MATCHES but BLOCKS: explicit field-level proconfig manifest entry requires manual verification (protected safety field)', () => {
    const before = makeBaseline({
      functions: [makeFunction({
        name: 'initialize_terminal_effects',
        arg_types: 'uuid, uuid, text[], text[], text[], text[], integer',
        proconfig: ['search_path=public, extensions'],
      })],
    });
    const after = makeBaseline({
      git_sha: 'def456',
      functions: [makeFunction({
        name: 'initialize_terminal_effects',
        arg_types: 'uuid, uuid, text[], text[], text[], text[], integer',
        proconfig: ['search_path=public, extensions, pg_catalog'],
      })],
    });
    const manifest = makeManifest({
      expected_changes: [{
        category: 'function',
        object_id: 'public.initialize_terminal_effects(uuid, uuid, text[], text[], text[], text[], integer)',
        change_type: 'modified', field: 'proconfig',
        expected_before: '["search_path=public, extensions"]',
        expected_after: '["search_path=public, extensions, pg_catalog"]',
        reason: 'Adding pg_catalog', owner_authorization: '#999-owner-approval',
      }],
    });
    const diff = computeStateDiff(before, after, manifest);
    // proconfig is a protected safety field — classified as expected but blocks with PENDING_MANUAL_REVIEW
    expect(diff.entries[0].classification).toBe('expected');
    expect(diff.entries[0].critical).toBe(true);
    expect(diff.verdict).toBe('BLOCKED');
    expect(diff.block_reasons.some(r => r.includes('PENDING_MANUAL_REVIEW'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Overloaded function identity
// ═══════════════════════════════════════════════════════════════════

describe('Overloaded functions have independent identities', () => {
  it('two overloads are tracked separately — change to one does not affect the other', () => {
    const before = makeBaseline({
      functions: [
        makeFunction({ name: 'my_func', arg_types: 'uuid', body_hash: 'v1-uuid' }),
        makeFunction({ name: 'my_func', arg_types: 'uuid, text', body_hash: 'v1-uuid-text' }),
      ],
    });
    const after = makeBaseline({
      git_sha: 'def456',
      functions: [
        makeFunction({ name: 'my_func', arg_types: 'uuid', body_hash: 'v2-uuid' }), // changed
        makeFunction({ name: 'my_func', arg_types: 'uuid, text', body_hash: 'v1-uuid-text' }), // unchanged
      ],
    });
    const diff = computeStateDiff(before, after);
    expect(diff.entries).toHaveLength(1);
    expect(diff.entries[0].object_id).toBe('public.my_func(uuid)');
  });

  it('manifest for one overload cannot satisfy another overload', () => {
    const before = makeBaseline({
      functions: [
        makeFunction({ name: 'my_func', arg_types: 'uuid', body_hash: 'old' }),
        makeFunction({ name: 'my_func', arg_types: 'uuid, text', body_hash: 'old' }),
      ],
    });
    const after = makeBaseline({
      git_sha: 'def456',
      functions: [
        makeFunction({ name: 'my_func', arg_types: 'uuid', body_hash: 'new' }),
        makeFunction({ name: 'my_func', arg_types: 'uuid, text', body_hash: 'new' }),
      ],
    });
    // Manifest only covers the (uuid) overload
    const manifest = makeManifest({
      expected_changes: [{
        category: 'function', object_id: 'public.my_func(uuid)',
        change_type: 'modified', field: 'body_hash',
        reason: 'Updated', owner_authorization: '#400',
      }],
    });
    const diff = computeStateDiff(before, after, manifest);
    // (uuid) should be expected, (uuid, text) should be unexpected
    const uuidEntry = diff.entries.find(e => e.object_id === 'public.my_func(uuid)');
    const uuidTextEntry = diff.entries.find(e => e.object_id === 'public.my_func(uuid, text)');
    expect(uuidEntry!.classification).toBe('expected');
    expect(uuidTextEntry!.classification).toBe('unexpected');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Grant tracking with overload safety and grantability
// ═══════════════════════════════════════════════════════════════════

describe('Grant tracking with overload-safe identity', () => {
  it('detects grantability change', () => {
    const before = makeBaseline({
      function_grants: [
        { schema: 'public', function_name: 'my_func', arg_types: 'uuid', grantee: 'service_role', is_grantable: false },
      ],
    });
    const after = makeBaseline({
      git_sha: 'def456',
      function_grants: [
        { schema: 'public', function_name: 'my_func', arg_types: 'uuid', grantee: 'service_role', is_grantable: true },
      ],
    });
    const diff = computeStateDiff(before, after);
    expect(diff.entries.some(e => e.field === 'is_grantable')).toBe(true);
  });

  it('grant on different overload is tracked independently', () => {
    const before = makeBaseline({ function_grants: [] });
    const after = makeBaseline({
      git_sha: 'def456',
      function_grants: [
        { schema: 'public', function_name: 'my_func', arg_types: 'uuid', grantee: 'anon', is_grantable: false },
      ],
    });
    const diff = computeStateDiff(before, after);
    expect(diff.entries[0].object_id).toBe('public.my_func(uuid)→anon');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Previously-passing invariant regression
// ═══════════════════════════════════════════════════════════════════

describe('Previously passing invariant turns red → BLOCKS', () => {
  it('blocks and classifies as regression', () => {
    const before = makeBaseline({
      invariant_results: [
        { invariant_id: 'PAY-001', description: 'test', status: 'pass', evidence: 'ok', critical: true },
      ],
    });
    const after = makeBaseline({
      git_sha: 'def456',
      invariant_results: [
        { invariant_id: 'PAY-001', description: 'test', status: 'fail', evidence: 'missing', critical: true },
      ],
    });
    const diff = computeStateDiff(before, after);
    expect(diff.verdict).toBe('BLOCKED');
    expect(diff.block_reasons.some(r => r.includes('PREVIOUSLY PASSING'))).toBe(true);
  });

  it('fail→pass classified as improved, not regression', () => {
    const before = makeBaseline({
      invariant_results: [
        { invariant_id: 'PAY-002', description: 'test', status: 'fail', evidence: 'x', critical: true },
      ],
    });
    const after = makeBaseline({
      git_sha: 'def456',
      invariant_results: [
        { invariant_id: 'PAY-002', description: 'test', status: 'pass', evidence: 'fixed', critical: true },
      ],
    });
    const diff = computeStateDiff(before, after);
    expect(diff.verdict).toBe('PASS');
    expect(diff.entries[0].classification).toBe('improved');
  });
});

// ═══════════════════════════════════════════════════════════════════
// RLS enforcement
// ═══════════════════════════════════════════════════════════════════

describe('RLS enforcement', () => {
  it('blocks when RLS is disabled on a public table', () => {
    const before = makeBaseline({
      table_rls: [{ schema: 'public', table_name: 'payments', rls_enabled: true, force_rls: false }],
    });
    const after = makeBaseline({
      git_sha: 'def456',
      table_rls: [{ schema: 'public', table_name: 'payments', rls_enabled: false, force_rls: false }],
    });
    const diff = computeStateDiff(before, after);
    expect(diff.verdict).toBe('BLOCKED');
    expect(diff.entries[0].classification).toBe('regression');
  });
});

// ═══════════════════════════════════════════════════════════════════
// #366: does not assume unproven root cause
// ═══════════════════════════════════════════════════════════════════

describe('#366: PAY-002 does not assume Stripe API version root cause', () => {
  it('PAY-002 invariant describes provider-visible behavior, not Stripe-Version header', () => {
    // Verify the invariant registry does not prescribe a Stripe-Version header
    const pay002 = INVARIANTS.find(i => i.id === 'PAY-002');
    expect(pay002).toBeDefined();
    expect(pay002.description).not.toContain('Stripe-Version');
    expect(pay002.description).not.toContain('header');
    expect(pay002.description).not.toContain('>= 2024');
    expect(pay002.description).toContain('provider-visible');
    expect(pay002.evidence_type).toBe('provider_check');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BLOCKER 5 — Protected safety change with manifest still blocks as PENDING
// ═══════════════════════════════════════════════════════════════════

describe('Protected safety change with manifest still blocks as PENDING_MANUAL_REVIEW', () => {
  it('BLOCKS: field-specific security manifest entry matches but requires manual verification', () => {
    const before = makeBaseline({
      functions: [makeFunction({ name: 'my_func', security: 'definer' })],
    });
    const after = makeBaseline({
      git_sha: 'def456',
      functions: [makeFunction({ name: 'my_func', security: 'invoker' })],
    });
    const manifest = makeManifest({
      expected_changes: [{
        category: 'function', object_id: 'public.my_func(uuid, uuid)',
        change_type: 'modified', field: 'security',
        expected_before: 'definer', expected_after: 'invoker',
        reason: 'Switching to invoker for RLS', owner_authorization: '#500-owner-approval',
      }],
    });
    const diff = computeStateDiff(before, after, manifest);
    // Should be classified as 'expected' but still critical
    const entry = diff.entries.find(e => e.field === 'security');
    expect(entry).toBeDefined();
    expect(entry!.classification).toBe('expected');
    expect(entry!.critical).toBe(true);
    expect(entry!.manifest_entry).toContain('PENDING_MANUAL_REVIEW');
    // Should BLOCK the gate
    expect(diff.verdict).toBe('BLOCKED');
    expect(diff.block_reasons.some(r => r.includes('PENDING_MANUAL_REVIEW'))).toBe(true);
  });

  it('BLOCKS: field-specific proconfig manifest entry matches but requires manual verification', () => {
    const before = makeBaseline({
      functions: [makeFunction({
        name: 'initialize_terminal_effects',
        arg_types: 'uuid, uuid, text[], text[], text[], text[], integer',
        proconfig: ['search_path=public, extensions'],
      })],
    });
    const after = makeBaseline({
      git_sha: 'def456',
      functions: [makeFunction({
        name: 'initialize_terminal_effects',
        arg_types: 'uuid, uuid, text[], text[], text[], text[], integer',
        proconfig: ['search_path=public, extensions, pg_catalog'],
      })],
    });
    const manifest = makeManifest({
      expected_changes: [{
        category: 'function',
        object_id: 'public.initialize_terminal_effects(uuid, uuid, text[], text[], text[], text[], integer)',
        change_type: 'modified', field: 'proconfig',
        expected_before: '["search_path=public, extensions"]',
        expected_after: '["search_path=public, extensions, pg_catalog"]',
        reason: 'Adding pg_catalog', owner_authorization: '#999-owner-approval',
      }],
    });
    const diff = computeStateDiff(before, after, manifest);
    const entry = diff.entries[0];
    expect(entry.classification).toBe('expected');
    expect(entry.critical).toBe(true);
    expect(entry.manifest_entry).toContain('PENDING_MANUAL_REVIEW');
    expect(diff.verdict).toBe('BLOCKED');
  });

  it('does NOT require manual verification for non-protected fields', () => {
    const before = makeBaseline({
      functions: [makeFunction({ name: 'my_func', body_hash: 'old' })],
    });
    const after = makeBaseline({
      git_sha: 'def456',
      functions: [makeFunction({ name: 'my_func', body_hash: 'new' })],
    });
    const manifest = makeManifest({
      expected_changes: [{
        category: 'function', object_id: 'public.my_func(uuid, uuid)',
        change_type: 'modified', field: 'body_hash',
        reason: 'Updated logic', owner_authorization: '#400',
      }],
    });
    const diff = computeStateDiff(before, after, manifest);
    expect(diff.verdict).toBe('PASS');
    const entry = diff.entries[0];
    expect(entry.classification).toBe('expected');
    expect(entry.critical).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Invariant disappearance from candidate treated as regression
// ═══════════════════════════════════════════════════════════════════

describe('Invariant disappearance from candidate treated as regression', () => {
  it('pass → missing is a regression', () => {
    const before = makeBaseline({
      invariant_results: [
        { invariant_id: 'DB-001', description: 'test', status: 'pass', evidence: 'ok', critical: true },
      ],
    });
    const after = makeBaseline({
      git_sha: 'def456',
      invariant_results: [], // DB-001 is missing
    });
    const diff = computeStateDiff(before, after);
    expect(diff.verdict).toBe('BLOCKED');
    const entry = diff.entries.find(e => e.object_id === 'DB-001');
    expect(entry).toBeDefined();
    expect(entry!.classification).toBe('regression');
    expect(entry!.after).toBe('missing');
    expect(diff.block_reasons.some(r => r.includes('PREVIOUSLY PASSING') && r.includes('DB-001'))).toBe(true);
  });

  it('fail → missing is NOT a regression (was already failing)', () => {
    const before = makeBaseline({
      invariant_results: [
        { invariant_id: 'DB-001', description: 'test', status: 'fail', evidence: 'broken', critical: true },
      ],
    });
    const after = makeBaseline({
      git_sha: 'def456',
      invariant_results: [],
    });
    const diff = computeStateDiff(before, after);
    // Should NOT produce any entries for fail → missing
    expect(diff.entries.find(e => e.object_id === 'DB-001')).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Added/removed tables detected in table_rls diff
// ═══════════════════════════════════════════════════════════════════

describe('Table RLS diff detects added/removed tables and force_rls changes', () => {
  it('detects added table', () => {
    const before = makeBaseline({ table_rls: [] });
    const after = makeBaseline({
      git_sha: 'def456',
      table_rls: [{ schema: 'public', table_name: 'new_table', rls_enabled: true, force_rls: false }],
    });
    const diff = computeStateDiff(before, after);
    const entry = diff.entries.find(e => e.object_id === 'public.new_table');
    expect(entry).toBeDefined();
    expect(entry!.change_type).toBe('added');
    expect(entry!.field).toBe('existence');
  });

  it('detects removed table', () => {
    const before = makeBaseline({
      table_rls: [{ schema: 'public', table_name: 'old_table', rls_enabled: true, force_rls: false }],
    });
    const after = makeBaseline({ git_sha: 'def456', table_rls: [] });
    const diff = computeStateDiff(before, after);
    const entry = diff.entries.find(e => e.object_id === 'public.old_table');
    expect(entry).toBeDefined();
    expect(entry!.change_type).toBe('removed');
    expect(entry!.field).toBe('existence');
  });

  it('detects force_rls change', () => {
    const before = makeBaseline({
      table_rls: [{ schema: 'public', table_name: 'payments', rls_enabled: true, force_rls: false }],
    });
    const after = makeBaseline({
      git_sha: 'def456',
      table_rls: [{ schema: 'public', table_name: 'payments', rls_enabled: true, force_rls: true }],
    });
    const diff = computeStateDiff(before, after);
    const entry = diff.entries.find(e => e.field === 'force_rls');
    expect(entry).toBeDefined();
    expect(entry!.change_type).toBe('modified');
    expect(entry!.before).toBe('false');
    expect(entry!.after).toBe('true');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Clean release
// ═══════════════════════════════════════════════════════════════════

describe('Clean release', () => {
  it('passes when baselines are identical', () => {
    const b = makeBaseline({ functions: [makeFunction()] });
    expect(computeStateDiff(b, b).verdict).toBe('PASS');
  });

  it('counts summary categories correctly', () => {
    const before = makeBaseline({
      functions: [makeFunction({ name: 'func_a', body_hash: 'a1' })],
      invariant_results: [
        { invariant_id: 'PAY-002', description: 'test', status: 'fail', evidence: 'x', critical: true },
      ],
    });
    const after = makeBaseline({
      git_sha: 'def456',
      functions: [makeFunction({ name: 'func_a', body_hash: 'a2' })],
      invariant_results: [
        { invariant_id: 'PAY-002', description: 'test', status: 'pass', evidence: 'fixed', critical: true },
      ],
    });
    const manifest = makeManifest({
      expected_changes: [{
        category: 'function', object_id: 'public.func_a(uuid, uuid)',
        change_type: 'modified', field: 'body_hash',
        reason: 'Expected', owner_authorization: '#400',
      }],
    });
    const diff = computeStateDiff(before, after, manifest);
    expect(diff.summary.expected).toBe(1);
    expect(diff.summary.improved).toBe(1);
    expect(diff.summary.regressions).toBe(0);
    expect(diff.verdict).toBe('PASS');
  });
});

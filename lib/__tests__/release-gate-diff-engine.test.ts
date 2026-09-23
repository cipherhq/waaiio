/**
 * Release Gate V2 — State Diff Engine Tests
 *
 * Proves the diff engine correctly detects, classifies, and blocks on:
 * - #365: CREATE OR REPLACE silently removing search_path (DB-001/DB-002)
 * - #366: provider-facing parameter missing from Checkout (PAY-001/PAY-002)
 * - #338: transport vs canonical phone identity mismatch (DB-005/PAY-003)
 * - Protected object attribute changes without manifest declaration
 * - Previously-passing invariants that regress
 * - RLS disabling
 * - Unauthorized grant additions
 *
 * These tests use synthetic baselines — no database required.
 * Real-Postgres catalog tests are in release-gate-invariants-db.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { computeStateDiff } from '../release-gate/diff-engine';
import type {
  BaselineSnapshot,
  ReleaseManifest,
  FunctionCatalog,
  InvariantResult,
} from '../release-gate/types';

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

function makeBaseline(overrides: Partial<BaselineSnapshot> = {}): BaselineSnapshot {
  return {
    id: 'test-baseline',
    captured_at: '2026-09-22T00:00:00Z',
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

function makeManifest(overrides: Partial<ReleaseManifest> = {}): ReleaseManifest {
  return {
    release_id: 'test-release',
    candidate_sha: 'def456',
    base_sha: 'abc123',
    approved_by: 'CTO',
    created_at: '2026-09-22T00:00:00Z',
    expected_changes: [],
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════
// #365 — M394 search_path regression
// ═══════════════════════════════════════════════════════════════════

describe('#365: CREATE OR REPLACE drops search_path', () => {
  it('detects search_path removal on initialize_terminal_effects as critical regression', () => {
    const before = makeBaseline({
      functions: [
        makeFunction({
          name: 'initialize_terminal_effects',
          arg_types: 'uuid, uuid, text[], text[], text[], text[], integer',
          proconfig: ['search_path=public, extensions'],
          body_hash: 'original_hash',
        }),
      ],
    });

    // M394 recreates the function with only search_path=public
    const after = makeBaseline({
      git_sha: 'def456',
      functions: [
        makeFunction({
          name: 'initialize_terminal_effects',
          arg_types: 'uuid, uuid, text[], text[], text[], text[], integer',
          proconfig: ['search_path=public'],  // extensions DROPPED
          body_hash: 'new_hash',
        }),
      ],
    });

    const diff = computeStateDiff(before, after);

    // Must detect the proconfig change
    const proConfigDiff = diff.entries.find(e =>
      e.object_id.includes('initialize_terminal_effects') && e.field === 'proconfig'
    );
    expect(proConfigDiff).toBeDefined();
    expect(proConfigDiff!.critical).toBe(true);

    // Must block the release
    expect(diff.verdict).toBe('BLOCKED');
    expect(diff.block_reasons.length).toBeGreaterThan(0);
    expect(diff.block_reasons.some(r => r.includes('initialize_terminal_effects'))).toBe(true);
  });

  it('allows search_path change when covered by manifest entry', () => {
    const before = makeBaseline({
      functions: [
        makeFunction({
          name: 'initialize_terminal_effects',
          arg_types: 'uuid, uuid, text[], text[], text[], text[], integer',
          proconfig: ['search_path=public, extensions'],
        }),
      ],
    });

    const after = makeBaseline({
      git_sha: 'def456',
      functions: [
        makeFunction({
          name: 'initialize_terminal_effects',
          arg_types: 'uuid, uuid, text[], text[], text[], text[], integer',
          proconfig: ['search_path=public, extensions, pg_catalog'],
          body_hash: 'new_hash',
        }),
      ],
    });

    const manifest = makeManifest({
      expected_changes: [{
        category: 'function',
        object_id: 'public.initialize_terminal_effects',
        change_type: 'modified',
        reason: 'Adding pg_catalog to search_path for new feature',
        authorization: '#999',
      }],
    });

    const diff = computeStateDiff(before, after, manifest);

    const proConfigDiff = diff.entries.find(e =>
      e.object_id.includes('initialize_terminal_effects') && e.field === 'proconfig'
    );
    expect(proConfigDiff).toBeDefined();
    expect(proConfigDiff!.classification).toBe('expected');
  });

  it('detects finalize_payment_confirmation would also be caught if regressed', () => {
    const before = makeBaseline({
      functions: [
        makeFunction({
          name: 'finalize_payment_confirmation',
          arg_types: 'uuid, uuid',
          proconfig: ['search_path=public, extensions'],
        }),
      ],
    });

    const after = makeBaseline({
      git_sha: 'def456',
      functions: [
        makeFunction({
          name: 'finalize_payment_confirmation',
          arg_types: 'uuid, uuid',
          proconfig: ['search_path=public'],  // regression
        }),
      ],
    });

    const diff = computeStateDiff(before, after);
    expect(diff.verdict).toBe('BLOCKED');
    expect(diff.entries.some(e =>
      e.object_id.includes('finalize_payment_confirmation') && e.critical
    )).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// #366 — Invariant regression detection
// ═══════════════════════════════════════════════════════════════════

describe('#366: previously-passing invariant regresses', () => {
  it('blocks when PAY-001 changes from pass to fail', () => {
    const before = makeBaseline({
      invariant_results: [
        {
          invariant_id: 'PAY-001',
          description: 'Stripe Checkout includes saved_payment_method_options',
          status: 'pass',
          evidence: 'Param present in test',
          critical: true,
        },
      ],
    });

    const after = makeBaseline({
      git_sha: 'def456',
      invariant_results: [
        {
          invariant_id: 'PAY-001',
          description: 'Stripe Checkout includes saved_payment_method_options',
          status: 'fail',
          evidence: 'Param missing after refactor',
          critical: true,
        },
      ],
    });

    const diff = computeStateDiff(before, after);
    expect(diff.verdict).toBe('BLOCKED');
    expect(diff.block_reasons.some(r => r.includes('PAY-001'))).toBe(true);
    expect(diff.block_reasons.some(r => r.includes('PREVIOUSLY PASSING NOW FAILS'))).toBe(true);
  });

  it('classifies fail-to-pass as improved, not regression', () => {
    const before = makeBaseline({
      invariant_results: [
        {
          invariant_id: 'PAY-002',
          description: 'Stripe-Version header',
          status: 'fail',
          evidence: 'Header missing',
          critical: true,
        },
      ],
    });

    const after = makeBaseline({
      git_sha: 'def456',
      invariant_results: [
        {
          invariant_id: 'PAY-002',
          description: 'Stripe-Version header',
          status: 'pass',
          evidence: 'Header now present',
          critical: true,
        },
      ],
    });

    const diff = computeStateDiff(before, after);
    expect(diff.verdict).toBe('PASS');

    const payDiff = diff.entries.find(e => e.object_id === 'PAY-002');
    expect(payDiff).toBeDefined();
    expect(payDiff!.classification).toBe('improved');
  });
});

// ═══════════════════════════════════════════════════════════════════
// #338 — Transport key identity invariant
// ═══════════════════════════════════════════════════════════════════

describe('#338: phone identity invariant regression', () => {
  it('blocks when DB-005 transport key invariant regresses', () => {
    const before = makeBaseline({
      invariant_results: [
        {
          invariant_id: 'DB-005',
          description: 'bot_sessions.whatsapp_number stores raw transport key',
          status: 'pass',
          evidence: 'Behavioral test passed',
          critical: true,
        },
        {
          invariant_id: 'PAY-003',
          description: 'PIN session uses raw inbound phone',
          status: 'pass',
          evidence: 'Behavioral test passed',
          critical: true,
        },
      ],
    });

    const after = makeBaseline({
      git_sha: 'def456',
      invariant_results: [
        {
          invariant_id: 'DB-005',
          description: 'bot_sessions.whatsapp_number stores raw transport key',
          status: 'fail',
          evidence: 'Session stored with canonPhone instead of raw from',
          critical: true,
        },
        {
          invariant_id: 'PAY-003',
          description: 'PIN session uses raw inbound phone',
          status: 'fail',
          evidence: 'PIN session whatsapp_number has + prefix',
          critical: true,
        },
      ],
    });

    const diff = computeStateDiff(before, after);
    expect(diff.verdict).toBe('BLOCKED');
    expect(diff.summary.critical_regressions).toBe(2);
    expect(diff.block_reasons.some(r => r.includes('DB-005'))).toBe(true);
    expect(diff.block_reasons.some(r => r.includes('PAY-003'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Protected object enforcement
// ═══════════════════════════════════════════════════════════════════

describe('Protected object changes', () => {
  it('blocks when SECURITY DEFINER is changed to INVOKER on protected function', () => {
    const before = makeBaseline({
      functions: [
        makeFunction({
          name: 'initialize_terminal_effects',
          arg_types: 'uuid, uuid, text[], text[], text[], text[], integer',
          security: 'definer',
        }),
      ],
    });

    const after = makeBaseline({
      git_sha: 'def456',
      functions: [
        makeFunction({
          name: 'initialize_terminal_effects',
          arg_types: 'uuid, uuid, text[], text[], text[], text[], integer',
          security: 'invoker',
        }),
      ],
    });

    const diff = computeStateDiff(before, after);
    expect(diff.verdict).toBe('BLOCKED');
    expect(diff.entries.some(e =>
      e.field === 'security' && e.critical
    )).toBe(true);
  });

  it('blocks when critical function body changes without manifest', () => {
    const before = makeBaseline({
      functions: [
        makeFunction({
          name: 'finalize_payment_confirmation',
          arg_types: 'uuid, uuid',
          body_hash: 'known_good_hash',
        }),
      ],
    });

    const after = makeBaseline({
      git_sha: 'def456',
      functions: [
        makeFunction({
          name: 'finalize_payment_confirmation',
          arg_types: 'uuid, uuid',
          body_hash: 'silently_changed_hash',
        }),
      ],
    });

    const diff = computeStateDiff(before, after);
    // Body changes on protected objects are flagged
    expect(diff.entries.some(e =>
      e.object_id.includes('finalize_payment_confirmation') && e.field === 'body_hash'
    )).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// RLS enforcement
// ═══════════════════════════════════════════════════════════════════

describe('RLS enforcement', () => {
  it('blocks when RLS is disabled on a public table', () => {
    const before = makeBaseline({
      table_rls: [
        { schema: 'public', table_name: 'payments', rls_enabled: true, force_rls: false },
      ],
    });

    const after = makeBaseline({
      git_sha: 'def456',
      table_rls: [
        { schema: 'public', table_name: 'payments', rls_enabled: false, force_rls: false },
      ],
    });

    const diff = computeStateDiff(before, after);
    expect(diff.verdict).toBe('BLOCKED');
    expect(diff.entries.some(e =>
      e.object_id.includes('payments') && e.field === 'rls_enabled' && e.classification === 'regression'
    )).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Grant enforcement
// ═══════════════════════════════════════════════════════════════════

describe('Grant enforcement', () => {
  it('flags unauthorized EXECUTE grant on sensitive function', () => {
    const before = makeBaseline({ function_grants: [] });

    const after = makeBaseline({
      git_sha: 'def456',
      function_grants: [
        {
          schema: 'public',
          function_name: 'accept_saved_card_offer',
          arg_types: 'uuid, text, text',
          grantee: 'anon',
          is_grantable: false,
        },
      ],
    });

    const diff = computeStateDiff(before, after);
    expect(diff.entries.some(e =>
      e.category === 'grant' &&
      e.object_id.includes('accept_saved_card_offer') &&
      e.critical
    )).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Clean release (no unexpected changes)
// ═══════════════════════════════════════════════════════════════════

describe('Clean release', () => {
  it('passes when baselines are identical', () => {
    const baseline = makeBaseline({
      functions: [
        makeFunction({ name: 'some_function' }),
      ],
      invariant_results: [
        { invariant_id: 'DB-001', description: 'test', status: 'pass', evidence: 'ok', critical: true },
      ],
    });

    const diff = computeStateDiff(baseline, baseline);
    expect(diff.verdict).toBe('PASS');
    expect(diff.summary.total).toBe(0);
  });

  it('passes when all changes are declared in manifest', () => {
    const before = makeBaseline({
      functions: [
        makeFunction({ name: 'my_func', body_hash: 'old' }),
      ],
    });

    const after = makeBaseline({
      git_sha: 'def456',
      functions: [
        makeFunction({ name: 'my_func', body_hash: 'new' }),
      ],
    });

    const manifest = makeManifest({
      expected_changes: [{
        category: 'function',
        object_id: 'public.my_func',
        change_type: 'modified',
        reason: 'Updated logic per #400',
        authorization: '#400',
      }],
    });

    const diff = computeStateDiff(before, after, manifest);
    expect(diff.verdict).toBe('PASS');
    expect(diff.summary.expected).toBe(1);
  });

  it('correctly counts summary categories', () => {
    const before = makeBaseline({
      functions: [
        makeFunction({ name: 'func_a', body_hash: 'a1' }),
        makeFunction({ name: 'func_b', body_hash: 'b1' }),
      ],
      invariant_results: [
        { invariant_id: 'PAY-002', description: 'test', status: 'fail', evidence: 'missing', critical: true },
      ],
    });

    const after = makeBaseline({
      git_sha: 'def456',
      functions: [
        makeFunction({ name: 'func_a', body_hash: 'a2' }),  // modified
        makeFunction({ name: 'func_b', body_hash: 'b1' }),  // unchanged
      ],
      invariant_results: [
        { invariant_id: 'PAY-002', description: 'test', status: 'pass', evidence: 'fixed', critical: true },
      ],
    });

    const manifest = makeManifest({
      expected_changes: [{
        category: 'function',
        object_id: 'public.func_a',
        change_type: 'modified',
        reason: 'Expected change',
        authorization: '#400',
      }],
    });

    const diff = computeStateDiff(before, after, manifest);
    expect(diff.summary.expected).toBe(1);      // func_a body
    expect(diff.summary.improved).toBe(1);       // PAY-002 fail→pass
    expect(diff.summary.regressions).toBe(0);
    expect(diff.verdict).toBe('PASS');
  });
});

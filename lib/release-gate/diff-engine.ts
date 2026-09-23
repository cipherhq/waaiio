/**
 * Release Gate V2 — State Diff Engine
 *
 * Compares two baseline snapshots and produces a classified diff.
 * Every difference is classified as expected (covered by manifest),
 * unexpected, improved, or regression.
 *
 * Critical regressions block the release gate automatically.
 * Green unit tests cannot override a failed state-diff gate.
 *
 * Phase 1 scope: functions, function grants, table RLS, invariant status.
 * NOT in Phase 1 scope: RLS policy bodies, constraints, triggers,
 * extensions, cron jobs, migrations, journey results.
 * The certificate honestly declares which surfaces were checked.
 *
 * @see RELEASE_GATE_V2.md §8.4 (Automatic Delta)
 */

import { randomUUID } from 'crypto';
import type {
  BaselineSnapshot,
  ReleaseManifest,
  ExpectedChange,
  StateDiffEntry,
  StateDiffResult,
  DiffClassification,
  FunctionCatalog,
  FunctionGrant,
  TableRls,
  InvariantResult,
} from './types';
import { PROTECTED_OBJECTS } from './invariant-registry';

// ═══════════════════════════════════════════════════════════════════
// Phase 1 scope declaration
// ═══════════════════════════════════════════════════════════════════

/** Surfaces the Phase 1 diff engine actually checks */
export const PHASE1_SCOPE = {
  functions: true,
  function_grants: true,
  table_rls: true,
  rls_policies: false,   // Phase 2
  constraints: false,     // Phase 2
  triggers: false,        // Phase 2
  extensions: false,      // Phase 2
  cron_jobs: false,       // Phase 2
  invariants: true,
  journeys: false,        // Phase 2
} as const;

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

function functionKey(f: FunctionCatalog): string {
  return `${f.schema}.${f.name}(${f.arg_types})`;
}

/** Overload-safe grant key: includes arg_types and grantability */
function grantKey(g: FunctionGrant): string {
  return `${g.schema}.${g.function_name}(${g.arg_types})→${g.grantee}[${g.is_grantable ? 'grantable' : 'no-grant'}]`;
}

/** Simpler grant identity for diff (without grantability — grantability is a field) */
function grantIdentity(g: FunctionGrant): string {
  return `${g.schema}.${g.function_name}(${g.arg_types})→${g.grantee}`;
}

function rlsKey(t: TableRls): string {
  return `${t.schema}.${t.table_name}`;
}

function isProtectedObject(objectId: string): boolean {
  return PROTECTED_OBJECTS.some(o => o.identifier === objectId);
}

/** Protected safety properties that can NEVER be blanket-waived by a generic
 *  function modification manifest entry. These require their own specific
 *  field-level manifest entry with exact expected before/after values. */
const PROTECTED_SAFETY_FIELDS = new Set(['security', 'proconfig', 'owner']);

/**
 * Check if a specific diff entry is covered by a manifest entry.
 * Requires EXACT object_id match (no substring), exact field match for
 * modifications, and validates expected before/after when provided.
 */
function isExpectedChange(
  manifest: ReleaseManifest | null,
  category: StateDiffEntry['category'],
  objectId: string,
  field: string,
  before: string,
  after: string,
  changeType: StateDiffEntry['change_type'],
): { matched: boolean; entry?: string } {
  if (!manifest) return { matched: false };

  const match = manifest.expected_changes.find((ec: ExpectedChange) => {
    // Exact category match
    if (ec.category !== category) return false;
    // Exact object_id match — NO substring/prefix matching
    if (ec.object_id !== objectId) return false;
    // Change type must match
    if (ec.change_type !== changeType) return false;
    // For modifications: field must match if specified in manifest
    if (changeType === 'modified') {
      if (ec.field && ec.field !== field) return false;
      // If manifest doesn't specify field, it cannot waive protected safety fields
      if (!ec.field && PROTECTED_SAFETY_FIELDS.has(field)) return false;
    }
    // Validate expected before/after if provided
    if (ec.expected_before !== undefined && ec.expected_before !== before) return false;
    if (ec.expected_after !== undefined && ec.expected_after !== after) return false;
    return true;
  });

  return match
    ? { matched: true, entry: `${match.category}:${match.object_id}:${match.field || '*'} (${match.reason}) [auth: ${match.owner_authorization}]` }
    : { matched: false };
}

function classifyDiff(
  category: StateDiffEntry['category'],
  objectId: string,
  field: string,
  before: string,
  after: string,
  manifest: ReleaseManifest | null,
  changeType: StateDiffEntry['change_type'],
): { classification: DiffClassification; critical: boolean; manifestEntry?: string } {

  const expected = isExpectedChange(manifest, category, objectId, field, before, after, changeType);

  if (expected.matched) {
    return { classification: 'expected', critical: false, manifestEntry: expected.entry };
  }

  // Invariant/journey regressions
  if (category === 'invariant' || category === 'journey') {
    if (before === 'pass' && after === 'fail') {
      return { classification: 'regression', critical: true };
    }
    if (before === 'fail' && after === 'pass') {
      return { classification: 'improved', critical: false };
    }
  }

  // Protected object changes are always critical if unexpected
  if (isProtectedObject(objectId)) {
    return { classification: 'unexpected', critical: true };
  }

  // Function security/search_path/owner changes are critical
  if (category === 'function' && PROTECTED_SAFETY_FIELDS.has(field)) {
    return { classification: 'unexpected', critical: true };
  }

  // Grant changes are critical
  if (category === 'grant') {
    return { classification: 'unexpected', critical: true };
  }

  // RLS disabling is critical
  if (category === 'rls' && field === 'rls_enabled' && after === 'false') {
    return { classification: 'regression', critical: true };
  }

  // Other changes are unexpected but not necessarily critical
  return { classification: 'unexpected', critical: false };
}

// ═══════════════════════════════════════════════════════════════════
// Diff Computation
// ═══════════════════════════════════════════════════════════════════

function diffFunctions(
  before: FunctionCatalog[],
  after: FunctionCatalog[],
  manifest: ReleaseManifest | null,
): StateDiffEntry[] {
  const entries: StateDiffEntry[] = [];
  const beforeMap = new Map(before.map(f => [functionKey(f), f]));
  const afterMap = new Map(after.map(f => [functionKey(f), f]));

  // Removed functions
  for (const [key] of Array.from(beforeMap)) {
    if (!afterMap.has(key)) {
      const { classification, critical, manifestEntry } = classifyDiff(
        'function', key, 'existence', 'present', 'absent', manifest, 'removed',
      );
      entries.push({
        category: 'function', object_id: key, change_type: 'removed',
        field: 'existence', before: 'present', after: 'absent',
        classification, critical, manifest_entry: manifestEntry,
      });
    }
  }

  // Added functions
  for (const [key] of Array.from(afterMap)) {
    if (!beforeMap.has(key)) {
      const { classification, critical, manifestEntry } = classifyDiff(
        'function', key, 'existence', 'absent', 'present', manifest, 'added',
      );
      entries.push({
        category: 'function', object_id: key, change_type: 'added',
        field: 'existence', before: 'absent', after: 'present',
        classification, critical, manifest_entry: manifestEntry,
      });
    }
  }

  // Modified functions — each field is diffed independently
  for (const [key, bf] of Array.from(beforeMap)) {
    const af = afterMap.get(key);
    if (!af) continue;

    const fields: Array<{ field: string; bv: string; av: string }> = [];

    if (bf.security !== af.security) {
      fields.push({ field: 'security', bv: bf.security, av: af.security });
    }
    if (JSON.stringify(bf.proconfig) !== JSON.stringify(af.proconfig)) {
      fields.push({ field: 'proconfig', bv: JSON.stringify(bf.proconfig), av: JSON.stringify(af.proconfig) });
    }
    if (bf.body_hash !== af.body_hash) {
      fields.push({ field: 'body_hash', bv: bf.body_hash, av: af.body_hash });
    }
    if (bf.owner !== af.owner) {
      fields.push({ field: 'owner', bv: bf.owner, av: af.owner });
    }

    for (const { field, bv, av } of fields) {
      const { classification, critical, manifestEntry } = classifyDiff(
        'function', key, field, bv, av, manifest, 'modified',
      );
      entries.push({
        category: 'function', object_id: key, change_type: 'modified',
        field, before: bv, after: av,
        classification, critical, manifest_entry: manifestEntry,
      });
    }
  }

  return entries;
}

function diffGrants(
  before: FunctionGrant[],
  after: FunctionGrant[],
  manifest: ReleaseManifest | null,
): StateDiffEntry[] {
  const entries: StateDiffEntry[] = [];
  const beforeMap = new Map(before.map(g => [grantIdentity(g), g]));
  const afterMap = new Map(after.map(g => [grantIdentity(g), g]));

  // Removed grants
  for (const [key] of Array.from(beforeMap)) {
    if (!afterMap.has(key)) {
      const { classification, critical, manifestEntry } = classifyDiff(
        'grant', key, 'existence', 'granted', 'revoked', manifest, 'removed',
      );
      entries.push({
        category: 'grant', object_id: key, change_type: 'removed',
        field: 'existence', before: 'granted', after: 'revoked',
        classification, critical, manifest_entry: manifestEntry,
      });
    }
  }

  // Added grants
  for (const [key] of Array.from(afterMap)) {
    if (!beforeMap.has(key)) {
      const { classification, critical, manifestEntry } = classifyDiff(
        'grant', key, 'existence', 'absent', 'granted', manifest, 'added',
      );
      entries.push({
        category: 'grant', object_id: key, change_type: 'added',
        field: 'existence', before: 'absent', after: 'granted',
        classification, critical, manifest_entry: manifestEntry,
      });
    }
  }

  // Changed grantability
  for (const [key, bg] of Array.from(beforeMap)) {
    const ag = afterMap.get(key);
    if (!ag) continue;
    if (bg.is_grantable !== ag.is_grantable) {
      const { classification, critical, manifestEntry } = classifyDiff(
        'grant', key, 'is_grantable', String(bg.is_grantable), String(ag.is_grantable), manifest, 'modified',
      );
      entries.push({
        category: 'grant', object_id: key, change_type: 'modified',
        field: 'is_grantable', before: String(bg.is_grantable), after: String(ag.is_grantable),
        classification, critical, manifest_entry: manifestEntry,
      });
    }
  }

  return entries;
}

function diffTableRls(
  before: TableRls[],
  after: TableRls[],
  manifest: ReleaseManifest | null,
): StateDiffEntry[] {
  const entries: StateDiffEntry[] = [];
  const beforeMap = new Map(before.map(t => [rlsKey(t), t]));
  const afterMap = new Map(after.map(t => [rlsKey(t), t]));

  for (const [key, bt] of Array.from(beforeMap)) {
    const at = afterMap.get(key);
    if (!at) continue;

    if (bt.rls_enabled !== at.rls_enabled) {
      const { classification, critical, manifestEntry } = classifyDiff(
        'rls', key, 'rls_enabled', String(bt.rls_enabled), String(at.rls_enabled), manifest, 'modified',
      );
      entries.push({
        category: 'rls', object_id: key, change_type: 'modified',
        field: 'rls_enabled', before: String(bt.rls_enabled), after: String(at.rls_enabled),
        classification, critical, manifest_entry: manifestEntry,
      });
    }
  }

  return entries;
}

function diffInvariants(
  before: InvariantResult[],
  after: InvariantResult[],
  manifest: ReleaseManifest | null,
): StateDiffEntry[] {
  const entries: StateDiffEntry[] = [];
  const beforeMap = new Map(before.map(i => [i.invariant_id, i]));
  const afterMap = new Map(after.map(i => [i.invariant_id, i]));

  for (const [id, bi] of Array.from(beforeMap)) {
    const ai = afterMap.get(id);
    if (!ai) continue;

    if (bi.status !== ai.status) {
      const { classification, critical, manifestEntry } = classifyDiff(
        'invariant', id, 'status', bi.status, ai.status, manifest, 'modified',
      );
      entries.push({
        category: 'invariant', object_id: id, change_type: 'modified',
        field: 'status', before: bi.status, after: ai.status,
        classification, critical, manifest_entry: manifestEntry,
      });
    }
  }

  return entries;
}

// ═══════════════════════════════════════════════════════════════════
// Main Diff
// ═══════════════════════════════════════════════════════════════════

export function computeStateDiff(
  before: BaselineSnapshot,
  after: BaselineSnapshot,
  manifest: ReleaseManifest | null = null,
): StateDiffResult {
  const entries: StateDiffEntry[] = [
    ...diffFunctions(before.functions, after.functions, manifest),
    ...diffGrants(before.function_grants, after.function_grants, manifest),
    ...diffTableRls(before.table_rls, after.table_rls, manifest),
    ...diffInvariants(before.invariant_results, after.invariant_results, manifest),
  ];

  const summary = {
    total: entries.length,
    expected: entries.filter(e => e.classification === 'expected').length,
    unexpected: entries.filter(e => e.classification === 'unexpected').length,
    improved: entries.filter(e => e.classification === 'improved').length,
    regressions: entries.filter(e => e.classification === 'regression').length,
    critical_regressions: entries.filter(e => e.classification === 'regression' && e.critical).length,
  };

  // Determine verdict
  const criticalUnexpected = entries.filter(e => e.critical && e.classification !== 'expected' && e.classification !== 'improved');
  const blockReasons: string[] = [];

  if (summary.critical_regressions > 0) {
    blockReasons.push(`${summary.critical_regressions} critical regression(s) detected`);
  }

  for (const entry of criticalUnexpected) {
    if (entry.classification === 'regression') {
      blockReasons.push(`REGRESSION: ${entry.category} ${entry.object_id} — ${entry.field}: ${entry.before} → ${entry.after}`);
    } else if (entry.classification === 'unexpected') {
      blockReasons.push(`UNEXPECTED CRITICAL: ${entry.category} ${entry.object_id} — ${entry.field}: ${entry.before} → ${entry.after}`);
    }
  }

  // Previous-passing-must-stay-passing rule
  const passToFail = entries.filter(e =>
    (e.category === 'invariant' || e.category === 'journey') &&
    e.before === 'pass' && e.after === 'fail'
  );
  for (const pf of passToFail) {
    blockReasons.push(`PREVIOUSLY PASSING NOW FAILS: ${pf.object_id} (${pf.category})`);
  }

  return {
    id: randomUUID(),
    computed_at: new Date().toISOString(),
    before_baseline_id: before.id,
    before_sha: before.git_sha,
    after_baseline_id: after.id,
    after_sha: after.git_sha,
    manifest_id: manifest?.release_id || null,
    entries,
    summary,
    verdict: blockReasons.length > 0 ? 'BLOCKED' : 'PASS',
    block_reasons: blockReasons,
  };
}

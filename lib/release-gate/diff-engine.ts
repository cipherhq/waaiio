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
 * @see RELEASE_GATE_V2.md §8.4 (Automatic Delta)
 */

import { randomUUID } from 'crypto';
import type {
  BaselineSnapshot,
  ReleaseManifest,
  StateDiffEntry,
  StateDiffResult,
  DiffClassification,
  FunctionCatalog,
  FunctionGrant,
  TableRls,
  RlsPolicy,
  InvariantResult,
} from './types';
import { PROTECTED_OBJECTS } from './invariant-registry';

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

function functionKey(f: FunctionCatalog): string {
  return `${f.schema}.${f.name}(${f.arg_types})`;
}

function grantKey(g: FunctionGrant): string {
  return `${g.schema}.${g.function_name}→${g.grantee}`;
}

function rlsKey(t: TableRls): string {
  return `${t.schema}.${t.table_name}`;
}

function policyKey(p: RlsPolicy): string {
  return `${p.schema}.${p.table_name}.${p.policy_name}`;
}

function isProtectedObject(objectId: string): boolean {
  return PROTECTED_OBJECTS.some(o => o.identifier === objectId || objectId.includes(o.identifier.split('(')[0]));
}

function isExpectedChange(
  manifest: ReleaseManifest | null,
  category: StateDiffEntry['category'],
  objectId: string,
  changeType: StateDiffEntry['change_type'],
): { matched: boolean; entry?: string } {
  if (!manifest) return { matched: false };

  const match = manifest.expected_changes.find(ec =>
    ec.category === category &&
    (ec.object_id === objectId || objectId.includes(ec.object_id)) &&
    ec.change_type === changeType
  );

  return match
    ? { matched: true, entry: `${match.category}:${match.object_id} (${match.reason})` }
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

  const expected = isExpectedChange(manifest, category, objectId, changeType);

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

  // Function security/search_path changes are critical
  if (category === 'function' && (field === 'security' || field === 'proconfig')) {
    return { classification: 'unexpected', critical: true };
  }

  // Grant changes on critical functions are critical
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
  for (const [key, bf] of Array.from(beforeMap)) {
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
  for (const [key, af] of Array.from(afterMap)) {
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

  // Modified functions
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
  const beforeSet = new Set(before.map(grantKey));
  const afterSet = new Set(after.map(grantKey));

  for (const key of Array.from(beforeSet)) {
    if (!afterSet.has(key)) {
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

  for (const key of Array.from(afterSet)) {
    if (!beforeSet.has(key)) {
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

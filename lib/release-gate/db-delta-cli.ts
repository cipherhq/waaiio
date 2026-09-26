/**
 * Release Gate V2 — DB Delta CLI
 *
 * Orchestrates base→candidate database state comparison for PR CI.
 *
 * 1. Detects candidate migrations (added in PR) via NUL-safe git diff
 * 2. Applies base SHA's exact migration blobs to a clean delta DB
 * 3. Captures base baseline
 * 4. Applies candidate-only migrations from HEAD checkout
 * 5. Captures candidate baseline
 * 6. Computes Phase 1 state diff
 * 7. Writes artifacts + human summary
 *
 * Advisory mode: diff verdicts are reported but do not fail CI.
 * Tooling/capture/migration errors DO fail (non-zero exit).
 *
 * Usage:
 *   npx tsx lib/release-gate/db-delta-cli.ts \
 *     --base-sha <sha> --head-sha <sha> --db-url <url>
 *
 * @see RELEASE_GATE_V2.md §8.4
 */

import { execSync } from 'child_process';
import { writeFileSync, readFileSync } from 'fs';
import { resolve, basename } from 'path';
import { captureBaseline, runSQL } from './baseline-capture';
import { computeStateDiff } from './diff-engine';
import type { BaselineSnapshot, StateDiffResult } from './types';

// ═══════════════════════════════════════════════════════════════════
// CLI argument parsing
// ═══════════════════════════════════════════════════════════════════

interface CliArgs {
  baseSha: string;
  headSha: string;
  dbUrl: string;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let baseSha = '';
  let headSha = '';
  let dbUrl = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--base-sha' && args[i + 1]) baseSha = args[++i];
    else if (args[i] === '--head-sha' && args[i + 1]) headSha = args[++i];
    else if (args[i] === '--db-url' && args[i + 1]) dbUrl = args[++i];
  }

  if (!baseSha || !headSha || !dbUrl) {
    process.stderr.write('Usage: db-delta-cli.ts --base-sha <sha> --head-sha <sha> --db-url <url>\n');
    process.exit(1);
  }

  return { baseSha, headSha, dbUrl };
}

// ═══════════════════════════════════════════════════════════════════
// Migration detection (NUL-safe git diff)
// ═══════════════════════════════════════════════════════════════════

interface MigrationDelta {
  added: string[];       // filenames of new migrations
  modified: string[];    // filenames of modified existing migrations (error)
  deleted: string[];     // filenames of deleted migrations (error)
  renamed: string[];     // filenames of renamed/copied migrations (error)
}

/** Parse raw NUL-delimited git diff --name-status output into a MigrationDelta.
 *  Exported for direct testing of the parser. */
export function detectMigrationChangesRaw(raw: string): MigrationDelta {
  const result: MigrationDelta = { added: [], modified: [], deleted: [], renamed: [] };
  if (!raw.trim()) return result;

  const parts = raw.split('\0').filter(Boolean);
  let i = 0;
  while (i < parts.length) {
    const status = parts[i].trim();
    if (i + 1 >= parts.length) break;

    if (status === 'A') {
      result.added.push(basename(parts[i + 1].trim()));
      i += 2;
    } else if (status === 'M') {
      result.modified.push(basename(parts[i + 1].trim()));
      i += 2;
    } else if (status === 'D') {
      result.deleted.push(basename(parts[i + 1].trim()));
      i += 2;
    } else if (status.startsWith('R') || status.startsWith('C')) {
      // Rename/copy: consumes two paths (old and new)
      if (i + 2 >= parts.length) break;
      const oldFile = basename(parts[i + 1].trim());
      const newFile = basename(parts[i + 2].trim());
      result.renamed.push(`${oldFile} → ${newFile}`);
      i += 3;
    } else {
      // Unknown status — fail closed: treat as modified
      result.modified.push(basename(parts[i + 1].trim()));
      i += 2;
    }
  }

  result.added.sort();
  result.modified.sort();
  result.deleted.sort();
  result.renamed.sort();
  return result;
}

export function detectMigrationChanges(baseSha: string, headSha: string): MigrationDelta {
  let raw: string;
  try {
    raw = execSync(
      `git diff --name-status -z "${baseSha}" "${headSha}" -- 'supabase/migrations/*.sql'`,
      { encoding: 'utf-8', timeout: 30000 },
    );
  } catch {
    throw new Error(`Failed to detect migration changes between ${baseSha} and ${headSha}`);
  }

  return detectMigrationChangesRaw(raw);
}

// ═══════════════════════════════════════════════════════════════════
// Base migration enumeration (from base SHA's exact blobs)
// ═══════════════════════════════════════════════════════════════════

export function enumerateBaseMigrations(baseSha: string, cwd?: string): string[] {
  let raw: string;
  try {
    raw = execSync(
      `git ls-tree --name-only "${baseSha}" -- supabase/migrations/`,
      { encoding: 'utf-8', timeout: 30000, cwd },
    );
  } catch {
    throw new Error(`Failed to enumerate migrations at base SHA ${baseSha}`);
  }

  return raw
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.endsWith('.sql'))
    .sort();
}

function getBaseMigrationContent(baseSha: string, path: string): string {
  try {
    return execSync(
      `git show "${baseSha}:${path}"`,
      { encoding: 'utf-8', timeout: 30000 },
    );
  } catch {
    throw new Error(`Failed to read ${path} at SHA ${baseSha}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// Migration application
// ═══════════════════════════════════════════════════════════════════

function applySQL(dbUrl: string, sql: string, label: string): void {
  try {
    execSync(
      `psql "${dbUrl}" -q -v ON_ERROR_STOP=1`,
      { input: sql, encoding: 'utf-8', timeout: 60000 },
    );
  } catch (err: unknown) {
    const e = err as { stderr?: string; status?: number };
    throw new Error(`Migration application failed [${label}]: ${e.stderr || 'unknown error'}`);
  }
}

function applyBaseMigrations(dbUrl: string, baseSha: string, migrations: string[]): number {
  let applied = 0;
  for (const path of migrations) {
    const content = getBaseMigrationContent(baseSha, path);
    const file = basename(path);
    applySQL(dbUrl, content, file);
    applied++;
  }
  return applied;
}

function getCandidateMigrationContent(headSha: string, file: string): string {
  const path = `supabase/migrations/${file}`;
  try {
    return execSync(
      `git show "${headSha}:${path}"`,
      { encoding: 'utf-8', timeout: 30000 },
    );
  } catch {
    throw new Error(`Failed to read candidate migration ${path} at SHA ${headSha}`);
  }
}

function applyCandidateMigrations(dbUrl: string, headSha: string, migrationFiles: string[]): number {
  let applied = 0;
  for (const file of migrationFiles) {
    const content = getCandidateMigrationContent(headSha, file);
    applySQL(dbUrl, content, file);
    applied++;
  }
  return applied;
}

// ═══════════════════════════════════════════════════════════════════
// Bootstrap
// ═══════════════════════════════════════════════════════════════════

function bootstrapDeltaDb(dbUrl: string): void {
  const bootstrapPath = resolve(__dirname, 'ci-bootstrap.sql');
  const sql = readFileSync(bootstrapPath, 'utf-8');
  applySQL(dbUrl, sql, 'ci-bootstrap.sql');
}

// ═══════════════════════════════════════════════════════════════════
// Artifact writing
// ═══════════════════════════════════════════════════════════════════

export interface DeltaArtifact {
  baseSha: string;
  headSha: string;
  migrationDelta: MigrationDelta;
  baseBaseline: BaselineSnapshot | null;
  candidateBaseline: BaselineSnapshot | null;
  baseStats: { functions: number; grants: number; rls: number; policies: number; constraints: number; triggers: number };
  candidateStats: { functions: number; grants: number; rls: number; policies: number; constraints: number; triggers: number };
  diff: StateDiffResult;
  noOp: boolean;
}

function snapshotStats(snap: BaselineSnapshot) {
  return {
    functions: snap.functions.length,
    grants: snap.function_grants.length,
    rls: snap.table_rls.length,
    policies: snap.rls_policies.length,
    constraints: snap.constraints.length,
    triggers: snap.triggers.length,
  };
}

function printSummary(artifact: DeltaArtifact): void {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  DB Delta Analysis — Phase 1 (Advisory)');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Base SHA:      ${artifact.baseSha}`);
  console.log(`  Head SHA:      ${artifact.headSha}`);
  console.log(`  Migrations:    +${artifact.migrationDelta.added.length} added`);

  if (artifact.noOp) {
    console.log('  Result:        No migration changes — no delta to analyze');
    console.log('═══════════════════════════════════════════════════════════');
    return;
  }

  console.log('');
  console.log('  Base state:');
  console.log(`    functions=${artifact.baseStats.functions} grants=${artifact.baseStats.grants} rls=${artifact.baseStats.rls}`);
  console.log(`    policies=${artifact.baseStats.policies} constraints=${artifact.baseStats.constraints} triggers=${artifact.baseStats.triggers}`);
  console.log('  Candidate state:');
  console.log(`    functions=${artifact.candidateStats.functions} grants=${artifact.candidateStats.grants} rls=${artifact.candidateStats.rls}`);
  console.log(`    policies=${artifact.candidateStats.policies} constraints=${artifact.candidateStats.constraints} triggers=${artifact.candidateStats.triggers}`);
  console.log('');
  console.log(`  Verdict:       ${artifact.diff.verdict} (advisory — does not fail CI)`);
  console.log(`  Total diffs:   ${artifact.diff.summary.total}`);
  console.log(`  Expected:      ${artifact.diff.summary.expected}`);
  console.log(`  Unexpected:    ${artifact.diff.summary.unexpected}`);
  console.log(`  Improved:      ${artifact.diff.summary.improved}`);
  console.log(`  Regressions:   ${artifact.diff.summary.regressions}`);

  if (artifact.diff.entries.length > 0) {
    console.log('');
    console.log('  Entries:');
    for (const e of artifact.diff.entries) {
      const crit = e.critical ? ' [CRITICAL]' : '';
      console.log(`    ${e.classification.toUpperCase()} ${e.category} ${e.object_id} ${e.field}: ${e.before} → ${e.after}${crit}`);
    }
  }

  if (artifact.diff.block_reasons.length > 0) {
    console.log('');
    console.log('  Block reasons (advisory):');
    for (const r of artifact.diff.block_reasons) {
      console.log(`    - ${r}`);
    }
  }

  console.log('═══════════════════════════════════════════════════════════');
}

// ═══════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════

export async function runDbDelta(args: CliArgs & { _overrideDelta?: MigrationDelta }): Promise<DeltaArtifact> {
  const { baseSha, headSha, dbUrl, _overrideDelta } = args;

  // Step 1: Detect migration changes (or use test override)
  console.log(`Detecting migration changes: ${baseSha.substring(0, 8)}..${headSha.substring(0, 8)}`);
  const delta = _overrideDelta ?? detectMigrationChanges(baseSha, headSha);

  // Reject modified/deleted/renamed existing migrations — fail closed
  if (delta.modified.length > 0) {
    throw new Error(
      `GATE ERROR: ${delta.modified.length} existing migration(s) modified — immutability violation: ${delta.modified.join(', ')}`
    );
  }
  if (delta.deleted.length > 0) {
    throw new Error(
      `GATE ERROR: ${delta.deleted.length} existing migration(s) deleted: ${delta.deleted.join(', ')}`
    );
  }
  if (delta.renamed.length > 0) {
    throw new Error(
      `GATE ERROR: ${delta.renamed.length} existing migration(s) renamed/copied — immutability violation: ${delta.renamed.join(', ')}`
    );
  }

  // No-op: no candidate migration additions
  if (delta.added.length === 0) {
    console.log('No migration additions detected — no delta to analyze.');
    const noOpArtifact: DeltaArtifact = {
      baseSha, headSha, migrationDelta: delta,
      baseBaseline: null, candidateBaseline: null,
      baseStats: { functions: 0, grants: 0, rls: 0, policies: 0, constraints: 0, triggers: 0 },
      candidateStats: { functions: 0, grants: 0, rls: 0, policies: 0, constraints: 0, triggers: 0 },
      diff: {
        id: 'no-op', computed_at: new Date().toISOString(),
        before_baseline_id: '', before_sha: baseSha,
        after_baseline_id: '', after_sha: headSha,
        manifest_id: null, entries: [],
        summary: { total: 0, expected: 0, unexpected: 0, improved: 0, regressions: 0, critical_regressions: 0 },
        verdict: 'PASS', block_reasons: [],
      },
      noOp: true,
    };
    return noOpArtifact;
  }

  console.log(`Found ${delta.added.length} candidate migration(s): ${delta.added.join(', ')}`);

  // Step 2: Bootstrap delta database
  console.log('Bootstrapping delta database...');
  bootstrapDeltaDb(dbUrl);

  // Step 3: Apply base SHA's exact migration blobs
  console.log(`Enumerating base migrations at ${baseSha.substring(0, 8)}...`);
  const baseMigrations = enumerateBaseMigrations(baseSha);
  console.log(`Applying ${baseMigrations.length} base migrations...`);
  const baseApplied = applyBaseMigrations(dbUrl, baseSha, baseMigrations);
  console.log(`Applied ${baseApplied} base migrations.`);

  // Step 4: Capture base baseline
  console.log('Capturing base baseline...');
  const baseBaseline = captureBaseline({
    dbUrl, gitSha: baseSha, phase: 'pre_deployment',
    label: `Base at ${baseSha.substring(0, 8)} (${baseApplied} migrations)`,
  });

  // Step 5: Apply candidate-only migrations from HEAD checkout
  console.log(`Applying ${delta.added.length} candidate migration(s)...`);
  const candApplied = applyCandidateMigrations(dbUrl, headSha, delta.added);
  console.log(`Applied ${candApplied} candidate migration(s).`);

  // Step 6: Capture candidate baseline
  console.log('Capturing candidate baseline...');
  const candidateBaseline = captureBaseline({
    dbUrl, gitSha: headSha, phase: 'candidate',
    label: `Candidate at ${headSha.substring(0, 8)} (+${candApplied} migrations)`,
  });

  // Step 7: Compute diff
  console.log('Computing state diff...');
  const diff = computeStateDiff(baseBaseline, candidateBaseline, null);

  return {
    baseSha, headSha, migrationDelta: delta,
    baseBaseline, candidateBaseline,
    baseStats: snapshotStats(baseBaseline),
    candidateStats: snapshotStats(candidateBaseline),
    diff,
    noOp: false,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Exit decision (pure, testable)
// ═══════════════════════════════════════════════════════════════════

/** Advisory mode: diff verdicts (PASS or BLOCKED) always exit 0.
 *  Only tooling/capture/migration errors exit non-zero. */
export function advisoryExitCode(artifact: DeltaArtifact): number {
  // Advisory mode — all diff verdicts succeed
  return 0;
}

// ═══════════════════════════════════════════════════════════════════
// CLI entry point
// ═══════════════════════════════════════════════════════════════════

async function main() {
  const args = parseArgs();

  try {
    const artifact = await runDbDelta(args);

    // Write all three artifacts with SHA provenance
    if (artifact.baseBaseline) {
      writeFileSync('db-delta-base-baseline.json', JSON.stringify(artifact.baseBaseline, null, 2));
    }
    if (artifact.candidateBaseline) {
      writeFileSync('db-delta-candidate-baseline.json', JSON.stringify(artifact.candidateBaseline, null, 2));
    }
    // Delta result (summary + diff, without full baselines to keep artifact small)
    const { baseBaseline: _b, candidateBaseline: _c, ...deltaOnly } = artifact;
    writeFileSync('db-delta-result.json', JSON.stringify(deltaOnly, null, 2));
    console.log('Artifacts written: db-delta-base-baseline.json, db-delta-candidate-baseline.json, db-delta-result.json');

    // Print summary
    printSummary(artifact);

    process.exit(advisoryExitCode(artifact));
  } catch (err) {
    process.stderr.write(`DB Delta CLI FAILED: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

// Only run when invoked directly (not when imported by tests)
const isDirectRun = process.argv[1]?.includes('db-delta-cli');
if (isDirectRun) {
  main();
}

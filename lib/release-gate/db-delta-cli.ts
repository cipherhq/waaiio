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
    console.error('Usage: db-delta-cli.ts --base-sha <sha> --head-sha <sha> --db-url <url>');
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
}

export function detectMigrationChanges(baseSha: string, headSha: string): MigrationDelta {
  const result: MigrationDelta = { added: [], modified: [], deleted: [] };

  let raw: string;
  try {
    raw = execSync(
      `git diff --name-status -z "${baseSha}" "${headSha}" -- 'supabase/migrations/*.sql'`,
      { encoding: 'utf-8', timeout: 30000 },
    );
  } catch {
    throw new Error(`Failed to detect migration changes between ${baseSha} and ${headSha}`);
  }

  if (!raw.trim()) return result;

  // NUL-delimited: status\0path\0status\0path\0...
  const parts = raw.split('\0').filter(Boolean);
  for (let i = 0; i < parts.length - 1; i += 2) {
    const status = parts[i].trim();
    const path = parts[i + 1].trim();
    const file = basename(path);

    if (status === 'A') result.added.push(file);
    else if (status === 'M') result.modified.push(file);
    else if (status === 'D') result.deleted.push(file);
  }

  // Sort deterministically by filename
  result.added.sort();
  result.modified.sort();
  result.deleted.sort();

  return result;
}

// ═══════════════════════════════════════════════════════════════════
// Base migration enumeration (from base SHA's exact blobs)
// ═══════════════════════════════════════════════════════════════════

export function enumerateBaseMigrations(baseSha: string): string[] {
  let raw: string;
  try {
    raw = execSync(
      `git ls-tree --name-only "${baseSha}" -- supabase/migrations/`,
      { encoding: 'utf-8', timeout: 30000 },
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

function applyCandidateMigrations(dbUrl: string, migrationFiles: string[]): number {
  let applied = 0;
  for (const file of migrationFiles) {
    const fullPath = resolve('supabase/migrations', file);
    const content = readFileSync(fullPath, 'utf-8');
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

interface DeltaArtifact {
  baseSha: string;
  headSha: string;
  migrationDelta: MigrationDelta;
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

export async function runDbDelta(args: CliArgs): Promise<DeltaArtifact> {
  const { baseSha, headSha, dbUrl } = args;

  // Step 1: Detect migration changes
  console.log(`Detecting migration changes: ${baseSha.substring(0, 8)}..${headSha.substring(0, 8)}`);
  const delta = detectMigrationChanges(baseSha, headSha);

  // Reject modified/deleted existing migrations
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

  // No-op: no candidate migration additions
  if (delta.added.length === 0) {
    console.log('No migration additions detected — no delta to analyze.');
    const noOpArtifact: DeltaArtifact = {
      baseSha, headSha, migrationDelta: delta,
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
  const candApplied = applyCandidateMigrations(dbUrl, delta.added);
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
    baseStats: snapshotStats(baseBaseline),
    candidateStats: snapshotStats(candidateBaseline),
    diff,
    noOp: false,
  };
}

// ═══════════════════════════════════════════════════════════════════
// CLI entry point
// ═══════════════════════════════════════════════════════════════════

async function main() {
  const args = parseArgs();

  try {
    const artifact = await runDbDelta(args);

    // Write artifacts
    writeFileSync('db-delta-result.json', JSON.stringify(artifact, null, 2));
    console.log('Artifacts written to db-delta-result.json');

    // Print summary
    printSummary(artifact);

    // Advisory mode: always exit 0 for diff verdicts
    process.exit(0);
  } catch (err) {
    console.error(`DB Delta CLI FAILED: ${(err as Error).message}`);
    process.exit(1);
  }
}

// Only run when invoked directly (not when imported by tests)
const isDirectRun = process.argv[1]?.includes('db-delta-cli');
if (isDirectRun) {
  main();
}

/**
 * Release Gate V2 — Migration Diff Parser
 *
 * Parses `git diff --name-status -z` output for migration files and
 * classifies each change. This replaces fragile grep-based parsing.
 *
 * Classification:
 *   A = added (new migration → lint it)
 *   M = modified (historical mutation → BLOCK)
 *   D = deleted (historical removal → BLOCK)
 *   R = renamed (historical rename → BLOCK)
 *   C = copied (new copy → lint the new file)
 *
 * @see RELEASE_GATE_V2.md §2 (Final-State Migration Checks)
 */

export interface MigrationChange {
  /** Git status letter: A, M, D, R, C, etc. */
  status: 'A' | 'M' | 'D' | 'R' | 'C' | string;
  /** File path (for A/M/D) or new path (for R/C) */
  path: string;
  /** Original path (for R/C only) */
  originalPath?: string;
  /** Migration filename (basename) */
  filename: string;
}

export interface MigrationDiffResult {
  /** All detected migration changes */
  changes: MigrationChange[];
  /** New migrations to lint (status A or C) */
  newMigrations: string[];
  /** Modified historical migrations (status M) — must BLOCK */
  modifiedMigrations: string[];
  /** Deleted historical migrations (status D) — must BLOCK */
  deletedMigrations: string[];
  /** Renamed historical migrations (status R) — must BLOCK */
  renamedMigrations: string[];
  /** Whether any immutability violation was found */
  hasImmutabilityViolation: boolean;
  /** Human-readable block reasons */
  blockReasons: string[];
}

/**
 * Parse NUL-delimited `git diff --name-status -z` output.
 *
 * Format: status\0path\0 for A/M/D, status\0oldpath\0newpath\0 for R/C.
 * The status for R/C includes a similarity percentage, e.g. "R100".
 */
export function parseMigrationDiffNul(raw: string, migrationPrefix = 'supabase/migrations/'): MigrationDiffResult {
  const changes: MigrationChange[] = [];
  const parts = raw.split('\0').filter(p => p !== '');

  let i = 0;
  while (i < parts.length) {
    const statusField = parts[i];
    if (!statusField) { i++; continue; }

    // Extract the status letter (first char). R/C have trailing digits (e.g., R100).
    const statusLetter = statusField[0];

    if (statusLetter === 'R' || statusLetter === 'C') {
      // Rename or copy: next two fields are old path, new path
      const oldPath = parts[i + 1] || '';
      const newPath = parts[i + 2] || '';
      i += 3;

      // Only track migration files
      if (oldPath.startsWith(migrationPrefix) || newPath.startsWith(migrationPrefix)) {
        const filename = basename(newPath || oldPath);
        changes.push({ status: statusLetter, path: newPath, originalPath: oldPath, filename });
      }
    } else {
      // A, M, D, T, U, X, B: next field is the path
      const path = parts[i + 1] || '';
      i += 2;

      if (path.startsWith(migrationPrefix)) {
        const filename = basename(path);
        changes.push({ status: statusLetter, path, filename });
      }
    }
  }

  const newMigrations = changes.filter(c => c.status === 'A' || c.status === 'C').map(c => c.filename);
  const modifiedMigrations = changes.filter(c => c.status === 'M').map(c => c.filename);
  const deletedMigrations = changes.filter(c => c.status === 'D').map(c => c.filename);
  const renamedMigrations = changes.filter(c => c.status === 'R').map(c => `${c.originalPath} → ${c.path}`);

  const blockReasons: string[] = [];
  if (modifiedMigrations.length > 0) {
    blockReasons.push(`MODIFIED historical migration(s): ${modifiedMigrations.join(', ')}`);
  }
  if (deletedMigrations.length > 0) {
    blockReasons.push(`DELETED historical migration(s): ${deletedMigrations.join(', ')}`);
  }
  if (renamedMigrations.length > 0) {
    blockReasons.push(`RENAMED historical migration(s): ${renamedMigrations.join(', ')}`);
  }

  return {
    changes,
    newMigrations,
    modifiedMigrations,
    deletedMigrations,
    renamedMigrations,
    hasImmutabilityViolation: blockReasons.length > 0,
    blockReasons,
  };
}

/**
 * Parse line-based `git diff --name-status` output (fallback).
 * Uses field splitting, NOT regex tab matching.
 */
export function parseMigrationDiffLines(raw: string, migrationPrefix = 'supabase/migrations/'): MigrationDiffResult {
  const changes: MigrationChange[] = [];

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    // Split on any whitespace (tab or spaces)
    const fields = line.split(/\s+/);
    if (fields.length < 2) continue;

    const statusField = fields[0];
    const statusLetter = statusField[0];

    if (statusLetter === 'R' || statusLetter === 'C') {
      const oldPath = fields[1] || '';
      const newPath = fields[2] || '';
      if (oldPath.startsWith(migrationPrefix) || newPath.startsWith(migrationPrefix)) {
        changes.push({ status: statusLetter, path: newPath, originalPath: oldPath, filename: basename(newPath || oldPath) });
      }
    } else {
      const path = fields[1] || '';
      if (path.startsWith(migrationPrefix)) {
        changes.push({ status: statusLetter, path, filename: basename(path) });
      }
    }
  }

  const newMigrations = changes.filter(c => c.status === 'A' || c.status === 'C').map(c => c.filename);
  const modifiedMigrations = changes.filter(c => c.status === 'M').map(c => c.filename);
  const deletedMigrations = changes.filter(c => c.status === 'D').map(c => c.filename);
  const renamedMigrations = changes.filter(c => c.status === 'R').map(c => `${c.originalPath} → ${c.path}`);

  const blockReasons: string[] = [];
  if (modifiedMigrations.length > 0) blockReasons.push(`MODIFIED: ${modifiedMigrations.join(', ')}`);
  if (deletedMigrations.length > 0) blockReasons.push(`DELETED: ${deletedMigrations.join(', ')}`);
  if (renamedMigrations.length > 0) blockReasons.push(`RENAMED: ${renamedMigrations.join(', ')}`);

  return { changes, newMigrations, modifiedMigrations, deletedMigrations, renamedMigrations, hasImmutabilityViolation: blockReasons.length > 0, blockReasons };
}

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

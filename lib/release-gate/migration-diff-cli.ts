#!/usr/bin/env npx tsx
/**
 * Release Gate V2 — Migration Diff CLI
 *
 * Reads NUL-delimited `git diff --name-status -z` output from stdin,
 * classifies migration changes, enforces immutability, and lints new
 * candidate migrations.
 *
 * Usage (NUL-safe pipe — no shell variable intermediary):
 *   git diff --name-status -z $BASE_SHA -- 'supabase/migrations/*.sql' \
 *     | npx tsx lib/release-gate/migration-diff-cli.ts [migrations-dir]
 *
 * Exit codes:
 *   0 = pass (no violations)
 *   1 = BLOCKED (immutability violation or lint error)
 *   2 = fatal error (stdin read failure, parser error)
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parseMigrationDiffNul } from './migration-diff-parser';
import { lintMigrationDirectory } from './migration-lint';

async function main(): Promise<void> {
  const migrationsDir = process.argv[2] || resolve(process.cwd(), 'supabase/migrations');

  // Read stdin as a Buffer to preserve NUL bytes
  let rawBuffer: Buffer;
  try {
    rawBuffer = readFileSync(0); // fd 0 = stdin
  } catch (err) {
    process.stderr.write(`FATAL: Failed to read stdin: ${(err as Error).message}\n`);
    process.exit(2);
  }

  // Convert Buffer to string with NUL bytes preserved as \0
  const raw = rawBuffer.toString('utf-8');

  if (raw.length === 0) {
    console.log('No migration changes — lint passes.');
    process.exit(0);
  }

  const result = parseMigrationDiffNul(raw);

  if (result.changes.length === 0) {
    console.log('No migration changes — lint passes.');
    process.exit(0);
  }

  console.log(`Migration changes detected: ${result.changes.length}`);
  for (const c of result.changes) {
    const label = c.status === 'A' ? 'NEW' : c.status === 'M' ? 'MODIFIED' : c.status === 'D' ? 'DELETED' : c.status === 'R' ? 'RENAMED' : c.status;
    console.log(`  ${label}: ${c.filename}${c.originalPath ? ` (from ${c.originalPath})` : ''}`);
  }

  if (result.hasImmutabilityViolation) {
    for (const r of result.blockReasons) {
      console.log(`❌ BLOCKED: ${r}`);
    }
    process.exit(1);
  }

  if (result.newMigrations.length === 0) {
    console.log('No new migrations to lint.');
    process.exit(0);
  }

  console.log(`Linting new migrations: ${result.newMigrations.join(', ')}`);
  const violations = lintMigrationDirectory(migrationsDir, result.newMigrations);
  const errors = violations.filter(v => v.severity === 'error');

  for (const v of violations) {
    const icon = v.severity === 'error' ? '❌' : '⚠️';
    console.log(`${icon} ${v.file}:${v.line} [${v.rule}] ${v.message}`);
  }

  if (errors.length > 0) {
    console.log(`\n❌ BLOCKED — ${errors.length} migration lint error(s).`);
    process.exit(1);
  }

  console.log('✅ All candidate migrations pass lint.');
}

main().catch(err => {
  process.stderr.write(`FATAL: ${(err as Error).message}\n`);
  process.exit(2);
});

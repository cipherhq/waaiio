#!/usr/bin/env node
/**
 * Validates the migration repair allowlist against the reconciliation manifest
 * and repository migration files.
 *
 * Fails on:
 * - Invalid JSON
 * - Duplicate versions
 * - Unsorted versions
 * - Filename mismatch with repository
 * - Checksum mismatch with repository file
 * - Already-tracked version in allowlist
 * - Non-eligible classification in allowlist
 * - Superseded or unverifiable migration in allowlist
 * - Manifest/allowlist disagreement
 * - Expected count mismatch
 *
 * Does not connect to Supabase or any external service.
 */
import { readFileSync, existsSync, readdirSync } from 'fs';
import { createHash } from 'crypto';
import { resolve } from 'path';

const ALLOWLIST_PATH = resolve('docs/migrations/101-246-repair-allowlist.json');
const MANIFEST_PATH = resolve('docs/migrations/101-246-production-reconciliation.json');
const MIGRATIONS_DIR = resolve('supabase/migrations');

let errors = 0;
let warnings = 0;

function fail(msg) {
  console.error(`  FAIL: ${msg}`);
  errors++;
}

function pass(msg) {
  console.log(`  PASS: ${msg}`);
}

function warn(msg) {
  console.warn(`  WARN: ${msg}`);
  warnings++;
}

console.log('=== Migration Repair Allowlist Validation ===\n');

// ── Check files exist ──
if (!existsSync(ALLOWLIST_PATH)) {
  fail('Allowlist file not found: ' + ALLOWLIST_PATH);
  process.exit(1);
}
if (!existsSync(MANIFEST_PATH)) {
  fail('Manifest file not found: ' + MANIFEST_PATH);
  process.exit(1);
}

// ── Parse JSON ──
let allowlist, manifest;
try {
  allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf-8'));
  pass('Allowlist is valid JSON');
} catch (e) {
  fail('Allowlist is invalid JSON: ' + e.message);
  process.exit(1);
}
try {
  manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
  pass('Manifest is valid JSON');
} catch (e) {
  fail('Manifest is invalid JSON: ' + e.message);
  process.exit(1);
}

// ── Allowlist structure ──
if (!Array.isArray(allowlist)) {
  fail('Allowlist must be an array');
  process.exit(1);
}

// ── Check for duplicates ──
const versions = allowlist.map(e => e.version);
const uniqueVersions = new Set(versions);
if (uniqueVersions.size !== versions.length) {
  fail(`Duplicate versions found: ${versions.length} entries but ${uniqueVersions.size} unique`);
} else {
  pass(`No duplicate versions (${versions.length} entries)`);
}

// ── Check sorted ──
const sorted = [...versions].sort((a, b) => parseInt(a) - parseInt(b));
const isSorted = versions.every((v, i) => v === sorted[i]);
if (!isSorted) {
  fail('Versions are not numerically sorted');
} else {
  pass('Versions are numerically sorted');
}

// ── Build manifest lookup ──
const manifestByVersion = {};
manifest.forEach(e => { manifestByVersion[e.version] = e; });

// ── Get migration files ──
const migrationFiles = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql'));

// ── Validate each entry ──
const NON_ELIGIBLE_CLASSIFICATIONS = new Set([
  'NOT_VERIFIABLE_SAFELY',
  'SUPERSEDED_WITH_EQUIVALENT_STATE',
  'ALIGNED_TRACKED'
]);

for (const entry of allowlist) {
  const ver = entry.version;

  // Check filename matches repository
  const repoFile = migrationFiles.find(f => f.startsWith(ver + '_'));
  if (!repoFile) {
    fail(`Version ${ver}: no matching migration file in repository`);
    continue;
  }
  if (entry.filename !== repoFile) {
    fail(`Version ${ver}: filename mismatch. Allowlist: ${entry.filename}, Repo: ${repoFile}`);
  }

  // Check checksum matches repository file
  const filePath = resolve(MIGRATIONS_DIR, repoFile);
  const fileContent = readFileSync(filePath, 'utf-8');
  const sha256 = createHash('sha256').update(fileContent).digest('hex');
  if (entry.checksum !== sha256) {
    fail(`Version ${ver}: checksum mismatch. Allowlist: ${entry.checksum.slice(0,12)}..., File: ${sha256.slice(0,12)}...`);
  }

  // Check against manifest
  const manifestEntry = manifestByVersion[ver];
  if (!manifestEntry) {
    fail(`Version ${ver}: not found in manifest`);
    continue;
  }

  // Check not already tracked
  if (manifestEntry.remote_tracked) {
    fail(`Version ${ver}: already tracked remotely — must not be in allowlist`);
  }

  // Check classification is eligible
  if (NON_ELIGIBLE_CLASSIFICATIONS.has(manifestEntry.current_classification)) {
    fail(`Version ${ver}: classification ${manifestEntry.current_classification} is not eligible for repair`);
  }

  // Check manifest agrees it's repair-eligible
  if (!manifestEntry.repair_eligible) {
    fail(`Version ${ver}: manifest says repair_eligible=false`);
  }
}

pass(`Validated ${allowlist.length} allowlist entries against manifest and repository`);

// ── Check expected candidate count ──
const manifestPending = manifest.filter(e => e.repair_status === 'pending' && e.repair_eligible);
if (manifestPending.length !== allowlist.length) {
  fail(`Count mismatch: manifest has ${manifestPending.length} repair-eligible pending entries, allowlist has ${allowlist.length}`);
} else {
  pass(`Candidate count matches: ${allowlist.length} in both manifest and allowlist`);
}

// ── Check no superseded or unverifiable in allowlist ──
const nvVersions = new Set(['101','105','107','160','163','164','187','222','226']);
const supersededVersions = new Set(['122','130']);
for (const entry of allowlist) {
  if (nvVersions.has(entry.version)) {
    fail(`Version ${entry.version}: NOT_VERIFIABLE_SAFELY must not be in allowlist`);
  }
  if (supersededVersions.has(entry.version)) {
    fail(`Version ${entry.version}: SUPERSEDED must not be in allowlist`);
  }
}

// ── Summary ──
console.log('\n=== Summary ===');
console.log(`  Errors: ${errors}`);
console.log(`  Warnings: ${warnings}`);
if (errors > 0) {
  console.log('\nMigration repair allowlist validation FAILED.');
  process.exit(1);
} else {
  console.log('\nMigration repair allowlist validation PASSED.');
}

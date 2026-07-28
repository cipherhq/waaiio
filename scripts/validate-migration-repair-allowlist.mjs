#!/usr/bin/env node
/**
 * Validates the migration repair allowlist against the reconciliation manifest
 * and repository migration files.
 *
 * Does not connect to Supabase or any external service.
 */
import { readFileSync, existsSync, readdirSync } from 'fs';
import { createHash } from 'crypto';
import { resolve } from 'path';

const ALLOWLIST_PATH = resolve('docs/migrations/101-246-repair-allowlist.json');
const MANIFEST_PATH = resolve('docs/migrations/101-246-production-reconciliation.json');
const MIGRATIONS_DIR = resolve('supabase/migrations');

const VALID_CLASSIFICATIONS = new Set([
  'ALIGNED_TRACKED',
  'VERIFIED_APPLIED_UNTRACKED',
  'NOT_VERIFIABLE_SAFELY',
  'SUPERSEDED_WITH_EQUIVALENT_STATE'
]);

const EXPECTED_MANIFEST_COUNT = 146;
const EXPECTED_ALLOWLIST_COUNT = 127;

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

if (!Array.isArray(allowlist)) {
  fail('Allowlist must be an array');
  process.exit(1);
}
if (!Array.isArray(manifest)) {
  fail('Manifest must be an array');
  process.exit(1);
}

// ── Get migration files ──
const migrationFiles = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql'));

// ══════════════════════════════════════════════════════════════
// MANIFEST CHECKS
// ══════════════════════════════════════════════════════════════
console.log('\n--- Manifest Checks ---\n');

// Exactly 146 entries
if (manifest.length !== EXPECTED_MANIFEST_COUNT) {
  fail(`Manifest has ${manifest.length} entries, expected ${EXPECTED_MANIFEST_COUNT}`);
} else {
  pass(`Manifest has exactly ${EXPECTED_MANIFEST_COUNT} entries`);
}

// One entry per version 101-246
const manifestVersions = manifest.map(e => e.version);
const expectedVersions = [];
for (let i = 101; i <= 246; i++) expectedVersions.push(String(i));
const missingVersions = expectedVersions.filter(v => !manifestVersions.includes(v));
const extraVersions = manifestVersions.filter(v => !expectedVersions.includes(v));
if (missingVersions.length > 0) {
  fail(`Manifest missing versions: ${missingVersions.join(', ')}`);
} else {
  pass('Manifest covers all versions 101-246');
}
if (extraVersions.length > 0) {
  fail(`Manifest has unexpected versions: ${extraVersions.join(', ')}`);
}

// Unique versions
const manifestUniqueVersions = new Set(manifestVersions);
if (manifestUniqueVersions.size !== manifestVersions.length) {
  fail(`Manifest has duplicate versions: ${manifestVersions.length} entries but ${manifestUniqueVersions.size} unique`);
} else {
  pass(`Manifest has no duplicate versions`);
}

// Sorted
const manifestSorted = [...manifestVersions].sort((a, b) => parseInt(a) - parseInt(b));
const manifestIsSorted = manifestVersions.every((v, i) => v === manifestSorted[i]);
if (!manifestIsSorted) {
  fail('Manifest versions are not numerically sorted');
} else {
  pass('Manifest versions are numerically sorted');
}

// Valid classifications only
const invalidClassifications = manifest.filter(e => !VALID_CLASSIFICATIONS.has(e.current_classification));
if (invalidClassifications.length > 0) {
  fail(`Manifest has invalid classifications: ${invalidClassifications.map(e => `${e.version}=${e.current_classification}`).join(', ')}`);
} else {
  pass('All manifest classifications are valid');
}

// Every filename matches repository
let filenameErrors = 0;
for (const entry of manifest) {
  const repoFile = migrationFiles.find(f => f.startsWith(entry.version + '_'));
  if (!repoFile) {
    fail(`Manifest version ${entry.version}: no matching migration file in repository`);
    filenameErrors++;
  } else if (entry.filename !== repoFile) {
    fail(`Manifest version ${entry.version}: filename mismatch. Manifest: ${entry.filename}, Repo: ${repoFile}`);
    filenameErrors++;
  }
}
if (filenameErrors === 0) {
  pass('All manifest filenames match repository');
}

// Every checksum matches repository file
let checksumErrors = 0;
for (const entry of manifest) {
  const filePath = resolve(MIGRATIONS_DIR, entry.filename);
  if (!existsSync(filePath)) continue; // already reported above
  const fileContent = readFileSync(filePath, 'utf-8');
  const sha256 = createHash('sha256').update(fileContent).digest('hex');
  if (entry.checksum !== sha256) {
    fail(`Manifest version ${entry.version}: checksum mismatch. Manifest: ${entry.checksum.slice(0,12)}..., File: ${sha256.slice(0,12)}...`);
    checksumErrors++;
  }
}
if (checksumErrors === 0) {
  pass('All manifest checksums match repository files');
}

// Completed entries have non-contradictory evidence
const completedEntries = manifest.filter(e => e.repair_status === 'completed');
let contradictionErrors = 0;
for (const entry of completedEntries) {
  const evidenceLower = (entry.evidence || '').toLowerCase();
  if (evidenceLower.includes('missing') && !evidenceLower.includes('original evidence:')) {
    fail(`Manifest version ${entry.version}: completed entry has "missing" in evidence without original context`);
    contradictionErrors++;
  }
  if (evidenceLower.includes('absent') && !evidenceLower.includes('original evidence:')) {
    fail(`Manifest version ${entry.version}: completed entry has "absent" in evidence without original context`);
    contradictionErrors++;
  }
}
if (contradictionErrors === 0) {
  pass(`All ${completedEntries.length} completed entries have non-contradictory evidence`);
}

// Repair-eligible entries have detailed evidence
const repairEligible = manifest.filter(e => e.repair_eligible && e.repair_status === 'pending');
let evidenceErrors = 0;
for (const entry of repairEligible) {
  if (!entry.evidence || entry.evidence.length < 20) {
    fail(`Manifest version ${entry.version}: repair-eligible entry has insufficient evidence`);
    evidenceErrors++;
  }
}
if (evidenceErrors === 0) {
  pass(`All ${repairEligible.length} repair-eligible entries have detailed evidence`);
}

// ══════════════════════════════════════════════════════════════
// ALLOWLIST CHECKS
// ══════════════════════════════════════════════════════════════
console.log('\n--- Allowlist Checks ---\n');

// Build manifest lookup
const manifestByVersion = {};
manifest.forEach(e => { manifestByVersion[e.version] = e; });

// Unique versions
const allowlistVersions = allowlist.map(e => e.version);
const allowlistUnique = new Set(allowlistVersions);
if (allowlistUnique.size !== allowlistVersions.length) {
  fail(`Allowlist has duplicate versions`);
} else {
  pass(`Allowlist has no duplicate versions (${allowlistVersions.length} entries)`);
}

// Sorted
const allowlistSorted = [...allowlistVersions].sort((a, b) => parseInt(a) - parseInt(b));
const allowlistIsSorted = allowlistVersions.every((v, i) => v === allowlistSorted[i]);
if (!allowlistIsSorted) {
  fail('Allowlist versions are not numerically sorted');
} else {
  pass('Allowlist versions are numerically sorted');
}

// Expected count
if (allowlist.length !== EXPECTED_ALLOWLIST_COUNT) {
  fail(`Allowlist has ${allowlist.length} entries, expected ${EXPECTED_ALLOWLIST_COUNT}`);
} else {
  pass(`Allowlist has exactly ${EXPECTED_ALLOWLIST_COUNT} entries`);
}

// Validate each allowlist entry
let allowlistEntryErrors = 0;
for (const entry of allowlist) {
  const ver = entry.version;

  // Filename matches repository
  const repoFile = migrationFiles.find(f => f.startsWith(ver + '_'));
  if (!repoFile) {
    fail(`Allowlist version ${ver}: no matching migration file in repository`);
    allowlistEntryErrors++;
    continue;
  }
  if (entry.filename !== repoFile) {
    fail(`Allowlist version ${ver}: filename mismatch`);
    allowlistEntryErrors++;
  }

  // Checksum matches repository file
  const filePath = resolve(MIGRATIONS_DIR, repoFile);
  const fileContent = readFileSync(filePath, 'utf-8');
  const sha256 = createHash('sha256').update(fileContent).digest('hex');
  if (entry.checksum !== sha256) {
    fail(`Allowlist version ${ver}: checksum mismatch`);
    allowlistEntryErrors++;
  }

  // Manifest entry exists
  const manifestEntry = manifestByVersion[ver];
  if (!manifestEntry) {
    fail(`Allowlist version ${ver}: not found in manifest`);
    allowlistEntryErrors++;
    continue;
  }

  // current_classification is exactly VERIFIED_APPLIED_UNTRACKED
  if (manifestEntry.current_classification !== 'VERIFIED_APPLIED_UNTRACKED') {
    fail(`Allowlist version ${ver}: manifest classification is ${manifestEntry.current_classification}, expected VERIFIED_APPLIED_UNTRACKED`);
    allowlistEntryErrors++;
  }

  // remote_tracked is false
  if (manifestEntry.remote_tracked !== false) {
    fail(`Allowlist version ${ver}: manifest remote_tracked is ${manifestEntry.remote_tracked}, expected false`);
    allowlistEntryErrors++;
  }

  // repair_eligible is true
  if (manifestEntry.repair_eligible !== true) {
    fail(`Allowlist version ${ver}: manifest repair_eligible is ${manifestEntry.repair_eligible}, expected true`);
    allowlistEntryErrors++;
  }

  // repair_status is pending
  if (manifestEntry.repair_status !== 'pending') {
    fail(`Allowlist version ${ver}: manifest repair_status is ${manifestEntry.repair_status}, expected pending`);
    allowlistEntryErrors++;
  }

  // confidence is HIGH
  if (entry.confidence !== 'HIGH') {
    fail(`Allowlist version ${ver}: confidence is ${entry.confidence}, expected HIGH`);
    allowlistEntryErrors++;
  }

  // evidence_digest recomputes correctly
  const canonical = JSON.stringify({
    version: manifestEntry.version,
    filename: manifestEntry.filename,
    checksum: manifestEntry.checksum,
    current_classification: manifestEntry.current_classification,
    remote_tracked: manifestEntry.remote_tracked,
    repair_eligible: manifestEntry.repair_eligible,
    evidence: manifestEntry.evidence,
    missing_effects: manifestEntry.missing_effects,
    superseding_migration: manifestEntry.superseding_migration
  });
  const expectedDigest = createHash('sha256').update(canonical).digest('hex');
  if (entry.evidence_digest !== expectedDigest) {
    fail(`Allowlist version ${ver}: evidence_digest mismatch. Got: ${entry.evidence_digest.slice(0,12)}..., Expected: ${expectedDigest.slice(0,12)}...`);
    allowlistEntryErrors++;
  }
}

if (allowlistEntryErrors === 0) {
  pass(`All ${allowlist.length} allowlist entries validated against manifest and repository`);
}

// Allowlist equals the complete set of eligible pending manifest entries
const manifestEligiblePending = manifest
  .filter(e => e.current_classification === 'VERIFIED_APPLIED_UNTRACKED' && e.repair_eligible && e.repair_status === 'pending')
  .map(e => e.version)
  .sort((a, b) => parseInt(a) - parseInt(b));
const allowlistVersionsSorted = [...allowlistVersions].sort((a, b) => parseInt(a) - parseInt(b));

const manifestNotInAllowlist = manifestEligiblePending.filter(v => !allowlistUnique.has(v));
const allowlistNotInManifest = allowlistVersionsSorted.filter(v => !new Set(manifestEligiblePending).has(v));

if (manifestNotInAllowlist.length > 0) {
  fail(`Manifest eligible entries missing from allowlist: ${manifestNotInAllowlist.join(', ')}`);
}
if (allowlistNotInManifest.length > 0) {
  fail(`Allowlist entries not eligible in manifest: ${allowlistNotInManifest.join(', ')}`);
}
if (manifestNotInAllowlist.length === 0 && allowlistNotInManifest.length === 0) {
  pass('Allowlist is the complete set of eligible pending manifest entries');
}

// ══════════════════════════════════════════════════════════════
// EXCLUSION CHECKS
// ══════════════════════════════════════════════════════════════
console.log('\n--- Exclusion Checks ---\n');

const allowlistVersionSet = new Set(allowlistVersions);

// NOT_VERIFIABLE_SAFELY entries are not in allowlist
const nvVersions = manifest.filter(e => e.current_classification === 'NOT_VERIFIABLE_SAFELY').map(e => e.version);
const nvInAllowlist = nvVersions.filter(v => allowlistVersionSet.has(v));
if (nvInAllowlist.length > 0) {
  fail(`NOT_VERIFIABLE_SAFELY versions in allowlist: ${nvInAllowlist.join(', ')}`);
} else {
  pass(`All ${nvVersions.length} NOT_VERIFIABLE_SAFELY versions excluded from allowlist`);
}

// SUPERSEDED entries are not in allowlist
const supersededVersions = manifest.filter(e => e.current_classification === 'SUPERSEDED_WITH_EQUIVALENT_STATE').map(e => e.version);
const supersededInAllowlist = supersededVersions.filter(v => allowlistVersionSet.has(v));
if (supersededInAllowlist.length > 0) {
  fail(`SUPERSEDED versions in allowlist: ${supersededInAllowlist.join(', ')}`);
} else {
  pass(`All ${supersededVersions.length} SUPERSEDED versions excluded from allowlist`);
}

// ALIGNED_TRACKED entries are not in allowlist
const alignedVersions = manifest.filter(e => e.current_classification === 'ALIGNED_TRACKED').map(e => e.version);
const alignedInAllowlist = alignedVersions.filter(v => allowlistVersionSet.has(v));
if (alignedInAllowlist.length > 0) {
  fail(`ALIGNED_TRACKED versions in allowlist: ${alignedInAllowlist.join(', ')}`);
} else {
  pass(`All ${alignedVersions.length} ALIGNED_TRACKED versions excluded from allowlist`);
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

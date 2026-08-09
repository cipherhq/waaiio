/**
 * Migration Repair Guard — CI Governance Validator
 *
 * Validates that the repair allowlist does not contain any protected versions.
 * Run as: node scripts/validate-migration-repair-guard.mjs
 *
 * Exit 0 = valid (empty allowlist or all entries permitted)
 * Exit 1 = blocked entry found
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const MANIFEST_PATH = resolve('docs/migrations/101-246-production-reconciliation.json');
const ALLOWLIST_PATH = resolve('docs/migrations/101-246-repair-allowlist.json');

// Versions that were marked applied without SQL execution (production deviation)
const DEVIATION_VERSIONS = new Set([
  '101', '105', '107', '122', '126', '130', '160', '163', '164', '187', '216', '217', '222', '226',
]);

const BLOCKED_CLASSIFICATIONS = new Set([
  'NOT_VERIFIABLE_SAFELY',
  'SUPERSEDED_WITH_EQUIVALENT_STATE',
]);

function main() {
  console.log('🔒 Migration Repair Guard — validating allowlist...');

  // 1. Verify manifest exists
  if (!existsSync(MANIFEST_PATH)) {
    console.error('❌ Manifest not found:', MANIFEST_PATH);
    process.exit(1);
  }

  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
  const manifestMap = new Map(manifest.map(e => [e.version, e]));

  // 2. Load allowlist
  if (!existsSync(ALLOWLIST_PATH)) {
    console.log('✅ No allowlist file — no repairs authorized.');
    process.exit(0);
  }

  const allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf-8'));
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    console.log('✅ Allowlist is empty — no repairs authorized.');
    process.exit(0);
  }

  // 3. Validate each entry
  let hasError = false;

  for (const entry of allowlist) {
    const version = typeof entry === 'string' ? entry : entry?.version;
    if (!version) {
      console.error('❌ Invalid allowlist entry:', JSON.stringify(entry));
      hasError = true;
      continue;
    }

    // Check deviation protection
    if (DEVIATION_VERSIONS.has(version)) {
      console.error(`❌ BLOCKED: Version ${version} is APPLIED_WITHOUT_EXECUTION (production deviation). Cannot be re-repaired.`);
      hasError = true;
      continue;
    }

    // Check manifest
    const manifestEntry = manifestMap.get(version);
    if (!manifestEntry) {
      console.error(`❌ BLOCKED: Version ${version} is not registered in the reconciliation manifest.`);
      hasError = true;
      continue;
    }

    // Check classification
    if (BLOCKED_CLASSIFICATIONS.has(manifestEntry.current_classification)) {
      console.error(`❌ BLOCKED: Version ${version} classified as ${manifestEntry.current_classification}. Repair is not safe.`);
      hasError = true;
      continue;
    }

    // Check repair eligibility
    if (!manifestEntry.repair_eligible) {
      console.error(`❌ BLOCKED: Version ${version} is not marked repair_eligible.`);
      hasError = true;
      continue;
    }

    console.log(`  ✅ ${version} — permitted`);
  }

  if (hasError) {
    console.error('\n❌ Migration repair guard FAILED. Blocked entries found in allowlist.');
    process.exit(1);
  }

  console.log(`\n✅ Migration repair guard passed. ${allowlist.length} entries validated.`);
}

main();

#!/usr/bin/env node

/**
 * Engineering governance validation script.
 *
 * Validates that required governance artifacts exist, are well-formed,
 * and contain internally consistent data.
 *
 * Usage: node scripts/verify-engineering-governance.mjs
 */

import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';

const REQUIRED_FILES = [
  'docs/ENGINEERING_WORKFLOW.md',
  'docs/ENGINEERING_STATUS.md',
  'docs/engineering-status.json',
  'docs/MIGRATION_REGISTRY.md',
  'docs/CHAT_HANDOFF_TEMPLATE.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/ISSUE_TEMPLATE/milestone.yml',
];

const VALID_STAGES = [
  'PLANNED',
  'IN_PROGRESS',
  'IMPLEMENTED',
  'LOCALLY_TESTED',
  'INDEPENDENTLY_REVIEWED',
  'MERGED',
  'DEPLOYED',
  'PRODUCTION_VERIFIED',
  'CLOSED',
  'BLOCKED',
  'STRANDED',
  'SUPERSEDED',
  'ROLLED_BACK',
];

const SHA_REGEX = /^[0-9a-f]{40}$/;

let errors = 0;
let warnings = 0;

function fail(msg) {
  console.error(`  FAIL: ${msg}`);
  errors++;
}

function warn(msg) {
  console.warn(`  WARN: ${msg}`);
  warnings++;
}

function pass(msg) {
  console.log(`  PASS: ${msg}`);
}

// ── 1. Required files exist ──
console.log('\n=== Required Governance Files ===');
for (const file of REQUIRED_FILES) {
  if (existsSync(file)) {
    pass(file);
  } else {
    fail(`Missing required file: ${file}`);
  }
}

// ── 2. Parse engineering-status.json ──
console.log('\n=== Engineering Status Ledger ===');
let ledger;
try {
  const raw = readFileSync('docs/engineering-status.json', 'utf-8');
  ledger = JSON.parse(raw);
  pass('engineering-status.json is valid JSON');
} catch (e) {
  fail(`engineering-status.json is not valid JSON: ${e.message}`);
  process.exit(1);
}

// ── 3. Schema version ──
if (ledger.$schema_version) {
  pass(`Schema version: ${ledger.$schema_version}`);
} else {
  fail('Missing $schema_version');
}

// ── 4. Last reconciled SHA format ──
if (ledger.last_reconciled_main_sha && SHA_REGEX.test(ledger.last_reconciled_main_sha)) {
  pass(`Reconciled SHA format valid: ${ledger.last_reconciled_main_sha.slice(0, 8)}...`);
} else {
  fail(`Invalid or missing last_reconciled_main_sha: "${ledger.last_reconciled_main_sha}"`);
}

// ── 5. Milestones array ──
if (!Array.isArray(ledger.milestones)) {
  fail('milestones is not an array');
  process.exit(1);
}
pass(`${ledger.milestones.length} milestone(s) found`);

// ── 6. Unique milestone IDs ──
const ids = ledger.milestones.map((m) => m.id);
const uniqueIds = new Set(ids);
if (ids.length === uniqueIds.size) {
  pass('All milestone IDs are unique');
} else {
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  fail(`Duplicate milestone IDs: ${dupes.join(', ')}`);
}

// ── 7. Valid stages ──
for (const m of ledger.milestones) {
  if (VALID_STAGES.includes(m.stage)) {
    pass(`${m.id}: stage "${m.stage}" is valid`);
  } else {
    fail(`${m.id}: stage "${m.stage}" is not a recognized stage`);
  }
}

// ── 8. Stage-specific evidence requirements ──
for (const m of ledger.milestones) {
  // IMPLEMENTED, LOCALLY_TESTED, INDEPENDENTLY_REVIEWED or later must have implementation_sha
  if (['IMPLEMENTED', 'LOCALLY_TESTED', 'INDEPENDENTLY_REVIEWED', 'MERGED', 'DEPLOYED', 'PRODUCTION_VERIFIED', 'CLOSED'].includes(m.stage)) {
    if (m.implementation_sha && SHA_REGEX.test(m.implementation_sha)) {
      pass(`${m.id}: implementation_sha present and valid format`);
    } else {
      fail(`${m.id}: stage "${m.stage}" requires a valid implementation_sha`);
    }
  }

  // INDEPENDENTLY_REVIEWED must have reviewed_sha
  if (['INDEPENDENTLY_REVIEWED'].includes(m.stage)) {
    if (m.reviewed_sha && SHA_REGEX.test(m.reviewed_sha)) {
      pass(`${m.id}: reviewed_sha present and valid format`);
    } else {
      fail(`${m.id}: stage "${m.stage}" requires a valid reviewed_sha`);
    }
  }

  // MERGED or later must have merge_sha
  if (['MERGED', 'DEPLOYED', 'PRODUCTION_VERIFIED', 'CLOSED'].includes(m.stage)) {
    if (m.merge_sha && SHA_REGEX.test(m.merge_sha)) {
      pass(`${m.id}: merge_sha present and valid format`);
    } else {
      fail(`${m.id}: stage "${m.stage}" requires a valid merge_sha`);
    }
  }

  // DEPLOYED or later must have deployed_sha and environment
  if (['DEPLOYED', 'PRODUCTION_VERIFIED', 'CLOSED'].includes(m.stage)) {
    if (m.deployed_sha && SHA_REGEX.test(m.deployed_sha)) {
      pass(`${m.id}: deployed_sha present and valid format`);
    } else {
      fail(`${m.id}: stage "${m.stage}" requires a valid deployed_sha`);
    }
    if (m.environment) {
      pass(`${m.id}: environment specified: "${m.environment}"`);
    } else {
      fail(`${m.id}: stage "${m.stage}" requires an environment`);
    }
  }

  // PRODUCTION_VERIFIED or CLOSED must have verification evidence
  if (['PRODUCTION_VERIFIED', 'CLOSED'].includes(m.stage)) {
    if (Array.isArray(m.verification_evidence) && m.verification_evidence.length > 0) {
      pass(`${m.id}: verification_evidence present (${m.verification_evidence.length} items)`);
    } else {
      fail(`${m.id}: stage "${m.stage}" requires non-empty verification_evidence`);
    }
  }

  // STRANDED must have blockers and next_action
  if (m.stage === 'STRANDED') {
    if (Array.isArray(m.blockers) && m.blockers.length > 0) {
      pass(`${m.id}: blockers documented (${m.blockers.length} items)`);
    } else {
      fail(`${m.id}: STRANDED milestone requires non-empty blockers`);
    }
    if (m.next_action) {
      pass(`${m.id}: next_action specified`);
    } else {
      fail(`${m.id}: STRANDED milestone requires a next_action`);
    }
  }

  // BLOCKED must have blockers
  if (m.stage === 'BLOCKED') {
    if (Array.isArray(m.blockers) && m.blockers.length > 0) {
      pass(`${m.id}: blockers documented`);
    } else {
      fail(`${m.id}: BLOCKED milestone requires non-empty blockers`);
    }
  }

  // No milestone should be marked complete with only a PR head SHA (no merge SHA)
  if (['PRODUCTION_VERIFIED', 'CLOSED'].includes(m.stage) && !m.merge_sha && m.implementation_sha) {
    fail(`${m.id}: marked "${m.stage}" with only implementation_sha — merge_sha required`);
  }
}

// ── 9. Git ancestry checks ──
console.log('\n=== Git Ancestry Checks ===');
try {
  execSync('git rev-parse HEAD', { stdio: 'pipe' });

  // Determine if full history is available (fetch-depth: 0 in CI)
  let fullHistory = false;
  try {
    const depth = execSync('git rev-list --count HEAD', { encoding: 'utf-8' }).trim();
    fullHistory = parseInt(depth, 10) > 100;
  } catch {
    // If rev-list fails, assume shallow
  }

  // Prefer origin/main if available, fall back to HEAD
  let ancestryRef = 'HEAD';
  try {
    execSync('git rev-parse origin/main', { stdio: 'pipe' });
    ancestryRef = 'origin/main';
  } catch {
    // origin/main not available — use HEAD
  }
  pass(`Ancestry reference: ${ancestryRef} (full history: ${fullHistory})`);

  // Verify the reconciled main SHA is an ancestor of origin/main (not just that it exists)
  if (ledger.last_reconciled_main_sha) {
    try {
      execSync(`git merge-base --is-ancestor ${ledger.last_reconciled_main_sha} ${ancestryRef}`, { stdio: 'pipe' });
      pass(`Reconciled SHA ${ledger.last_reconciled_main_sha.slice(0, 8)} is ancestor of ${ancestryRef}`);
    } catch {
      if (fullHistory) {
        fail(`Reconciled SHA ${ledger.last_reconciled_main_sha.slice(0, 8)} is NOT ancestor of ${ancestryRef} — ledger references a SHA not on main`);
      } else {
        warn(`Reconciled SHA ${ledger.last_reconciled_main_sha.slice(0, 8)} ancestry unverifiable (shallow clone)`);
      }
    }
  }

  // Verify merge SHAs for merged milestones
  for (const m of ledger.milestones) {
    if (m.merge_sha && ['MERGED', 'DEPLOYED', 'PRODUCTION_VERIFIED', 'CLOSED'].includes(m.stage)) {
      try {
        execSync(`git merge-base --is-ancestor ${m.merge_sha} ${ancestryRef}`, { stdio: 'pipe' });
        pass(`${m.id}: merge_sha ${m.merge_sha.slice(0, 8)} is ancestor of ${ancestryRef}`);
      } catch {
        if (fullHistory) {
          fail(`${m.id}: merge_sha ${m.merge_sha.slice(0, 8)} is NOT ancestor of ${ancestryRef} — milestone claims "${m.stage}" but merge SHA is not on main`);
        } else {
          warn(`${m.id}: merge_sha ${m.merge_sha.slice(0, 8)} is NOT ancestor of ${ancestryRef} (shallow clone — cannot verify, fetch full history to confirm)`);
        }
      }
    }
  }
} catch {
  warn('Git not available — skipping ancestry checks');
}

// ── 10. Summary ──
console.log('\n=== Summary ===');
console.log(`  Errors: ${errors}`);
console.log(`  Warnings: ${warnings}`);
if (errors > 0) {
  console.error('\nGovernance validation FAILED.\n');
  process.exit(1);
} else {
  console.log('\nGovernance validation PASSED.\n');
}

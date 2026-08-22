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

// ── 10. Capability Contract Registry Validation ──
console.log('\n=== Capability Contract Registry ===');

const TIER1_CAPABILITIES = ['scheduling', 'payment', 'giving', 'ordering', 'ticketing', 'reservation', 'loyalty', 'recurring'];
let indexIds = []; // Populated from capability index, shared with journey validation

try {
  const indexPath = 'docs/contracts/capability-index.json';
  if (!existsSync(indexPath)) {
    fail('Missing capability index: ' + indexPath);
  } else {
    const capIndex = JSON.parse(readFileSync(indexPath, 'utf-8'));
    if (!capIndex.capabilities || !Array.isArray(capIndex.capabilities)) {
      fail('capability-index.json: capabilities must be an array');
    } else {
      indexIds = capIndex.capabilities.map(c => c.id);
      const dupes = indexIds.filter((id, i) => indexIds.indexOf(id) !== i);
      if (dupes.length) fail('capability-index.json: duplicate IDs: ' + dupes.join(', '));
      else pass(`capability-index.json: ${indexIds.length} capabilities, no duplicates`);

      // Validate index total matches array length
      if (capIndex.total !== indexIds.length) {
        fail(`capability-index.json: total (${capIndex.total}) does not match array length (${indexIds.length})`);
      }

      // Validate index IDs against canonical shared/capabilities.ts
      try {
        const capSrc = readFileSync('shared/capabilities.ts', 'utf-8');
        const canonicalMatch = capSrc.match(/export type CapabilityId\s*=\s*([\s\S]*?);/);
        if (canonicalMatch) {
          const canonicalIds = canonicalMatch[1].match(/'([^']+)'/g).map(s => s.replace(/'/g, ''));
          const missing = canonicalIds.filter(id => !indexIds.includes(id));
          const extra = indexIds.filter(id => !canonicalIds.includes(id));
          if (missing.length) fail('capability-index.json: missing canonical IDs: ' + missing.join(', '));
          if (extra.length) fail('capability-index.json: extra IDs not in shared/capabilities.ts: ' + extra.join(', '));
          if (!missing.length && !extra.length) pass('capability-index.json: matches shared/capabilities.ts');
        } else {
          warn('Could not parse CapabilityId from shared/capabilities.ts');
        }
      } catch (e) {
        warn('Could not read shared/capabilities.ts: ' + e.message);
      }

      // Validate Tier-1 contracts exist, have requiredTestsOnChange with real files, and have session keys
      for (const cap of TIER1_CAPABILITIES) {
        const contractPath = `docs/contracts/${cap}.contract.json`;
        if (!existsSync(contractPath)) {
          fail(`Missing Tier-1 contract: ${contractPath}`);
        } else {
          try {
            const contract = JSON.parse(readFileSync(contractPath, 'utf-8'));
            if (contract.id !== cap) fail(`${contractPath}: id mismatch (expected '${cap}', got '${contract.id}')`);
            else pass(`${contractPath}: valid`);
            // Validate requiredTestsOnChange paths exist (required field)
            if (!contract.requiredTestsOnChange || !Array.isArray(contract.requiredTestsOnChange) || !contract.requiredTestsOnChange.length) {
              fail(`${contractPath}: requiredTestsOnChange must be a non-empty array`);
            } else {
              for (const tp of contract.requiredTestsOnChange) {
                if (!existsSync(tp)) {
                  fail(`${contractPath}: requiredTestsOnChange path not found: ${tp}`);
                }
              }
            }
            // Validate session keys use per-key structure (not legacy arrays)
            if (contract.sessionKeys) {
              if (!contract.sessionKeys.keys && !contract.sessionKeys.inheritsFrom) {
                fail(`${contractPath}: sessionKeys must use per-key 'keys' object (not legacy domain/shared arrays)`);
              }
            }
          } catch (e) {
            fail(`${contractPath}: invalid JSON — ${e.message}`);
          }
        }
      }
    }
  }
} catch (e) {
  fail('Contract registry validation error: ' + e.message);
}

// ── 11. Golden Journey Registry Validation ──
console.log('\n=== Golden Journey Registry ===');

try {
  const journeyPath = 'docs/journeys/journey-registry.json';
  if (!existsSync(journeyPath)) {
    fail('Missing journey registry: ' + journeyPath);
  } else {
    const registry = JSON.parse(readFileSync(journeyPath, 'utf-8'));
    if (!registry.journeys || !Array.isArray(registry.journeys)) {
      fail('journey-registry.json: journeys must be an array');
    } else {
      const journeyIds = registry.journeys.map(j => j.id);
      const dupes = journeyIds.filter((id, i) => journeyIds.indexOf(id) !== i);
      if (dupes.length) fail('journey-registry.json: duplicate IDs: ' + dupes.join(', '));
      else pass(`journey-registry.json: ${journeyIds.length} journeys, no duplicates`);

      const validStatuses = ['PROTECTED', 'PARTIAL', 'KNOWN_GAP'];
      for (const j of registry.journeys) {
        if (!validStatuses.includes(j.status)) {
          fail(`Journey ${j.id}: invalid status '${j.status}'`);
        }
        // PROTECTED and PARTIAL must have non-empty testPaths with existing files
        if (j.status === 'PROTECTED' || j.status === 'PARTIAL') {
          if (!j.testPaths || !Array.isArray(j.testPaths) || !j.testPaths.length) {
            fail(`Journey ${j.id} (${j.status}): testPaths must be a non-empty array`);
          } else {
            for (const tp of j.testPaths) {
              if (!existsSync(tp)) {
                fail(`Journey ${j.id} (${j.status}): test file not found: ${tp}`);
              }
            }
          }
        }
        if (j.status === 'KNOWN_GAP' && !j.linkedIssue) {
          fail(`Journey ${j.id} (KNOWN_GAP): must have a linkedIssue`);
        }
        // Validate journey capabilities reference the capability index
        if (j.capabilities && Array.isArray(j.capabilities)) {
          for (const cap of j.capabilities) {
            if (!indexIds.includes(cap)) {
              fail(`Journey ${j.id}: references unknown capability '${cap}'`);
            }
          }
        }
        // Validate journey contracts reference existing Tier-1 contract files
        if (j.contracts && Array.isArray(j.contracts)) {
          for (const c of j.contracts) {
            if (!existsSync(`docs/contracts/${c}.contract.json`)) {
              fail(`Journey ${j.id}: references missing contract '${c}'`);
            }
          }
        }
      }
      pass('Journey entries validated');
    }
  }
} catch (e) {
  fail('Journey registry validation error: ' + e.message);
}

// ── 12. Acceptance Registry Validation ──
console.log('\n=== Acceptance Registry ===');

try {
  const accPath = 'docs/acceptance/registry.json';
  if (!existsSync(accPath)) {
    fail('Missing acceptance registry: ' + accPath);
  } else {
    const accRegistry = JSON.parse(readFileSync(accPath, 'utf-8'));
    if (!accRegistry.findings || !Array.isArray(accRegistry.findings)) {
      fail('registry.json: findings must be an array');
    } else {
      const accIds = accRegistry.findings.map(f => f.id);
      const dupes = accIds.filter((id, i) => accIds.indexOf(id) !== i);
      if (dupes.length) fail('acceptance registry: duplicate IDs: ' + dupes.join(', '));
      // Enforce exact ACC-001..ACC-011 set
      const requiredAccIds = Array.from({ length: 11 }, (_, i) => `ACC-${String(i + 1).padStart(3, '0')}`);
      const missingAcc = requiredAccIds.filter(id => !accIds.includes(id));
      if (missingAcc.length) fail('acceptance registry: missing required IDs: ' + missingAcc.join(', '));
      const accValidStatuses = ['OPEN', 'RESOLVED', 'DEFERRED', 'IN_PROGRESS'];
      for (const f of accRegistry.findings) {
        if (!accValidStatuses.includes(f.status)) {
          fail(`${f.id}: invalid status '${f.status}'`);
        }
      }
      pass(`acceptance registry: ${accIds.length} findings validated (all ACC-001..ACC-011 present)`);
    }
  }
} catch (e) {
  fail('Acceptance registry validation error: ' + e.message);
}

// ── 13. Summary ──
console.log('\n=== Summary ===');
console.log(`  Errors: ${errors}`);
console.log(`  Warnings: ${warnings}`);
if (errors > 0) {
  console.error('\nGovernance validation FAILED.\n');
  process.exit(1);
} else {
  console.log('\nGovernance validation PASSED.\n');
}

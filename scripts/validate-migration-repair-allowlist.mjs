#!/usr/bin/env node
/**
 * Validates the migration reconciliation manifest, repair allowlist,
 * and verification candidates against repository migration files.
 *
 * Key invariants:
 * - Manifest has exactly 146 entries (one per version 101-246)
 * - PENDING + VERIFIED_APPLIED_UNTRACKED = 124 (progressive batches)
 * - ALIGNED_TRACKED = 8, NOT_VERIFIABLE_SAFELY = 12, SUPERSEDED = 2
 * - No candidate may enter the repair allowlist without production_verified evidence_source
 * - The approved repair allowlist must equal the exact set of manifest entries with
 *   repair_eligible=true and repair_status=approved_for_repair
 * - Every approved entry must have verified production evidence with digests
 * - Verification candidates = exact PENDING set
 * - Superseded objects must document replacement and impact
 * - Rejected verified_state values are never allowed in approved evidence
 * - All timestamps must be valid UTC
 * - Batch evidence files must cross-validate against manifest
 *
 * Does not connect to Supabase or any external service.
 */
import { readFileSync, existsSync, readdirSync } from 'fs';
import { createHash } from 'crypto';
import { resolve } from 'path';

const ALLOWLIST_PATH = resolve('docs/migrations/101-246-repair-allowlist.json');
const MANIFEST_PATH = resolve('docs/migrations/101-246-production-reconciliation.json');
const CANDIDATES_PATH = resolve('docs/migrations/101-246-verification-candidates.json');
const MIGRATIONS_DIR = resolve('supabase/migrations');
const BATCH_01_PATH = resolve('docs/migrations/evidence/batch-01-production-verification.json');

const VALID_CLASSIFICATIONS = new Set([
  'ALIGNED_TRACKED',
  'VERIFIED_APPLIED_UNTRACKED',
  'PENDING_PRODUCTION_REVERIFICATION',
  'NOT_VERIFIABLE_SAFELY',
  'SUPERSEDED_WITH_EQUIVALENT_STATE'
]);

const REJECTED_VERIFIED_STATES = new Set([
  'true', 'false', 'missing', 'absent', 'failed', 'ambiguous',
  'unknown', 'unverified', '', null
]);

const VALID_SUPERSEDED_STATES = new Set([
  'superseded_with_equivalent_state',
  'superseded_with_stricter_state'
]);

const EXPECTED_MANIFEST_COUNT = 146;
const EXPECTED_ALIGNED = 8;
const EXPECTED_NV = 12;
const EXPECTED_SUPERSEDED = 2;
const EXPECTED_PENDING_PLUS_VERIFIED = 124; // PENDING + VERIFIED = 124 (progressive)

let errors = 0;
let warnings = 0;

function fail(msg) {
  console.error(`  FAIL: ${msg}`);
  errors++;
}

function warn(msg) {
  console.error(`  WARN: ${msg}`);
  warnings++;
}

function pass(msg) {
  console.log(`  PASS: ${msg}`);
}

function isValidUTCTimestamp(ts) {
  if (!ts || typeof ts !== 'string') return false;
  // Accept Z suffix or +00:00 offset
  if (!ts.endsWith('Z') && !ts.endsWith('+00:00')) return false;
  const d = new Date(ts);
  return !isNaN(d.getTime());
}

console.log('=== Migration Reconciliation Validation ===\n');

// ── Check files exist ──
for (const [name, path] of [['Allowlist', ALLOWLIST_PATH], ['Manifest', MANIFEST_PATH], ['Candidates', CANDIDATES_PATH]]) {
  if (!existsSync(path)) {
    fail(`${name} file not found: ${path}`);
    process.exit(1);
  }
}

// ── Parse JSON ──
let allowlist, manifest, candidates;
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
try {
  candidates = JSON.parse(readFileSync(CANDIDATES_PATH, 'utf-8'));
  pass('Candidates is valid JSON');
} catch (e) {
  fail('Candidates is invalid JSON: ' + e.message);
  process.exit(1);
}

// ── Get migration files ──
const migrationFiles = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql'));

// ══════════════════════════════════════════════════════════════
// MANIFEST CHECKS
// ══════════════════════════════════════════════════════════════
console.log('\n--- Manifest Checks ---\n');

if (manifest.length !== EXPECTED_MANIFEST_COUNT) {
  fail(`Manifest has ${manifest.length} entries, expected ${EXPECTED_MANIFEST_COUNT}`);
} else {
  pass(`Manifest has exactly ${EXPECTED_MANIFEST_COUNT} entries`);
}

// One entry per version 101-246, unique, sorted
const manifestVersions = manifest.map(e => e.version);
const expectedVersions = [];
for (let i = 101; i <= 246; i++) expectedVersions.push(String(i));
const missingVersions = expectedVersions.filter(v => !manifestVersions.includes(v));
if (missingVersions.length > 0) {
  fail(`Missing versions: ${missingVersions.join(', ')}`);
} else {
  pass('All versions 101-246 present');
}

const uniqueSet = new Set(manifestVersions);
if (uniqueSet.size !== manifestVersions.length) {
  fail('Duplicate versions');
} else {
  pass('No duplicate versions');
}

const sorted = [...manifestVersions].sort((a, b) => parseInt(a) - parseInt(b));
if (!manifestVersions.every((v, i) => v === sorted[i])) {
  fail('Versions not sorted');
} else {
  pass('Versions sorted');
}

// Valid classifications
const invalidClass = manifest.filter(e => !VALID_CLASSIFICATIONS.has(e.current_classification));
if (invalidClass.length > 0) {
  fail(`Invalid classifications: ${invalidClass.map(e => `${e.version}=${e.current_classification}`).join(', ')}`);
} else {
  pass('All classifications valid');
}

// Filenames and checksums match repository
let fileErrors = 0;
for (const entry of manifest) {
  const repoFile = migrationFiles.find(f => f.startsWith(entry.version + '_'));
  if (!repoFile || entry.filename !== repoFile) {
    fail(`Version ${entry.version}: filename mismatch`);
    fileErrors++;
    continue;
  }
  const content = readFileSync(resolve(MIGRATIONS_DIR, repoFile), 'utf-8');
  const sha256 = createHash('sha256').update(content).digest('hex');
  if (entry.checksum !== sha256) {
    fail(`Version ${entry.version}: checksum mismatch`);
    fileErrors++;
  }
}
if (fileErrors === 0) pass('All filenames and checksums match repository');

// Classification counts
const counts = {};
manifest.forEach(e => { counts[e.current_classification] = (counts[e.current_classification] || 0) + 1; });

const alignedCount = counts['ALIGNED_TRACKED'] || 0;
const pendingCount = counts['PENDING_PRODUCTION_REVERIFICATION'] || 0;
const nvCount = counts['NOT_VERIFIABLE_SAFELY'] || 0;
const supersededCount = counts['SUPERSEDED_WITH_EQUIVALENT_STATE'] || 0;
const verifiedCount = counts['VERIFIED_APPLIED_UNTRACKED'] || 0;

if (alignedCount !== EXPECTED_ALIGNED) fail(`ALIGNED_TRACKED: ${alignedCount}, expected ${EXPECTED_ALIGNED}`);
else pass(`ALIGNED_TRACKED: ${alignedCount}`);

// Progressive: PENDING + VERIFIED must equal 124
if (pendingCount + verifiedCount !== EXPECTED_PENDING_PLUS_VERIFIED) {
  fail(`PENDING (${pendingCount}) + VERIFIED (${verifiedCount}) = ${pendingCount + verifiedCount}, expected ${EXPECTED_PENDING_PLUS_VERIFIED}`);
} else {
  pass(`PENDING (${pendingCount}) + VERIFIED (${verifiedCount}) = ${EXPECTED_PENDING_PLUS_VERIFIED}`);
}

if (nvCount !== EXPECTED_NV) fail(`NOT_VERIFIABLE_SAFELY: ${nvCount}, expected ${EXPECTED_NV}`);
else pass(`NOT_VERIFIABLE_SAFELY: ${nvCount}`);

if (supersededCount !== EXPECTED_SUPERSEDED) fail(`SUPERSEDED: ${supersededCount}, expected ${EXPECTED_SUPERSEDED}`);
else pass(`SUPERSEDED: ${supersededCount}`);

// ── Approved entries validation ──
const approvedInManifest = manifest.filter(e => e.repair_eligible && e.repair_status === 'approved_for_repair');
let approvedErrors = 0;
for (const e of approvedInManifest) {
  if (e.evidence_source !== 'production_verified') {
    fail(`Version ${e.version}: approved but evidence_source=${e.evidence_source} (must be production_verified)`);
    approvedErrors++;
  }
  if (e.confidence !== 'HIGH') {
    fail(`Version ${e.version}: approved but confidence=${e.confidence} (must be HIGH)`);
    approvedErrors++;
  }
  if (!Array.isArray(e.evidence) || e.evidence.length === 0) {
    fail(`Version ${e.version}: approved but evidence array is empty`);
    approvedErrors++;
  } else {
    // Every evidence item must have verified_state, verified_at, and verification_source
    for (const ev of e.evidence) {
      if (!ev.verified_state) {
        fail(`Version ${e.version}: evidence for ${ev.object_name} missing verified_state`);
        approvedErrors++;
      }
      if (!ev.verified_at) {
        fail(`Version ${e.version}: evidence for ${ev.object_name} missing verified_at`);
        approvedErrors++;
      }
      if (!ev.verification_source) {
        fail(`Version ${e.version}: evidence for ${ev.object_name} missing verification_source`);
        approvedErrors++;
      }

      // 2a: Reject unsafe verified_state values
      if (REJECTED_VERIFIED_STATES.has(ev.verified_state)) {
        fail(`Version ${e.version}: evidence for ${ev.object_name} has rejected verified_state "${ev.verified_state}"`);
        approvedErrors++;
      }

      // 2b: verified_state must satisfy expected_state
      if (ev.verified_state && !REJECTED_VERIFIED_STATES.has(ev.verified_state)) {
        const isSuperseded = VALID_SUPERSEDED_STATES.has(ev.verified_state);
        if (isSuperseded) {
          // Superseded evidence must have replacement metadata
          if (!ev.replacement_object_name) {
            fail(`Version ${e.version}: superseded object ${ev.object_name} missing replacement_object_name`);
            approvedErrors++;
          }
          if (!ev.superseding_migration) {
            fail(`Version ${e.version}: superseded object ${ev.object_name} missing superseding_migration`);
            approvedErrors++;
          }
          if (!ev.rationale) {
            fail(`Version ${e.version}: superseded object ${ev.object_name} missing rationale`);
            approvedErrors++;
          }
          if (!ev.application_behaviour_impact) {
            fail(`Version ${e.version}: superseded object ${ev.object_name} missing application_behaviour_impact`);
            approvedErrors++;
          }
          // Superseded evidence must have valid verified_at
          if (!isValidUTCTimestamp(ev.verified_at)) {
            fail(`Version ${e.version}: superseded object ${ev.object_name} has invalid verified_at timestamp "${ev.verified_at}"`);
            approvedErrors++;
          }
        } else {
          // Non-superseded: verified_state must equal expected_state
          if (ev.verified_state !== ev.expected_state) {
            fail(`Version ${e.version}: evidence for ${ev.object_name} has verified_state "${ev.verified_state}" but expected_state "${ev.expected_state}"`);
            approvedErrors++;
          }
        }
      }

      // 2c: UTC timestamp validation for verified_at
      if (ev.verified_at && !isValidUTCTimestamp(ev.verified_at)) {
        fail(`Version ${e.version}: evidence for ${ev.object_name} has non-UTC timestamp "${ev.verified_at}"`);
        approvedErrors++;
      }

      // 2e: Reject failed/ambiguous results
      if (ev.result === 'failed') {
        fail(`Version ${e.version}: evidence for ${ev.object_name} has result "failed" — cannot be approved`);
        approvedErrors++;
      }
      if (ev.result === 'ambiguous') {
        fail(`Version ${e.version}: evidence for ${ev.object_name} has result "ambiguous" — cannot be approved`);
        approvedErrors++;
      }
    }
  }
  if (e.current_classification !== 'VERIFIED_APPLIED_UNTRACKED') {
    fail(`Version ${e.version}: approved but classification=${e.current_classification}`);
    approvedErrors++;
  }

  // 2c: UTC timestamp validation for last_verified_at
  if (e.last_verified_at && !isValidUTCTimestamp(e.last_verified_at)) {
    fail(`Version ${e.version}: last_verified_at is not a valid UTC timestamp "${e.last_verified_at}"`);
    approvedErrors++;
  }
}
if (approvedErrors === 0) pass(`All ${approvedInManifest.length} approved entries correctly configured with production evidence`);

// Pending verification entries must have evidence_source=sql_derived and repair_eligible=false
const pendingEntries = manifest.filter(e => e.current_classification === 'PENDING_PRODUCTION_REVERIFICATION');
let pendingErrors = 0;
for (const e of pendingEntries) {
  if (e.repair_eligible !== false) {
    fail(`Version ${e.version}: PENDING entry has repair_eligible=true`);
    pendingErrors++;
  }
  if (e.evidence_source !== 'sql_derived') {
    fail(`Version ${e.version}: PENDING entry has evidence_source=${e.evidence_source}, expected sql_derived`);
    pendingErrors++;
  }
  if (e.confidence !== 'UNCONFIRMED') {
    fail(`Version ${e.version}: PENDING entry has confidence=${e.confidence}, expected UNCONFIRMED`);
    pendingErrors++;
  }
}
if (pendingErrors === 0) pass(`All ${pendingEntries.length} PENDING entries correctly configured`);

// Completed entries have production_verified evidence
const completedEntries = manifest.filter(e => e.repair_status === 'completed');
let completedErrors = 0;
for (const e of completedEntries) {
  if (e.evidence_source !== 'production_verified') {
    fail(`Version ${e.version}: completed but evidence_source=${e.evidence_source}`);
    completedErrors++;
  }
}
if (completedErrors === 0) pass(`All ${completedEntries.length} completed entries have production-verified evidence`);

// ══════════════════════════════════════════════════════════════
// ALLOWLIST CHECKS
// ══════════════════════════════════════════════════════════════
console.log('\n--- Allowlist Checks ---\n');

// Approved allowlist must equal manifest entries with repair_eligible=true AND repair_status=approved_for_repair
if (allowlist.length !== approvedInManifest.length) {
  fail(`Allowlist has ${allowlist.length} entries, manifest has ${approvedInManifest.length} approved entries`);
} else {
  pass(`Allowlist matches manifest approved entries: ${allowlist.length}`);
}

// Verify allowlist versions match approved manifest versions exactly
const allowlistVersions = new Set(allowlist.map(e => e.version));
const approvedVersions = new Set(approvedInManifest.map(e => e.version));
const allowlistNotApproved = [...allowlistVersions].filter(v => !approvedVersions.has(v));
const approvedNotAllowlist = [...approvedVersions].filter(v => !allowlistVersions.has(v));
if (allowlistNotApproved.length > 0) {
  fail(`Allowlist contains versions not approved: ${allowlistNotApproved.join(', ')}`);
}
if (approvedNotAllowlist.length > 0) {
  fail(`Approved versions missing from allowlist: ${approvedNotAllowlist.join(', ')}`);
}
if (allowlistNotApproved.length === 0 && approvedNotAllowlist.length === 0) {
  pass('Allowlist and approved manifest versions match exactly');
}

// Verify allowlist production_evidence_digest recomputes correctly
const manifestByVersion = {};
manifest.forEach(e => { manifestByVersion[e.version] = e; });
let digestErrors = 0;
for (const entry of allowlist) {
  const me = manifestByVersion[entry.version];
  if (!me) {
    fail(`Allowlist version ${entry.version}: not found in manifest`);
    digestErrors++;
    continue;
  }
  // Recompute digest
  const canonical = JSON.stringify({
    version: me.version,
    filename: me.filename,
    checksum: me.checksum,
    current_classification: me.current_classification,
    evidence_source: me.evidence_source,
    evidence: me.evidence,
    last_verified_at: me.last_verified_at
  });
  const expectedDigest = createHash('sha256').update(canonical).digest('hex');
  if (entry.production_evidence_digest !== expectedDigest) {
    fail(`Allowlist version ${entry.version}: digest mismatch (expected ${expectedDigest}, got ${entry.production_evidence_digest})`);
    digestErrors++;
  }
  // Verify checksum matches manifest
  if (entry.checksum !== me.checksum) {
    fail(`Allowlist version ${entry.version}: checksum mismatch with manifest`);
    digestErrors++;
  }
  // Verify filename matches manifest
  if (entry.filename !== me.filename) {
    fail(`Allowlist version ${entry.version}: filename mismatch with manifest`);
    digestErrors++;
  }
  // Verify confidence
  if (entry.confidence !== 'HIGH') {
    fail(`Allowlist version ${entry.version}: confidence=${entry.confidence}, expected HIGH`);
    digestErrors++;
  }
}
if (digestErrors === 0) pass(`All ${allowlist.length} allowlist production_evidence_digest values recompute correctly`);

// ══════════════════════════════════════════════════════════════
// CANDIDATE CHECKS
// ══════════════════════════════════════════════════════════════
console.log('\n--- Verification Candidate Checks ---\n');

if (candidates.length !== pendingCount) {
  fail(`Candidates has ${candidates.length} entries, expected ${pendingCount} (PENDING count)`);
} else {
  pass(`Candidates count matches PENDING count: ${candidates.length}`);
}

// Candidates must be exact PENDING set
const candVersionSet = new Set(candidates.map(c => c.version));
const pendingVersionSet = new Set(pendingEntries.map(e => e.version));
const candNotPending = [...candVersionSet].filter(v => !pendingVersionSet.has(v));
const pendingNotCand = [...pendingVersionSet].filter(v => !candVersionSet.has(v));
if (candNotPending.length > 0) {
  fail(`Candidate versions not in PENDING: ${candNotPending.join(', ')}`);
}
if (pendingNotCand.length > 0) {
  fail(`PENDING versions missing from candidates: ${pendingNotCand.join(', ')}`);
}
if (candNotPending.length === 0 && pendingNotCand.length === 0) {
  pass('Candidates = exact PENDING set');
}

// Candidates sorted and unique
const candVersions = candidates.map(e => e.version);
const candUnique = new Set(candVersions);
if (candUnique.size !== candVersions.length) fail('Candidate duplicate versions');
else pass('Candidate versions unique');

const candSorted = [...candVersions].sort((a, b) => parseInt(a) - parseInt(b));
if (!candVersions.every((v, i) => v === candSorted[i])) fail('Candidates not sorted');
else pass('Candidates sorted');

// Each candidate's checksum matches repository
let candErrors = 0;
for (const entry of candidates) {
  const repoFile = migrationFiles.find(f => f.startsWith(entry.version + '_'));
  if (!repoFile) { fail(`Candidate ${entry.version}: no repo file`); candErrors++; continue; }
  const content = readFileSync(resolve(MIGRATIONS_DIR, repoFile), 'utf-8');
  const sha256 = createHash('sha256').update(content).digest('hex');
  if (entry.checksum !== sha256) { fail(`Candidate ${entry.version}: checksum mismatch`); candErrors++; }

  // Verify digest recomputes
  const me = manifestByVersion[entry.version];
  if (me) {
    const canonical = JSON.stringify({
      version: me.version,
      filename: me.filename,
      checksum: me.checksum,
      evidence: me.evidence
    });
    const expectedDigest = createHash('sha256').update(canonical).digest('hex');
    if (entry.expected_object_digest !== expectedDigest) {
      fail(`Candidate ${entry.version}: digest mismatch`);
      candErrors++;
    }
  }
}
if (candErrors === 0) pass(`All ${candidates.length} candidate checksums and digests verified`);

// ══════════════════════════════════════════════════════════════
// BATCH EVIDENCE CROSS-VALIDATION
// ══════════════════════════════════════════════════════════════
console.log('\n--- Batch Evidence Cross-Validation ---\n');

if (existsSync(BATCH_01_PATH)) {
  let batch01;
  try {
    batch01 = JSON.parse(readFileSync(BATCH_01_PATH, 'utf-8'));
    pass('Batch 01 evidence is valid JSON');
  } catch (e) {
    fail('Batch 01 evidence is invalid JSON: ' + e.message);
  }

  if (batch01) {
    let batchErrors = 0;

    // Check main_sha
    if (batch01.main_sha !== '761fdf8895079488ead7f8e4d5e359e4262a89ae') {
      fail(`Batch 01 main_sha mismatch: ${batch01.main_sha}`);
      batchErrors++;
    } else {
      pass('Batch 01 main_sha correct');
    }

    // Check batch_number
    if (batch01.batch_number !== 1) {
      fail(`Batch 01 batch_number: ${batch01.batch_number}, expected 1`);
      batchErrors++;
    } else {
      pass('Batch 01 batch_number = 1');
    }

    // Check versions
    const expectedBatch1Versions = ['102','103','104','106','108','109','110','111','112','113','114','116','117','118','120'];
    const batch1VersionsMatch = JSON.stringify(batch01.versions) === JSON.stringify(expectedBatch1Versions);
    if (!batch1VersionsMatch) {
      fail(`Batch 01 versions mismatch`);
      batchErrors++;
    } else {
      pass('Batch 01 versions = exact 15 versions');
    }

    // Check totals
    if (batch01.total_objects_checked !== 94) {
      fail(`Batch 01 total_objects_checked: ${batch01.total_objects_checked}, expected 94`);
      batchErrors++;
    } else {
      pass('Batch 01 total_objects_checked = 94');
    }

    if (batch01.total_passed !== 93) {
      fail(`Batch 01 total_passed: ${batch01.total_passed}, expected 93`);
      batchErrors++;
    } else {
      pass('Batch 01 total_passed = 93');
    }

    if (batch01.total_superseded !== 1) {
      fail(`Batch 01 total_superseded: ${batch01.total_superseded}, expected 1`);
      batchErrors++;
    } else {
      pass('Batch 01 total_superseded = 1');
    }

    if (batch01.total_failed !== 0) {
      fail(`Batch 01 total_failed: ${batch01.total_failed}, expected 0`);
      batchErrors++;
    } else {
      pass('Batch 01 total_failed = 0');
    }

    // Check all classifications = VERIFIED_APPLIED_UNTRACKED
    if (batch01.classifications) {
      let classErrors = 0;
      for (const [ver, cls] of Object.entries(batch01.classifications)) {
        if (cls !== 'VERIFIED_APPLIED_UNTRACKED') {
          fail(`Batch 01 version ${ver}: classification=${cls}, expected VERIFIED_APPLIED_UNTRACKED`);
          classErrors++;
          batchErrors++;
        }
      }
      if (classErrors === 0) pass('Batch 01 all classifications = VERIFIED_APPLIED_UNTRACKED');
    }

    // Check checksums match repository
    let checksumErrors = 0;
    for (const m of batch01.migrations || []) {
      const repoFile = migrationFiles.find(f => f.startsWith(m.version + '_'));
      if (!repoFile) { continue; }
      const content = readFileSync(resolve(MIGRATIONS_DIR, repoFile), 'utf-8');
      const sha256 = createHash('sha256').update(content).digest('hex');
      if (m.checksum !== sha256) {
        fail(`Batch 01 version ${m.version}: checksum mismatch with repository`);
        checksumErrors++;
        batchErrors++;
      }
    }
    if (checksumErrors === 0) pass('Batch 01 all checksums match repository');

    // Check evidence versions = allowlist versions
    const batch1VersionSet = new Set(batch01.versions);
    const allowlistVersionSet = new Set(allowlist.map(e => e.version));
    const batch1NotAllowlist = [...batch1VersionSet].filter(v => !allowlistVersionSet.has(v));
    const allowlistNotBatch1Extra = [...allowlistVersionSet].filter(v => !batch1VersionSet.has(v));
    // Batch 1 versions should be a subset of (or equal to) allowlist versions
    if (batch1NotAllowlist.length > 0) {
      fail(`Batch 01 versions not in allowlist: ${batch1NotAllowlist.join(', ')}`);
      batchErrors++;
    } else {
      pass('Batch 01 evidence versions present in allowlist');
    }

    // Check Migration 103 contains supersession documentation
    const mig103 = (batch01.migrations || []).find(m => m.version === '103');
    if (mig103) {
      const supersededObj = mig103.objects.find(o => o.result === 'superseded');
      if (!supersededObj) {
        fail('Batch 01 Migration 103: no superseded object found');
        batchErrors++;
      } else {
        if (!supersededObj.replacement_object_name) {
          fail('Batch 01 Migration 103: superseded object missing replacement_object_name');
          batchErrors++;
        }
        if (!supersededObj.superseding_migration) {
          fail('Batch 01 Migration 103: superseded object missing superseding_migration');
          batchErrors++;
        }
        if (!supersededObj.rationale) {
          fail('Batch 01 Migration 103: superseded object missing rationale');
          batchErrors++;
        }
        if (!supersededObj.application_behaviour_impact) {
          fail('Batch 01 Migration 103: superseded object missing application_behaviour_impact');
          batchErrors++;
        }
        if (supersededObj.replacement_object_name && supersededObj.superseding_migration && supersededObj.rationale && supersededObj.application_behaviour_impact) {
          pass('Batch 01 Migration 103 supersession fully documented');
        }
      }
    } else {
      fail('Batch 01: Migration 103 not found in batch evidence');
      batchErrors++;
    }

    // Check no rejected verified_states in batch evidence
    let batchStateErrors = 0;
    for (const m of batch01.migrations || []) {
      for (const obj of m.objects || []) {
        if (REJECTED_VERIFIED_STATES.has(obj.verified_state)) {
          fail(`Batch 01 version ${m.version}: object ${obj.object_name} has rejected verified_state "${obj.verified_state}"`);
          batchStateErrors++;
          batchErrors++;
        }
      }
    }
    if (batchStateErrors === 0) pass('Batch 01 no rejected verified_states');

    if (batchErrors === 0) pass('Batch 01 cross-validation passed');
  }
} else {
  pass('Batch 01 evidence file not present (skipped)');
}

// ── Summary ──
console.log('\n=== Summary ===');
console.log(`  Manifest: ${manifest.length} entries`);
console.log(`    ALIGNED_TRACKED: ${alignedCount}`);
console.log(`    VERIFIED_APPLIED_UNTRACKED: ${verifiedCount}`);
console.log(`    PENDING_PRODUCTION_REVERIFICATION: ${pendingCount}`);
console.log(`    NOT_VERIFIABLE_SAFELY: ${nvCount}`);
console.log(`    SUPERSEDED: ${supersededCount}`);
console.log(`  Approved repair allowlist: ${allowlist.length}`);
console.log(`  Verification candidates: ${candidates.length}`);
console.log(`  Errors: ${errors}`);
console.log(`  Warnings: ${warnings}`);
if (errors > 0) {
  console.log('\nMigration reconciliation validation FAILED.');
  process.exit(1);
} else {
  console.log('\nMigration reconciliation validation PASSED.');
}

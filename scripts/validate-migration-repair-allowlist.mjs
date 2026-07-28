#!/usr/bin/env node
/**
 * Validates the migration reconciliation manifest, repair allowlist,
 * verification candidates, and repair evidence against repository migration files.
 *
 * Progressive invariants (multi-batch aware):
 * - Manifest has exactly 146 entries (one per version 101-246)
 * - ALIGNED_TRACKED = 38 (8 original + 15 Batch 1 repaired + 15 Batch 2 repaired)
 * - VERIFIED_APPLIED_UNTRACKED = 15 (Batch 3 verified, repair pending)
 * - PENDING_PRODUCTION_REVERIFICATION = 79
 * - NOT_VERIFIABLE_SAFELY = 12, SUPERSEDED = 2
 * - Active repair allowlist = 15 (Batch 3 approved, repair pending)
 * - Verification candidates = 79 (exact PENDING set)
 * - The 124-candidate cohort: PENDING + VERIFIED + repaired candidates = 124
 * - Completed repair entries cross-validate against batch evidence
 * - All verification batch evidence files are discovered and validated
 * - No duplicate versions or batch numbers across batches
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
const EVIDENCE_DIR = resolve('docs/migrations/evidence');

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
const EXPECTED_ALIGNED = 38;
const EXPECTED_VERIFIED = 15;
const EXPECTED_PENDING = 79;
const EXPECTED_NV = 12;
const EXPECTED_SUPERSEDED = 2;
const EXPECTED_CANDIDATE_COHORT = 124; // PENDING + VERIFIED + repaired candidates = 124

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

if (verifiedCount !== EXPECTED_VERIFIED) fail(`VERIFIED_APPLIED_UNTRACKED: ${verifiedCount}, expected ${EXPECTED_VERIFIED}`);
else pass(`VERIFIED_APPLIED_UNTRACKED: ${verifiedCount}`);

if (pendingCount !== EXPECTED_PENDING) fail(`PENDING: ${pendingCount}, expected ${EXPECTED_PENDING}`);
else pass(`PENDING_PRODUCTION_REVERIFICATION: ${pendingCount}`);

// Progressive: PENDING + VERIFIED + repaired candidates = 124
const repairedCandidateCount = manifest.filter(e =>
  e.current_classification === 'ALIGNED_TRACKED' &&
  e.repair_status === 'completed' &&
  e.original_classification === 'VERIFIED_APPLIED_UNTRACKED'
).length;
if (pendingCount + verifiedCount + repairedCandidateCount !== EXPECTED_CANDIDATE_COHORT) {
  fail(`PENDING (${pendingCount}) + VERIFIED (${verifiedCount}) + repaired candidates (${repairedCandidateCount}) = ${pendingCount + verifiedCount + repairedCandidateCount}, expected ${EXPECTED_CANDIDATE_COHORT}`);
} else {
  pass(`PENDING (${pendingCount}) + VERIFIED (${verifiedCount}) + repaired candidates (${repairedCandidateCount}) = ${EXPECTED_CANDIDATE_COHORT}`);
}

if (nvCount !== EXPECTED_NV) fail(`NOT_VERIFIABLE_SAFELY: ${nvCount}, expected ${EXPECTED_NV}`);
else pass(`NOT_VERIFIABLE_SAFELY: ${nvCount}`);

if (supersededCount !== EXPECTED_SUPERSEDED) fail(`SUPERSEDED: ${supersededCount}, expected ${EXPECTED_SUPERSEDED}`);
else pass(`SUPERSEDED: ${supersededCount}`);

// ── Approved entries validation (repair_eligible=true AND repair_status=approved_for_repair) ──
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
      if (REJECTED_VERIFIED_STATES.has(ev.verified_state)) {
        fail(`Version ${e.version}: evidence for ${ev.object_name} has rejected verified_state "${ev.verified_state}"`);
        approvedErrors++;
      }
      if (ev.verified_state && !REJECTED_VERIFIED_STATES.has(ev.verified_state)) {
        const isSuperseded = VALID_SUPERSEDED_STATES.has(ev.verified_state);
        if (isSuperseded) {
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
          if (!isValidUTCTimestamp(ev.verified_at)) {
            fail(`Version ${e.version}: superseded object ${ev.object_name} has invalid verified_at timestamp "${ev.verified_at}"`);
            approvedErrors++;
          }
        } else {
          // Default: verified_state must exactly equal expected_state
          const stateMatch = ev.verified_state === ev.expected_state;
          if (!stateMatch) {
            fail(`Version ${e.version}: evidence for ${ev.object_name} has verified_state "${ev.verified_state}" but expected_state "${ev.expected_state}"`);
            approvedErrors++;
          }
        }
      }
      if (ev.verified_at && !isValidUTCTimestamp(ev.verified_at)) {
        fail(`Version ${e.version}: evidence for ${ev.object_name} has non-UTC timestamp "${ev.verified_at}"`);
        approvedErrors++;
      }
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
  if (e.last_verified_at && !isValidUTCTimestamp(e.last_verified_at)) {
    fail(`Version ${e.version}: last_verified_at is not a valid UTC timestamp "${e.last_verified_at}"`);
    approvedErrors++;
  }
}
if (approvedErrors === 0) pass(`All ${approvedInManifest.length} approved entries correctly configured with production evidence`);

// ── Completed repair entries validation ──
console.log('\n--- Completed Repair Checks ---\n');

const completedEntries = manifest.filter(e => e.repair_status === 'completed');
// Batch-repaired entries: completed entries with a repair_batch (went through the batch repair process)
const batchRepairedEntries = completedEntries.filter(e => Number.isInteger(e.repair_batch) && e.repair_batch >= 1);
// Individually-repaired entries: completed entries without a repair_batch (repaired before batch process)
const individuallyRepairedEntries = completedEntries.filter(e => !Number.isInteger(e.repair_batch) || e.repair_batch < 1);

let completedErrors = 0;

// All completed entries must share these properties
for (const e of completedEntries) {
  if (e.current_classification !== 'ALIGNED_TRACKED') {
    fail(`Version ${e.version}: completed but current_classification=${e.current_classification} (expected ALIGNED_TRACKED)`);
    completedErrors++;
  }
  if (e.remote_tracked !== true) {
    fail(`Version ${e.version}: completed but remote_tracked=${e.remote_tracked} (expected true)`);
    completedErrors++;
  }
  if (e.repair_eligible !== false) {
    fail(`Version ${e.version}: completed but repair_eligible=${e.repair_eligible} (expected false)`);
    completedErrors++;
  }
  if (allowlist.some(a => a.version === e.version)) {
    fail(`Version ${e.version}: completed but still present in active allowlist`);
    completedErrors++;
  }
}

// Batch-repaired entries have stricter requirements
for (const e of batchRepairedEntries) {
  if (e.original_classification !== 'VERIFIED_APPLIED_UNTRACKED') {
    fail(`Version ${e.version}: batch-repaired but original_classification=${e.original_classification} (expected VERIFIED_APPLIED_UNTRACKED)`);
    completedErrors++;
  }
  if (e.confidence !== 'HIGH') {
    fail(`Version ${e.version}: batch-repaired but confidence=${e.confidence} (expected HIGH)`);
    completedErrors++;
  }
  if (e.evidence_source !== 'production_verified') {
    fail(`Version ${e.version}: batch-repaired but evidence_source=${e.evidence_source} (expected production_verified)`);
    completedErrors++;
  }
  if (!e.repaired_at) {
    fail(`Version ${e.version}: batch-repaired but missing repaired_at`);
    completedErrors++;
  } else if (!isValidUTCTimestamp(e.repaired_at)) {
    fail(`Version ${e.version}: batch-repaired but repaired_at is not valid UTC: "${e.repaired_at}"`);
    completedErrors++;
  }
  if (!e.repair_evidence_path || typeof e.repair_evidence_path !== 'string') {
    fail(`Version ${e.version}: batch-repaired but missing or invalid repair_evidence_path`);
    completedErrors++;
  }
  if (!e.repair_evidence_digest) {
    fail(`Version ${e.version}: batch-repaired but missing repair_evidence_digest`);
    completedErrors++;
  }
}

if (completedErrors === 0) pass(`All ${completedEntries.length} completed entries correctly configured (${batchRepairedEntries.length} batch-repaired, ${individuallyRepairedEntries.length} individually-repaired)`);

// ── Pending entries validation ──
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

// Verify allowlist production_evidence_digest recomputes correctly (if non-empty)
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
  if (entry.checksum !== me.checksum) {
    fail(`Allowlist version ${entry.version}: checksum mismatch with manifest`);
    digestErrors++;
  }
  if (entry.filename !== me.filename) {
    fail(`Allowlist version ${entry.version}: filename mismatch with manifest`);
    digestErrors++;
  }
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
// MULTI-BATCH VERIFICATION EVIDENCE CROSS-VALIDATION
// ══════════════════════════════════════════════════════════════
console.log('\n--- Multi-Batch Verification Evidence Cross-Validation ---\n');

// Discover all verification batch evidence files
const batchFiles = existsSync(EVIDENCE_DIR)
  ? readdirSync(EVIDENCE_DIR).filter(f => /^batch-\d+-production-verification\.json$/.test(f)).sort()
  : [];

if (batchFiles.length === 0) {
  warn('No batch verification evidence files found');
} else {
  pass(`Found ${batchFiles.length} verification batch evidence file(s): ${batchFiles.join(', ')}`);
}

// Parse all batch evidence
const allBatches = [];
for (const file of batchFiles) {
  const filePath = resolve(EVIDENCE_DIR, file);
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    allBatches.push({ file, data });
    pass(`${file} is valid JSON`);
  } catch (e) {
    fail(`${file} is invalid JSON: ${e.message}`);
  }
}

// Cross-validate: no duplicate batch numbers
const batchNumbers = allBatches.map(b => b.data.batch_number);
const uniqueBatchNumbers = new Set(batchNumbers);
if (uniqueBatchNumbers.size !== batchNumbers.length) {
  fail(`Duplicate batch numbers found: ${batchNumbers.join(', ')}`);
} else {
  pass(`All batch numbers unique: ${batchNumbers.join(', ')}`);
}

// Cross-validate: no duplicate versions across batches
const allBatchVersions = [];
for (const batch of allBatches) {
  allBatchVersions.push(...(batch.data.versions || []));
}
const uniqueBatchVersions = new Set(allBatchVersions);
if (uniqueBatchVersions.size !== allBatchVersions.length) {
  const dupes = allBatchVersions.filter((v, i) => allBatchVersions.indexOf(v) !== i);
  fail(`Duplicate versions across batches: ${[...new Set(dupes)].join(', ')}`);
} else {
  pass(`No duplicate versions across ${allBatches.length} batches (${allBatchVersions.length} total versions)`);
}

// Validate each batch individually
for (const { file, data: batch } of allBatches) {
  console.log(`\n--- Batch ${batch.batch_number} (${file}) ---\n`);

  let batchErrors = 0;

  // Valid SHA
  if (!batch.main_sha || typeof batch.main_sha !== 'string' || batch.main_sha.length < 7) {
    fail(`Batch ${batch.batch_number}: invalid main_sha`);
    batchErrors++;
  } else {
    pass(`Batch ${batch.batch_number} main_sha: ${batch.main_sha.substring(0, 8)}`);
  }

  // Batch number must be a positive integer
  if (!Number.isInteger(batch.batch_number) || batch.batch_number < 1) {
    fail(`Batch ${batch.batch_number}: invalid batch_number`);
    batchErrors++;
  }

  // Versions must be an array
  if (!Array.isArray(batch.versions) || batch.versions.length === 0) {
    fail(`Batch ${batch.batch_number}: empty or missing versions`);
    batchErrors++;
  }

  // Valid timestamp
  if (!isValidUTCTimestamp(batch.verification_timestamp)) {
    fail(`Batch ${batch.batch_number}: invalid verification_timestamp "${batch.verification_timestamp}"`);
    batchErrors++;
  } else {
    pass(`Batch ${batch.batch_number} timestamp valid UTC`);
  }

  // Totals consistency
  const computedTotal = (batch.total_passed || 0) + (batch.total_superseded || 0) + (batch.total_failed || 0);
  if (computedTotal !== batch.total_objects_checked) {
    fail(`Batch ${batch.batch_number}: totals inconsistent: passed(${batch.total_passed}) + superseded(${batch.total_superseded || 0}) + failed(${batch.total_failed}) = ${computedTotal}, expected ${batch.total_objects_checked}`);
    batchErrors++;
  } else {
    pass(`Batch ${batch.batch_number} totals consistent: ${batch.total_objects_checked} objects`);
  }

  // No failed objects
  if (batch.total_failed > 0) {
    fail(`Batch ${batch.batch_number}: has ${batch.total_failed} failed objects`);
    batchErrors++;
  } else {
    pass(`Batch ${batch.batch_number} no failed objects`);
  }

  // All classifications must be VERIFIED_APPLIED_UNTRACKED (at time of verification)
  if (batch.classifications) {
    let classErrors = 0;
    for (const [ver, cls] of Object.entries(batch.classifications)) {
      if (cls !== 'VERIFIED_APPLIED_UNTRACKED') {
        fail(`Batch ${batch.batch_number} version ${ver}: classification=${cls}, expected VERIFIED_APPLIED_UNTRACKED`);
        classErrors++;
        batchErrors++;
      }
    }
    if (classErrors === 0) pass(`Batch ${batch.batch_number} all classifications = VERIFIED_APPLIED_UNTRACKED`);
  }

  // Checksums match repository — missing files are a failure
  let checksumErrors = 0;
  for (const m of batch.migrations || []) {
    const repoFile = migrationFiles.find(f => f.startsWith(m.version + '_'));
    if (!repoFile) {
      fail(`Batch ${batch.batch_number} version ${m.version}: repository migration file missing`);
      checksumErrors++;
      batchErrors++;
      continue;
    }
    const content = readFileSync(resolve(MIGRATIONS_DIR, repoFile), 'utf-8');
    const sha256 = createHash('sha256').update(content).digest('hex');
    if (m.checksum !== sha256) {
      fail(`Batch ${batch.batch_number} version ${m.version}: checksum mismatch with repository`);
      checksumErrors++;
      batchErrors++;
    }
  }
  if (checksumErrors === 0) pass(`Batch ${batch.batch_number} all checksums match repository`);

  // No rejected verified_states in batch evidence
  let batchStateErrors = 0;
  for (const m of batch.migrations || []) {
    for (const obj of m.objects || []) {
      if (REJECTED_VERIFIED_STATES.has(obj.verified_state)) {
        fail(`Batch ${batch.batch_number} version ${m.version}: object ${obj.object_name} has rejected verified_state "${obj.verified_state}"`);
        batchStateErrors++;
        batchErrors++;
      }
    }
  }
  if (batchStateErrors === 0) pass(`Batch ${batch.batch_number} no rejected verified_states`);

  // All batch timestamps must be valid UTC
  let tsErrors = 0;
  for (const m of batch.migrations || []) {
    for (const obj of m.objects || []) {
      if (obj.verification_timestamp && !isValidUTCTimestamp(obj.verification_timestamp)) {
        fail(`Batch ${batch.batch_number} version ${m.version}: object ${obj.object_name} has non-UTC timestamp "${obj.verification_timestamp}"`);
        tsErrors++;
        batchErrors++;
      }
    }
  }
  if (tsErrors === 0) pass(`Batch ${batch.batch_number} all object timestamps valid UTC`);

  // Cross-validate: batch versions exist in manifest with correct verification_batch
  for (const ver of batch.versions || []) {
    const me = manifestByVersion[ver];
    if (!me) {
      fail(`Batch ${batch.batch_number} version ${ver}: not found in manifest`);
      batchErrors++;
    } else if (me.verification_batch !== undefined && me.verification_batch !== batch.batch_number) {
      // Only check if verification_batch is set (completed entries may have repair_batch instead)
      if (me.repair_status !== 'completed') {
        fail(`Batch ${batch.batch_number} version ${ver}: manifest verification_batch=${me.verification_batch}, expected ${batch.batch_number}`);
        batchErrors++;
      }
    }
  }

  // Check Migration 103 supersession (Batch 1 specific)
  if (batch.batch_number === 1) {
    const mig103 = (batch.migrations || []).find(m => m.version === '103');
    if (mig103) {
      const supersededObj = mig103.objects.find(o => o.result === 'superseded');
      if (!supersededObj) {
        fail('Batch 1 Migration 103: no superseded object found');
        batchErrors++;
      } else {
        if (!supersededObj.replacement_object_name || !supersededObj.superseding_migration || !supersededObj.rationale || !supersededObj.application_behaviour_impact) {
          fail('Batch 1 Migration 103: superseded object missing documentation fields');
          batchErrors++;
        } else {
          pass('Batch 1 Migration 103 supersession fully documented');
        }
      }
    }
  }

  // Batch-specific expected values
  if (batch.batch_number === 1) {
    if (batch.total_objects_checked !== 94) fail(`Batch 1 total_objects_checked: ${batch.total_objects_checked}, expected 94`);
    else pass('Batch 1 total_objects_checked = 94');
    if (batch.total_passed !== 93) fail(`Batch 1 total_passed: ${batch.total_passed}, expected 93`);
    else pass('Batch 1 total_passed = 93');
    if ((batch.total_superseded || 0) !== 1) fail(`Batch 1 total_superseded: ${batch.total_superseded}, expected 1`);
    else pass('Batch 1 total_superseded = 1');
  }

  if (batch.batch_number === 2) {
    if (batch.total_objects_checked !== 63) fail(`Batch 2 total_objects_checked: ${batch.total_objects_checked}, expected 63`);
    else pass('Batch 2 total_objects_checked = 63');
    if (batch.total_passed !== 63) fail(`Batch 2 total_passed: ${batch.total_passed}, expected 63`);
    else pass('Batch 2 total_passed = 63');
  }

  if (batch.batch_number === 3) {
    if (batch.total_objects_checked !== 91) fail(`Batch 3 total_objects_checked: ${batch.total_objects_checked}, expected 91`);
    else pass('Batch 3 total_objects_checked = 91');
    if (batch.total_passed !== 88) fail(`Batch 3 total_passed: ${batch.total_passed}, expected 88`);
    else pass('Batch 3 total_passed = 88');
    if ((batch.total_superseded || 0) !== 3) fail(`Batch 3 total_superseded: ${batch.total_superseded}, expected 3`);
    else pass('Batch 3 total_superseded = 3');
  }

  // ── Version-set equality: batch.versions must equal set of migration versions AND classification keys ──
  const migrationVersionSet = new Set((batch.migrations || []).map(m => m.version));
  const classificationVersionSet = batch.classifications ? new Set(Object.keys(batch.classifications)) : new Set();
  const batchVersionSet = new Set(batch.versions || []);

  const versionsNotInMigrations = [...batchVersionSet].filter(v => !migrationVersionSet.has(v));
  const migrationsNotInVersions = [...migrationVersionSet].filter(v => !batchVersionSet.has(v));
  if (versionsNotInMigrations.length > 0 || migrationsNotInVersions.length > 0) {
    fail(`Batch ${batch.batch_number}: versions array and migrations array mismatch (missing from migrations: ${versionsNotInMigrations.join(',') || 'none'}, extra in migrations: ${migrationsNotInVersions.join(',') || 'none'})`);
    batchErrors++;
  } else {
    pass(`Batch ${batch.batch_number} versions = migrations version set`);
  }

  if (batch.classifications) {
    const versionsNotInClassifications = [...batchVersionSet].filter(v => !classificationVersionSet.has(v));
    const classificationsNotInVersions = [...classificationVersionSet].filter(v => !batchVersionSet.has(v));
    if (versionsNotInClassifications.length > 0 || classificationsNotInVersions.length > 0) {
      fail(`Batch ${batch.batch_number}: versions array and classifications keys mismatch`);
      batchErrors++;
    } else {
      pass(`Batch ${batch.batch_number} versions = classifications key set`);
    }
  }

  // Manifest verification_batch must match batch versions
  if (batch.batch_number >= 2) {
    const manifestBatchEntries = manifest.filter(e => e.verification_batch === batch.batch_number);
    const manifestBatchVersionSet = new Set(manifestBatchEntries.map(e => e.version));
    const batchNotInManifestBatch = [...batchVersionSet].filter(v => !manifestBatchVersionSet.has(v));
    const manifestBatchNotInBatch = [...manifestBatchVersionSet].filter(v => !batchVersionSet.has(v));
    if (batchNotInManifestBatch.length > 0 || manifestBatchNotInBatch.length > 0) {
      fail(`Batch ${batch.batch_number}: version-set mismatch with manifest verification_batch entries`);
      batchErrors++;
    } else {
      pass(`Batch ${batch.batch_number} versions = manifest verification_batch=${batch.batch_number} entries`);
    }
  }

  // ── Count reconciliation: per-migration object_count === objects.length ──
  if (batch.batch_number >= 2) {
    let countErrors = 0;
    let totalObjectSum = 0;
    let totalPassedSum = 0;
    let totalFailedSum = 0;
    let totalAmbiguousSum = 0;
    let totalSupersededSum = 0;

    for (const m of batch.migrations || []) {
      const actualLen = (m.objects || []).length;
      totalObjectSum += actualLen;
      totalPassedSum += (m.passed || 0);
      totalFailedSum += (m.failed || 0);
      totalSupersededSum += (m.superseded || 0);
      totalAmbiguousSum += (m.ambiguous || 0);

      if (m.object_count !== undefined && m.object_count !== actualLen) {
        fail(`Batch ${batch.batch_number} version ${m.version}: object_count=${m.object_count} but objects.length=${actualLen}`);
        countErrors++;
        batchErrors++;
      }
    }

    if (totalObjectSum !== batch.total_objects_checked) {
      fail(`Batch ${batch.batch_number}: sum of per-migration objects (${totalObjectSum}) !== total_objects_checked (${batch.total_objects_checked})`);
      batchErrors++;
    } else {
      pass(`Batch ${batch.batch_number} per-migration object sums match totals`);
    }

    if (countErrors === 0 && (batch.migrations || []).some(m => m.object_count !== undefined)) {
      pass(`Batch ${batch.batch_number} all per-migration object_count values match`);
    }

    // Global totals
    if (batch.total_ambiguous !== undefined && batch.total_ambiguous !== totalAmbiguousSum) {
      fail(`Batch ${batch.batch_number}: total_ambiguous (${batch.total_ambiguous}) !== sum of per-migration ambiguous (${totalAmbiguousSum})`);
      batchErrors++;
    }
    if (batch.total_superseded !== undefined && (batch.total_superseded || 0) !== totalSupersededSum) {
      fail(`Batch ${batch.batch_number}: total_superseded (${batch.total_superseded}) !== sum of per-migration superseded (${totalSupersededSum})`);
      batchErrors++;
    }

    // Derive per-migration counts from object results and compare against stored counts
    let derivedCountErrors = 0;
    for (const m of batch.migrations || []) {
      const derivedPassed = (m.objects || []).filter(o => o.result === 'pass').length;
      const derivedFailed = (m.objects || []).filter(o => o.result === 'failed' || o.result === 'fail').length;
      const derivedAmbiguous = (m.objects || []).filter(o => o.result === 'ambiguous').length;
      const derivedSuperseded = (m.objects || []).filter(o => o.result === 'superseded').length;

      if (m.passed !== undefined && m.passed !== derivedPassed) {
        fail(`Batch ${batch.batch_number} version ${m.version}: stored passed=${m.passed} but derived=${derivedPassed}`);
        derivedCountErrors++; batchErrors++;
      }
      if (m.failed !== undefined && m.failed !== derivedFailed) {
        fail(`Batch ${batch.batch_number} version ${m.version}: stored failed=${m.failed} but derived=${derivedFailed}`);
        derivedCountErrors++; batchErrors++;
      }
      if (m.ambiguous !== undefined && m.ambiguous !== derivedAmbiguous) {
        fail(`Batch ${batch.batch_number} version ${m.version}: stored ambiguous=${m.ambiguous} but derived=${derivedAmbiguous}`);
        derivedCountErrors++; batchErrors++;
      }
      if (m.superseded !== undefined && m.superseded !== derivedSuperseded) {
        fail(`Batch ${batch.batch_number} version ${m.version}: stored superseded=${m.superseded} but derived=${derivedSuperseded}`);
        derivedCountErrors++; batchErrors++;
      }
    }
    if (derivedCountErrors === 0) pass(`Batch ${batch.batch_number} derived per-migration counts match stored counts`);
  }

  // ── Batch 2+ evidence enrichment checks: verification_source and query_category ──
  if (batch.batch_number >= 2) {
    let enrichErrors = 0;
    for (const m of batch.migrations || []) {
      for (const obj of m.objects || []) {
        if (!obj.verification_source) {
          fail(`Batch ${batch.batch_number} version ${m.version}: object ${obj.object_name} missing verification_source`);
          enrichErrors++;
          batchErrors++;
        }
        if (!obj.query_category) {
          fail(`Batch ${batch.batch_number} version ${m.version}: object ${obj.object_name} missing query_category`);
          enrichErrors++;
          batchErrors++;
        }
      }
    }
    // Complete object evidence field checks for Batch 2+
    for (const m of batch.migrations || []) {
      for (const obj of m.objects || []) {
        if (!obj.object_type) {
          fail(`Batch ${batch.batch_number} version ${m.version}: object missing object_type`);
          enrichErrors++; batchErrors++;
        }
        if (!obj.object_name) {
          fail(`Batch ${batch.batch_number} version ${m.version}: object missing object_name`);
          enrichErrors++; batchErrors++;
        }
        if (!obj.expected_state) {
          fail(`Batch ${batch.batch_number} version ${m.version}: object ${obj.object_name || '?'} missing expected_state`);
          enrichErrors++; batchErrors++;
        }
        if (!obj.verified_state) {
          fail(`Batch ${batch.batch_number} version ${m.version}: object ${obj.object_name || '?'} missing verified_state`);
          enrichErrors++; batchErrors++;
        }
        if (!obj.verification_timestamp || !isValidUTCTimestamp(obj.verification_timestamp)) {
          fail(`Batch ${batch.batch_number} version ${m.version}: object ${obj.object_name || '?'} has invalid verification_timestamp`);
          enrichErrors++; batchErrors++;
        }
        if (!obj.result) {
          fail(`Batch ${batch.batch_number} version ${m.version}: object ${obj.object_name || '?'} missing result`);
          enrichErrors++; batchErrors++;
        } else if (obj.result !== 'pass' && obj.result !== 'superseded') {
          fail(`Batch ${batch.batch_number} version ${m.version}: object ${obj.object_name || '?'} has invalid result "${obj.result}" (must be "pass" or "superseded")`);
          enrichErrors++; batchErrors++;
        }
        // For result=pass: verified_state must exactly equal expected_state
        if (obj.result === 'pass' && obj.verified_state && obj.expected_state && obj.verified_state !== obj.expected_state) {
          fail(`Batch ${batch.batch_number} version ${m.version}: object ${obj.object_name || '?'} result=pass but verified_state "${obj.verified_state}" !== expected_state "${obj.expected_state}"`);
          enrichErrors++; batchErrors++;
        }
      }
    }
    if (enrichErrors === 0) pass(`Batch ${batch.batch_number} all objects have complete evidence fields`);
  } else {
    // Batch 1: warn only for missing verification_source/query_category
    let batch1Missing = 0;
    for (const m of batch.migrations || []) {
      for (const obj of m.objects || []) {
        if (!obj.verification_source) batch1Missing++;
        if (!obj.query_category) batch1Missing++;
      }
    }
    if (batch1Missing > 0) {
      warn(`Batch ${batch.batch_number}: ${batch1Missing} objects missing verification_source/query_category (pre-requirement batch)`);
    }
  }

  // ── Manifest cross-validation for Batch 2+ ──
  if (batch.batch_number >= 2) {
    let crossErrors = 0;
    for (const m of batch.migrations || []) {
      const me = manifestByVersion[m.version];
      if (!me) continue;

      // Require verification_batch on approved manifest entries
      if (me.verification_batch === undefined) {
        fail(`Batch ${batch.batch_number} version ${m.version}: manifest entry missing verification_batch field`);
        crossErrors++;
        batchErrors++;
      }

      if (!Array.isArray(me.evidence)) continue;
      for (const obj of m.objects || []) {
        // Match by object_type + object_name + expected_state to handle cases where
        // the same object appears twice in a migration (e.g., DROP then CREATE)
        const manifestObj = me.evidence.find(ev =>
          ev.object_type === obj.object_type && ev.object_name === obj.object_name && ev.expected_state === obj.expected_state
        );
        if (!manifestObj) {
          fail(`Batch ${batch.batch_number} version ${m.version}: object ${obj.object_name} (${obj.object_type}, expected_state=${obj.expected_state}) not found in manifest evidence`);
          crossErrors++;
          batchErrors++;
          continue;
        }
        if (manifestObj.verified_state !== obj.verified_state) {
          fail(`Batch ${batch.batch_number} version ${m.version}: object ${obj.object_name} verified_state mismatch (batch: ${obj.verified_state}, manifest: ${manifestObj.verified_state})`);
          crossErrors++;
          batchErrors++;
        }
        if (manifestObj.verification_source !== obj.verification_source) {
          fail(`Batch ${batch.batch_number} version ${m.version}: object ${obj.object_name} verification_source mismatch (batch: ${obj.verification_source}, manifest: ${manifestObj.verification_source})`);
          crossErrors++;
          batchErrors++;
        }
        if (manifestObj.result !== obj.result) {
          fail(`Batch ${batch.batch_number} version ${m.version}: object ${obj.object_name} result mismatch (batch: ${obj.result}, manifest: ${manifestObj.result})`);
          crossErrors++;
          batchErrors++;
        }
        if (manifestObj.verified_at !== obj.verification_timestamp) {
          fail(`Batch ${batch.batch_number} version ${m.version}: object ${obj.object_name} timestamp mismatch (batch verification_timestamp: ${obj.verification_timestamp}, manifest verified_at: ${manifestObj.verified_at})`);
          crossErrors++;
          batchErrors++;
        }
      }

      // Check for manifest objects not in evidence (reverse direction)
      for (const manifestObj of me.evidence) {
        const evidenceObj = (m.objects || []).find(o =>
          o.object_type === manifestObj.object_type && o.object_name === manifestObj.object_name && o.expected_state === manifestObj.expected_state
        );
        if (!evidenceObj) {
          fail(`Batch ${batch.batch_number} version ${m.version}: manifest object ${manifestObj.object_name} (${manifestObj.object_type}, expected_state=${manifestObj.expected_state}) not in evidence`);
          crossErrors++;
          batchErrors++;
        }
      }
    }
    if (crossErrors === 0) pass(`Batch ${batch.batch_number} manifest cross-validation passed`);
  }

  if (batchErrors === 0) pass(`Batch ${batch.batch_number} cross-validation passed`);
}

// ══════════════════════════════════════════════════════════════
// MULTI-BATCH REPAIR EVIDENCE CROSS-VALIDATION
// ══════════════════════════════════════════════════════════════
console.log('\n--- Multi-Batch Repair Evidence Cross-Validation ---\n');

// Discover all repair evidence files
const repairFiles = existsSync(EVIDENCE_DIR)
  ? readdirSync(EVIDENCE_DIR).filter(f => /^batch-\d+-repair\.json$/.test(f)).sort()
  : [];

if (repairFiles.length === 0) {
  warn('No batch repair evidence files found');
} else {
  pass(`Found ${repairFiles.length} repair evidence file(s): ${repairFiles.join(', ')}`);
}

// Parse all repair evidence
const allRepairBatches = [];
for (const file of repairFiles) {
  const filePath = resolve(EVIDENCE_DIR, file);
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    // Extract batch number from filename
    const match = file.match(/batch-(\d+)-repair\.json/);
    const batchNumber = match ? parseInt(match[1]) : 0;
    allRepairBatches.push({ file, batchNumber, data });
    pass(`${file} is valid JSON`);
  } catch (e) {
    fail(`${file} is invalid JSON: ${e.message}`);
  }
}

// Cross-validate: no duplicate batch numbers across repair batches
const repairBatchNumbers = allRepairBatches.map(b => b.batchNumber);
const uniqueRepairBatchNumbers = new Set(repairBatchNumbers);
if (uniqueRepairBatchNumbers.size !== repairBatchNumbers.length) {
  fail(`Duplicate repair batch numbers found: ${repairBatchNumbers.join(', ')}`);
} else if (repairBatchNumbers.length > 0) {
  pass(`All repair batch numbers unique: ${repairBatchNumbers.join(', ')}`);
}

// Cross-validate: no duplicate versions across repair batches
const allRepairVersions = [];
for (const batch of allRepairBatches) {
  allRepairVersions.push(...batch.data.approved_versions.map(String));
}
const uniqueRepairVersions = new Set(allRepairVersions);
if (uniqueRepairVersions.size !== allRepairVersions.length) {
  const dupes = allRepairVersions.filter((v, i) => allRepairVersions.indexOf(v) !== i);
  fail(`Duplicate versions across repair batches: ${[...new Set(dupes)].join(', ')}`);
} else if (allRepairVersions.length > 0) {
  pass(`No duplicate versions across ${allRepairBatches.length} repair batches (${allRepairVersions.length} total versions)`);
}

// Validate each repair batch individually
for (const { file, batchNumber, data: repairData } of allRepairBatches) {
  console.log(`\n--- Repair Batch ${batchNumber} (${file}) ---\n`);

  let repairErrors = 0;

  // ── 2a. Filename/JSON batch-number equality ──
  const fileMatch = file.match(/batch-(\d+)-repair\.json$/);
  const filenameBatchNum = fileMatch ? parseInt(fileMatch[1]) : null;
  if (!filenameBatchNum || filenameBatchNum < 1) {
    fail(`${file}: cannot derive positive batch number from filename`);
    continue;
  }
  if (!Number.isInteger(repairData.batch_number) || repairData.batch_number < 1) {
    fail(`${file}: missing or invalid JSON batch_number`);
    continue;
  }
  if (repairData.batch_number !== filenameBatchNum) {
    fail(`${file}: filename batch ${filenameBatchNum} !== JSON batch_number ${repairData.batch_number}`);
    continue;
  }
  pass(`Repair Batch ${batchNumber} filename/JSON batch-number match`);

  // ── 2b. Full 40-char lowercase SHA ──
  if (!/^[0-9a-f]{40}$/.test(repairData.repository_sha)) {
    fail(`Repair batch ${repairData.batch_number}: repository_sha is not a valid 40-char lowercase hex SHA`);
    repairErrors++;
  } else {
    pass(`Repair Batch ${batchNumber} repository_sha: ${repairData.repository_sha.substring(0, 8)}`);
  }

  // Valid timestamp
  if (!isValidUTCTimestamp(repairData.timestamp_utc)) {
    fail(`Repair Batch ${batchNumber}: invalid timestamp_utc "${repairData.timestamp_utc}"`);
    repairErrors++;
  } else {
    pass(`Repair Batch ${batchNumber} timestamp valid UTC`);
  }

  // ── 2c. Exact version-set equality (5 sets must match) ──
  const approvedSet = new Set(repairData.approved_versions.map(String));
  const resultSet = new Set(repairData.repair_results.map(r => String(r.version)));
  const fileSet = new Set(Object.keys(repairData.migration_files));
  const manifestRepairSet = new Set(manifest.filter(e => e.repair_batch === repairData.batch_number).map(e => e.version));
  const newVersionsSet = new Set((repairData.post_repair.new_versions_added || []).map(String));

  for (const [name, s] of [['repair_results', resultSet], ['migration_files', fileSet], ['manifest repair_batch', manifestRepairSet], ['new_versions_added', newVersionsSet]]) {
    const missing = [...approvedSet].filter(v => !s.has(v));
    const extra = [...s].filter(v => !approvedSet.has(v));
    if (missing.length > 0 || extra.length > 0) {
      fail(`Repair batch ${repairData.batch_number}: approved_versions vs ${name} mismatch (missing: ${missing.join(',')}, extra: ${extra.join(',')})`);
      repairErrors++;
    }
  }
  const approvedArr = repairData.approved_versions.map(Number);
  if (new Set(approvedArr).size !== approvedArr.length) {
    fail(`Repair batch ${repairData.batch_number}: duplicate approved_versions`);
    repairErrors++;
  }
  const sortedApproved = [...approvedArr].sort((a,b) => a-b);
  if (!approvedArr.every((v,i) => v === sortedApproved[i])) {
    fail(`Repair batch ${repairData.batch_number}: approved_versions not sorted`);
    repairErrors++;
  }
  if (repairErrors === 0) pass(`Repair Batch ${batchNumber} 5-way version-set equality`);

  // ── 2d. Derive before/after version difference ──
  const preVersions = new Set((repairData.pre_repair.range_101_246_versions || []).map(String));
  const postVersions = new Set((repairData.post_repair.range_101_246_versions || []).map(String));
  const derivedAdded = [...postVersions].filter(v => !preVersions.has(v)).sort((a,b) => parseInt(a)-parseInt(b));
  const derivedRemoved = [...preVersions].filter(v => !postVersions.has(v));
  const approvedSorted = [...approvedSet].sort((a,b) => parseInt(a)-parseInt(b));

  if (JSON.stringify(derivedAdded) !== JSON.stringify(approvedSorted)) {
    fail(`Repair batch ${repairData.batch_number}: derived added versions don't match approved`);
    repairErrors++;
  } else {
    pass(`Repair Batch ${batchNumber} derived added versions match approved`);
  }
  if (derivedRemoved.length > 0) {
    fail(`Repair batch ${repairData.batch_number}: ${derivedRemoved.length} pre-existing versions removed`);
    repairErrors++;
  } else {
    pass(`Repair Batch ${batchNumber} no pre-existing versions removed`);
  }
  if (repairData.post_repair.total_remote_count - repairData.pre_repair.total_remote_count !== repairData.approved_count) {
    fail(`Repair batch ${repairData.batch_number}: total count delta mismatch`);
    repairErrors++;
  }
  if (repairData.post_repair.range_101_246_count - repairData.pre_repair.range_101_246_count !== repairData.approved_count) {
    fail(`Repair batch ${repairData.batch_number}: range count delta mismatch`);
    repairErrors++;
  }

  // ── 2e. Validate each result (order-independent) ──
  const postTotals = [];
  const postRanges = [];
  for (const r of repairData.repair_results) {
    if (!approvedSet.has(String(r.version))) {
      fail(`Repair batch ${repairData.batch_number}: result version ${r.version} not in approved_versions`);
      repairErrors++;
    }
    if (r.exit_status !== 0) {
      fail(`Repair batch ${repairData.batch_number} version ${r.version}: exit_status=${r.exit_status}`);
      repairErrors++;
    }
    if (r.version_tracked !== true) {
      fail(`Repair batch ${repairData.batch_number} version ${r.version}: version_tracked=${r.version_tracked}`);
      repairErrors++;
    }
    // total_delta check (Batch 2+ uses total_delta, Batch 1 uses delta)
    const tDelta = r.total_delta !== undefined ? r.total_delta : r.delta;
    if (tDelta !== 1) {
      fail(`Repair batch ${repairData.batch_number} version ${r.version}: total_delta=${tDelta}`);
      repairErrors++;
    }
    // range_delta check (Batch 2+ only)
    if (r.range_delta !== undefined && r.range_delta !== 1) {
      fail(`Repair batch ${repairData.batch_number} version ${r.version}: range_delta=${r.range_delta}`);
      repairErrors++;
    }
    if (!Number.isInteger(r.post_total)) {
      fail(`Repair batch ${repairData.batch_number} version ${r.version}: post_total not integer`);
      repairErrors++;
    }
    postTotals.push(r.post_total);
    // post_range is only present in Batch 2+
    if (r.post_range !== undefined) {
      if (!Number.isInteger(r.post_range)) {
        fail(`Repair batch ${repairData.batch_number} version ${r.version}: post_range not integer`);
        repairErrors++;
      }
      postRanges.push(r.post_range);
    }
  }

  // Order-independent: post_total set must be pre+1 through post
  const expectedTotalSet = new Set();
  for (let i = repairData.pre_repair.total_remote_count + 1; i <= repairData.post_repair.total_remote_count; i++) expectedTotalSet.add(i);
  const actualTotalSet = new Set(postTotals);
  if (actualTotalSet.size !== postTotals.length) {
    fail(`Repair batch ${repairData.batch_number}: duplicate post_total values`);
    repairErrors++;
  }
  if (actualTotalSet.size !== expectedTotalSet.size || [...actualTotalSet].some(v => !expectedTotalSet.has(v))) {
    fail(`Repair batch ${repairData.batch_number}: post_total values don't cover ${repairData.pre_repair.total_remote_count+1}-${repairData.post_repair.total_remote_count}`);
    repairErrors++;
  } else {
    pass(`Repair Batch ${batchNumber} post_total set covers ${repairData.pre_repair.total_remote_count+1}-${repairData.post_repair.total_remote_count}`);
  }

  // post_range order-independent check (only if post_range values exist)
  if (postRanges.length > 0) {
    const expectedRangeSet = new Set();
    for (let i = repairData.pre_repair.range_101_246_count + 1; i <= repairData.post_repair.range_101_246_count; i++) expectedRangeSet.add(i);
    const actualRangeSet = new Set(postRanges);
    if (actualRangeSet.size !== postRanges.length) {
      fail(`Repair batch ${repairData.batch_number}: duplicate post_range values`);
      repairErrors++;
    }
    if (actualRangeSet.size !== expectedRangeSet.size || [...actualRangeSet].some(v => !expectedRangeSet.has(v))) {
      fail(`Repair batch ${repairData.batch_number}: post_range values don't cover ${repairData.pre_repair.range_101_246_count+1}-${repairData.post_repair.range_101_246_count}`);
      repairErrors++;
    } else {
      pass(`Repair Batch ${batchNumber} post_range set covers ${repairData.pre_repair.range_101_246_count+1}-${repairData.post_repair.range_101_246_count}`);
    }
  }

  // Build lookup for repair results
  const repairResultsByVersion = {};
  repairData.repair_results.forEach(r => { repairResultsByVersion[String(r.version)] = r; });

  // Cross-validate each completed entry against repair evidence
  const batchCompletedEntries = completedEntries.filter(e => e.repair_batch === batchNumber);

  // Verify manifest entries with this batch number match repair evidence versions
  const manifestBatchVersions = new Set(batchCompletedEntries.map(e => e.version));
  const evidenceNotInManifest = [...approvedSet].filter(v => !manifestBatchVersions.has(v));
  const manifestNotInEvidence = [...manifestBatchVersions].filter(v => !approvedSet.has(v));
  if (evidenceNotInManifest.length > 0 || manifestNotInEvidence.length > 0) {
    fail(`Repair Batch ${batchNumber}: version-set mismatch between manifest (repair_batch=${batchNumber}) and repair evidence`);
    repairErrors++;
  } else {
    pass(`Repair Batch ${batchNumber}: manifest and evidence version sets match (${batchCompletedEntries.length} versions)`);
  }

  for (const entry of batchCompletedEntries) {
    const repairResult = repairResultsByVersion[entry.version];
    if (!repairResult) {
      fail(`Version ${entry.version}: completed with repair_batch=${batchNumber} but absent from repair evidence`);
      repairErrors++;
      continue;
    }

    // Verify exit_status = 0
    if (repairResult.exit_status !== 0) {
      fail(`Version ${entry.version}: repair exit_status=${repairResult.exit_status} (expected 0)`);
      repairErrors++;
    }

    // Verify version_tracked = true
    if (repairResult.version_tracked !== true) {
      fail(`Version ${entry.version}: repair version_tracked=${repairResult.version_tracked} (expected true)`);
      repairErrors++;
    }

    // Verify version, filename, checksum match between manifest and repair evidence
    const repairFileInfo = repairData.migration_files[entry.version];
    if (repairFileInfo) {
      if (repairFileInfo.filename !== entry.filename) {
        fail(`Version ${entry.version}: repair evidence filename mismatch`);
        repairErrors++;
      }
      if (repairFileInfo.checksum !== entry.checksum) {
        fail(`Version ${entry.version}: repair evidence checksum mismatch`);
        repairErrors++;
      }
    } else {
      fail(`Version ${entry.version}: not found in repair evidence migration_files`);
      repairErrors++;
    }

    // Verify repair_evidence_digest recomputes correctly
    if (entry.repair_evidence_digest) {
      const repairEvidence = {
        version: entry.version,
        filename: entry.filename,
        checksum: entry.checksum,
        repair_result: repairResult,
        repair_timestamp: repairData.timestamp_utc,
        repository_sha: repairData.repository_sha
      };
      const expectedDigest = createHash('sha256').update(JSON.stringify(repairEvidence)).digest('hex');
      if (entry.repair_evidence_digest !== expectedDigest) {
        fail(`Version ${entry.version}: repair_evidence_digest mismatch (computed ${expectedDigest}, stored ${entry.repair_evidence_digest})`);
        repairErrors++;
      }
    }
  }

  // Verify before/after count delta
  if (repairData.post_repair && repairData.pre_repair) {
    const expectedDelta = repairData.approved_count;
    const actualTotalDelta = repairData.post_repair.total_remote_count - repairData.pre_repair.total_remote_count;
    const actualRangeDelta = repairData.post_repair.range_101_246_count - repairData.pre_repair.range_101_246_count;
    if (actualTotalDelta !== expectedDelta) {
      fail(`Repair Batch ${batchNumber}: total count delta ${actualTotalDelta}, expected ${expectedDelta}`);
      repairErrors++;
    } else {
      pass(`Repair Batch ${batchNumber}: total count delta +${actualTotalDelta} (${repairData.pre_repair.total_remote_count} -> ${repairData.post_repair.total_remote_count})`);
    }
    if (actualRangeDelta !== expectedDelta) {
      fail(`Repair Batch ${batchNumber}: range count delta ${actualRangeDelta}, expected ${expectedDelta}`);
      repairErrors++;
    } else {
      pass(`Repair Batch ${batchNumber}: range count delta +${actualRangeDelta} (${repairData.pre_repair.range_101_246_count} -> ${repairData.post_repair.range_101_246_count})`);
    }
  }

  // Verify no unrelated version changed
  if (repairData.confirmations && !repairData.confirmations.no_unrelated_version_changed) {
    fail(`Repair Batch ${batchNumber}: unrelated version change detected`);
    repairErrors++;
  }

  // Verify all approved versions appear exactly once
  if (repairData.post_repair && !repairData.post_repair.all_approved_appear_exactly_once) {
    fail(`Repair Batch ${batchNumber}: not all approved versions appear exactly once`);
    repairErrors++;
  }

  // Verify completed entries are NOT in allowlist
  for (const entry of batchCompletedEntries) {
    if (allowlist.some(a => a.version === entry.version)) {
      fail(`Version ${entry.version}: completed in repair batch ${batchNumber} but still in active allowlist`);
      repairErrors++;
    }
  }

  if (repairErrors === 0) pass(`Repair Batch ${batchNumber} cross-validation passed`);
}

// ── Summary ──
console.log('\n=== Summary ===');
console.log(`  Manifest: ${manifest.length} entries`);
console.log(`    ALIGNED_TRACKED: ${alignedCount}`);
console.log(`    VERIFIED_APPLIED_UNTRACKED: ${verifiedCount}`);
console.log(`    PENDING_PRODUCTION_REVERIFICATION: ${pendingCount}`);
console.log(`    NOT_VERIFIABLE_SAFELY: ${nvCount}`);
console.log(`    SUPERSEDED: ${supersededCount}`);
console.log(`  Completed repairs: ${completedEntries.length}`);
console.log(`  Repaired candidates (cohort): ${repairedCandidateCount}`);
console.log(`  Approved repair allowlist: ${allowlist.length}`);
console.log(`  Verification candidates: ${candidates.length}`);
console.log(`  Verification batch evidence files: ${batchFiles.length}`);
console.log(`  Errors: ${errors}`);
console.log(`  Warnings: ${warnings}`);
if (errors > 0) {
  console.log('\nMigration reconciliation validation FAILED.');
  process.exit(1);
} else {
  console.log('\nMigration reconciliation validation PASSED.');
}

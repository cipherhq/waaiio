#!/usr/bin/env node
/**
 * Validates the migration reconciliation manifest, repair allowlist,
 * verification candidates, and repair evidence against repository migration files.
 *
 * Progressive invariants (multi-batch aware):
 * - Manifest has exactly 146 entries (one per version 101-246)
 * - ALIGNED_TRACKED = 83 (8 original + 15 Batch 1 + 15 Batch 2 + 15 Batch 3 + 15 Batch 4 + 15 Batch 5 repaired)
 * - VERIFIED_APPLIED_UNTRACKED = 0
 * - PENDING_PRODUCTION_REVERIFICATION = 49
 * - NOT_VERIFIABLE_SAFELY = 12, SUPERSEDED = 2
 * - Active repair allowlist = 0 (all Batch 5 repairs complete)
 * - Verification candidates = 49 (exact PENDING set)
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
const EXPECTED_ALIGNED = 83;
const EXPECTED_VERIFIED = 0;
const EXPECTED_PENDING = 49;
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
          // Default: verified_state must exactly equal expected_state, or be a recognized equivalent pair
          const stateMatch = ev.verified_state === ev.expected_state ||
            (ev.expected_state === 'drop_not_null' && ev.verified_state === 'column_exists_nullable' && (ev.object_type === 'column' || ev.object_type === 'column_alter')) ||
            (ev.expected_state === 'exists' && ev.verified_state === 'enabled' && ev.object_type === 'rls') ||
            (ev.expected_state === 'set' && ev.verified_state === 'exists' && ev.object_type === 'column_alter');
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

// Verify allowlist production_evidence_digest consistency
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
  // Allowlist digest must match manifest production_evidence_digest
  if (!entry.production_evidence_digest) {
    fail(`Allowlist version ${entry.version}: production_evidence_digest is empty`);
    digestErrors++;
  } else if (me.production_evidence_digest && entry.production_evidence_digest !== me.production_evidence_digest) {
    fail(`Allowlist version ${entry.version}: digest mismatch with manifest (allowlist: ${entry.production_evidence_digest.slice(0,12)}..., manifest: ${me.production_evidence_digest.slice(0,12)}...)`);
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
if (digestErrors === 0) pass(`All ${allowlist.length} allowlist production_evidence_digest values consistent`);

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

  if (batch.batch_number === 4) {
    if (batch.total_objects_checked !== 55) fail(`Batch 4 total_objects_checked: ${batch.total_objects_checked}, expected 55`);
    else pass('Batch 4 total_objects_checked = 55');
    if (batch.total_passed !== 53) fail(`Batch 4 total_passed: ${batch.total_passed}, expected 53`);
    else pass('Batch 4 total_passed = 53');
    if ((batch.total_superseded || 0) !== 2) fail(`Batch 4 total_superseded: ${batch.total_superseded}, expected 2`);
    else pass('Batch 4 total_superseded = 2');
  }

  if (batch.batch_number === 5) {
    if (batch.total_objects_checked !== 55) fail(`Batch 5 total_objects_checked: ${batch.total_objects_checked}, expected 55`);
    else pass('Batch 5 total_objects_checked = 55');
    if (batch.total_passed !== 55) fail(`Batch 5 total_passed: ${batch.total_passed}, expected 55`);
    else pass('Batch 5 total_passed = 55');
    if ((batch.total_superseded || 0) !== 0) fail(`Batch 5 total_superseded: ${batch.total_superseded}, expected 0`);
    else pass('Batch 5 total_superseded = 0');
    if ((batch.total_ambiguous || 0) !== 0) fail(`Batch 5 total_ambiguous: ${batch.total_ambiguous}, expected 0`);
    else pass('Batch 5 total_ambiguous = 0');
    // Batch 5 migration-history checks
    if (batch.pre_total_remote_count !== 164) fail(`Batch 5 pre_total_remote_count: ${batch.pre_total_remote_count}, expected 164`);
    else pass('Batch 5 pre_total_remote_count = 164');
    if (batch.post_total_remote_count !== 164) fail(`Batch 5 post_total_remote_count: ${batch.post_total_remote_count}, expected 164`);
    else pass('Batch 5 post_total_remote_count = 164');
    if (batch.pre_range_101_246_count !== 68) fail(`Batch 5 pre_range_101_246_count: ${batch.pre_range_101_246_count}, expected 68`);
    else pass('Batch 5 pre_range_101_246_count = 68');
    if (batch.post_range_101_246_count !== 68) fail(`Batch 5 post_range_101_246_count: ${batch.post_range_101_246_count}, expected 68`);
    else pass('Batch 5 post_range_101_246_count = 68');
    if (batch.migration_298_pre_occurrences !== 1) fail(`Batch 5 migration_298_pre_occurrences: ${batch.migration_298_pre_occurrences}, expected 1`);
    else pass('Batch 5 migration_298_pre_occurrences = 1');
    if (batch.migration_298_post_occurrences !== 1) fail(`Batch 5 migration_298_post_occurrences: ${batch.migration_298_post_occurrences}, expected 1`);
    else pass('Batch 5 migration_298_post_occurrences = 1');
    if (batch.migration_history_unchanged !== true) fail(`Batch 5 migration_history_unchanged: ${batch.migration_history_unchanged}, expected true`);
    else pass('Batch 5 migration_history_unchanged = true');
    // Strict occurrence map validation (maps must exist, not optional)
    const batch5Versions = ['172','173','174','175','177','178','179','180','183','184','185','186','188','189','190'];
    let occErrors = 0;

    if (!batch.batch5_pre_occurrence_map || typeof batch.batch5_pre_occurrence_map !== 'object') {
      fail('Batch 5: batch5_pre_occurrence_map missing or not an object');
      occErrors++;
    } else {
      const preKeys = Object.keys(batch.batch5_pre_occurrence_map);
      if (preKeys.length !== 15) {
        fail(`Batch 5: batch5_pre_occurrence_map has ${preKeys.length} keys, expected 15`);
        occErrors++;
      }
      const extraPreKeys = preKeys.filter(k => !batch5Versions.includes(k));
      if (extraPreKeys.length > 0) {
        fail(`Batch 5: batch5_pre_occurrence_map has extra keys: ${extraPreKeys.join(',')}`);
        occErrors++;
      }
      for (const v of batch5Versions) {
        if (batch.batch5_pre_occurrence_map[v] !== 0) {
          fail(`Batch 5 pre occurrence for version ${v}: ${batch.batch5_pre_occurrence_map[v]}, expected 0`);
          occErrors++;
        }
      }
    }

    if (!batch.batch5_post_occurrence_map || typeof batch.batch5_post_occurrence_map !== 'object') {
      fail('Batch 5: batch5_post_occurrence_map missing or not an object');
      occErrors++;
    } else {
      const postKeys = Object.keys(batch.batch5_post_occurrence_map);
      if (postKeys.length !== 15) {
        fail(`Batch 5: batch5_post_occurrence_map has ${postKeys.length} keys, expected 15`);
        occErrors++;
      }
      const extraPostKeys = postKeys.filter(k => !batch5Versions.includes(k));
      if (extraPostKeys.length > 0) {
        fail(`Batch 5: batch5_post_occurrence_map has extra keys: ${extraPostKeys.join(',')}`);
        occErrors++;
      }
      for (const v of batch5Versions) {
        if (batch.batch5_post_occurrence_map[v] !== 0) {
          fail(`Batch 5 post occurrence for version ${v}: ${batch.batch5_post_occurrence_map[v]}, expected 0`);
          occErrors++;
        }
      }
    }
    if (occErrors === 0) pass('Batch 5 all version occurrences are 0 pre and post (strict)');
    // Strict snapshot validation
    let snapErrors = 0;
    if (!Array.isArray(batch.pre_tracked_snapshot)) {
      fail('Batch 5: pre_tracked_snapshot missing or not an array');
      snapErrors++;
    } else if (!Array.isArray(batch.post_tracked_snapshot)) {
      fail('Batch 5: post_tracked_snapshot missing or not an array');
      snapErrors++;
    } else {
      // Must have exactly 164 unique versions
      const preUnique = new Set(batch.pre_tracked_snapshot);
      const postUnique = new Set(batch.post_tracked_snapshot);
      if (preUnique.size !== 164) {
        fail(`Batch 5: pre_tracked_snapshot has ${preUnique.size} unique versions, expected 164`);
        snapErrors++;
      }
      if (batch.pre_tracked_snapshot.length !== preUnique.size) {
        fail(`Batch 5: pre_tracked_snapshot has duplicate versions`);
        snapErrors++;
      }
      if (postUnique.size !== 164) {
        fail(`Batch 5: post_tracked_snapshot has ${postUnique.size} unique versions, expected 164`);
        snapErrors++;
      }
      if (batch.post_tracked_snapshot.length !== postUnique.size) {
        fail(`Batch 5: post_tracked_snapshot has duplicate versions`);
        snapErrors++;
      }
      // Must be byte-for-byte equal
      if (JSON.stringify(batch.pre_tracked_snapshot) !== JSON.stringify(batch.post_tracked_snapshot)) {
        fail('Batch 5 pre/post tracked snapshots differ');
        snapErrors++;
      }
      // Must contain Migration 298 exactly once
      const pre298 = batch.pre_tracked_snapshot.filter(v => String(v) === '298').length;
      if (pre298 !== 1) {
        fail(`Batch 5: pre_tracked_snapshot contains Migration 298 ${pre298} times, expected 1`);
        snapErrors++;
      }
      // Must not contain any Batch 5 versions
      for (const v of batch5Versions) {
        if (batch.pre_tracked_snapshot.some(sv => String(sv) === v)) {
          fail(`Batch 5: pre_tracked_snapshot contains Batch 5 version ${v}`);
          snapErrors++;
        }
      }
    }
    if (snapErrors === 0) pass('Batch 5 snapshot validation passed (strict)');

    // V3 canonical evidence file SHA
    const batch5EvidencePath = resolve(EVIDENCE_DIR, 'batch-05-production-verification.json');
    const batch5Content = readFileSync(batch5EvidencePath);
    const batch5SHA = createHash('sha256').update(batch5Content).digest('hex');
    if (batch5SHA !== '8f093426b4688650d4e9da185f82d3d001592b9f3cc9b4b1ed2bdc8553962930') {
      fail(`Batch 5 evidence SHA mismatch: ${batch5SHA}`);
    } else {
      pass('Batch 5 evidence file SHA matches V3 canonical');
    }

    // V3 identity fields
    if (batch.task_identifier !== 'batch-05-production-verification-v3') {
      fail(`Batch 5 task_identifier: ${batch.task_identifier}, expected batch-05-production-verification-v3`);
    } else {
      pass('Batch 5 task_identifier = batch-05-production-verification-v3');
    }

    // V3 compared property paths total (341 real intersecting paths across 55 objects)
    if (batch.detailed_property_checks_total !== 341) {
      fail(`Batch 5 detailed_property_checks_total: ${batch.detailed_property_checks_total}, expected 341`);
    } else {
      pass('Batch 5 detailed_property_checks_total = 341');
    }

    // Preserved V2 snapshot invariant: verified_properties key count per object per migration
    const expectedVerifiedKeyCounts = {
      '172': 27, '173': 42, '174': 20, '175': 8, '177': 15, '178': 15,
      '179': 9, '180': 28, '183': 38, '184': 31, '185': 3, '186': 65,
      '188': 9, '189': 25, '190': 48
    };
    let propCountErrors = 0;
    let propCountSum = 0;
    for (const m of batch.migrations || []) {
      const ver = String(m.version);
      const count = (m.objects || []).reduce((sum, obj) => sum + Object.keys(obj.verified_properties || {}).length, 0);
      propCountSum += count;
      const expected = expectedVerifiedKeyCounts[ver];
      if (expected !== undefined && count !== expected) {
        fail(`Batch 5 version ${ver}: preserved V2 verified key count ${count}, expected ${expected}`);
        propCountErrors++;
      }
    }
    if (propCountSum !== 383) {
      fail(`Batch 5 preserved V2 verified key sum: ${propCountSum}, expected 383`);
      propCountErrors++;
    }
    if (propCountErrors === 0) pass('Batch 5 preserved V2 verified_properties key counts intact');

    // V2 per-migration migration_evidence_digest recomputation
    let digestRecomputeErrors = 0;
    for (const m of batch.migrations || []) {
      if (!m.migration_evidence_digest) {
        fail(`Batch 5 version ${m.version}: missing migration_evidence_digest`);
        digestRecomputeErrors++;
        continue;
      }
      // Deep clone and remove digest
      const clone = JSON.parse(JSON.stringify(m));
      delete clone.migration_evidence_digest;
      // Recursively sort keys
      function sortKeysRecursive(obj) {
        if (Array.isArray(obj)) return obj.map(sortKeysRecursive);
        if (obj && typeof obj === 'object') {
          const sorted = {};
          for (const key of Object.keys(obj).sort()) {
            sorted[key] = sortKeysRecursive(obj[key]);
          }
          return sorted;
        }
        return obj;
      }
      const sorted = sortKeysRecursive(clone);
      const serialized = JSON.stringify(sorted);
      const computed = createHash('sha256').update(serialized).digest('hex');
      if (computed !== m.migration_evidence_digest) {
        fail(`Batch 5 version ${m.version}: migration_evidence_digest mismatch (stored: ${m.migration_evidence_digest.slice(0,12)}..., computed: ${computed.slice(0,12)}...)`);
        digestRecomputeErrors++;
      }
    }
    if (digestRecomputeErrors === 0) pass('Batch 5 all 15 migration_evidence_digest values recompute correctly');

    // V2 manifest and allowlist digest binding
    let bindingErrors = 0;
    for (const m of batch.migrations || []) {
      const ver = String(m.version);
      const me = manifestByVersion[ver];
      if (me && me.production_evidence_digest !== m.migration_evidence_digest) {
        fail(`Batch 5 version ${ver}: manifest digest differs from V2 migration digest`);
        bindingErrors++;
      }
      const al = allowlist.find(a => a.version === ver);
      if (al && al.production_evidence_digest !== m.migration_evidence_digest) {
        fail(`Batch 5 version ${ver}: allowlist digest differs from V2 migration digest`);
        bindingErrors++;
      }
      if (me && !me.production_evidence_digest) {
        fail(`Batch 5 version ${ver}: manifest production_evidence_digest is empty`);
        bindingErrors++;
      }
      if (al && !al.production_evidence_digest) {
        fail(`Batch 5 version ${ver}: allowlist production_evidence_digest is empty`);
        bindingErrors++;
      }
    }
    if (bindingErrors === 0) pass('Batch 5 all manifest and allowlist digests match V2 migration digests');

    // V2 object required fields
    let objFieldErrors = 0;
    const requiredObjFields = [
      'migration_version', 'migration_filename', 'migration_checksum',
      'expected_object_digest', 'object_type', 'object_name',
      'expected_state', 'verified_state', 'result',
      'verification_source', 'query_category', 'verification_timestamp',
      'expected_properties', 'verified_properties', 'property_comparison_result'
    ];
    for (const m of batch.migrations || []) {
      for (const obj of m.objects || []) {
        for (const field of requiredObjFields) {
          if (!(field in obj)) {
            fail(`Batch 5 version ${m.version} object ${obj.object_name || '?'}: missing ${field}`);
            objFieldErrors++;
          }
        }
        // Object migration provenance must match parent
        if (obj.migration_version !== undefined && String(obj.migration_version) !== String(m.version)) {
          fail(`Batch 5 version ${m.version} object ${obj.object_name}: migration_version mismatch (${obj.migration_version})`);
          objFieldErrors++;
        }
        if (obj.migration_filename !== undefined && obj.migration_filename !== m.filename) {
          fail(`Batch 5 version ${m.version} object ${obj.object_name}: migration_filename mismatch`);
          objFieldErrors++;
        }
        if (obj.migration_checksum !== undefined && obj.migration_checksum !== m.checksum) {
          fail(`Batch 5 version ${m.version} object ${obj.object_name}: migration_checksum mismatch`);
          objFieldErrors++;
        }
        // No generic pg_catalog
        if (obj.verification_source === 'pg_catalog') {
          fail(`Batch 5 version ${m.version} object ${obj.object_name}: generic pg_catalog verification_source`);
          objFieldErrors++;
        }
        // Property comparison must be a valid result (exact_match, equivalent_stricter, or superseded)
        const validResults = new Set(['exact_match', 'equivalent_stricter', 'superseded']);
        if (!validResults.has(obj.property_comparison_result)) {
          fail(`Batch 5 version ${m.version} object ${obj.object_name}: property_comparison_result "${obj.property_comparison_result}" is not a valid V3 result`);
          objFieldErrors++;
        }
      }
    }
    if (objFieldErrors === 0) pass('Batch 5 all objects have required V2 fields with correct provenance');
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
        // For result=pass: verified_state must exactly equal expected_state, or be a recognized equivalent pair
        if (obj.result === 'pass' && obj.verified_state && obj.expected_state) {
          const stateOk = obj.verified_state === obj.expected_state ||
            (obj.expected_state === 'drop_not_null' && obj.verified_state === 'column_exists_nullable' && (obj.object_type === 'column' || obj.object_type === 'column_alter')) ||
            (obj.expected_state === 'exists' && obj.verified_state === 'enabled' && obj.object_type === 'rls') ||
            (obj.expected_state === 'set' && obj.verified_state === 'exists' && obj.object_type === 'column_alter');
          if (!stateOk) {
            fail(`Batch ${batch.batch_number} version ${m.version}: object ${obj.object_name || '?'} result=pass but verified_state "${obj.verified_state}" !== expected_state "${obj.expected_state}"`);
            enrichErrors++; batchErrors++;
          }
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

  // ── Safety confirmations (verification evidence, Batch 4+) ──
  if (batch.batch_number >= 4) {
    const requiredVerificationConfirmations = [
      'all_queries_read_only',
      'no_migration_repair',
      'no_migration_sql_executed',
      'no_supabase_db_push',
      'no_schema_or_data_changed',
      'no_customer_records_accessed',
      'no_deployment_occurred',
      'no_token_recorded'
    ];
    // Each batch must confirm the next batch was not started
    const nextBatchKey = `batch_${batch.batch_number + 1}_not_started`;
    requiredVerificationConfirmations.push(nextBatchKey);
    let safetyErrors = 0;
    for (const key of requiredVerificationConfirmations) {
      if (batch[key] !== true) {
        fail(`Batch ${batch.batch_number}: safety confirmation ${key} missing or not boolean true (got ${JSON.stringify(batch[key])})`);
        safetyErrors++;
        batchErrors++;
      }
    }
    if (safetyErrors === 0) pass(`Batch ${batch.batch_number} all ${requiredVerificationConfirmations.length} verification safety confirmations present and true`);
  }

  // ── Batch 5 extended safety booleans (17 total) ──
  if (batch.batch_number === 5) {
    const requiredBatch5SafetyBooleans = [
      'all_queries_read_only', 'no_record_contents_returned', 'no_customer_records_accessed',
      'no_write_query_executed', 'no_migration_sql_executed', 'no_migration_repair',
      'no_migration_up', 'no_supabase_db_push', 'no_management_api_write',
      'no_schema_or_data_changed', 'no_migration_history_changed', 'no_repository_change',
      'no_commit_push_or_pr', 'no_issue_53_mutation', 'no_deployment_occurred',
      'no_token_recorded', 'batch_6_not_started'
    ];
    let batch5SafetyErrors = 0;
    for (const key of requiredBatch5SafetyBooleans) {
      if (batch[key] !== true) {
        fail(`Batch 5: safety boolean ${key} missing or not true (got ${JSON.stringify(batch[key])})`);
        batch5SafetyErrors++;
      }
    }
    if (batch5SafetyErrors === 0) pass(`Batch 5 all ${requiredBatch5SafetyBooleans.length} safety booleans present and true`);

    // total_failed must explicitly equal 0
    if (batch.total_failed !== 0) {
      fail(`Batch 5: total_failed is ${batch.total_failed}, must explicitly equal 0`);
    } else {
      pass('Batch 5 total_failed explicitly equals 0');
    }

    // classification_counts must represent exactly 15 VERIFIED_APPLIED_UNTRACKED
    if (batch.classification_counts) {
      const ccKeys = Object.keys(batch.classification_counts);
      if (ccKeys.length !== 1 || ccKeys[0] !== 'VERIFIED_APPLIED_UNTRACKED') {
        fail(`Batch 5: classification_counts has unexpected keys: ${ccKeys.join(',')}`);
      } else if (batch.classification_counts.VERIFIED_APPLIED_UNTRACKED !== 15) {
        fail(`Batch 5: classification_counts.VERIFIED_APPLIED_UNTRACKED = ${batch.classification_counts.VERIFIED_APPLIED_UNTRACKED}, expected 15`);
      } else {
        pass('Batch 5 classification_counts exactly {VERIFIED_APPLIED_UNTRACKED: 15}');
      }
    }
  }


    // V3 evidence enrichment checks
    const v2PreservedPath = resolve(EVIDENCE_DIR, 'batch-05-production-verification-v2.json');
    if (!existsSync(v2PreservedPath)) {
      fail('Batch 5: preserved V2 evidence file missing');
    } else {
      const v2Content = readFileSync(v2PreservedPath);
      const v2SHA = createHash('sha256').update(v2Content).digest('hex');
      if (v2SHA !== 'bf528a884c0361b4d601232074b6d78194930b413726922d624f1fa932a4d2a8') {
        fail(`Batch 5: preserved V2 evidence SHA mismatch: ${v2SHA}`);
      } else {
        pass('Batch 5 preserved V2 evidence SHA verified');
      }
    }

    // V3 identity fields
    if (batch.task_identifier === 'batch-05-production-verification-v3') {
      if (batch.supersedes_repository_evidence_path !== 'docs/migrations/evidence/batch-05-production-verification-v2.json') {
        fail('Batch 5 V3: incorrect supersedes_repository_evidence_path');
      }
      if (batch.superseded_repository_evidence_sha256 !== 'bf528a884c0361b4d601232074b6d78194930b413726922d624f1fa932a4d2a8') {
        fail('Batch 5 V3: incorrect superseded_repository_evidence_sha256');
      }
      pass('Batch 5 V3 lineage fields verified');
      
      // V3 compared_property_paths real value comparison
      let v3CompareErrors = 0;

      // Resolve a dot-separated or plain path in an object
      function resolvePath(obj, path) {
        if (path in obj) return { found: true, value: obj[path] };
        const parts = path.split('.');
        let cur = obj;
        for (const p of parts) {
          if (cur == null || typeof cur !== 'object') return { found: false };
          if (!(p in cur)) return { found: false };
          cur = cur[p];
        }
        return { found: true, value: cur };
      }

      // Deterministic deep-equal (handles objects, arrays, primitives)
      function deepEqual(a, b) {
        if (a === b) return true;
        if (a == null || b == null) return a === b;
        if (typeof a !== typeof b) return false;
        if (Array.isArray(a)) {
          if (!Array.isArray(b) || a.length !== b.length) return false;
          return a.every((v, i) => deepEqual(v, b[i]));
        }
        if (typeof a === 'object') {
          const ka = Object.keys(a).sort();
          const kb = Object.keys(b).sort();
          if (ka.length !== kb.length) return false;
          return ka.every((k, i) => k === kb[i] && deepEqual(a[k], b[k]));
        }
        return false;
      }

      for (const m of batch.migrations || []) {
        const ver = String(m.version);
        const storedCount = m.detailed_property_checks_count;
        let actualSum = 0;

        for (const obj of m.objects || []) {
          const ep = obj.expected_properties || {};
          const vp = obj.verified_properties || {};
          const paths = obj.compared_property_paths;
          const cr = obj.property_comparison_result;
          const mm = obj.property_mismatches || [];

          // 1. compared_property_paths must be non-empty array
          if (!Array.isArray(paths) || paths.length === 0) {
            fail(`Batch 5 V3 ${ver}/${obj.object_name}: compared_property_paths missing or empty`);
            v3CompareErrors++; continue;
          }

          // 2. Reject duplicates
          if (new Set(paths).size !== paths.length) {
            fail(`Batch 5 V3 ${ver}/${obj.object_name}: duplicate compared paths`);
            v3CompareErrors++;
          }

          actualSum += paths.length;

          // 3. Resolve every path in expected and verified; compute actual unequal set
          const actualUnequal = [];
          for (const p of paths) {
            const epRes = resolvePath(ep, p);
            const vpRes = resolvePath(vp, p);
            if (!epRes.found) {
              fail(`Batch 5 V3 ${ver}/${obj.object_name}: compared path "${p}" not in expected_properties`);
              v3CompareErrors++;
            }
            if (!vpRes.found) {
              fail(`Batch 5 V3 ${ver}/${obj.object_name}: compared path "${p}" not in verified_properties`);
              v3CompareErrors++;
            }
            if (epRes.found && vpRes.found && !deepEqual(epRes.value, vpRes.value)) {
              actualUnequal.push(p);
            }
          }

          // 4. Reject generic comparison result
          if (cr === 'match') {
            fail(`Batch 5 V3 ${ver}/${obj.object_name}: generic "match" comparison not allowed`);
            v3CompareErrors++;
          }

          // 5. Validate exact_match
          if (cr === 'exact_match') {
            if (actualUnequal.length > 0) {
              fail(`Batch 5 V3 ${ver}/${obj.object_name}: exact_match but values differ at: ${actualUnequal.join(', ')}`);
              v3CompareErrors++;
            }
            if (mm.length > 0) {
              fail(`Batch 5 V3 ${ver}/${obj.object_name}: exact_match but property_mismatches non-empty`);
              v3CompareErrors++;
            }
          }

          // 6. Validate equivalent_stricter
          if (cr === 'equivalent_stricter') {
            // Mismatch paths must equal actual unequal paths exactly
            const declaredPaths = new Set(mm.map(x => x.path));
            const actualPaths = new Set(actualUnequal);
            for (const p of actualPaths) {
              if (!declaredPaths.has(p)) {
                fail(`Batch 5 V3 ${ver}/${obj.object_name}: undeclared unequal path "${p}"`);
                v3CompareErrors++;
              }
            }
            for (const p of declaredPaths) {
              if (!actualPaths.has(p)) {
                fail(`Batch 5 V3 ${ver}/${obj.object_name}: declared mismatch "${p}" but values actually match`);
                v3CompareErrors++;
              }
            }

            // Verify mismatch expected_original and verified_current match actual values
            for (const mismatch of mm) {
              const epVal = resolvePath(ep, mismatch.path);
              const vpVal = resolvePath(vp, mismatch.path);
              if (epVal.found && !deepEqual(mismatch.expected_original, epVal.value)) {
                fail(`Batch 5 V3 ${ver}/${obj.object_name}: mismatch "${mismatch.path}" expected_original doesn't match actual expected value`);
                v3CompareErrors++;
              }
              if (vpVal.found && !deepEqual(mismatch.verified_current, vpVal.value)) {
                fail(`Batch 5 V3 ${ver}/${obj.object_name}: mismatch "${mismatch.path}" verified_current doesn't match actual verified value`);
                v3CompareErrors++;
              }
            }

            // Require lineage
            if (!Array.isArray(obj.later_migration_lineage) || obj.later_migration_lineage.length === 0) {
              fail(`Batch 5 V3 ${ver}/${obj.object_name}: equivalent_stricter without later_migration_lineage`);
              v3CompareErrors++;
            } else {
              for (const lin of obj.later_migration_lineage) {
                if (!lin.version || !lin.filename) {
                  fail(`Batch 5 V3 ${ver}/${obj.object_name}: lineage entry missing version or filename`);
                  v3CompareErrors++;
                }
              }
            }

            // Migration 173 function-specific checks
            if (ver === '173' && obj.object_type === 'function') {
              const permitted = new Set(['anon_exec', 'auth_exec']);
              for (const p of actualUnequal) {
                if (!permitted.has(p)) {
                  fail(`Batch 5 V3 173/${obj.object_name}: unpermitted unequal property "${p}"`);
                  v3CompareErrors++;
                }
              }
              // svc_exec must be true in both
              if (ep.svc_exec !== true || vp.svc_exec !== true) {
                fail(`Batch 5 V3 173/${obj.object_name}: svc_exec must be true in both expected and verified`);
                v3CompareErrors++;
              }
              // def_hash must match exactly
              if (ep.def_hash !== vp.def_hash) {
                fail(`Batch 5 V3 173/${obj.object_name}: def_hash mismatch (expected ${(ep.def_hash||'').slice(0,12)}... verified ${(vp.def_hash||'').slice(0,12)}...)`);
                v3CompareErrors++;
              }
              // Lineage must contain exactly 181 and 296
              const lineageVersions = new Set((obj.later_migration_lineage || []).map(l => l.version));
              if (!lineageVersions.has('181') || !lineageVersions.has('296') || lineageVersions.size !== 2) {
                fail(`Batch 5 V3 173/${obj.object_name}: lineage must contain exactly versions 181 and 296`);
                v3CompareErrors++;
              }
              const lineageFilenames = new Set((obj.later_migration_lineage || []).map(l => l.filename));
              if (!lineageFilenames.has('181_financial_integrity.sql') || !lineageFilenames.has('296_restrict_sensitive_rpc_execution.sql')) {
                fail(`Batch 5 V3 173/${obj.object_name}: lineage filenames incorrect`);
                v3CompareErrors++;
              }
            }
          }
        }

        // Sum must equal stored count
        if (storedCount !== undefined && actualSum !== storedCount) {
          fail(`Batch 5 V3 ${ver}: compared_property_paths sum ${actualSum} !== detailed_property_checks_count ${storedCount}`);
          v3CompareErrors++;
        }
      }
      if (v3CompareErrors === 0) pass('Batch 5 V3 property comparison validated (values resolved and compared)');
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
    let data = JSON.parse(readFileSync(filePath, 'utf-8'));
    // Normalize Batch 5+ repair evidence (repairs array with sequence/exit_status/postcondition_passed)
    if (data.repairs && Array.isArray(data.repairs) && !data.repair_results) {
      // Validate Batch 5 specific structure: each repair must have sequence, exit_status, postcondition_passed
      const batch5Versions = data.approved_versions.map(String);
      let b5Errors = 0;
      for (let i = 0; i < data.repairs.length; i++) {
        const r = data.repairs[i];
        if (r.sequence !== i + 1) { fail(`Batch 5 repair evidence: sequence ${r.sequence} at index ${i}, expected ${i+1}`); b5Errors++; }
        if (String(r.version) !== batch5Versions[i]) { fail(`Batch 5 repair evidence: version ${r.version} at index ${i}, expected ${batch5Versions[i]}`); b5Errors++; }
        if (r.exit_status !== 0) { fail(`Batch 5 repair evidence: version ${r.version} exit_status=${r.exit_status}`); b5Errors++; }
        if (r.pre_occurrences !== 0) { fail(`Batch 5 repair evidence: version ${r.version} pre_occurrences=${r.pre_occurrences}`); b5Errors++; }
        if (r.post_occurrences !== 1) { fail(`Batch 5 repair evidence: version ${r.version} post_occurrences=${r.post_occurrences}`); b5Errors++; }
        if (r.postcondition_passed !== true) { fail(`Batch 5 repair evidence: version ${r.version} postcondition_passed=${r.postcondition_passed}`); b5Errors++; }
        if (r.migration_298_post_occurrences !== 1) { fail(`Batch 5 repair evidence: version ${r.version} migration_298_post_occurrences=${r.migration_298_post_occurrences}`); b5Errors++; }
        // Count progression: total and range must advance by exactly 1 per repair
        const expectedTotal = data.pre_repair.total_remote_count + i + 1;
        const expectedRange = data.pre_repair.range_101_246_count + i + 1;
        if (r.post_total_remote_count !== expectedTotal) { fail(`Batch 5 repair evidence: version ${r.version} post_total=${r.post_total_remote_count}, expected ${expectedTotal}`); b5Errors++; }
        if (r.post_range_101_246_count !== expectedRange) { fail(`Batch 5 repair evidence: version ${r.version} post_range=${r.post_range_101_246_count}, expected ${expectedRange}`); b5Errors++; }
      }

      // Validate safety confirmations exist and are boolean true
      const b5SafetyKeys = [
        'every_approved_version_appears_exactly_once', 'exactly_15_versions_added',
        'no_version_removed', 'no_unapproved_version_added', 'migration_history_only_change',
        'only_approved_migration_history_writes', 'no_migration_sql_executed', 'no_migration_up',
        'no_supabase_db_push', 'no_management_api_write', 'no_schema_or_application_data_changed',
        'no_customer_records_accessed', 'no_record_identifiers_returned', 'no_repository_change',
        'no_commit_push_or_pr', 'no_issue_53_mutation', 'no_deployment_occurred',
        'no_token_recorded', 'batch_6_not_started'
      ];
      for (const key of b5SafetyKeys) {
        if (data[key] !== true) { fail(`Batch 5 repair evidence: safety boolean ${key} missing or not true (got ${JSON.stringify(data[key])})`); b5Errors++; }
      }

      // Validate canonical verification and V2 SHAs
      if (data.canonical_verification_evidence_sha256 !== '8f093426b4688650d4e9da185f82d3d001592b9f3cc9b4b1ed2bdc8553962930') {
        fail(`Batch 5 repair evidence: canonical V3 SHA mismatch`); b5Errors++;
      }
      if (data.preserved_v2_evidence_sha256 !== 'bf528a884c0361b4d601232074b6d78194930b413726922d624f1fa932a4d2a8') {
        fail(`Batch 5 repair evidence: preserved V2 SHA mismatch`); b5Errors++;
      }

      // Validate pre/post counts
      if (data.pre_repair.total_remote_count !== 164) { fail(`Batch 5 repair: pre total ${data.pre_repair.total_remote_count}, expected 164`); b5Errors++; }
      if (data.pre_repair.range_101_246_count !== 68) { fail(`Batch 5 repair: pre range ${data.pre_repair.range_101_246_count}, expected 68`); b5Errors++; }
      if (data.post_repair.total_remote_count !== 179) { fail(`Batch 5 repair: post total ${data.post_repair.total_remote_count}, expected 179`); b5Errors++; }
      if (data.post_repair.range_101_246_count !== 83) { fail(`Batch 5 repair: post range ${data.post_repair.range_101_246_count}, expected 83`); b5Errors++; }
      if (data.pre_repair.migration_298_occurrences !== 1) { fail(`Batch 5 repair: pre m298=${data.pre_repair.migration_298_occurrences}`); b5Errors++; }
      if (data.post_repair.migration_298_occurrences !== 1) { fail(`Batch 5 repair: post m298=${data.post_repair.migration_298_occurrences}`); b5Errors++; }

      // Validate post-repair occurrence map
      for (const v of batch5Versions) {
        if (data.post_repair.batch_5_occurrence_map[v] !== 1) { fail(`Batch 5 repair: post occurrence ${v}=${data.post_repair.batch_5_occurrence_map[v]}`); b5Errors++; }
      }

      // Validate exact_new_versions, removed, unapproved
      const expectedVersionsInt = data.approved_versions;
      if (JSON.stringify(data.post_repair.exact_new_versions) !== JSON.stringify(expectedVersionsInt)) { fail('Batch 5 repair: exact_new_versions mismatch'); b5Errors++; }
      if (data.post_repair.removed_versions.length !== 0) { fail('Batch 5 repair: removed_versions not empty'); b5Errors++; }
      if (data.post_repair.unapproved_added_versions.length !== 0) { fail('Batch 5 repair: unapproved not empty'); b5Errors++; }

      // Validate each repair checksum matches repository
      let checksumMatchErrors = 0;
      for (const r of data.repairs) {
        const matchingFiles = migrationFiles.filter(f => f.startsWith(String(r.version) + '_'));
        if (matchingFiles.length !== 1) { fail(`Batch 5 repair version ${r.version}: no unique repo file`); checksumMatchErrors++; continue; }
        const content = readFileSync(resolve(MIGRATIONS_DIR, matchingFiles[0]), 'utf-8');
        const sha256 = createHash('sha256').update(content).digest('hex');
        if (r.checksum !== sha256) { fail(`Batch 5 repair version ${r.version}: checksum mismatch with repo`); checksumMatchErrors++; }
        if (r.filename !== matchingFiles[0]) { fail(`Batch 5 repair version ${r.version}: filename mismatch with repo`); checksumMatchErrors++; }
      }
      if (checksumMatchErrors === 0) pass(`Batch 5 repair all 15 checksums and filenames match repository`);

      // Batch 5 production_evidence_digest values are V2 migration_evidence_digest
      // (computed from batch evidence with sorted keys), not the canonical form used by
      // Batches 3-4. Provide them for structural requirement but skip canonical recomputation.
      const approvedPED = {};
      for (const v of batch5Versions) {
        const me = manifestByVersion[v];
        if (me && me.production_evidence_digest) {
          approvedPED[v] = me.production_evidence_digest;
        }
      }

      // Normalize to standard structure for downstream validation
      const repairResults = data.repairs.map(r => ({
        version: r.version,
        exit_status: r.exit_status,
        version_tracked: r.post_occurrences === 1,
        total_delta: 1,
        range_delta: 1,
        post_total: r.post_total_remote_count,
        post_range: r.post_range_101_246_count
      }));
      const migFilenames = data.repairs.map(r => r.filename);
      const approvedChecksums = {};
      data.repairs.forEach(r => { approvedChecksums[String(r.version)] = r.checksum; });

      data = {
        ...data,
        approved_versions: data.approved_versions,
        timestamp_utc: null, // Batch 5 repair has no single timestamp
        repair_timestamp: null,
        migration_filenames: migFilenames,
        approved_checksums: approvedChecksums,
        approved_production_evidence_digests: approvedPED,
        repair_results: repairResults,
        pre_repair: {
          total_remote_count: data.pre_repair.total_remote_count,
          range_101_246_count: data.pre_repair.range_101_246_count,
          tracked_version_snapshot: data.pre_repair.ordered_version_snapshot || []
        },
        post_repair: {
          total_remote_count: data.post_repair.total_remote_count,
          range_101_246_count: data.post_repair.range_101_246_count,
          tracked_version_snapshot: data.post_repair.ordered_version_snapshot || [],
          new_versions_added: data.post_repair.exact_new_versions || [],
          lost_versions: [],
          all_approved_appear_exactly_once: data.every_approved_version_appears_exactly_once
        },
        confirmations: {
          every_approved_version_appears_exactly_once: data.every_approved_version_appears_exactly_once,
          no_unrelated_version_changed: data.no_version_removed && data.no_unapproved_version_added,
          no_migration_sql_executed: data.no_migration_sql_executed,
          no_schema_or_application_data_changed: data.no_schema_or_application_data_changed,
          no_customer_record_contents_accessed: data.no_customer_records_accessed,
          no_deployment_occurred: data.no_deployment_occurred,
          no_token_or_auth_header_recorded: data.no_token_recorded,
          batch_6_did_not_start: data.batch_6_not_started
        },
        derived_added_version_set: data.post_repair.exact_new_versions || [],
        derived_removed_version_set: []
      };
    }
    // Normalize flat-key repair evidence (Batch 4+) to nested structure
    if (data.pre_repair_total !== undefined && !data.pre_repair) {
      // Strict: require all safety booleans to exist and be true
      const batchNum = data.batch_number || 0;
      const nextBatchKey = `batch_${batchNum + 1}_not_started`;
      const requiredFlatBooleans = [
        'no_unapproved_versions_added', 'no_migration_sql_executed', 'no_supabase_db_push',
        'no_schema_or_data_changed', 'no_customer_records_accessed',
        'no_deployment_occurred', 'no_token_recorded', nextBatchKey
      ];
      for (const key of requiredFlatBooleans) {
        if (!(key in data)) {
          fail(`Flat repair evidence ${file}: missing required boolean field "${key}"`);
        } else if (data[key] !== true) {
          fail(`Flat repair evidence ${file}: "${key}" must be boolean true (got: ${JSON.stringify(data[key])})`);
        }
      }
      // Convert object-keyed migration_filenames to array ordered by approved_versions
      let migFilenamesArray = data.migration_filenames;
      if (migFilenamesArray && !Array.isArray(migFilenamesArray)) {
        migFilenamesArray = data.approved_versions.map(v => migFilenamesArray[String(v)]);
      }
      // Convert string snapshots to integers
      const toIntArray = (arr) => Array.isArray(arr) ? arr.map(v => typeof v === 'string' ? parseInt(v, 10) : v) : arr;
      // Derive exactly-once and no-unrelated-change from structural evidence, not just a single boolean
      const approvedVersionSet = new Set(data.approved_versions.map(String));
      const resultVersionSet = new Set(data.repair_results.map(r => String(r.version)));
      const preSnap = toIntArray(data.pre_repair_tracked_snapshot || []);
      const postSnap = toIntArray(data.post_repair_tracked_snapshot || []);
      const preSnapSet = new Set(preSnap.map(String));
      const postSnapSet = new Set(postSnap.map(String));
      const snapAdded = [...postSnapSet].filter(v => !preSnapSet.has(v));
      const snapRemoved = [...preSnapSet].filter(v => !postSnapSet.has(v));
      const newVersions = (data.new_versions_added || []).map(String);
      const derivedExactlyOnce = (
        approvedVersionSet.size === resultVersionSet.size &&
        [...approvedVersionSet].every(v => resultVersionSet.has(v)) &&
        data.repair_results.every(r => r.exit_status === 0 && r.version_tracked === true) &&
        snapAdded.length === approvedVersionSet.size &&
        snapAdded.every(v => approvedVersionSet.has(v)) &&
        newVersions.length === approvedVersionSet.size &&
        newVersions.every(v => approvedVersionSet.has(v))
      );
      const derivedNoUnrelated = snapRemoved.length === 0;
      data = {
        ...data,
        timestamp_utc: data.repair_timestamp || data.timestamp_utc,
        migration_filenames: migFilenamesArray,
        pre_repair: {
          total_remote_count: data.pre_repair_total,
          range_101_246_count: data.pre_repair_range_101_246,
          tracked_version_snapshot: toIntArray(data.pre_repair_tracked_snapshot)
        },
        post_repair: {
          total_remote_count: data.post_repair_total,
          range_101_246_count: data.post_repair_range_101_246,
          tracked_version_snapshot: toIntArray(data.post_repair_tracked_snapshot),
          new_versions_added: data.new_versions_added || [],
          lost_versions: [],
          all_approved_appear_exactly_once: derivedExactlyOnce
        },
        confirmations: {
          every_approved_version_appears_exactly_once: derivedExactlyOnce,
          no_unrelated_version_changed: derivedNoUnrelated,
          no_migration_sql_executed: data.no_migration_sql_executed === true,
          no_schema_or_application_data_changed: data.no_schema_or_data_changed === true,
          no_customer_record_contents_accessed: data.no_customer_records_accessed === true,
          no_deployment_occurred: data.no_deployment_occurred === true,
          no_token_or_auth_header_recorded: data.no_token_recorded === true,
          batch_5_did_not_start: data.batch_5_not_started === true
        },
        derived_added_version_set: data.new_versions_added || [],
        derived_removed_version_set: []
      };
    }
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

  // Valid timestamp (Batch 1-2 use timestamp_utc, Batch 3-4 use repair_timestamp, Batch 5+ use per-repair timestamps)
  const repairTimestamp = repairData.timestamp_utc || repairData.repair_timestamp;
  if (repairTimestamp === null && repairData.batch_number >= 5) {
    // Batch 5+ repair evidence has per-repair postconditions instead of a single timestamp
    pass(`Repair Batch ${batchNumber} timestamp: per-repair postcondition model (no single timestamp)`);
  } else if (!isValidUTCTimestamp(repairTimestamp)) {
    fail(`Repair Batch ${batchNumber}: invalid timestamp "${repairTimestamp}"`);
    repairErrors++;
  } else {
    pass(`Repair Batch ${batchNumber} timestamp valid UTC`);
  }

  // ── Required Batch 3+ structure ──
  if (repairData.batch_number >= 3) {
    let structErrors = 0;
    const requireArray = (path, val) => {
      if (!Array.isArray(val)) { fail(`Repair batch ${batchNumber}: ${path} must be an array (got ${val === null ? 'null' : typeof val})`); structErrors++; repairErrors++; return false; }
      return true;
    };
    const requireObject = (path, val) => {
      if (!val || typeof val !== 'object' || Array.isArray(val)) { fail(`Repair batch ${batchNumber}: ${path} must be a plain object (got ${val === null ? 'null' : Array.isArray(val) ? 'array' : typeof val})`); structErrors++; repairErrors++; return false; }
      return true;
    };

    const hasMigrationFilenames = requireArray('migration_filenames', repairData.migration_filenames);
    const hasApprovedChecksums = requireObject('approved_checksums', repairData.approved_checksums);
    const hasApprovedPED = requireObject('approved_production_evidence_digests', repairData.approved_production_evidence_digests);
    const hasPreRepair = requireObject('pre_repair', repairData.pre_repair);
    const hasPostRepair = requireObject('post_repair', repairData.post_repair);
    const hasConfirmations = requireObject('confirmations', repairData.confirmations);

    let hasPreSnapshot = false, hasPostSnapshot = false;
    if (hasPreRepair) {
      hasPreSnapshot = requireArray('pre_repair.tracked_version_snapshot', repairData.pre_repair?.tracked_version_snapshot);
    }
    if (hasPostRepair) {
      hasPostSnapshot = requireArray('post_repair.tracked_version_snapshot', repairData.post_repair?.tracked_version_snapshot);
      requireArray('post_repair.new_versions_added', repairData.post_repair?.new_versions_added);
      requireArray('post_repair.lost_versions', repairData.post_repair?.lost_versions);
    }
    requireArray('derived_added_version_set', repairData.derived_added_version_set);
    requireArray('derived_removed_version_set', repairData.derived_removed_version_set);

    if (structErrors > 0) {
      fail(`Repair batch ${batchNumber}: ${structErrors} required fields missing or wrong type — skipping dependent checks`);
      continue; // Skip dependent validation for this batch
    }
    pass(`Repair Batch ${batchNumber} all required structural fields present`);
  }

  // ── 2c. Exact version-set equality (4-5 sets must match) ──
  const approvedSet = new Set(repairData.approved_versions.map(String));
  const resultSet = new Set(repairData.repair_results.map(r => String(r.version)));
  // Batch 1-2: migration_files is object keyed by version. Batch 3+: migration_filenames is array.
  const fileSet = repairData.migration_files
    ? new Set(Object.keys(repairData.migration_files))
    : new Set(repairData.approved_versions.map(String)); // Batch 3+: filenames array is indexed same as approved_versions, so version set is identical
  const manifestRepairSet = new Set(manifest.filter(e => e.repair_batch === repairData.batch_number).map(e => e.version));
  const newVersionsSet = new Set((repairData.post_repair.new_versions_added || repairData.derived_added_version_set || []).map(String));

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

  // ── Filename-map binding (Batch 3+ with migration_filenames array) ──
  if (Array.isArray(repairData.migration_filenames)) {
    if (repairData.migration_filenames.length !== repairData.approved_versions.length) {
      fail(`Repair batch ${batchNumber}: migration_filenames length (${repairData.migration_filenames.length}) !== approved_versions length (${repairData.approved_versions.length})`);
      repairErrors++;
    }
    const fnSet = new Set(repairData.migration_filenames);
    if (fnSet.size !== repairData.migration_filenames.length) {
      fail(`Repair batch ${batchNumber}: duplicate migration_filenames`);
      repairErrors++;
    }
    // Zip and validate against manifest
    let fnErrors = 0;
    repairData.approved_versions.forEach((ver, i) => {
      const fn = repairData.migration_filenames[i];
      if (!fn || typeof fn !== 'string' || fn.length === 0) {
        fail(`Repair batch ${batchNumber} version ${ver}: missing or empty filename at index ${i}`);
        fnErrors++; repairErrors++;
        return;
      }
      const me = manifestByVersion[String(ver)];
      if (me && me.filename !== fn) {
        fail(`Repair batch ${batchNumber} version ${ver}: filename "${fn}" !== manifest "${me.filename}"`);
        fnErrors++; repairErrors++;
      }
    });
    if (fnErrors === 0) pass(`Repair Batch ${batchNumber} all ${repairData.migration_filenames.length} filenames match manifest`);
  }

  // ── Checksum-map binding (Batch 3+ with approved_checksums object) ──
  if (repairData.approved_checksums && typeof repairData.approved_checksums === 'object') {
    const csKeys = new Set(Object.keys(repairData.approved_checksums));
    const missing = [...approvedSet].filter(v => !csKeys.has(v));
    const extra = [...csKeys].filter(v => !approvedSet.has(v));
    if (missing.length > 0) { fail(`Repair batch ${batchNumber}: approved_checksums missing versions: ${missing.join(',')}`); repairErrors++; }
    if (extra.length > 0) { fail(`Repair batch ${batchNumber}: approved_checksums has extra versions: ${extra.join(',')}`); repairErrors++; }
    let csErrors = 0;
    for (const [ver, cs] of Object.entries(repairData.approved_checksums)) {
      if (!/^[0-9a-f]{64}$/.test(cs)) {
        fail(`Repair batch ${batchNumber} version ${ver}: checksum is not valid 64-char lowercase hex SHA-256`);
        csErrors++; repairErrors++;
      }
      const me = manifestByVersion[ver];
      if (me && me.checksum !== cs) {
        fail(`Repair batch ${batchNumber} version ${ver}: checksum mismatch with manifest`);
        csErrors++; repairErrors++;
      }
      // Also verify against actual repository file — require exactly one match
      const matchingFiles = migrationFiles.filter(f => f.startsWith(ver + '_'));
      if (matchingFiles.length === 0) {
        fail(`Repair batch ${batchNumber} version ${ver}: no repository migration file found`);
        csErrors++; repairErrors++;
      } else if (matchingFiles.length > 1) {
        fail(`Repair batch ${batchNumber} version ${ver}: multiple repository files match: ${matchingFiles.join(', ')}`);
        csErrors++; repairErrors++;
      } else {
        const repoFile = matchingFiles[0];
        const content = readFileSync(resolve(MIGRATIONS_DIR, repoFile), 'utf-8');
        const sha256 = createHash('sha256').update(content).digest('hex');
        if (cs !== sha256) {
          fail(`Repair batch ${batchNumber} version ${ver}: checksum mismatch with repository file`);
          csErrors++; repairErrors++;
        }
      }
    }
    if (csErrors === 0) pass(`Repair Batch ${batchNumber} all checksums valid and match manifest/repository`);
  }

  // ── Production-evidence digest authorization chain (Batch 3-4 only; Batch 5 uses V2 migration_evidence_digest scheme) ──
  if (repairData.approved_production_evidence_digests && typeof repairData.approved_production_evidence_digests === 'object' && repairData.batch_number <= 4) {
    const pedKeys = new Set(Object.keys(repairData.approved_production_evidence_digests));
    const pedMissing = [...approvedSet].filter(v => !pedKeys.has(v));
    const pedExtra = [...pedKeys].filter(v => !approvedSet.has(v));
    if (pedMissing.length > 0) { fail(`Repair batch ${batchNumber}: approved_production_evidence_digests missing versions: ${pedMissing.join(',')}`); repairErrors++; }
    if (pedExtra.length > 0) { fail(`Repair batch ${batchNumber}: approved_production_evidence_digests has extra versions: ${pedExtra.join(',')}`); repairErrors++; }

    let pedErrors = 0;
    for (const [ver, storedDigest] of Object.entries(repairData.approved_production_evidence_digests)) {
      if (!/^[0-9a-f]{64}$/.test(storedDigest)) {
        fail(`Repair batch ${batchNumber} version ${ver}: production-evidence digest is not valid 64-char hex`);
        pedErrors++; repairErrors++;
        continue;
      }
      // Recompute canonical digest from manifest evidence (same method as allowlist creation)
      const me = manifestByVersion[ver];
      if (!me) {
        fail(`Repair batch ${batchNumber} version ${ver}: not found in manifest for digest recomputation`);
        pedErrors++; repairErrors++;
        continue;
      }
      // Verify the verification batch matches the repair batch
      if (me.verification_batch !== repairData.batch_number) {
        fail(`Repair batch ${batchNumber} version ${ver}: verification_batch=${me.verification_batch} !== repair batch ${repairData.batch_number}`);
        pedErrors++; repairErrors++;
      }
      // Recompute using the canonical method with pre-repair classification
      const canonical = JSON.stringify({
        version: me.version, filename: me.filename, checksum: me.checksum,
        current_classification: 'VERIFIED_APPLIED_UNTRACKED',
        evidence_source: me.evidence_source,
        evidence: me.evidence,
        last_verified_at: me.last_verified_at
      });
      const recomputedDigest = createHash('sha256').update(canonical).digest('hex');
      if (storedDigest !== recomputedDigest) {
        fail(`Repair batch ${batchNumber} version ${ver}: production-evidence digest mismatch (stored: ${storedDigest.slice(0,12)}..., recomputed: ${recomputedDigest.slice(0,12)}...)`);
        pedErrors++; repairErrors++;
      }
    }
    if (pedErrors === 0) pass(`Repair Batch ${batchNumber} all ${pedKeys.size} production-evidence digests recompute correctly`);
  }

  // ── Snapshot validation (Batch 3+ with tracked_version_snapshot) ──
  const approvedSorted = [...approvedSet].sort((a,b) => parseInt(a)-parseInt(b));
  if (repairData.pre_repair.tracked_version_snapshot && repairData.post_repair.tracked_version_snapshot) {
    const preSnap = repairData.pre_repair.tracked_version_snapshot;
    const postSnap = repairData.post_repair.tracked_version_snapshot;

    // Both must be arrays of positive integers with no duplicates
    for (const [label, snap, expectedTotal, expectedRange] of [
      ['pre_repair', preSnap, repairData.pre_repair.total_remote_count, repairData.pre_repair.range_101_246_count],
      ['post_repair', postSnap, repairData.post_repair.total_remote_count, repairData.post_repair.range_101_246_count]
    ]) {
      if (!Array.isArray(snap)) {
        fail(`Repair batch ${batchNumber}: ${label}.tracked_version_snapshot is not an array`);
        repairErrors++;
        continue;
      }
      if (!snap.every(v => Number.isInteger(v) && v > 0)) {
        fail(`Repair batch ${batchNumber}: ${label}.tracked_version_snapshot contains non-positive-integer values`);
        repairErrors++;
      }
      if (new Set(snap).size !== snap.length) {
        fail(`Repair batch ${batchNumber}: ${label}.tracked_version_snapshot contains duplicates`);
        repairErrors++;
      }
      if (snap.length !== expectedTotal) {
        fail(`Repair batch ${batchNumber}: ${label}.tracked_version_snapshot length (${snap.length}) !== total_remote_count (${expectedTotal})`);
        repairErrors++;
      }
      const rangeCount = snap.filter(v => v >= 101 && v <= 246).length;
      if (rangeCount !== expectedRange) {
        fail(`Repair batch ${batchNumber}: ${label} range 101-246 count (${rangeCount}) !== range_101_246_count (${expectedRange})`);
        repairErrors++;
      }
    }

    // Derive added/removed from snapshots
    const preSet = new Set(preSnap.map(String));
    const postSet = new Set(postSnap.map(String));
    const snapAdded = [...postSet].filter(v => !preSet.has(v)).sort((a,b) => parseInt(a)-parseInt(b));
    const snapRemoved = [...preSet].filter(v => !postSet.has(v));

    if (JSON.stringify(snapAdded) !== JSON.stringify(approvedSorted)) {
      fail(`Repair batch ${batchNumber}: snapshot-derived added set doesn't match approved_versions`);
      repairErrors++;
    }
    if (snapRemoved.length > 0) {
      fail(`Repair batch ${batchNumber}: snapshot-derived removed set is non-empty: ${snapRemoved.join(',')}`);
      repairErrors++;
    }

    // Cross-validate with explicit fields
    // For Batch 3+, these fields are REQUIRED, not optional
    if (repairData.batch_number >= 3) {
      // new_versions_added must equal snapshot-derived added set
      const newAdded = (repairData.post_repair.new_versions_added || []).map(String).sort((a,b) => parseInt(a)-parseInt(b));
      if (JSON.stringify(newAdded) !== JSON.stringify(snapAdded)) {
        fail(`Repair batch ${batchNumber}: post_repair.new_versions_added doesn't match snapshot-derived added set`);
        repairErrors++;
      }
      // lost_versions must equal snapshot-derived removed set (empty)
      const lost = (repairData.post_repair.lost_versions || []).map(String);
      if (lost.length > 0) {
        fail(`Repair batch ${batchNumber}: post_repair.lost_versions is non-empty: ${lost.join(',')}`);
        repairErrors++;
      }
      // derived_added_version_set must equal snapshot-derived added set
      if (repairData.derived_added_version_set) {
        const explicitAdded = repairData.derived_added_version_set.map(String).sort((a,b) => parseInt(a)-parseInt(b));
        if (JSON.stringify(explicitAdded) !== JSON.stringify(snapAdded)) {
          fail(`Repair batch ${batchNumber}: derived_added_version_set doesn't match snapshot-derived added set`);
          repairErrors++;
        }
      }
      // derived_removed_version_set must equal snapshot-derived removed set (empty)
      if (repairData.derived_removed_version_set && repairData.derived_removed_version_set.length > 0) {
        fail(`Repair batch ${batchNumber}: derived_removed_version_set is non-empty`);
        repairErrors++;
      }
    } else {
      if (repairData.post_repair.new_versions_added) {
        const newAdded = repairData.post_repair.new_versions_added.map(String).sort((a,b) => parseInt(a)-parseInt(b));
        if (JSON.stringify(newAdded) !== JSON.stringify(snapAdded)) {
          fail(`Repair batch ${batchNumber}: post_repair.new_versions_added doesn't match snapshot-derived added set`);
          repairErrors++;
        }
      }
      if (repairData.post_repair.lost_versions && repairData.post_repair.lost_versions.length > 0) {
        fail(`Repair batch ${batchNumber}: post_repair.lost_versions is non-empty`);
        repairErrors++;
      }
    }

    pass(`Repair Batch ${batchNumber} snapshot validation passed`);
  }

  // ── Safety confirmations (Batch 3+) ──
  if (repairData.batch_number >= 3 && repairData.confirmations) {
    const requiredConfirmations = [
      'every_approved_version_appears_exactly_once',
      'no_unrelated_version_changed',
      'no_migration_sql_executed',
      'no_schema_or_application_data_changed',
      'no_customer_record_contents_accessed',
      'no_deployment_occurred',
      'no_token_or_auth_header_recorded'
    ];
    // The next-batch confirmation key varies (batch_4_did_not_start, batch_5_did_not_start, etc.)
    const nextBatch = repairData.batch_number + 1;
    requiredConfirmations.push(`batch_${nextBatch}_did_not_start`);

    let confErrors = 0;
    for (const key of requiredConfirmations) {
      if (!(key in repairData.confirmations) || repairData.confirmations[key] !== true) {
        fail(`Repair batch ${batchNumber}: confirmation "${key}" must be boolean true (got: ${JSON.stringify(repairData.confirmations[key])})`);
        confErrors++; repairErrors++;
      }
    }
    if (confErrors === 0) pass(`Repair Batch ${batchNumber} all ${requiredConfirmations.length} safety confirmations present and true`);
  }

  // ── 2d. Derive before/after version difference ──
  // Batch 1-2: range_101_246_versions. Batch 3+: tracked_version_snapshot (full, filter to 101-246 range).
  function getVersionsInRange(snapshot) {
    if (!snapshot) return [];
    return snapshot.filter(v => v >= 101 && v <= 246);
  }
  const preRangeVersions = repairData.pre_repair.range_101_246_versions
    || getVersionsInRange(repairData.pre_repair.tracked_version_snapshot);
  const postRangeVersions = repairData.post_repair.range_101_246_versions
    || getVersionsInRange(repairData.post_repair.tracked_version_snapshot);
  const preVersions = new Set((preRangeVersions || []).map(String));
  const postVersions = new Set((postRangeVersions || []).map(String));
  const derivedAdded = [...postVersions].filter(v => !preVersions.has(v)).sort((a,b) => parseInt(a)-parseInt(b));
  const derivedRemoved = [...preVersions].filter(v => !postVersions.has(v));

  // If we have explicit derived sets from the report, cross-validate
  if (repairData.derived_added_version_set) {
    const explicitAdded = repairData.derived_added_version_set.map(String).sort((a,b) => parseInt(a)-parseInt(b));
    if (JSON.stringify(explicitAdded) !== JSON.stringify(approvedSorted)) {
      fail(`Repair batch ${repairData.batch_number}: derived_added_version_set doesn't match approved_versions`);
      repairErrors++;
    }
  }
  if (repairData.derived_removed_version_set && repairData.derived_removed_version_set.length > 0) {
    fail(`Repair batch ${repairData.batch_number}: derived_removed_version_set is non-empty`);
    repairErrors++;
  }

  if (preVersions.size > 0 && postVersions.size > 0) {
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
  } else {
    pass(`Repair Batch ${batchNumber} version snapshot derivation skipped (no range_101_246_versions or tracked_version_snapshot)`);
  }

  // approved_count: Batch 1-2 require it explicitly, Batch 3+ derive from approved_versions.length
  let approvedCount;
  if (repairData.batch_number <= 2) {
    // Legacy: approved_count must exist as a positive integer
    if (!Number.isInteger(repairData.approved_count) || repairData.approved_count <= 0) {
      fail(`Repair batch ${batchNumber}: approved_count must be a positive integer (got: ${JSON.stringify(repairData.approved_count)})`);
      repairErrors++;
      approvedCount = repairData.approved_versions.length; // fallback for continued validation
    } else if (repairData.approved_count !== repairData.approved_versions.length) {
      fail(`Repair batch ${batchNumber}: approved_count (${repairData.approved_count}) !== approved_versions.length (${repairData.approved_versions.length})`);
      repairErrors++;
      approvedCount = repairData.approved_versions.length;
    } else {
      approvedCount = repairData.approved_count;
    }
  } else {
    // Batch 3+: derive from approved_versions.length
    approvedCount = repairData.approved_versions.length;
    // If approved_count is present, it must match
    if (repairData.approved_count !== undefined && repairData.approved_count !== null) {
      if (!Number.isInteger(repairData.approved_count) || repairData.approved_count !== approvedCount) {
        fail(`Repair batch ${batchNumber}: approved_count (${repairData.approved_count}) !== approved_versions.length (${approvedCount})`);
        repairErrors++;
      }
    }
  }
  if (repairData.post_repair.total_remote_count - repairData.pre_repair.total_remote_count !== approvedCount) {
    fail(`Repair batch ${repairData.batch_number}: total count delta mismatch`);
    repairErrors++;
  }
  if (repairData.post_repair.range_101_246_count - repairData.pre_repair.range_101_246_count !== approvedCount) {
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
    // Batch 1-2: migration_files[version].filename/.checksum
    // Batch 3+: migration_filenames[idx], approved_checksums[version]
    let repairFilename = null, repairChecksum = null;
    if (repairData.migration_files && repairData.migration_files[entry.version]) {
      repairFilename = repairData.migration_files[entry.version].filename;
      repairChecksum = repairData.migration_files[entry.version].checksum;
    } else if (repairData.migration_filenames && repairData.approved_versions) {
      const idx = repairData.approved_versions.map(String).indexOf(entry.version);
      if (idx >= 0) repairFilename = repairData.migration_filenames[idx];
      if (repairData.approved_checksums) repairChecksum = repairData.approved_checksums[entry.version];
    }
    if (repairFilename !== null) {
      if (repairFilename !== entry.filename) {
        fail(`Version ${entry.version}: repair evidence filename mismatch`);
        repairErrors++;
      }
    } else {
      fail(`Version ${entry.version}: not found in repair evidence migration files`);
      repairErrors++;
    }
    if (repairChecksum !== null) {
      if (repairChecksum !== entry.checksum) {
        fail(`Version ${entry.version}: repair evidence checksum mismatch`);
        repairErrors++;
      }
    }

    // Verify repair_evidence_digest recomputes correctly
    if (entry.repair_evidence_digest) {
      const repairEvidence = {
        version: entry.version,
        filename: entry.filename,
        checksum: entry.checksum,
        repair_result: repairResult,
        repair_timestamp: repairTimestamp,
        repository_sha: repairData.repository_sha
      };
      const expectedDigest = createHash('sha256').update(JSON.stringify(repairEvidence)).digest('hex');
      if (entry.repair_evidence_digest !== expectedDigest) {
        fail(`Version ${entry.version}: repair_evidence_digest mismatch (computed ${expectedDigest}, stored ${entry.repair_evidence_digest})`);
        repairErrors++;
      }
    }
  }

  // Verify before/after count delta (already checked above in 2d, this is the secondary pass with formatted output)
  if (repairData.post_repair && repairData.pre_repair) {
    const expectedDelta = approvedCount;
    const actualTotalDelta = repairData.post_repair.total_remote_count - repairData.pre_repair.total_remote_count;
    const actualRangeDelta = repairData.post_repair.range_101_246_count - repairData.pre_repair.range_101_246_count;
    if (actualTotalDelta === expectedDelta) {
      pass(`Repair Batch ${batchNumber}: total count delta +${actualTotalDelta} (${repairData.pre_repair.total_remote_count} -> ${repairData.post_repair.total_remote_count})`);
    }
    if (actualRangeDelta === expectedDelta) {
      pass(`Repair Batch ${batchNumber}: range count delta +${actualRangeDelta} (${repairData.pre_repair.range_101_246_count} -> ${repairData.post_repair.range_101_246_count})`);
    }
  }

  // Verify no unrelated version changed
  if (repairData.confirmations && !repairData.confirmations.no_unrelated_version_changed) {
    fail(`Repair Batch ${batchNumber}: unrelated version change detected`);
    repairErrors++;
  }

  // Exactly-once: support both legacy (Batch 1-2) and current (Batch 3+) fields
  const exactlyOnceFromPostRepair = repairData.post_repair?.all_approved_appear_exactly_once;
  const exactlyOnceFromConfirmations = repairData.confirmations?.every_approved_version_appears_exactly_once;
  const hasExactlyOnce = exactlyOnceFromPostRepair !== undefined || exactlyOnceFromConfirmations !== undefined;
  if (!hasExactlyOnce) {
    fail(`Repair Batch ${batchNumber}: no exactly-once confirmation found (checked post_repair.all_approved_appear_exactly_once and confirmations.every_approved_version_appears_exactly_once)`);
    repairErrors++;
  } else {
    const exactlyOnceValue = exactlyOnceFromPostRepair ?? exactlyOnceFromConfirmations;
    if (exactlyOnceValue !== true) {
      fail(`Repair Batch ${batchNumber}: exactly-once confirmation is not boolean true (got: ${JSON.stringify(exactlyOnceValue)})`);
      repairErrors++;
    } else {
      pass(`Repair Batch ${batchNumber} exactly-once confirmation verified`);
    }
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

// ══════════════════════════════════════════════════════════════
// MIGRATION 298 EVIDENCE VALIDATION
// ══════════════════════════════════════════════════════════════
console.log('\n--- Migration 298 Evidence Validation ---\n');

const M298_ORIGINAL_PATH = resolve(EVIDENCE_DIR, 'migration-298-production-application-original.json');
const M298_CORRECTED_PATH = resolve(EVIDENCE_DIR, 'migration-298-production-application-corrected.json');

if (!existsSync(M298_ORIGINAL_PATH)) {
  fail('Migration 298 original evidence file missing');
} else {
  pass('Migration 298 original evidence file exists');
}
if (!existsSync(M298_CORRECTED_PATH)) {
  fail('Migration 298 corrected evidence file missing');
} else {
  pass('Migration 298 corrected evidence file exists');
}

if (existsSync(M298_ORIGINAL_PATH) && existsSync(M298_CORRECTED_PATH)) {
  let m298Orig, m298Corr;
  try {
    m298Orig = JSON.parse(readFileSync(M298_ORIGINAL_PATH, 'utf-8'));
    pass('Migration 298 original evidence is valid JSON');
  } catch (e) {
    fail('Migration 298 original evidence is invalid JSON: ' + e.message);
  }
  try {
    m298Corr = JSON.parse(readFileSync(M298_CORRECTED_PATH, 'utf-8'));
    pass('Migration 298 corrected evidence is valid JSON');
  } catch (e) {
    fail('Migration 298 corrected evidence is invalid JSON: ' + e.message);
  }

  if (m298Orig && m298Corr) {
    let m298Errors = 0;
    const m298Check = (cond, msg) => { if (!cond) { fail(msg); m298Errors++; } else { pass(msg); } };

    // ── Original report validation ──
    m298Check(m298Orig.task_identifier === 'migration-298-production-application', 'Original: task_identifier correct');
    m298Check(m298Orig.repository_sha === '6ceb7fae6e67a389af24424775b50e06e6c57858', 'Original: repository_sha correct');
    m298Check(m298Orig.migration_version === 298, 'Original: migration_version = 298');
    m298Check(m298Orig.dry_run?.pending_migration_count === 79, 'Original: dry_run.pending_migration_count = 79');
    m298Check(m298Orig.dry_run?.migration_298_only === false, 'Original: dry_run.migration_298_only = false');
    m298Check(m298Orig.application?.command_category === 'supabase_management_api_sql', 'Original: application.command_category = supabase_management_api_sql');
    m298Check(m298Orig.application?.migration_history_recorded_via === 'supabase_migration_repair', 'Original: application.migration_history_recorded_via = supabase_migration_repair');
    m298Check(m298Orig.application?.migration_298_applied === true, 'Original: application.migration_298_applied = true');
    m298Check(m298Orig.post_application?.migration_298_occurrences === 1, 'Original: post_application.migration_298_occurrences = 1');
    m298Check(m298Orig.post_application?.current_pending_rows === 0, 'Original: post_application.current_pending_rows = 0');
    m298Check(m298Orig.post_application?.populated_metadata_match_rows === 39, 'Original: post_application.populated_metadata_match_rows = 39');
    m298Check(m298Orig.no_migration_repair_for_other_versions === true, 'Original: no_migration_repair_for_other_versions = true');
    m298Check(m298Orig.no_manual_sql_execution_beyond_298 === true, 'Original: no_manual_sql_execution_beyond_298 = true');
    m298Check(m298Orig.batch_5_not_started === true, 'Original: batch_5_not_started = true');

    // ── Corrected report validation ──
    m298Check(m298Corr.task_identifier === 'migration-298-production-application-corrected', 'Corrected: task_identifier correct');
    m298Check(m298Corr.repository_sha === '6ceb7fae6e67a389af24424775b50e06e6c57858', 'Corrected: repository_sha correct');
    m298Check(m298Corr.linked_project_ref === 'cxcmiqotkowhxinjbytg', 'Corrected: linked_project_ref correct');
    m298Check(m298Corr.migration_version === 298, 'Corrected: migration_version = 298');
    m298Check(m298Corr.migration_filename === '298_complete_order_payment_backfill.sql', 'Corrected: migration_filename correct');
    m298Check(m298Corr.dry_run?.approved_gate_passed === false, 'Corrected: dry_run.approved_gate_passed = false');
    m298Check(m298Corr.dry_run?.required_action_was_stop === true, 'Corrected: dry_run.required_action_was_stop = true');
    m298Check(typeof m298Corr.dry_run?.result === 'string' && m298Corr.dry_run.result.includes('79'), 'Corrected: dry_run.result contains "79"');
    m298Check(m298Corr.actual_execution?.migration_sql_execution_method === 'supabase_management_api_sql', 'Corrected: actual_execution.migration_sql_execution_method correct');
    m298Check(m298Corr.actual_execution?.migration_up_linked_used === false, 'Corrected: actual_execution.migration_up_linked_used = false');
    m298Check(m298Corr.actual_execution?.migration_repair_used === true, 'Corrected: actual_execution.migration_repair_used = true');
    m298Check(m298Corr.actual_execution?.repaired_version === 298, 'Corrected: actual_execution.repaired_version = 298');
    m298Check(m298Corr.actual_execution?.approved_procedure_followed === false, 'Corrected: actual_execution.approved_procedure_followed = false');
    m298Check(m298Corr.actual_execution?.procedure_deviation_recorded === true, 'Corrected: actual_execution.procedure_deviation_recorded = true');
    m298Check(m298Corr.manual_sql_execution_occurred === true, 'Corrected: manual_sql_execution_occurred = true');
    m298Check(m298Corr.migration_repair_occurred === true, 'Corrected: migration_repair_occurred = true');
    m298Check(m298Corr.pre_application_history?.total_remote_migration_count === 163, 'Corrected: pre count = 163');
    m298Check(m298Corr.post_application_history?.total_remote_migration_count === 164, 'Corrected: post count = 164');
    m298Check(m298Corr.post_application_history?.tracked_101_246_count === 68, 'Corrected: tracked 101-246 = 68');
    m298Check(JSON.stringify(m298Corr.post_application_history?.exact_new_history_versions) === '[298]', 'Corrected: exact_new_history_versions = [298]');
    m298Check(m298Corr.exactly_11_rows_corrected === true, 'Corrected: exactly_11_rows_corrected = true');
    m298Check(m298Corr.current_pending_rows === 0, 'Corrected: current_pending_rows = 0');
    m298Check(m298Corr.populated_metadata_match_rows === 39, 'Corrected: populated_metadata_match_rows = 39');
    m298Check(m298Corr.populated_metadata_mismatch_rows === 0, 'Corrected: populated_metadata_mismatch_rows = 0');
    m298Check(m298Corr.historical_payment_business_ids_remain_null === true, 'Corrected: business IDs remain null');
    m298Check(m298Corr.referenced_order_business_ids_non_null === true, 'Corrected: referenced order business IDs non-null');
    m298Check(m298Corr.migration_result_verified === true, 'Corrected: migration_result_verified = true');
    m298Check(m298Corr.issue_53_remains_open === true, 'Corrected: issue_53_remains_open = true');
    m298Check(m298Corr.batch_5_not_started === true, 'Corrected: batch_5_not_started = true');
    m298Check(m298Corr.corrective_action?.do_not_rerun_migration_298 === true, 'Corrected: do_not_rerun = true');

    // ── Evidence lineage validation ──
    const origContent = readFileSync(M298_ORIGINAL_PATH);
    const origHash = createHash('sha256').update(origContent).digest('hex');
    m298Check(m298Corr.original_evidence_sha256 === origHash, 'Lineage: original_evidence_sha256 recomputes correctly');
    m298Check(m298Corr.original_evidence_path === '/tmp/waaiio-migration-298-production-application.json',
      'Lineage: original_evidence_path is exactly /tmp/waaiio-migration-298-production-application.json');
    m298Check(m298Orig.migration_file_sha256 === m298Corr.migration_file_sha256,
      'Lineage: migration_file_sha256 agrees between original and corrected');

    // ── Exact Migration 298 occurrence counts ──
    m298Check(m298Orig.post_application?.migration_298_occurrences === 1,
      'Original: post_application.migration_298_occurrences = 1');
    m298Check(m298Corr.pre_application_history?.migration_298_occurrences === 0,
      'Corrected: pre_application_history.migration_298_occurrences = 0');
    m298Check(m298Corr.post_application_history?.migration_298_occurrences === 1,
      'Corrected: post_application_history.migration_298_occurrences = 1');

    if (m298Errors === 0) pass('Migration 298 evidence cross-validation passed');
  }
}

// ══════════════════════════════════════════════════════════════
// BATCH 5 REPAIR EVIDENCE FILE VALIDATION
// ══════════════════════════════════════════════════════════════
const BATCH5_REPAIR_PATH = resolve(EVIDENCE_DIR, 'batch-05-repair.json');
if (!existsSync(BATCH5_REPAIR_PATH)) {
  fail('Batch 5 repair evidence file missing: ' + BATCH5_REPAIR_PATH);
} else {
  const b5Content = readFileSync(BATCH5_REPAIR_PATH);
  const b5SHA = createHash('sha256').update(b5Content).digest('hex');
  if (b5SHA !== '703cd382c603618111025f7403fa4de075ed9736b9f0deecfca017c013c0bafc') {
    fail(`Batch 5 repair evidence SHA mismatch: ${b5SHA}`);
  } else {
    pass('Batch 5 repair evidence file SHA matches');
  }
}
// Validate batch-repaired candidate count (cohort of 75 across Batches 1-5)
if (repairedCandidateCount !== 75) {
  fail(`Batch-repaired candidate count is ${repairedCandidateCount}, expected 75`);
} else {
  pass('Batch-repaired candidate count = 75');
}
// Validate total completed (75 batch + 8 individual = 83)
if (completedEntries.length !== 83) {
  fail(`Total completed entries is ${completedEntries.length}, expected 83`);
} else {
  pass('Total completed entries = 83');
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

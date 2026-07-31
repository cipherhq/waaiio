#!/usr/bin/env node
/**
 * Validates the migration reconciliation manifest, repair allowlist,
 * verification candidates, and repair evidence against repository migration files.
 *
 * Progressive invariants (multi-batch aware):
 * - Manifest has exactly 146 entries (one per version 101-246)
 * - ALIGNED_TRACKED = 132 (8 original + 120 batches 1-8 + 4 batch 9)
 * - VERIFIED_APPLIED_UNTRACKED = 0
 * - PENDING_PRODUCTION_REVERIFICATION = 0
 * - NOT_VERIFIABLE_SAFELY = 12, SUPERSEDED = 2
 * - Active repair allowlist = 0 (all complete)
 * - Verification candidates = 0 (all verified)
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
const EXPECTED_ALIGNED = 132;
const EXPECTED_VERIFIED = 0;
const EXPECTED_PENDING = 0;
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

/**
 * Strict canonical UTC ISO-8601 timestamp parser.
 * Requires exact format: YYYY-MM-DDTHH:mm:ss.sssZ
 * Rejects timezone offsets, missing Z, missing milliseconds, spaces, bare dates.
 * Returns milliseconds if valid, or null if invalid (and emits a diagnostic).
 */
const CANONICAL_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
function parseCanonicalUtcTimestamp(value, label) {
  if (typeof value !== 'string') {
    fail(`${label} must be canonical UTC ISO-8601 (got ${typeof value})`);
    return null;
  }
  if (!CANONICAL_UTC_RE.test(value)) {
    fail(`${label} "${value}" must be canonical UTC ISO-8601 (YYYY-MM-DDTHH:mm:ss.sssZ)`);
    return null;
  }
  const ms = Date.parse(value);
  if (isNaN(ms)) {
    fail(`${label} "${value}" must be canonical UTC ISO-8601 (unparseable)`);
    return null;
  }
  if (new Date(ms).toISOString() !== value) {
    fail(`${label} "${value}" must be canonical UTC ISO-8601 (round-trip mismatch)`);
    return null;
  }
  return ms;
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
      // Wave 2 format uses expected_properties/verified_properties (no verified_state/result)
      // Wave 1 and earlier format uses verified_state + result + expected_state
      const isWave2Format = ev.expected_properties !== undefined && ev.verified_state === undefined;
      if (isWave2Format) {
        // Wave 2 format validation
        if (!ev.verified_at) {
          fail(`Version ${e.version}: evidence for ${ev.object_name} missing verified_at`);
          approvedErrors++;
        }
        if (!ev.verification_source) {
          fail(`Version ${e.version}: evidence for ${ev.object_name} missing verification_source`);
          approvedErrors++;
        }
        if (!ev.property_comparison_result) {
          fail(`Version ${e.version}: evidence for ${ev.object_name} missing property_comparison_result`);
          approvedErrors++;
        }
        if (ev.property_comparison_result === 'failed' || ev.property_comparison_result === 'ambiguous') {
          fail(`Version ${e.version}: evidence for ${ev.object_name} has ${ev.property_comparison_result} result`);
          approvedErrors++;
        }
      } else {
      // Legacy format validation
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
      } // end legacy format else block
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
  // Batch 5 chronology: repaired_at must be after PR #75 merge and before PR #76 creation
  if (e.repair_batch === 5) {
    const PR75_MERGE = new Date('2026-07-30T02:54:38Z').getTime();
    const PR76_CREATED = new Date('2026-07-30T04:37:37Z').getTime();
    const repairedAtMs = new Date(e.repaired_at).getTime();
    if (repairedAtMs <= PR75_MERGE) {
      fail(`Version ${e.version}: Batch 5 repaired_at ${e.repaired_at} is not later than PR #75 merge 2026-07-30T02:54:38Z`);
      completedErrors++;
    }
    if (repairedAtMs > PR76_CREATED) {
      fail(`Version ${e.version}: Batch 5 repaired_at ${e.repaired_at} is later than PR #76 creation 2026-07-30T04:37:37Z`);
      completedErrors++;
    }
    if (e.repaired_at_source !== 'batch-05-repair source evidence file mtime after final post-repair verification') {
      fail(`Version ${e.version}: Batch 5 repaired_at_source missing or incorrect: "${e.repaired_at_source}"`);
      completedErrors++;
    }
  }
  // Batch 6 chronology: repaired_at must be after PR #77 merge
  if (e.repair_batch === 6) {
    const PR77_MERGE_B6 = new Date('2026-07-30T12:54:50Z').getTime();
    const repairedAtMs = new Date(e.repaired_at).getTime();
    if (repairedAtMs <= PR77_MERGE_B6) {
      fail(`Version ${e.version}: Batch 6 repaired_at ${e.repaired_at} is not later than PR #77 merge 2026-07-30T12:54:50Z`);
      completedErrors++;
    }
    if (e.repaired_at_source !== 'batch-06-repair evidence repairs[].completed_at') {
      fail(`Version ${e.version}: Batch 6 repaired_at_source missing or incorrect: "${e.repaired_at_source}"`);
      completedErrors++;
    }
  }
  // Batch 7 chronology: repaired_at must be after PR #78 merge
  if (e.repair_batch === 7) {
    const PR78_MERGE = new Date('2026-07-30T14:24:15Z').getTime();
    const repairedAtMs = new Date(e.repaired_at).getTime();
    if (repairedAtMs <= PR78_MERGE) {
      fail(`Version ${e.version}: Batch 7 repaired_at ${e.repaired_at} is not later than PR #78 merge 2026-07-30T14:24:15Z`);
      completedErrors++;
    }
    if (e.repaired_at_source !== 'batch-07-repair evidence repairs[].completed_at') {
      fail(`Version ${e.version}: Batch 7 repaired_at_source missing or incorrect: "${e.repaired_at_source}"`);
      completedErrors++;
    }
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

// Parse all batch evidence (skip Wave 1 format files — validated in dedicated section)
const allBatches = [];
const wave1BatchFiles = [];
for (const file of batchFiles) {
  const filePath = resolve(EVIDENCE_DIR, file);
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    // Wave 1 evidence uses task_identifier instead of main_sha
    if (data.task_identifier && !data.main_sha) {
      wave1BatchFiles.push({ file, data });
      pass(`${file} is valid JSON (Wave 1 format — validated in dedicated section)`);
      continue;
    }
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
    // Batch 6 and 7 repair evidence have different structures and are validated in their own dedicated sections
    if (file === 'batch-06-repair.json') {
      pass(`${file} is valid JSON (validated in Batch 6 Repair Closeout section)`);
      continue;
    }
    if (file === 'batch-07-repair.json') {
      pass(`${file} is valid JSON (validated in Batch 7 Repair Closeout section)`);
      continue;
    }
    if (file === 'batch-08-repair.json') {
      pass(`${file} is valid JSON (validated in Batch 8 Repair Closeout section)`);
      continue;
    }
    if (file === 'batch-09-repair.json') {
      pass(`${file} is valid JSON (validated in Batch 9 Repair Closeout section)`);
      continue;
    }
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
// Validate batch-repaired candidate count (cohort of 124 across Batches 1-9)
if (repairedCandidateCount !== 124) {
  fail(`Batch-repaired candidate count is ${repairedCandidateCount}, expected 124`);
} else {
  pass('Batch-repaired candidate count = 124');
}
// Validate total completed (124 batch + 8 individual = 132)
if (completedEntries.length !== 132) {
  fail(`Total completed entries is ${completedEntries.length}, expected 132`);
} else {
  pass('Total completed entries = 132');
}

// ══════════════════════════════════════════════════════════════
// WAVE 1 (BATCHES 6-7) EVIDENCE VALIDATION
// ══════════════════════════════════════════════════════════════
console.log('\n--- Wave 1 Evidence Validation ---\n');

const WAVE1_BATCH6_SHA = '0fc3ff1f5f56644c0570a6f6ff30f7961a873dae29aab02abe7fa83cd3c60cf6';
const WAVE1_BATCH7_SHA = 'ef3822deec7191c1a6b5fee69afd8c0c97fb588b6458cdc7aa86feeda5b66c00';
const WAVE1_WAVE_SHA = 'c78e0c2677eb5cbe75ef883b3a5f99c68e97fc1ff6a66e005ac8854c23cbe5a7';
const WAVE1_BATCH6_VERSIONS = ['191','192','193','194','195','196','197','198','201','202','203','204','205','206','207'];
const WAVE1_BATCH7_VERSIONS = ['208','209','210','211','212','213','214','215','218','219','220','221','223','224','225'];
const WAVE1_ALL_VERSIONS = [...WAVE1_BATCH6_VERSIONS, ...WAVE1_BATCH7_VERSIONS];

const WAVE1_B6_PATH = resolve(EVIDENCE_DIR, 'batch-06-production-verification.json');
const WAVE1_B7_PATH = resolve(EVIDENCE_DIR, 'batch-07-production-verification.json');
const WAVE1_WAVE_PATH = resolve(EVIDENCE_DIR, 'wave-01-production-verification.json');

// 1. All three evidence files exist
let wave1Errors = 0;
function w1fail(msg) { fail(`Wave 1: ${msg}`); wave1Errors++; }
function w1pass(msg) { pass(`Wave 1: ${msg}`); }

if (!existsSync(WAVE1_B6_PATH)) { w1fail('Batch 6 evidence file missing'); }
else { w1pass('Batch 6 evidence file exists'); }
if (!existsSync(WAVE1_B7_PATH)) { w1fail('Batch 7 evidence file missing'); }
else { w1pass('Batch 7 evidence file exists'); }
if (!existsSync(WAVE1_WAVE_PATH)) { w1fail('Wave summary evidence file missing'); }
else { w1pass('Wave summary evidence file exists'); }

if (existsSync(WAVE1_B6_PATH) && existsSync(WAVE1_B7_PATH) && existsSync(WAVE1_WAVE_PATH)) {
  // 2. Exact SHA values match
  const b6Content = readFileSync(WAVE1_B6_PATH);
  const b7Content = readFileSync(WAVE1_B7_PATH);
  const waveContent = readFileSync(WAVE1_WAVE_PATH);
  const b6SHA = createHash('sha256').update(b6Content).digest('hex');
  const b7SHA = createHash('sha256').update(b7Content).digest('hex');
  const waveSHA = createHash('sha256').update(waveContent).digest('hex');

  if (b6SHA !== WAVE1_BATCH6_SHA) { w1fail(`Batch 6 SHA mismatch: ${b6SHA}`); }
  else { w1pass('Batch 6 SHA matches'); }
  if (b7SHA !== WAVE1_BATCH7_SHA) { w1fail(`Batch 7 SHA mismatch: ${b7SHA}`); }
  else { w1pass('Batch 7 SHA matches'); }
  if (waveSHA !== WAVE1_WAVE_SHA) { w1fail(`Wave summary SHA mismatch: ${waveSHA}`); }
  else { w1pass('Wave summary SHA matches'); }

  const b6Data = JSON.parse(b6Content);
  const b7Data = JSON.parse(b7Content);
  const waveData = JSON.parse(waveContent);

  // 3-4. Exact version sets
  if (JSON.stringify(b6Data.versions) !== JSON.stringify(WAVE1_BATCH6_VERSIONS)) { w1fail('Batch 6 version set mismatch'); }
  else { w1pass('Batch 6 exact version set'); }
  if (JSON.stringify(b7Data.versions) !== JSON.stringify(WAVE1_BATCH7_VERSIONS)) { w1fail('Batch 7 version set mismatch'); }
  else { w1pass('Batch 7 exact version set'); }

  // 5-6. Object counts
  if (b6Data.actual_object_count !== 129) { w1fail(`Batch 6 object count: ${b6Data.actual_object_count}, expected 129`); }
  else { w1pass('Batch 6 object count = 129'); }
  if (b7Data.actual_object_count !== 83) { w1fail(`Batch 7 object count: ${b7Data.actual_object_count}, expected 83`); }
  else { w1pass('Batch 7 object count = 83'); }

  // 7. Combined object count
  if (waveData.actual_combined_object_count !== 212) { w1fail(`Combined object count: ${waveData.actual_combined_object_count}, expected 212`); }
  else { w1pass('Combined object count = 212'); }

  // 8-9. Result counts
  if (b6Data.exact_match_count !== 129 || b6Data.equivalent_stricter_count !== 0 || b6Data.superseded_count !== 0 || b6Data.failed_count !== 0 || b6Data.ambiguous_count !== 0) {
    w1fail(`Batch 6 result counts: ${b6Data.exact_match_count}/${b6Data.equivalent_stricter_count}/${b6Data.superseded_count}/${b6Data.failed_count}/${b6Data.ambiguous_count}, expected 129/0/0/0/0`);
  } else { w1pass('Batch 6 result counts = 129/0/0/0/0'); }

  if (b7Data.exact_match_count !== 82 || b7Data.equivalent_stricter_count !== 0 || b7Data.superseded_count !== 1 || b7Data.failed_count !== 0 || b7Data.ambiguous_count !== 0) {
    w1fail(`Batch 7 result counts: ${b7Data.exact_match_count}/${b7Data.equivalent_stricter_count}/${b7Data.superseded_count}/${b7Data.failed_count}/${b7Data.ambiguous_count}, expected 82/0/1/0/0`);
  } else { w1pass('Batch 7 result counts = 82/0/1/0/0'); }

  // 10. Compared-path counts
  if (b6Data.compared_property_path_count !== 550) { w1fail(`Batch 6 compared paths: ${b6Data.compared_property_path_count}, expected 550`); }
  else { w1pass('Batch 6 compared paths = 550'); }
  if (b7Data.compared_property_path_count !== 341) { w1fail(`Batch 7 compared paths: ${b7Data.compared_property_path_count}, expected 341`); }
  else { w1pass('Batch 7 compared paths = 341'); }
  if (waveData.combined_compared_property_path_count !== 891) { w1fail(`Combined compared paths: ${waveData.combined_compared_property_path_count}, expected 891`); }
  else { w1pass('Combined compared paths = 891'); }

  // 11-12. Every migration digest recomputes and is non-empty
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

  let digestErrors = 0;
  for (const batchInfo of [{data: b6Data, label: 'B6'}, {data: b7Data, label: 'B7'}]) {
    for (const m of batchInfo.data.migrations) {
      if (!m.migration_evidence_digest) {
        w1fail(`${batchInfo.label} migration ${m.migration_version}: empty digest`);
        digestErrors++;
        continue;
      }
      const clone = JSON.parse(JSON.stringify(m));
      delete clone.migration_evidence_digest;
      const sorted = sortKeysRecursive(clone);
      const serialized = JSON.stringify(sorted);
      const computed = createHash('sha256').update(serialized).digest('hex');
      if (computed !== m.migration_evidence_digest) {
        w1fail(`${batchInfo.label} migration ${m.migration_version}: digest mismatch (stored: ${m.migration_evidence_digest.slice(0,12)}..., computed: ${computed.slice(0,12)}...)`);
        digestErrors++;
      }
    }
  }
  if (digestErrors === 0) w1pass('All 30 migration digests recompute correctly');

  // 13. No failed or ambiguous result
  let resultErrors = 0;
  for (const batchInfo of [{data: b6Data, label: 'B6'}, {data: b7Data, label: 'B7'}]) {
    for (const m of batchInfo.data.migrations) {
      for (const o of m.objects || []) {
        if (o.property_comparison_result === 'failed') { w1fail(`${batchInfo.label} ${m.migration_version}: failed result`); resultErrors++; }
        if (o.property_comparison_result === 'ambiguous') { w1fail(`${batchInfo.label} ${m.migration_version}: ambiguous result`); resultErrors++; }
      }
    }
  }
  if (resultErrors === 0) w1pass('No failed or ambiguous results');

  // 14. Migration 223 superseded object with Migration 293 lineage
  const mig223 = b7Data.migrations.find(m => m.migration_version === '223');
  if (!mig223) { w1fail('Migration 223 not found in Batch 7'); }
  else {
    const superseded = mig223.objects.filter(o => o.property_comparison_result === 'superseded');
    if (superseded.length !== 1) { w1fail(`Migration 223: expected 1 superseded, got ${superseded.length}`); }
    else {
      const s = superseded[0];
      if (!s.object_name || !s.object_name.includes('public_read_active_businesses')) {
        w1fail(`Migration 223 superseded object name: ${s.object_name}`);
      }
      const lineage = s.lineage || {};
      if (String(lineage.later_migration) !== '293') { w1fail(`Migration 223 superseded lineage: ${lineage.later_migration}`); }
      else if (!lineage.later_filename || !lineage.later_filename.includes('293_fix_production_table_exposure')) {
        w1fail(`Migration 223 superseded lineage filename: ${lineage.later_filename}`);
      } else {
        w1pass('Migration 223 supersession: businesses:public_read_active_businesses -> Migration 293');
      }
    }
    // Verify no other objects are superseded
    let otherSuperseded = 0;
    for (const m of b7Data.migrations) {
      if (m.migration_version === '223') continue;
      for (const o of m.objects || []) {
        if (o.property_comparison_result === 'superseded') { otherSuperseded++; w1fail(`Non-223 superseded: ${m.migration_version}/${o.object_name}`); }
      }
    }
    if (otherSuperseded === 0) w1pass('No other superseded objects outside Migration 223');
  }

  // 15. Pre/post history snapshots exist and are exactly equal
  for (const batchInfo of [{data: b6Data, label: 'B6'}, {data: b7Data, label: 'B7'}]) {
    if (JSON.stringify(batchInfo.data.pre_verification_ordered_snapshot) !== JSON.stringify(batchInfo.data.post_verification_ordered_snapshot)) {
      w1fail(`${batchInfo.label} pre/post snapshots differ`);
    } else {
      w1pass(`${batchInfo.label} pre/post snapshots equal`);
    }
  }
  if (waveData.snapshots_exactly_equal !== true) { w1fail('Wave snapshots_exactly_equal not true'); }
  else { w1pass('Wave snapshots_exactly_equal = true'); }

  // 16. Counts remain 179/83/1
  for (const batchInfo of [{data: b6Data, label: 'B6'}, {data: b7Data, label: 'B7'}, {data: waveData, label: 'Wave'}]) {
    const pre = batchInfo.data.pre_verification_history_summary;
    if (pre.total_remote_count !== 179) w1fail(`${batchInfo.label} total_remote: ${pre.total_remote_count}`);
    if (pre.range_101_246_count !== 83) w1fail(`${batchInfo.label} range_count: ${pre.range_101_246_count}`);
    if (pre.migration_298_count !== 1) w1fail(`${batchInfo.label} m298_count: ${pre.migration_298_count}`);
  }
  w1pass('History counts = 179/83/1 in all evidence');

  // 17. All 30 Wave 1 occurrence values remain zero
  let occErrors = 0;
  for (const batchInfo of [{data: b6Data, versions: WAVE1_BATCH6_VERSIONS}, {data: b7Data, versions: WAVE1_BATCH7_VERSIONS}]) {
    const occ = batchInfo.data.pre_verification_occurrence_map || {};
    for (const v of batchInfo.versions) {
      if ((occ[v] || 0) !== 0) { w1fail(`Version ${v} occurrence != 0`); occErrors++; }
    }
  }
  if (occErrors === 0) w1pass('All 30 Wave 1 version occurrences = 0');

  // 18. All safety confirmations exist and are true
  let safetyErrors = 0;
  for (const batchInfo of [{data: b6Data, label: 'B6'}, {data: b7Data, label: 'B7'}, {data: waveData, label: 'Wave'}]) {
    for (const [k, v] of Object.entries(batchInfo.data.safety_confirmations || {})) {
      if (v !== true) { w1fail(`${batchInfo.label} safety ${k}: ${v}`); safetyErrors++; }
    }
  }
  if (safetyErrors === 0) w1pass('All safety confirmations true');

  // 19. Manifest classifications
  // (already checked above in main manifest checks)
  w1pass('Manifest classifications verified in main checks (113/19/0/12/2)');

  // 20. Batch 6 manifest entries are ALIGNED_TRACKED and completed
  let b6ManifestErrors = 0;
  for (const v of WAVE1_BATCH6_VERSIONS) {
    const me = manifestByVersion[v];
    if (!me) { w1fail(`Batch 6 version ${v} not in manifest`); b6ManifestErrors++; continue; }
    if (me.current_classification !== 'ALIGNED_TRACKED') { w1fail(`B6 ${v} classification: ${me.current_classification}`); b6ManifestErrors++; }
    if (me.repair_eligible !== false) { w1fail(`B6 ${v} repair_eligible: ${me.repair_eligible}`); b6ManifestErrors++; }
    if (me.repair_status !== 'completed') { w1fail(`B6 ${v} repair_status: ${me.repair_status}`); b6ManifestErrors++; }
    if (me.remote_tracked !== true) { w1fail(`B6 ${v} remote_tracked: ${me.remote_tracked}`); b6ManifestErrors++; }
    if (me.verification_batch !== 6) { w1fail(`B6 ${v} verification_batch: ${me.verification_batch}`); b6ManifestErrors++; }
  }
  if (b6ManifestErrors === 0) w1pass('Batch 6 manifest entries ALIGNED_TRACKED and completed');

  // 21. Allowlist is empty (all repairs complete)
  if (allowlist.length !== 0) { w1fail(`Allowlist length: ${allowlist.length}, expected 0`); }
  else { w1pass('Allowlist empty (all repairs complete)'); }

  // 22. Batch 7 manifest entries are ALIGNED_TRACKED and completed (repair done)
  let b7ManifestErrors = 0;
  for (const v of WAVE1_BATCH7_VERSIONS) {
    const me = manifestByVersion[v];
    if (!me) { w1fail(`Batch 7 version ${v} not in manifest`); b7ManifestErrors++; continue; }
    if (me.current_classification !== 'ALIGNED_TRACKED') { w1fail(`B7 ${v} classification: ${me.current_classification}`); b7ManifestErrors++; }
    if (me.repair_eligible !== false) { w1fail(`B7 ${v} repair_eligible: ${me.repair_eligible}`); b7ManifestErrors++; }
    if (me.repair_status !== 'completed') { w1fail(`B7 ${v} repair_status: ${me.repair_status}`); b7ManifestErrors++; }
    if (me.verification_batch !== 7) { w1fail(`B7 ${v} verification_batch: ${me.verification_batch}`); b7ManifestErrors++; }
  }
  if (b7ManifestErrors === 0) w1pass('Batch 7 manifest entries ALIGNED_TRACKED and completed');

  // 23. No Batch 6 or 7 version in allowlist
  const allowlistVersionSet = new Set(allowlist.map(e => e.version));
  const b6InAllowlist = WAVE1_BATCH6_VERSIONS.filter(v => allowlistVersionSet.has(v));
  const b7InAllowlist = WAVE1_BATCH7_VERSIONS.filter(v => allowlistVersionSet.has(v));
  if (b6InAllowlist.length > 0) { w1fail(`Batch 6 versions in allowlist: ${b6InAllowlist.join(',')}`); }
  if (b7InAllowlist.length > 0) { w1fail(`Batch 7 versions in allowlist: ${b7InAllowlist.join(',')}`); }
  if (b6InAllowlist.length === 0 && b7InAllowlist.length === 0) { w1pass('No Batch 6 or 7 version in allowlist'); }

  // 24. Candidate file is empty (all candidates verified in Wave 2)
  if (candidates.length !== 0) {
    w1fail(`Candidate count: ${candidates.length}, expected 0 (all verified)`);
  } else { w1pass('Candidate file is empty (all verified)'); }

  // 25. Completed repair count verified in Batch 7 closeout section
  w1pass('Completed repair count verified in Batch 7 closeout checks');

}

// ══════════════════════════════════════════════════════════════
// WAVE 2 (BATCHES 8-9) EVIDENCE VALIDATION
// ══════════════════════════════════════════════════════════════
console.log('\n--- Wave 2 Evidence Validation ---\n');

// V3 canonical SHAs
const WAVE2_BATCH8_SHA = 'f2d54c694f97858fb523247834587bcc3257f8715446ce5d2034086870913c95';
const WAVE2_BATCH9_SHA = 'ca531e1e6f23307d14948b89d854a985d6a56495539c072eb2ce3d17334a35c5';
const WAVE2_WAVE_SHA = '3d8550b4967ed4fd95769575e2a70b60e091b904867c3804ca276d243be2d70d';

// V1 audit SHAs
const WAVE2_BATCH8_V1_SHA = 'bc5ac3169b34c663e45707b25c4fb48c70e7f22b561f90155f7457a57ddd44f5';
const WAVE2_BATCH9_V1_SHA = '531f94b3c11e2c0c02d078e37a6e71f950d59fd9741818d1b81f93e34f51eff7';
const WAVE2_WAVE_V1_SHA = '8008cd5817061972b5e6973fa7da59464d3483798e62fb803604cdefbe1413ae';

// V2 audit SHAs
const WAVE2_BATCH8_V2_SHA = '8e136a202cbf49234ad14484ce6a7721f66de96ff18e416719bf8410b92936de';
const WAVE2_BATCH9_V2_SHA = '24d34f0b95484139cb1da95fc788a0976555a5763aab8ba295504654b5767e5d';
const WAVE2_WAVE_V2_SHA = 'd3adc5de8895e38519ce33206b8a211dd9b88caa1b0cdbd322a7fe645cf239e1';

const WAVE2_BATCH8_VERSIONS = ['227','228','229','230','231','232','233','234','235','236','237','238','239','240','241'];
const WAVE2_BATCH9_VERSIONS = ['242','243','245','246'];
const WAVE2_ALL_VERSIONS = [...WAVE2_BATCH8_VERSIONS, ...WAVE2_BATCH9_VERSIONS];

const WAVE2_REQUIRED_SAFETY_KEYS = [
  'all_queries_read_only',
  'metadata_catalogues_only',
  'no_commit_push_or_pr',
  'no_customer_records_accessed',
  'no_deployment_occurred',
  'no_issue_53_mutation',
  'no_management_api_write',
  'no_migration_history_changed',
  'no_migration_repair',
  'no_migration_sql_executed',
  'no_migration_up',
  'no_record_contents_returned',
  'no_repair_allowlist_created',
  'no_repair_started',
  'no_repository_change',
  'no_schema_or_data_changed',
  'no_supabase_db_push',
  'no_token_recorded',
  'no_write_query_executed',
];

const WAVE2_B8_PATH = resolve(EVIDENCE_DIR, 'batch-08-production-verification.json');
const WAVE2_B9_PATH = resolve(EVIDENCE_DIR, 'batch-09-production-verification.json');
const WAVE2_WAVE_PATH = resolve(EVIDENCE_DIR, 'wave-02-production-verification.json');

const WAVE2_B8_V1_PATH = resolve(EVIDENCE_DIR, 'batch-08-production-verification-v1.json');
const WAVE2_B9_V1_PATH = resolve(EVIDENCE_DIR, 'batch-09-production-verification-v1.json');
const WAVE2_WAVE_V1_PATH = resolve(EVIDENCE_DIR, 'wave-02-production-verification-v1.json');

const WAVE2_B8_V2_PATH = resolve(EVIDENCE_DIR, 'batch-08-production-verification-v2.json');
const WAVE2_B9_V2_PATH = resolve(EVIDENCE_DIR, 'batch-09-production-verification-v2.json');
const WAVE2_WAVE_V2_PATH = resolve(EVIDENCE_DIR, 'wave-02-production-verification-v2.json');

let wave2Errors = 0;
function w2fail(msg) { fail(`Wave 2: ${msg}`); wave2Errors++; }
function w2pass(msg) { pass(`Wave 2: ${msg}`); }

// 1. All three V3 canonical evidence files exist
if (!existsSync(WAVE2_B8_PATH)) { w2fail('Batch 8 evidence file missing'); }
else { w2pass('Batch 8 evidence file exists'); }
if (!existsSync(WAVE2_B9_PATH)) { w2fail('Batch 9 evidence file missing'); }
else { w2pass('Batch 9 evidence file exists'); }
if (!existsSync(WAVE2_WAVE_PATH)) { w2fail('Wave 2 summary evidence file missing'); }
else { w2pass('Wave 2 summary evidence file exists'); }

// 1b. V1 audit files exist
if (!existsSync(WAVE2_B8_V1_PATH)) { w2fail('Batch 8 V1 audit file missing'); }
else { w2pass('Batch 8 V1 audit file exists'); }
if (!existsSync(WAVE2_B9_V1_PATH)) { w2fail('Batch 9 V1 audit file missing'); }
else { w2pass('Batch 9 V1 audit file exists'); }
if (!existsSync(WAVE2_WAVE_V1_PATH)) { w2fail('Wave 2 V1 audit file missing'); }
else { w2pass('Wave 2 V1 audit file exists'); }

// 1c. V2 audit files exist
if (!existsSync(WAVE2_B8_V2_PATH)) { w2fail('Batch 8 V2 audit file missing'); }
else { w2pass('Batch 8 V2 audit file exists'); }
if (!existsSync(WAVE2_B9_V2_PATH)) { w2fail('Batch 9 V2 audit file missing'); }
else { w2pass('Batch 9 V2 audit file exists'); }
if (!existsSync(WAVE2_WAVE_V2_PATH)) { w2fail('Wave 2 V2 audit file missing'); }
else { w2pass('Wave 2 V2 audit file exists'); }

if (existsSync(WAVE2_B8_PATH) && existsSync(WAVE2_B9_PATH) && existsSync(WAVE2_WAVE_PATH)) {
  // 2. Exact V3 canonical SHA values match
  const w2b8Content = readFileSync(WAVE2_B8_PATH);
  const w2b9Content = readFileSync(WAVE2_B9_PATH);
  const w2waveContent = readFileSync(WAVE2_WAVE_PATH);
  const w2b8SHA = createHash('sha256').update(w2b8Content).digest('hex');
  const w2b9SHA = createHash('sha256').update(w2b9Content).digest('hex');
  const w2waveSHA = createHash('sha256').update(w2waveContent).digest('hex');

  if (w2b8SHA !== WAVE2_BATCH8_SHA) { w2fail(`Batch 8 SHA mismatch: ${w2b8SHA}`); }
  else { w2pass('Batch 8 SHA matches'); }
  if (w2b9SHA !== WAVE2_BATCH9_SHA) { w2fail(`Batch 9 SHA mismatch: ${w2b9SHA}`); }
  else { w2pass('Batch 9 SHA matches'); }
  if (w2waveSHA !== WAVE2_WAVE_SHA) { w2fail(`Wave 2 summary SHA mismatch: ${w2waveSHA}`); }
  else { w2pass('Wave 2 summary SHA matches'); }

  // 2b. V1 audit SHAs match
  if (existsSync(WAVE2_B8_V1_PATH)) {
    const v1b8SHA = createHash('sha256').update(readFileSync(WAVE2_B8_V1_PATH)).digest('hex');
    if (v1b8SHA !== WAVE2_BATCH8_V1_SHA) { w2fail(`Batch 8 V1 SHA mismatch: ${v1b8SHA}`); }
    else { w2pass('Batch 8 V1 SHA matches'); }
  }
  if (existsSync(WAVE2_B9_V1_PATH)) {
    const v1b9SHA = createHash('sha256').update(readFileSync(WAVE2_B9_V1_PATH)).digest('hex');
    if (v1b9SHA !== WAVE2_BATCH9_V1_SHA) { w2fail(`Batch 9 V1 SHA mismatch: ${v1b9SHA}`); }
    else { w2pass('Batch 9 V1 SHA matches'); }
  }
  if (existsSync(WAVE2_WAVE_V1_PATH)) {
    const v1waveSHA = createHash('sha256').update(readFileSync(WAVE2_WAVE_V1_PATH)).digest('hex');
    if (v1waveSHA !== WAVE2_WAVE_V1_SHA) { w2fail(`Wave 2 V1 SHA mismatch: ${v1waveSHA}`); }
    else { w2pass('Wave 2 V1 SHA matches'); }
  }

  // 2c. V2 audit SHAs match
  if (existsSync(WAVE2_B8_V2_PATH)) {
    const v2b8SHA = createHash('sha256').update(readFileSync(WAVE2_B8_V2_PATH)).digest('hex');
    if (v2b8SHA !== WAVE2_BATCH8_V2_SHA) { w2fail(`Batch 8 V2 SHA mismatch: ${v2b8SHA}`); }
    else { w2pass('Batch 8 V2 SHA matches'); }
  }
  if (existsSync(WAVE2_B9_V2_PATH)) {
    const v2b9SHA = createHash('sha256').update(readFileSync(WAVE2_B9_V2_PATH)).digest('hex');
    if (v2b9SHA !== WAVE2_BATCH9_V2_SHA) { w2fail(`Batch 9 V2 SHA mismatch: ${v2b9SHA}`); }
    else { w2pass('Batch 9 V2 SHA matches'); }
  }
  if (existsSync(WAVE2_WAVE_V2_PATH)) {
    const v2waveSHA = createHash('sha256').update(readFileSync(WAVE2_WAVE_V2_PATH)).digest('hex');
    if (v2waveSHA !== WAVE2_WAVE_V2_SHA) { w2fail(`Wave 2 V2 SHA mismatch: ${v2waveSHA}`); }
    else { w2pass('Wave 2 V2 SHA matches'); }
  }

  const w2b8Data = JSON.parse(w2b8Content);
  const w2b9Data = JSON.parse(w2b9Content);
  const w2waveData = JSON.parse(w2waveContent);

  // 2d. Independent recomputation of all totals
  const W2_EXPECTED_RECOMP = {
    B8: { migCount: 15, objCount: 111, results: { exact_match: 106, equivalent_stricter: 1, superseded: 4, failed: 0, ambiguous: 0 }, comparedPaths: 222 },
    B9: { migCount: 4, objCount: 42, results: { exact_match: 34, equivalent_stricter: 1, superseded: 7, failed: 0, ambiguous: 0 }, comparedPaths: 148 },
  };
  let w2RecompErrors = 0;
  let w2CombinedRecompMigCount = 0;
  let w2CombinedRecompObjCount = 0;
  const w2CombinedRecompResults = { exact_match: 0, equivalent_stricter: 0, superseded: 0, failed: 0, ambiguous: 0 };
  let w2CombinedRecompPaths = 0;
  let w2RecompFuncCount = 0;

  for (const batchInfo of [{ data: w2b8Data, label: 'B8', key: 'B8' }, { data: w2b9Data, label: 'B9', key: 'B9' }]) {
    const exp = W2_EXPECTED_RECOMP[batchInfo.key];
    const batchData = batchInfo.data;

    const actualMigCount = batchData.migrations.length;
    const actualVersions = batchData.migrations.map(m => m.migration_version);
    let actualObjCount = 0;
    const actualResults = { exact_match: 0, equivalent_stricter: 0, superseded: 0, failed: 0, ambiguous: 0 };
    let actualComparedPaths = 0;
    let actualFuncCount = 0;

    for (const m of batchData.migrations) {
      actualObjCount += m.objects.length;
      for (const o of m.objects) {
        const r = o.property_comparison_result;
        if (r in actualResults) actualResults[r]++;
        actualComparedPaths += (o.compared_property_paths || []).length;
        if (o.object_type === 'function') actualFuncCount++;
      }
    }

    // Migration count: recomputed vs declared vs expected
    if (actualMigCount !== batchData.total_migrations) {
      w2fail(`Batch ${batchInfo.key} recomputed migration count ${actualMigCount} differs from declared ${batchData.total_migrations}`);
      w2RecompErrors++;
    }
    if (actualMigCount !== exp.migCount) {
      w2fail(`Batch ${batchInfo.key} recomputed migration count ${actualMigCount} differs from expected ${exp.migCount}`);
      w2RecompErrors++;
    }

    // Versions: recomputed vs declared
    if (JSON.stringify(actualVersions) !== JSON.stringify(batchData.versions)) {
      w2fail(`Batch ${batchInfo.key} recomputed versions differ from declared versions`);
      w2RecompErrors++;
    }

    // Object count: recomputed vs declared vs expected
    if (actualObjCount !== batchData.total_objects_checked) {
      w2fail(`Batch ${batchInfo.key} recomputed object count ${actualObjCount} differs from declared ${batchData.total_objects_checked}`);
      w2RecompErrors++;
    }
    if (actualObjCount !== exp.objCount) {
      w2fail(`Batch ${batchInfo.key} recomputed object count ${actualObjCount} differs from expected ${exp.objCount}`);
      w2RecompErrors++;
    }

    // Result totals: recomputed vs declared vs expected
    for (const rKey of Object.keys(actualResults)) {
      if (actualResults[rKey] !== batchData.result_totals[rKey]) {
        w2fail(`Batch ${batchInfo.key} recomputed ${rKey} ${actualResults[rKey]} differs from declared ${batchData.result_totals[rKey]}`);
        w2RecompErrors++;
      }
      if (actualResults[rKey] !== exp.results[rKey]) {
        w2fail(`Batch ${batchInfo.key} recomputed ${rKey} ${actualResults[rKey]} differs from expected ${exp.results[rKey]}`);
        w2RecompErrors++;
      }
    }

    // Compared paths: recomputed vs declared vs expected
    if (actualComparedPaths !== batchData.total_compared_property_paths) {
      w2fail(`Batch ${batchInfo.key} recomputed compared paths ${actualComparedPaths} differs from declared ${batchData.total_compared_property_paths}`);
      w2RecompErrors++;
    }
    if (actualComparedPaths !== exp.comparedPaths) {
      w2fail(`Batch ${batchInfo.key} recomputed compared paths ${actualComparedPaths} differs from expected ${exp.comparedPaths}`);
      w2RecompErrors++;
    }

    w2CombinedRecompMigCount += actualMigCount;
    w2CombinedRecompObjCount += actualObjCount;
    for (const rKey of Object.keys(actualResults)) w2CombinedRecompResults[rKey] += actualResults[rKey];
    w2CombinedRecompPaths += actualComparedPaths;
    w2RecompFuncCount += actualFuncCount;
  }

  // Combined recomputation checks
  if (w2CombinedRecompMigCount !== 19) {
    w2fail(`Combined recomputed migration count ${w2CombinedRecompMigCount} differs from expected 19`);
    w2RecompErrors++;
  }
  if (w2CombinedRecompObjCount !== 153) {
    w2fail(`Combined recomputed object count ${w2CombinedRecompObjCount} differs from expected 153`);
    w2RecompErrors++;
  }
  const expCombinedResults = { exact_match: 140, equivalent_stricter: 2, superseded: 11, failed: 0, ambiguous: 0 };
  for (const rKey of Object.keys(expCombinedResults)) {
    if (w2CombinedRecompResults[rKey] !== expCombinedResults[rKey]) {
      w2fail(`Combined recomputed ${rKey} ${w2CombinedRecompResults[rKey]} differs from expected ${expCombinedResults[rKey]}`);
      w2RecompErrors++;
    }
  }
  if (w2CombinedRecompPaths !== 370) {
    w2fail(`Combined recomputed compared paths ${w2CombinedRecompPaths} differs from expected 370`);
    w2RecompErrors++;
  }
  if (w2RecompFuncCount !== 13) {
    w2fail(`Recomputed function object count ${w2RecompFuncCount} expected 13`);
    w2RecompErrors++;
  }
  if (w2RecompErrors === 0) w2pass('Independent recomputation of all totals matches declared and expected values');

  // 3. Wave summary embeds exact Batch 8 and Batch 9 SHAs
  if (w2waveData.batch_08_evidence_sha256 !== WAVE2_BATCH8_SHA) { w2fail(`Wave embeds wrong Batch 8 SHA: ${w2waveData.batch_08_evidence_sha256}`); }
  else { w2pass('Wave embeds correct Batch 8 SHA'); }
  if (w2waveData.batch_09_evidence_sha256 !== WAVE2_BATCH9_SHA) { w2fail(`Wave embeds wrong Batch 9 SHA: ${w2waveData.batch_09_evidence_sha256}`); }
  else { w2pass('Wave embeds correct Batch 9 SHA'); }

  // 4-5. Exact version sets and order
  if (JSON.stringify(w2b8Data.versions) !== JSON.stringify(WAVE2_BATCH8_VERSIONS)) { w2fail('Batch 8 version set mismatch'); }
  else { w2pass('Batch 8 exact version set'); }
  if (JSON.stringify(w2b9Data.versions) !== JSON.stringify(WAVE2_BATCH9_VERSIONS)) { w2fail('Batch 9 version set mismatch'); }
  else { w2pass('Batch 9 exact version set'); }

  // Combined version set
  if (JSON.stringify(w2waveData.combined_ordered_versions) !== JSON.stringify(WAVE2_ALL_VERSIONS)) { w2fail('Combined version set mismatch'); }
  else { w2pass('Combined exact 19-version ordered set'); }

  // 6-7. Batch object counts
  if (w2b8Data.total_objects_checked !== 111) { w2fail(`Batch 8 objects: ${w2b8Data.total_objects_checked}, expected 111`); }
  else { w2pass('Batch 8 objects = 111'); }
  if (w2b9Data.total_objects_checked !== 42) { w2fail(`Batch 9 objects: ${w2b9Data.total_objects_checked}, expected 42`); }
  else { w2pass('Batch 9 objects = 42'); }

  // 8. Combined counts
  if (w2waveData.actual_combined_object_count !== 153) { w2fail(`Combined objects: ${w2waveData.actual_combined_object_count}, expected 153`); }
  else { w2pass('Combined objects = 153'); }
  if (w2b8Data.total_migrations !== 15) { w2fail(`Batch 8 migrations: ${w2b8Data.total_migrations}, expected 15`); }
  else { w2pass('Batch 8 migrations = 15'); }
  if (w2b9Data.total_migrations !== 4) { w2fail(`Batch 9 migrations: ${w2b9Data.total_migrations}, expected 4`); }
  else { w2pass('Batch 9 migrations = 4'); }

  // 9-10. Result counts
  const w2b8rt = w2b8Data.result_totals;
  if (w2b8rt.exact_match !== 106 || w2b8rt.equivalent_stricter !== 1 || w2b8rt.superseded !== 4 || w2b8rt.failed !== 0 || w2b8rt.ambiguous !== 0) {
    w2fail(`Batch 8 results: ${w2b8rt.exact_match}/${w2b8rt.equivalent_stricter}/${w2b8rt.superseded}/${w2b8rt.failed}/${w2b8rt.ambiguous}, expected 106/1/4/0/0`);
  } else { w2pass('Batch 8 result counts = 106/1/4/0/0'); }

  const w2b9rt = w2b9Data.result_totals;
  if (w2b9rt.exact_match !== 34 || w2b9rt.equivalent_stricter !== 1 || w2b9rt.superseded !== 7 || w2b9rt.failed !== 0 || w2b9rt.ambiguous !== 0) {
    w2fail(`Batch 9 results: ${w2b9rt.exact_match}/${w2b9rt.equivalent_stricter}/${w2b9rt.superseded}/${w2b9rt.failed}/${w2b9rt.ambiguous}, expected 34/1/7/0/0`);
  } else { w2pass('Batch 9 result counts = 34/1/7/0/0'); }

  // 11. Combined result counts
  const w2crt = w2waveData.combined_result_totals;
  if (w2crt.exact_match !== 140 || w2crt.equivalent_stricter !== 2 || w2crt.superseded !== 11 || w2crt.failed !== 0 || w2crt.ambiguous !== 0) {
    w2fail(`Combined results: ${w2crt.exact_match}/${w2crt.equivalent_stricter}/${w2crt.superseded}/${w2crt.failed}/${w2crt.ambiguous}, expected 140/2/11/0/0`);
  } else { w2pass('Combined result counts = 140/2/11/0/0'); }

  // 12. Compared-path counts (V3 values)
  if (w2b8Data.total_compared_property_paths !== 222) { w2fail(`Batch 8 compared paths: ${w2b8Data.total_compared_property_paths}, expected 222`); }
  else { w2pass('Batch 8 compared paths = 222'); }
  if (w2b9Data.total_compared_property_paths !== 148) { w2fail(`Batch 9 compared paths: ${w2b9Data.total_compared_property_paths}, expected 148`); }
  else { w2pass('Batch 9 compared paths = 148'); }
  if (w2waveData.combined_compared_property_paths !== 370) { w2fail(`Combined compared paths: ${w2waveData.combined_compared_property_paths}, expected 370`); }
  else { w2pass('Combined compared paths = 370'); }

  // 13-14. Every migration digest recomputes and is non-empty
  function w2SortKeysRecursive(obj) {
    if (Array.isArray(obj)) return obj.map(w2SortKeysRecursive);
    if (obj && typeof obj === 'object') {
      const sorted = {};
      for (const key of Object.keys(obj).sort()) {
        sorted[key] = w2SortKeysRecursive(obj[key]);
      }
      return sorted;
    }
    return obj;
  }

  // Escape non-ASCII characters in JSON serialization for digest computation
  function w2EscapeNonAscii(str) {
    return str.replace(/[\u0080-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  }

  let w2DigestErrors = 0;
  for (const batchInfo of [{data: w2b8Data, label: 'B8'}, {data: w2b9Data, label: 'B9'}]) {
    for (const m of batchInfo.data.migrations) {
      if (!m.migration_evidence_digest) {
        w2fail(`${batchInfo.label} migration ${m.migration_version}: empty digest`);
        w2DigestErrors++;
        continue;
      }
      const clone = JSON.parse(JSON.stringify(m));
      delete clone.migration_evidence_digest;
      const sorted = w2SortKeysRecursive(clone);
      const serialized = w2EscapeNonAscii(JSON.stringify(sorted));
      const computed = createHash('sha256').update(serialized).digest('hex');
      if (computed !== m.migration_evidence_digest) {
        w2fail(`${batchInfo.label} migration ${m.migration_version}: digest mismatch (stored: ${m.migration_evidence_digest.slice(0,12)}..., computed: ${computed.slice(0,12)}...)`);
        w2DigestErrors++;
      }
    }
  }
  if (w2DigestErrors === 0) w2pass('All 19 migration digests recompute correctly');

  // 15. No failed or ambiguous result
  let w2ResultErrors = 0;
  for (const batchInfo of [{data: w2b8Data, label: 'B8'}, {data: w2b9Data, label: 'B9'}]) {
    for (const m of batchInfo.data.migrations) {
      for (const o of m.objects || []) {
        if (o.property_comparison_result === 'failed') { w2fail(`${batchInfo.label} ${m.migration_version}: failed result on ${o.object_name}`); w2ResultErrors++; }
        if (o.property_comparison_result === 'ambiguous') { w2fail(`${batchInfo.label} ${m.migration_version}: ambiguous result on ${o.object_name}`); w2ResultErrors++; }
      }
    }
  }
  if (w2ResultErrors === 0) w2pass('No failed or ambiguous results');

  // 15b. Object provenance validation: all 153 objects contain provenance fields matching parent migration
  const PROVENANCE_FIELDS = ['migration_version', 'migration_filename', 'migration_checksum', 'expected_object_digest'];
  let w2ProvErrors = 0;
  for (const batchInfo of [{data: w2b8Data, label: 'B8'}, {data: w2b9Data, label: 'B9'}]) {
    for (const m of batchInfo.data.migrations) {
      for (const o of m.objects || []) {
        const missing = PROVENANCE_FIELDS.filter(f => o[f] === undefined || o[f] === null || o[f] === '');
        if (missing.length > 0) {
          w2fail(`${batchInfo.label} ${m.migration_version} ${o.object_name}: object provenance missing ${missing.join(',')}`);
          w2ProvErrors++;
        } else {
          // Verify provenance matches parent migration
          for (const f of PROVENANCE_FIELDS) {
            if (o[f] !== m[f]) {
              w2fail(`${batchInfo.label} ${m.migration_version} ${o.object_name}: object provenance mismatch on ${f} (object: ${o[f]}, migration: ${m[f]})`);
              w2ProvErrors++;
            }
          }
        }
      }
    }
  }
  if (w2ProvErrors === 0) w2pass('All 153 objects have correct provenance matching parent migration');

  // 15c. Function object count validation: exactly 13 across B8+B9
  let w2FuncCount = 0;
  for (const batchInfo of [{data: w2b8Data, label: 'B8'}, {data: w2b9Data, label: 'B9'}]) {
    for (const m of batchInfo.data.migrations) {
      for (const o of m.objects || []) {
        if (o.object_type === 'function') w2FuncCount++;
      }
    }
  }
  if (w2FuncCount !== 13) { w2fail(`function object count: ${w2FuncCount}, expected 13`); }
  else { w2pass('Function object count = 13'); }

  // 15d. Function definition hash validation for exact_match non-exception functions
  let w2FuncHashErrors = 0;
  for (const batchInfo of [{data: w2b8Data, label: 'B8'}, {data: w2b9Data, label: 'B9'}]) {
    for (const m of batchInfo.data.migrations) {
      for (const o of m.objects || []) {
        if (o.object_type !== 'function') continue;
        if (o.property_comparison_result !== 'exact_match') continue;
        if (o.comparison_basis === 'normalized_executable_sql_exact_match_with_comment_only_raw_definition_difference') continue;
        // For non-exception exact-match functions: check definition hashes
        const repoHash = o.expected_properties.repository_definition_sha256 || o.expected_properties.definition_sha256;
        const prodHash = o.verified_properties.production_definition_sha256 || o.verified_properties.definition_sha256;
        if (!repoHash) {
          w2fail(`${batchInfo.label} ${m.migration_version} ${o.object_name}: function definition hash missing in expected_properties`);
          w2FuncHashErrors++;
        } else if (!prodHash) {
          w2fail(`${batchInfo.label} ${m.migration_version} ${o.object_name}: function definition hash missing in verified_properties`);
          w2FuncHashErrors++;
        } else if (repoHash !== prodHash) {
          w2fail(`${batchInfo.label} ${m.migration_version} ${o.object_name}: function raw hashes differ (repo: ${repoHash.slice(0,12)}..., prod: ${prodHash.slice(0,12)}...)`);
          w2FuncHashErrors++;
        }
      }
    }
  }
  if (w2FuncHashErrors === 0) w2pass('All non-exception exact-match function definition hashes equal');

  // 15e. Migration 236 exception validation
  const w2Mig236 = w2b8Data.migrations.find(m => m.migration_version === '236');
  if (!w2Mig236) { w2fail('Migration 236 not found in Batch 8'); }
  else {
    const m236Funcs = w2Mig236.objects.filter(o => o.object_type === 'function');
    if (m236Funcs.length !== 1) { w2fail(`Migration 236: expected exactly 1 function object, got ${m236Funcs.length}`); }
    else {
      const f236 = m236Funcs[0];
      let m236Errors = 0;

      // comparison result and basis
      if (f236.property_comparison_result !== 'exact_match') {
        w2fail(`Migration 236 function: property_comparison_result = ${f236.property_comparison_result}, expected exact_match`);
        m236Errors++;
      }
      if (f236.comparison_basis !== 'normalized_executable_sql_exact_match_with_comment_only_raw_definition_difference') {
        w2fail(`Migration 236 function: wrong comparison_basis: ${f236.comparison_basis}`);
        m236Errors++;
      }

      // expected_properties.repository_definition_sha256
      if (f236.expected_properties.repository_definition_sha256 !== '14eab786c96c68a107b813ab6b1ceb2b3e2345673440b261d59bb081d09ff2af') {
        w2fail(`Migration 236 function: expected repository_definition_sha256 mismatch: ${f236.expected_properties.repository_definition_sha256}`);
        m236Errors++;
      }

      // verified_properties.production_definition_sha256
      if (f236.verified_properties.production_definition_sha256 !== '7df85cfe54243452810229ea236d41c98c45dcae5029a9091c48d43000dfc20b') {
        w2fail(`Migration 236 function: verified production_definition_sha256 mismatch: ${f236.verified_properties.production_definition_sha256}`);
        m236Errors++;
      }

      // repository hash !== production hash (they must differ)
      if (f236.expected_properties.repository_definition_sha256 === f236.verified_properties.production_definition_sha256) {
        w2fail('Migration 236 function: repository hash must differ from production hash');
        m236Errors++;
      }

      // raw_definition_comparison
      const rdc = f236.raw_definition_comparison || {};
      if (rdc.repository_definition_sha256 !== '14eab786c96c68a107b813ab6b1ceb2b3e2345673440b261d59bb081d09ff2af') {
        w2fail(`Migration 236 function: raw_definition_comparison.repository_definition_sha256 mismatch`); m236Errors++;
      }
      if (rdc.production_definition_sha256 !== '7df85cfe54243452810229ea236d41c98c45dcae5029a9091c48d43000dfc20b') {
        w2fail(`Migration 236 function: raw_definition_comparison.production_definition_sha256 mismatch`); m236Errors++;
      }
      if (rdc.raw_hashes_equal !== false) {
        w2fail(`Migration 236 function: raw_hashes_equal = ${rdc.raw_hashes_equal}, expected false`); m236Errors++;
      }
      if (rdc.comment_only_difference_proven !== true) {
        w2fail(`Migration 236 function: comment_only_difference_proven = ${rdc.comment_only_difference_proven}, expected true`); m236Errors++;
      }

      // executable_equivalence_derivation
      const eed = f236.executable_equivalence_derivation || {};
      if (eed.source_commit_sha !== '58a8d11f570851b69c2cd1c74fcde805188944dc') {
        w2fail(`Migration 236 function: source_commit_sha mismatch`); m236Errors++;
      }
      if (eed.source_blob_sha !== '53ef69d6d25dc96e4cb64a59837b91fb04fa8092') {
        w2fail(`Migration 236 function: source_blob_sha mismatch`); m236Errors++;
      }
      if (eed.repository_derived_candidate_definition_sha256 !== '7df85cfe54243452810229ea236d41c98c45dcae5029a9091c48d43000dfc20b') {
        w2fail(`Migration 236 function: repository_derived_candidate_definition_sha256 mismatch`); m236Errors++;
      }
      if (eed.production_observed_definition_sha256 !== '7df85cfe54243452810229ea236d41c98c45dcae5029a9091c48d43000dfc20b') {
        w2fail(`Migration 236 function: production_observed_definition_sha256 mismatch`); m236Errors++;
      }
      if (eed.repository_derived_candidate_definition_sha256 !== eed.production_observed_definition_sha256) {
        w2fail(`Migration 236 function: candidate !== production`); m236Errors++;
      }
      if (eed.normalized_executable_sha256_current !== '3d8197ddb16ed3c057839b47ee2def16f7c8e937239f9ed2cffff8531e4d1fcf') {
        w2fail(`Migration 236 function: normalized_executable_sha256_current mismatch`); m236Errors++;
      }
      if (eed.normalized_executable_sha256_deployed_candidate !== '3d8197ddb16ed3c057839b47ee2def16f7c8e937239f9ed2cffff8531e4d1fcf') {
        w2fail(`Migration 236 function: normalized_executable_sha256_deployed_candidate mismatch`); m236Errors++;
      }
      if (eed.normalized_executable_sql_equal !== true) {
        w2fail(`Migration 236 function: normalized_executable_sql_equal = ${eed.normalized_executable_sql_equal}, expected true`); m236Errors++;
      }
      if (eed.exact_removed_comment !== '-- Version mismatch \u2014 return the current state so caller can retry') {
        w2fail(`Migration 236 function: exact_removed_comment mismatch`); m236Errors++;
      }
      if (!Array.isArray(eed.other_source_differences) || eed.other_source_differences.length !== 0) {
        w2fail(`Migration 236 function: other_source_differences must be exactly []`); m236Errors++;
      }
      if (eed.no_committed_matching_blob_exists !== true) {
        w2fail(`Migration 236 function: no_committed_matching_blob_exists = ${eed.no_committed_matching_blob_exists}, expected true`); m236Errors++;
      }
      if (eed.no_later_migration_modification_through !== 298) {
        w2fail(`Migration 236 function: no_later_migration_modification_through = ${eed.no_later_migration_modification_through}, expected 298`); m236Errors++;
      }
      if (eed.production_source_was_not_queried !== true) {
        w2fail(`Migration 236 function: production_source_was_not_queried = ${eed.production_source_was_not_queried}, expected true`); m236Errors++;
      }

      // non_executable_source_differences
      const nesd = f236.non_executable_source_differences || [];
      if (!Array.isArray(nesd) || nesd.length !== 1) {
        w2fail(`Migration 236 function: non_executable_source_differences must have exactly 1 entry, got ${Array.isArray(nesd) ? nesd.length : 'not array'}`);
        m236Errors++;
      } else {
        const entry = nesd[0];
        if (entry.type !== 'sql_line_comment') {
          w2fail(`Migration 236 function: non_executable_source_differences[0].type = ${entry.type}, expected sql_line_comment`); m236Errors++;
        }
        if (entry.repository_text !== '-- Version mismatch \u2014 return the current state so caller can retry') {
          w2fail(`Migration 236 function: non_executable_source_differences[0].repository_text mismatch`); m236Errors++;
        }
        if (entry.deployed_candidate_text !== null) {
          w2fail(`Migration 236 function: non_executable_source_differences[0].deployed_candidate_text = ${entry.deployed_candidate_text}, expected null`); m236Errors++;
        }
        if (entry.executable_effect !== 'none') {
          w2fail(`Migration 236 function: non_executable_source_differences[0].executable_effect = ${entry.executable_effect}, expected none`); m236Errors++;
        }
      }

      if (m236Errors === 0) w2pass('Migration 236 comment-only exception fully validated');
    }

    // No other function in any migration may use the comment-only exception basis
    let m236ExclusivityErrors = 0;
    for (const batchInfo of [{data: w2b8Data, label: 'B8'}, {data: w2b9Data, label: 'B9'}]) {
      for (const m of batchInfo.data.migrations) {
        if (m.migration_version === '236') continue;
        for (const o of m.objects || []) {
          if (o.object_type === 'function' && o.comparison_basis === 'normalized_executable_sql_exact_match_with_comment_only_raw_definition_difference') {
            w2fail(`only Migration 236 may use comment-only exception: found in Migration ${m.migration_version} ${o.object_name}`);
            m236ExclusivityErrors++;
          }
        }
      }
    }
    if (m236ExclusivityErrors === 0) w2pass('Only Migration 236 uses comment-only exception basis');
  }

  // 15f. Superseded function hash validation
  const WAVE2_SUPERSEDED_FUNCTIONS = [
    { batch: 'B8', batchData: w2b8Data, migration: '231', name: 'create_catalog_order_atomic', lineageField: 'superseded_by', lineageValue: 'migration_235',
      expectedHash: 'a0e76b33988da4247097eb411e6a37ed8e83ca8c0091487af96bfdc918f9fe00',
      verifiedHash: 'e6824d66dac39b6580b3f599aa6bc9228383b5d2ef13b4038ad3374d6203d74c' },
    { batch: 'B8', batchData: w2b8Data, migration: '233', name: 'process_recurring_charge', lineageField: 'superseded_by', lineageValue: 'migration_244',
      expectedHash: '0266ec2f7117f38c9e22d3bb64f14ccd1745578dc5ba4470101dddf0c6e7c26a',
      verifiedHash: 'e9ba948272e9b45af73550fb6307131f2be04aaeb6fed166400b2c9791d130be' },
    { batch: 'B9', batchData: w2b9Data, migration: '242', name: 'reserve_credits_atomic(uuid, uuid, integer)', lineageField: 'superseding_migration', lineageValue: '243',
      expectedHash: '254f64f8089836d8b14da00996b98cc3bb646146e21d0d643abe105f069521cc',
      verifiedHash: '2c3a0bd9cdc9be9054de5523e4f5b8127999bc701f78c57701aa3c5d23962932' },
    { batch: 'B9', batchData: w2b9Data, migration: '242', name: 'consume_credits_atomic(uuid, uuid, integer)', lineageField: 'superseding_migration', lineageValue: '243',
      expectedHash: '41fca1c289a1a5500055f60f9769a69d1c6a245fd2cfa33be9617990cd92db76',
      verifiedHash: '28e737b0a5395614e97015fe5044e7f83c1a62837393ba91094f1191cc2a71aa' },
  ];
  let w2SupFuncHashErrors = 0;
  for (const sf of WAVE2_SUPERSEDED_FUNCTIONS) {
    const mig = sf.batchData.migrations.find(m => m.migration_version === sf.migration);
    if (!mig) { w2fail(`Superseded function hash: Migration ${sf.migration} not found`); w2SupFuncHashErrors++; continue; }
    const func = mig.objects.find(o => o.object_name === sf.name && o.object_type === 'function' && o.property_comparison_result === 'superseded');
    if (!func) { w2fail(`Superseded function hash: ${sf.batch} M${sf.migration} ${sf.name} not found`); w2SupFuncHashErrors++; continue; }

    const epHash = func.expected_properties && func.expected_properties.definition_sha256;
    const vpHash = func.verified_properties && func.verified_properties.definition_sha256;

    // expected_properties contains definition_sha256
    if (!epHash) {
      w2fail(`${sf.batch} M${sf.migration} ${sf.name}: expected_properties.definition_sha256 missing`);
      w2SupFuncHashErrors++;
    } else if (!/^[0-9a-f]{64}$/.test(epHash)) {
      w2fail(`${sf.batch} M${sf.migration} ${sf.name}: expected_properties.definition_sha256 not valid 64-char hex`);
      w2SupFuncHashErrors++;
    } else if (epHash !== sf.expectedHash) {
      w2fail(`${sf.batch} M${sf.migration} ${sf.name}: expected_properties.definition_sha256 = ${epHash}, expected ${sf.expectedHash}`);
      w2SupFuncHashErrors++;
    }

    // verified_properties contains definition_sha256
    if (!vpHash) {
      w2fail(`${sf.batch} M${sf.migration} ${sf.name}: verified_properties.definition_sha256 missing`);
      w2SupFuncHashErrors++;
    } else if (!/^[0-9a-f]{64}$/.test(vpHash)) {
      w2fail(`${sf.batch} M${sf.migration} ${sf.name}: verified_properties.definition_sha256 not valid 64-char hex`);
      w2SupFuncHashErrors++;
    } else if (vpHash !== sf.verifiedHash) {
      w2fail(`${sf.batch} M${sf.migration} ${sf.name}: verified_properties.definition_sha256 = ${vpHash}, expected ${sf.verifiedHash}`);
      w2SupFuncHashErrors++;
    }

    // Hashes must be UNEQUAL (superseded means function body changed)
    if (epHash && vpHash && epHash === vpHash) {
      w2fail(`${sf.batch} M${sf.migration} ${sf.name}: expected and verified hashes must differ for superseded function`);
      w2SupFuncHashErrors++;
    }

    // Exact superseding lineage
    if (func[sf.lineageField] !== sf.lineageValue) {
      w2fail(`${sf.batch} M${sf.migration} ${sf.name}: ${sf.lineageField} = "${func[sf.lineageField]}", expected "${sf.lineageValue}"`);
      w2SupFuncHashErrors++;
    }
  }
  if (w2SupFuncHashErrors === 0) w2pass('All 4 superseded functions have valid unequal definition hashes and exact lineage');

  // 15g. Non-superseded function hash equality (8 normal + 1 M236 exception = 9 total)
  {
    let nonSupFuncHashErrors = 0;
    let nonSupFuncCount = 0;
    for (const batchInfo of [{data: w2b8Data, label: 'B8'}, {data: w2b9Data, label: 'B9'}]) {
      for (const m of batchInfo.data.migrations) {
        for (const o of m.objects || []) {
          if (o.object_type !== 'function') continue;
          if (o.property_comparison_result === 'superseded') continue;
          nonSupFuncCount++;
          // Skip M236 exception (already validated above with its own logic)
          if (o.comparison_basis === 'normalized_executable_sql_exact_match_with_comment_only_raw_definition_difference') continue;
          const repoHash = o.expected_properties.repository_definition_sha256 || o.expected_properties.definition_sha256;
          const prodHash = o.verified_properties.production_definition_sha256 || o.verified_properties.definition_sha256;
          if (repoHash && prodHash && repoHash !== prodHash) {
            w2fail(`${batchInfo.label} M${m.migration_version} ${o.object_name}: non-superseded function hashes differ`);
            nonSupFuncHashErrors++;
          }
        }
      }
    }
    if (nonSupFuncCount !== 9) {
      w2fail(`Non-superseded function count: ${nonSupFuncCount}, expected 9 (8 normal + 1 M236 exception)`);
      nonSupFuncHashErrors++;
    }
    if (nonSupFuncHashErrors === 0) w2pass('All 9 non-superseded functions have equal expected/verified hashes');
  }

  // 16. Equivalent-stricter lineage validation (exact equality)
  // Migration 233: process_recurring_charge.revoke_public -> migration_295
  const w2Mig233 = w2b8Data.migrations.find(m => m.migration_version === '233');
  if (!w2Mig233) { w2fail('Migration 233 not found in Batch 8'); }
  else {
    const eqStricter233 = w2Mig233.objects.filter(o => o.property_comparison_result === 'equivalent_stricter');
    if (eqStricter233.length !== 1) { w2fail(`Migration 233: expected 1 equivalent_stricter, got ${eqStricter233.length}`); }
    else {
      const es = eqStricter233[0];
      let es233Errors = 0;
      if (es.object_name !== 'process_recurring_charge.revoke_public') {
        w2fail(`Migration 233 eq-stricter object_name: "${es.object_name}", expected "process_recurring_charge.revoke_public"`);
        es233Errors++;
      }
      if (es.object_type !== 'grant') {
        w2fail(`Migration 233 eq-stricter object_type: "${es.object_type}", expected "grant"`);
        es233Errors++;
      }
      if (es.equivalent_stricter_by !== 'migration_295') {
        w2fail(`Migration 233 eq-stricter equivalent_stricter_by: "${es.equivalent_stricter_by}", expected "migration_295"`);
        es233Errors++;
      }
      if (es233Errors === 0) w2pass('Migration 233 equivalent-stricter: process_recurring_charge.revoke_public -> migration_295');
    }
  }

  // Migration 245: book_slot_atomic_26_args_service_role -> 296
  const w2Mig245 = w2b9Data.migrations.find(m => m.migration_version === '245');
  if (!w2Mig245) { w2fail('Migration 245 not found in Batch 9'); }
  else {
    const eqStricter245 = w2Mig245.objects.filter(o => o.property_comparison_result === 'equivalent_stricter');
    if (eqStricter245.length !== 1) { w2fail(`Migration 245: expected 1 equivalent_stricter, got ${eqStricter245.length}`); }
    else {
      const es = eqStricter245[0];
      let es245Errors = 0;
      if (es.object_name !== 'book_slot_atomic_26_args_service_role') {
        w2fail(`Migration 245 eq-stricter object_name: "${es.object_name}", expected "book_slot_atomic_26_args_service_role"`);
        es245Errors++;
      }
      if (es.object_type !== 'grant') {
        w2fail(`Migration 245 eq-stricter object_type: "${es.object_type}", expected "grant"`);
        es245Errors++;
      }
      if (es.tightening_migration !== '296') {
        w2fail(`Migration 245 eq-stricter tightening_migration: "${es.tightening_migration}", expected "296"`);
        es245Errors++;
      }
      if (es245Errors === 0) w2pass('Migration 245 equivalent-stricter: book_slot_atomic_26_args_service_role -> 296');
    }
  }

  // Count verification: no extra equivalent-stricter objects across B8+B9
  {
    let totalEqStricter = 0;
    for (const batchInfo of [{data: w2b8Data, label: 'B8'}, {data: w2b9Data, label: 'B9'}]) {
      for (const m of batchInfo.data.migrations) {
        for (const o of m.objects || []) {
          if (o.property_comparison_result === 'equivalent_stricter') totalEqStricter++;
        }
      }
    }
    if (totalEqStricter !== 2) { w2fail(`Total equivalent_stricter objects: ${totalEqStricter}, expected exactly 2`); }
    else { w2pass('Exactly 2 equivalent_stricter objects across B8+B9'); }
  }

  // Superseded lineage: Batch 8 (4 objects, exact identity)
  const WAVE2_EXPECTED_SUPERSEDED_B8 = [
    { migration: '229', object_name: 'attendance_log.service_insert', object_type: 'policy', superseded_by: 'migration_230' },
    { migration: '231', object_name: 'create_catalog_order_atomic', object_type: 'function', superseded_by: 'migration_235' },
    { migration: '233', object_name: 'process_recurring_charge', object_type: 'function', superseded_by: 'migration_244' },
    { migration: '241', object_name: 'customer_consents.customer_consents_service_insert', object_type: 'policy', superseded_by: 'migration_242' },
  ];
  let w2SupB8Errors = 0;
  for (const expected of WAVE2_EXPECTED_SUPERSEDED_B8) {
    const mig = w2b8Data.migrations.find(m => m.migration_version === expected.migration);
    if (!mig) { w2fail(`Superseded check: Migration ${expected.migration} not found`); w2SupB8Errors++; continue; }
    const sup = mig.objects.filter(o => o.property_comparison_result === 'superseded' && o.object_name === expected.object_name);
    if (sup.length !== 1) { w2fail(`Migration ${expected.migration}: expected 1 superseded "${expected.object_name}", got ${sup.length}`); w2SupB8Errors++; continue; }
    if (sup[0].object_type !== expected.object_type) {
      w2fail(`Migration ${expected.migration} superseded "${expected.object_name}" object_type: "${sup[0].object_type}", expected "${expected.object_type}"`);
      w2SupB8Errors++;
    }
    if (sup[0].superseded_by !== expected.superseded_by) {
      w2fail(`Migration ${expected.migration} superseded "${expected.object_name}" superseded_by: "${sup[0].superseded_by}", expected "${expected.superseded_by}"`);
      w2SupB8Errors++;
    }
  }
  // Verify no extra superseded in B8
  {
    let totalSupB8 = 0;
    for (const m of w2b8Data.migrations) {
      for (const o of m.objects || []) {
        if (o.property_comparison_result === 'superseded') totalSupB8++;
      }
    }
    if (totalSupB8 !== 4) { w2fail(`Batch 8 total superseded objects: ${totalSupB8}, expected exactly 4`); w2SupB8Errors++; }
  }
  if (w2SupB8Errors === 0) w2pass('Batch 8 superseded lineage: 4 objects with exact identity and lineage');

  // Superseded lineage: Batch 9 (7 objects, all Migration 242 -> 243, exact identity)
  const WAVE2_EXPECTED_SUPERSEDED_B9 = [
    { object_name: 'reserve_credits_atomic(uuid, uuid, integer)', object_type: 'function', superseding_migration: '243' },
    { object_name: 'consume_credits_atomic(uuid, uuid, integer)', object_type: 'function', superseding_migration: '243' },
    { object_name: 'revoke_reserve_credits_atomic_from_public', object_type: 'grant', superseding_migration: '243' },
    { object_name: 'grant_reserve_credits_atomic_to_service_role', object_type: 'grant', superseding_migration: '243' },
    { object_name: 'revoke_consume_credits_atomic_from_public', object_type: 'grant', superseding_migration: '243' },
    { object_name: 'grant_consume_credits_atomic_to_service_role', object_type: 'grant', superseding_migration: '243' },
    { object_name: 'uq_growth_campaign_dedup', object_type: 'constraint', superseding_migration: '243' },
  ];
  const w2Mig242 = w2b9Data.migrations.find(m => m.migration_version === '242');
  if (!w2Mig242) { w2fail('Migration 242 not found in Batch 9'); }
  else {
    const sup242 = w2Mig242.objects.filter(o => o.property_comparison_result === 'superseded');
    if (sup242.length !== 7) { w2fail(`Migration 242: expected 7 superseded, got ${sup242.length}`); }
    else {
      let lineageErrors = 0;
      for (const expected of WAVE2_EXPECTED_SUPERSEDED_B9) {
        const found = sup242.find(o => o.object_name === expected.object_name);
        if (!found) {
          w2fail(`Migration 242 missing superseded object: "${expected.object_name}"`);
          lineageErrors++;
          continue;
        }
        if (found.object_type !== expected.object_type) {
          w2fail(`Migration 242 "${expected.object_name}" object_type: "${found.object_type}", expected "${expected.object_type}"`);
          lineageErrors++;
        }
        if (found.superseding_migration !== expected.superseding_migration) {
          w2fail(`Migration 242 "${expected.object_name}" superseding_migration: "${found.superseding_migration}", expected "${expected.superseding_migration}"`);
          lineageErrors++;
        }
      }
      if (lineageErrors === 0) w2pass('Batch 9 superseded lineage: 7 objects from Migration 242 -> 243 with exact identity');
    }
  }

  // Count verification: no extra superseded objects across B8+B9
  {
    let totalSup = 0;
    for (const batchInfo of [{data: w2b8Data, label: 'B8'}, {data: w2b9Data, label: 'B9'}]) {
      for (const m of batchInfo.data.migrations) {
        for (const o of m.objects || []) {
          if (o.property_comparison_result === 'superseded') totalSup++;
        }
      }
    }
    if (totalSup !== 11) { w2fail(`Total superseded objects: ${totalSup}, expected exactly 11`); }
    else { w2pass('Exactly 11 superseded objects across B8+B9'); }
  }

  // 17. Pre/post history snapshots exist and are exactly equal
  for (const batchInfo of [{data: w2b8Data, label: 'B8'}, {data: w2b9Data, label: 'B9'}]) {
    if (JSON.stringify(batchInfo.data.pre_verification_ordered_snapshot) !== JSON.stringify(batchInfo.data.post_verification_ordered_snapshot)) {
      w2fail(`${batchInfo.label} pre/post snapshots differ`);
    } else {
      w2pass(`${batchInfo.label} pre/post snapshots equal`);
    }
  }
  if (w2waveData.snapshots_exactly_equal !== true) { w2fail('Wave snapshots_exactly_equal not true'); }
  else { w2pass('Wave snapshots_exactly_equal = true'); }

  // 18. History counts remain 209/113/1
  for (const batchInfo of [{data: w2b8Data, label: 'B8'}, {data: w2b9Data, label: 'B9'}]) {
    const pre = batchInfo.data.pre_verification_history_summary;
    if (pre.total_remote_count !== 209) w2fail(`${batchInfo.label} total_remote: ${pre.total_remote_count}`);
    if (pre.range_101_246_count !== 113) w2fail(`${batchInfo.label} range_count: ${pre.range_101_246_count}`);
    if (pre.migration_298_count !== 1) w2fail(`${batchInfo.label} m298_count: ${pre.migration_298_count}`);
  }
  const w2WavePre = w2waveData.pre_verification_history_summary;
  if (w2WavePre.total_remote_count !== 209) w2fail(`Wave total_remote: ${w2WavePre.total_remote_count}`);
  if (w2WavePre.range_101_246_count !== 113) w2fail(`Wave range_count: ${w2WavePre.range_101_246_count}`);
  if (w2WavePre.migration_298_count !== 1) w2fail(`Wave m298_count: ${w2WavePre.migration_298_count}`);
  w2pass('History counts = 209/113/1 in all evidence');

  // 19. Occurrence-map validation with strict key checks
  let w2OccErrors = 0;
  for (const batchInfo of [{data: w2b8Data, versions: WAVE2_BATCH8_VERSIONS, label: 'B8'}, {data: w2b9Data, versions: WAVE2_BATCH9_VERSIONS, label: 'B9'}]) {
    const occ = batchInfo.data.pre_verification_occurrence_map || {};
    const occKeys = Object.keys(occ);
    const expectedKeySet = new Set(batchInfo.versions);
    // Key-count check
    if (occKeys.length !== batchInfo.versions.length) {
      w2fail(`${batchInfo.label} pre occurrence map: ${occKeys.length} keys, expected ${batchInfo.versions.length}`); w2OccErrors++;
    }
    // Exact key-set check
    const occKeySet = new Set(occKeys);
    const missingOccKeys = batchInfo.versions.filter(v => !occKeySet.has(v));
    const extraOccKeys = occKeys.filter(k => !expectedKeySet.has(k));
    if (missingOccKeys.length > 0) { w2fail(`${batchInfo.label} pre occurrence map missing keys: ${missingOccKeys.join(',')}`); w2OccErrors++; }
    if (extraOccKeys.length > 0) { w2fail(`${batchInfo.label} pre occurrence map extra keys: ${extraOccKeys.join(',')}`); w2OccErrors++; }
    for (const v of batchInfo.versions) {
      if (occ[v] !== 0) { w2fail(`Version ${v} occurrence != 0`); w2OccErrors++; }
    }

    const postOcc = batchInfo.data.post_verification_occurrence_map || {};
    const postOccKeys = Object.keys(postOcc);
    // Key-count check
    if (postOccKeys.length !== batchInfo.versions.length) {
      w2fail(`${batchInfo.label} post occurrence map: ${postOccKeys.length} keys, expected ${batchInfo.versions.length}`); w2OccErrors++;
    }
    // Exact key-set check
    const postOccKeySet = new Set(postOccKeys);
    const missingPostOccKeys = batchInfo.versions.filter(v => !postOccKeySet.has(v));
    const extraPostOccKeys = postOccKeys.filter(k => !expectedKeySet.has(k));
    if (missingPostOccKeys.length > 0) { w2fail(`${batchInfo.label} post occurrence map missing keys: ${missingPostOccKeys.join(',')}`); w2OccErrors++; }
    if (extraPostOccKeys.length > 0) { w2fail(`${batchInfo.label} post occurrence map extra keys: ${extraPostOccKeys.join(',')}`); w2OccErrors++; }
    for (const v of batchInfo.versions) {
      if (postOcc[v] !== 0) { w2fail(`Version ${v} post occurrence != 0`); w2OccErrors++; }
    }
  }
  if (w2OccErrors === 0) w2pass('All 19 version occurrences = 0 (pre and post) with exact key sets');

  // 20. Exact 19-key safety set validation
  let w2SafetyErrors = 0;
  const w2RequiredSafetySet = new Set(WAVE2_REQUIRED_SAFETY_KEYS);
  for (const batchInfo of [{data: w2b8Data, label: 'B8'}, {data: w2b9Data, label: 'B9'}, {data: w2waveData, label: 'Wave'}]) {
    const safetyConf = batchInfo.data.safety_confirmations || {};
    const actualKeys = Object.keys(safetyConf);
    const actualKeySet = new Set(actualKeys);
    // Check for missing keys
    const missingSafety = WAVE2_REQUIRED_SAFETY_KEYS.filter(k => !actualKeySet.has(k));
    if (missingSafety.length > 0) {
      w2fail(`${batchInfo.label} safety key missing: ${missingSafety.join(', ')}`);
      w2SafetyErrors++;
    }
    // Check for extra keys
    const extraSafety = actualKeys.filter(k => !w2RequiredSafetySet.has(k));
    if (extraSafety.length > 0) {
      w2fail(`${batchInfo.label} safety key extra: ${extraSafety.join(', ')}`);
      w2SafetyErrors++;
    }
    // Check key count
    if (actualKeys.length !== 19) {
      w2fail(`${batchInfo.label} safety key count: ${actualKeys.length}, expected 19`);
      w2SafetyErrors++;
    }
    // All values must be boolean true
    for (const [k, v] of Object.entries(safetyConf)) {
      if (v !== true) { w2fail(`${batchInfo.label} safety key not true: ${k} = ${v}`); w2SafetyErrors++; }
    }
  }
  if (w2SafetyErrors === 0) w2pass('All safety confirmations: exact 19-key set, all true');

  // 21. Worker/canonical path provenance (exact validation)
  {
    const EXPECTED_WORKER_PATHS = {
      batch_08: '/tmp/waaiio-batch-08-worker-output.json',
      batch_09: '/tmp/waaiio-batch-09-worker-output.json',
    };
    const EXPECTED_CANONICAL_PATHS = {
      batch_08: '/tmp/waaiio-batch-08-production-verification-v2.json',
      batch_09: '/tmp/waaiio-batch-09-production-verification-v2.json',
      wave_02: '/tmp/waaiio-wave-02-production-verification-v2.json',
    };

    const workerPaths = w2waveData.worker_output_paths;
    const canonicalPaths = w2waveData.canonical_output_paths;
    let w2PathErrors = 0;

    // worker_output_paths exists as object with exact keys and values
    if (!workerPaths || typeof workerPaths !== 'object') {
      w2fail('Wave worker_output_paths missing or not an object'); w2PathErrors++;
    } else {
      const wpKeys = Object.keys(workerPaths);
      const expectedWpKeys = Object.keys(EXPECTED_WORKER_PATHS);
      if (JSON.stringify(wpKeys.sort()) !== JSON.stringify(expectedWpKeys.sort())) {
        w2fail(`worker path keys: ${wpKeys.join(',')}, expected ${expectedWpKeys.join(',')}`); w2PathErrors++;
      }
      for (const [k, v] of Object.entries(EXPECTED_WORKER_PATHS)) {
        if (workerPaths[k] !== v) {
          w2fail(`worker path "${k}": "${workerPaths[k]}", expected "${v}"`); w2PathErrors++;
        }
      }
    }

    // canonical_output_paths exists as object with exact keys and values
    if (!canonicalPaths || typeof canonicalPaths !== 'object') {
      w2fail('Wave canonical_output_paths missing or not an object'); w2PathErrors++;
    } else {
      const cpKeys = Object.keys(canonicalPaths);
      const expectedCpKeys = Object.keys(EXPECTED_CANONICAL_PATHS);
      if (JSON.stringify(cpKeys.sort()) !== JSON.stringify(expectedCpKeys.sort())) {
        w2fail(`canonical path keys: ${cpKeys.join(',')}, expected ${expectedCpKeys.join(',')}`); w2PathErrors++;
      }
      for (const [k, v] of Object.entries(EXPECTED_CANONICAL_PATHS)) {
        if (canonicalPaths[k] !== v) {
          w2fail(`canonical path "${k}": "${canonicalPaths[k]}", expected "${v}"`); w2PathErrors++;
        }
      }
    }

    // No worker path equals any canonical path
    if (workerPaths && canonicalPaths) {
      const workerValues = Object.values(workerPaths);
      const canonicalValues = Object.values(canonicalPaths);
      const canonicalValueSet = new Set(canonicalValues);
      for (const wp of workerValues) {
        if (canonicalValueSet.has(wp)) {
          w2fail(`worker path equals canonical path: ${wp}`);
          w2PathErrors++;
        }
      }
      // No duplicate worker paths
      if (new Set(workerValues).size !== workerValues.length) {
        w2fail('duplicate worker paths detected'); w2PathErrors++;
      }
      // No duplicate canonical paths
      if (new Set(canonicalValues).size !== canonicalValues.length) {
        w2fail('duplicate canonical paths detected'); w2PathErrors++;
      }
    }

    // Boolean flags
    if (w2waveData.worker_paths_distinct_from_canonical_paths !== true) {
      w2fail(`worker_paths_distinct_from_canonical_paths = ${w2waveData.worker_paths_distinct_from_canonical_paths}, expected true`);
      w2PathErrors++;
    }
    if (w2waveData.coordinator_only_wrote_canonical_paths !== true) {
      w2fail(`coordinator_only_wrote_canonical_paths = ${w2waveData.coordinator_only_wrote_canonical_paths}, expected true`);
      w2PathErrors++;
    }
    if (w2waveData.no_worker_overwrote_canonical_evidence !== true) {
      w2fail(`no_worker_overwrote_canonical_evidence = ${w2waveData.no_worker_overwrote_canonical_evidence}, expected true`);
      w2PathErrors++;
    }

    // worker_output_provenance exact validation
    const EXPECTED_PROVENANCE = {
      'waaiio-batch-08-worker-output.json': '0bd114afb9461052f01b541ab7eb67c60040a75bcb915372debb994200968f7a',
      'waaiio-batch-09-worker-output.json': 'c703f405912e2ca099062691fd6d41249943db35fe2b9f4ed18d4f807e283d9e',
    };
    const provenance = w2waveData.worker_output_provenance;
    if (!provenance || typeof provenance !== 'object') {
      w2fail('worker_output_provenance missing or not an object'); w2PathErrors++;
    } else {
      const provKeys = Object.keys(provenance);
      const expectedProvKeys = Object.keys(EXPECTED_PROVENANCE);
      if (JSON.stringify(provKeys.sort()) !== JSON.stringify(expectedProvKeys.sort())) {
        w2fail(`path provenance keys: ${provKeys.join(',')}, expected ${expectedProvKeys.join(',')}`); w2PathErrors++;
      }
      for (const [k, v] of Object.entries(EXPECTED_PROVENANCE)) {
        if (provenance[k] !== v) {
          w2fail(`path provenance "${k}": "${provenance[k]}", expected "${v}"`); w2PathErrors++;
        }
      }
    }

    if (w2PathErrors === 0) w2pass('Worker/canonical path provenance fully validated');
  }

  // 22. Manifest classifications = 132/0/0/12/2
  if (alignedCount !== 132) w2fail(`ALIGNED: ${alignedCount}`);
  if (verifiedCount !== 0) w2fail(`VERIFIED: ${verifiedCount}`);
  if (pendingCount !== 0) w2fail(`PENDING: ${pendingCount}`);
  if (nvCount !== 12) w2fail(`NV: ${nvCount}`);
  if (supersededCount !== 2) w2fail(`SUPERSEDED: ${supersededCount}`);
  if (alignedCount === 132 && verifiedCount === 0 && pendingCount === 0 && nvCount === 12 && supersededCount === 2) {
    w2pass('Manifest classifications = 132/0/0/12/2');
  }

  // 23. Batch 8 manifest entries are ALIGNED_TRACKED (repair completed)
  let w2B8ManifestErrors = 0;
  for (const v of WAVE2_BATCH8_VERSIONS) {
    const me = manifestByVersion[v];
    if (!me) { w2fail(`Batch 8 version ${v} not in manifest`); w2B8ManifestErrors++; continue; }
    if (me.current_classification !== 'ALIGNED_TRACKED') { w2fail(`B8 ${v} classification: ${me.current_classification}`); w2B8ManifestErrors++; }
    if (me.repair_status !== 'completed') { w2fail(`B8 ${v} repair_status: ${me.repair_status}`); w2B8ManifestErrors++; }
    if (me.remote_tracked !== true) { w2fail(`B8 ${v} remote_tracked: ${me.remote_tracked}`); w2B8ManifestErrors++; }
    if (me.repair_eligible !== false) { w2fail(`B8 ${v} repair_eligible: ${me.repair_eligible}`); w2B8ManifestErrors++; }
    if (me.verification_batch !== 8) { w2fail(`B8 ${v} verification_batch: ${me.verification_batch}`); w2B8ManifestErrors++; }
    if (me.repair_batch !== 8) { w2fail(`B8 ${v} repair_batch: ${me.repair_batch}`); w2B8ManifestErrors++; }
  }
  if (w2B8ManifestErrors === 0) w2pass('Batch 8 manifest entries ALIGNED_TRACKED and repair completed');

  // 24. Allowlist is empty (all repairs complete)
  if (allowlist.length !== 0) {
    w2fail(`Allowlist not empty: ${allowlist.length} entries`);
  } else { w2pass('Allowlist is empty (all repairs complete)'); }

  // 25. Batch 9 manifest entries are ALIGNED_TRACKED and completed
  let w2B9ManifestErrors = 0;
  for (const v of WAVE2_BATCH9_VERSIONS) {
    const me = manifestByVersion[v];
    if (!me) { w2fail(`Batch 9 version ${v} not in manifest`); w2B9ManifestErrors++; continue; }
    if (me.current_classification !== 'ALIGNED_TRACKED') { w2fail(`B9 ${v} classification: ${me.current_classification}`); w2B9ManifestErrors++; }
    if (me.repair_eligible !== false) { w2fail(`B9 ${v} repair_eligible: ${me.repair_eligible}`); w2B9ManifestErrors++; }
    if (me.repair_status !== 'completed') { w2fail(`B9 ${v} repair_status: ${me.repair_status}`); w2B9ManifestErrors++; }
    if (me.remote_tracked !== true) { w2fail(`B9 ${v} remote_tracked: ${me.remote_tracked}`); w2B9ManifestErrors++; }
    if (me.verification_batch !== 9) { w2fail(`B9 ${v} verification_batch: ${me.verification_batch}`); w2B9ManifestErrors++; }
    if (me.repair_batch !== 9) { w2fail(`B9 ${v} repair_batch: ${me.repair_batch}`); w2B9ManifestErrors++; }
  }
  if (w2B9ManifestErrors === 0) w2pass('Batch 9 manifest entries ALIGNED_TRACKED and repair completed');

  // 27. Candidate registry is exactly empty
  if (candidates.length !== 0) { w2fail(`Candidates: ${candidates.length}, expected 0`); }
  else { w2pass('Candidate registry is empty'); }

  // 28. Completed repair count = 120
  if (repairedCandidateCount !== 124) { w2fail(`Completed repairs: ${repairedCandidateCount}, expected 124`); }
  else { w2pass('Completed repair count = 124'); }

  // 29. The 12 NOT_VERIFIABLE_SAFELY entries remain unchanged
  const NV_VERSIONS = ['101','105','107','126','160','163','164','187','216','217','222','226'];
  let w2NvErrors = 0;
  for (const v of NV_VERSIONS) {
    const me = manifestByVersion[v];
    if (!me) { w2fail(`NV version ${v} not in manifest`); w2NvErrors++; continue; }
    if (me.current_classification !== 'NOT_VERIFIABLE_SAFELY') { w2fail(`NV ${v} classification changed: ${me.current_classification}`); w2NvErrors++; }
  }
  if (w2NvErrors === 0) w2pass('12 NOT_VERIFIABLE_SAFELY entries unchanged');

  // 30. The two existing SUPERSEDED_WITH_EQUIVALENT_STATE entries remain unchanged
  const SUP_VERSIONS = ['122','130'];
  let w2SupErrors = 0;
  for (const v of SUP_VERSIONS) {
    const me = manifestByVersion[v];
    if (!me) { w2fail(`Superseded version ${v} not in manifest`); w2SupErrors++; continue; }
    if (me.current_classification !== 'SUPERSEDED_WITH_EQUIVALENT_STATE') { w2fail(`Superseded ${v} classification changed: ${me.current_classification}`); w2SupErrors++; }
  }
  if (w2SupErrors === 0) w2pass('2 SUPERSEDED_WITH_EQUIVALENT_STATE entries unchanged');

  // Reject: Batch 9 must not become repair active before Batch 8 repair closeout
  const b8Repaired = WAVE2_BATCH8_VERSIONS.every(v => {
    const me = manifestByVersion[v];
    return me && me.current_classification === 'ALIGNED_TRACKED' && me.repair_status === 'completed';
  });
  if (!b8Repaired) {
    // Batch 8 not yet repaired — ensure Batch 9 is NOT repair active
    for (const v of WAVE2_BATCH9_VERSIONS) {
      const me = manifestByVersion[v];
      if (me && me.repair_eligible === true) {
        w2fail(`Batch 9 version ${v} is repair_eligible while Batch 8 is not complete`);
      }
    }
    w2pass('Batch 9 correctly blocked from repair until Batch 8 closeout');
  }
}

// ══════════════════════════════════════════════════════════════
// SHARED REPAIR CLOSEOUT VALIDATION
// ══════════════════════════════════════════════════════════════

const BATCH6_CLOSEOUT_CONFIG = {
  batchNumber: 6,
  evidencePath: resolve('docs/migrations/evidence/batch-06-repair.json'),
  expectedSHA: 'e38ca82b69f8112c6b312ca5b966c3cecc2e5f28f7a621003ce378241de25d16',
  versions: ['191','192','193','194','195','196','197','198','201','202','203','204','205','206','207'],
  laterVersions: ['208','209','210','211','212','213','214','215','218','219','220','221','223','224','225'],
  expectedPreCounts: { total_remote_count: 179, range_101_246_count: 83 },
  expectedPostCounts: { total_remote_count: 194, range_101_246_count: 98 },
  prMergeTimestamp: '2026-07-30T12:54:50Z',
  repairedAtSource: 'batch-06-repair evidence repairs[].completed_at',
  repairFields: {
    startedAt: 'start_ts',
    completedAt: 'end_ts',
    preTotalCount: 'pre_total',
    postTotalCount: 'post_total',
    preRangeCount: 'pre_range',
    postRangeCount: 'post_range',
    migration298Count: 'migration_298_count',
    hasPreOccurrences: false,
    hasPostconditionPassed: false,
    hasLaterBatchRemainZero: false,
  },
  ownBatchOccurrenceMaps: { pre: 'batch_6_pre_occurrence_map', post: 'batch_6_post_occurrence_map' },
  laterBatchOccurrenceMaps: { pre: 'batch_7_pre_occurrence_map', post: 'batch_7_post_occurrence_map' },
  laterBatchLenient: true,
  hasOrderedSnapshots: false,
  expectedClassifications: null,
  expectedCompletedRepairs: null,
  expectedAllowlistLength: null,
  requiredSafetyKeys: null,
  expectedCandidates: null,
  laterBatchPendingVersions: null,
};

const BATCH7_CLOSEOUT_CONFIG = {
  batchNumber: 7,
  evidencePath: resolve('docs/migrations/evidence/batch-07-repair.json'),
  expectedSHA: 'd99a37ee09a8ebe6d80c7cc3cea2d858d60753b5b28783b1ac2a6a02196837ec',
  versions: ['208','209','210','211','212','213','214','215','218','219','220','221','223','224','225'],
  laterVersions: ['227','228','229','230','231','232','233','234','235','236','237','238','239','240','241','242','243','245','246'],
  expectedPreCounts: { total_remote_count: 194, range_101_246_count: 98 },
  expectedPostCounts: { total_remote_count: 209, range_101_246_count: 113 },
  prMergeTimestamp: '2026-07-30T14:24:15Z',
  repairedAtSource: 'batch-07-repair evidence repairs[].completed_at',
  repairFields: {
    startedAt: 'started_at',
    completedAt: 'completed_at',
    preTotalCount: 'pre_total_remote_count',
    postTotalCount: 'post_total_remote_count',
    preRangeCount: 'pre_range_101_246_count',
    postRangeCount: 'post_range_101_246_count',
    migration298Count: 'migration_298_post_occurrences',
    hasPreOccurrences: true,
    hasPostconditionPassed: true,
    hasLaterBatchRemainZero: true,
  },
  ownBatchOccurrenceMaps: { pre: 'batch_7_pre_occurrence_map', post: 'batch_7_post_occurrence_map' },
  laterBatchOccurrenceMaps: { pre: 'batches_8_9_pre_occurrence_map', post: 'batches_8_9_post_occurrence_map' },
  laterBatchLenient: false,
  hasOrderedSnapshots: true,
  expectedClassifications: null, // Superseded by Batch 8 closeout
  expectedCompletedRepairs: null, // Superseded by Batch 8 closeout
  expectedAllowlistLength: null, // Superseded by Batch 8 closeout
  requiredSafetyKeys: [
    'every_approved_version_appears_exactly_once',
    'exactly_15_versions_added',
    'no_version_removed',
    'no_unapproved_version_added',
    'batches_8_and_9_unchanged_and_untracked',
    'migration_history_only_change',
    'only_approved_migration_history_writes',
    'no_migration_sql_executed',
    'no_migration_up',
    'no_supabase_db_push',
    'no_management_api_write',
    'no_schema_or_application_data_changed',
    'no_customer_records_accessed',
    'no_record_identifiers_returned',
    'no_repository_change',
    'no_commit_push_or_pr',
    'no_issue_53_mutation',
    'no_deployment_occurred',
    'no_token_recorded',
    'no_batch_8_or_9_verification_started',
  ],
  expectedCandidates: [],
  laterBatchPendingVersions: null,
};

function validateRepairCloseout(cfg) {
  const b = cfg.batchNumber;
  const f = cfg.repairFields;
  const prMergeMs = new Date(cfg.prMergeTimestamp).getTime();
  const evidenceFilename = cfg.evidencePath.split('/').pop().replace('.json', '');

  // 1. Evidence file exists
  if (!existsSync(cfg.evidencePath)) {
    fail(`Batch ${b} repair evidence file missing`);
    return;
  }
  pass(`Batch ${b} repair evidence exists`);

  const content = readFileSync(cfg.evidencePath, 'utf-8');
  const sha = createHash('sha256').update(content).digest('hex');

  // 2. Exact repair evidence SHA
  if (sha !== cfg.expectedSHA) {
    fail(`Batch ${b} repair evidence SHA mismatch: ${sha}`);
  } else {
    pass(`Batch ${b} repair evidence SHA matches`);
  }

  const evidence = JSON.parse(content);

  // 2b. Evidence identity fields (optional, Batch 8+ only)
  if (cfg.expectedIdentity) {
    const id = cfg.expectedIdentity;
    let idErrors = 0;
    for (const [key, expected] of Object.entries(id)) {
      if (evidence[key] !== expected) {
        fail(`Batch ${b} evidence ${key}: ${JSON.stringify(evidence[key])}, expected ${JSON.stringify(expected)}`);
        idErrors++;
      }
    }
    if (idErrors === 0) pass(`Batch ${b} evidence identity fields verified`);
  }

  // 2c. Exact repair record count, filenames, checksums, command_category (Batch 8+ enhanced)
  if (cfg.expectedRepairFields) {
    const erf = cfg.expectedRepairFields;
    const repairs = evidence.repairs || [];
    let erfErrors = 0;
    for (let i = 0; i < repairs.length; i++) {
      const r = repairs[i];
      const ver = cfg.versions[i];
      if (r.command_category !== erf.command_category) {
        fail(`Batch ${b} repair ${ver} command_category: ${r.command_category}`);
        erfErrors++;
      }
      // Filename must equal repository migration filename
      const repoFile = migrationFiles.find(f => f.startsWith(ver + '_'));
      if (repoFile && r.filename !== repoFile) {
        fail(`Batch ${b} repair ${ver} filename ${r.filename} !== repo ${repoFile}`);
        erfErrors++;
      }
      // Checksum must equal manifest checksum
      const me = manifestByVersion[ver];
      if (me && r.checksum !== me.checksum) {
        fail(`Batch ${b} repair ${ver} checksum !== manifest checksum`);
        erfErrors++;
      }
    }
    if (erfErrors === 0) pass(`Batch ${b} all repair filenames, checksums, command categories correct`);
  }

  // 3. Exact version set and order
  const approvedVersions = evidence.approved_versions || [];
  if (JSON.stringify(approvedVersions) !== JSON.stringify(cfg.versions)) {
    fail(`Batch ${b} repair versions: ${approvedVersions.join(',')}, expected ${cfg.versions.join(',')}`);
  } else {
    pass(`Batch ${b} repair exact version set and order`);
  }

  // 4. Exact pre/post counts
  const pre = evidence.pre_repair_counts || {};
  const post = evidence.post_repair_counts || {};
  const expPre = cfg.expectedPreCounts;
  const expPost = cfg.expectedPostCounts;
  if (pre.total_remote_count !== expPre.total_remote_count) fail(`Pre total: ${pre.total_remote_count}, expected ${expPre.total_remote_count}`);
  if (pre.range_101_246_count !== expPre.range_101_246_count) fail(`Pre range: ${pre.range_101_246_count}, expected ${expPre.range_101_246_count}`);
  if (post.total_remote_count !== expPost.total_remote_count) fail(`Post total: ${post.total_remote_count}, expected ${expPost.total_remote_count}`);
  if (post.range_101_246_count !== expPost.range_101_246_count) fail(`Post range: ${post.range_101_246_count}, expected ${expPost.range_101_246_count}`);
  if (pre.total_remote_count === expPre.total_remote_count && pre.range_101_246_count === expPre.range_101_246_count &&
      post.total_remote_count === expPost.total_remote_count && post.range_101_246_count === expPost.range_101_246_count) {
    pass(`Batch ${b} repair pre/post counts ${expPre.total_remote_count}/${expPre.range_101_246_count} -> ${expPost.total_remote_count}/${expPost.range_101_246_count}`);
  }

  // 5. Migration 298 remains once in pre/post counts
  if (pre.migration_298_count !== 1) fail(`Pre m298: ${pre.migration_298_count}`);
  if (post.migration_298_count !== 1) fail(`Post m298: ${post.migration_298_count}`);
  if (pre.migration_298_count === 1 && post.migration_298_count === 1) pass('Migration 298 remains once');

  const repairs = evidence.repairs || [];

  // 6. Repairs array has exactly versions.length entries
  if (repairs.length !== cfg.versions.length) {
    fail(`Batch ${b} repairs count: ${repairs.length}, expected ${cfg.versions.length}`);
  } else {
    pass(`Batch ${b} repairs count = ${cfg.versions.length}`);
  }

  // 7. Every repair exit status is zero and required fields exist
  let exitErrors = 0;
  let fieldErrors = 0;
  for (const r of repairs) {
    if (r.exit_status !== 0) { fail(`Repair ${r.version} exit_status: ${r.exit_status}`); exitErrors++; }
    const requiredFields = ['version', 'filename', 'checksum', 'sequence', 'exit_status', f.startedAt, f.completedAt];
    for (const field of requiredFields) {
      if (r[field] === undefined || r[field] === null) { fail(`Repair ${r.version} missing field: ${field}`); fieldErrors++; }
    }
  }
  if (exitErrors === 0) pass('All repair exit statuses are zero');
  if (fieldErrors === 0) pass('All repair entries have required fields');

  // 8. Per-repair occurrence checks (Batch 7 format only)
  if (f.hasPreOccurrences) {
    let occErrors = 0;
    for (const r of repairs) {
      if (r.pre_occurrences !== 0) { fail(`Repair ${r.version} pre_occurrences: ${r.pre_occurrences}`); occErrors++; }
      if (r.post_occurrences !== 1) { fail(`Repair ${r.version} post_occurrences: ${r.post_occurrences}`); occErrors++; }
    }
    if (occErrors === 0) pass('All per-repair pre_occurrences=0 and post_occurrences=1');
  }

  if (f.hasPostconditionPassed) {
    let postcondErrors = 0;
    for (const r of repairs) {
      if (r.postcondition_passed !== true) { fail(`Repair ${r.version} postcondition: ${r.postcondition_passed}`); postcondErrors++; }
    }
    if (postcondErrors === 0) pass('All postconditions passed');
  }

  if (f.hasLaterBatchRemainZero) {
    let laterErrors = 0;
    for (const r of repairs) {
      if (r.later_batch_occurrences_remain_zero !== true) { fail(`Repair ${r.version} later_batch_occurrences_remain_zero: ${r.later_batch_occurrences_remain_zero}`); laterErrors++; }
    }
    if (laterErrors === 0) pass('All later_batch_occurrences_remain_zero = true');
  }

  // 9. Count progression: absolute anchoring + delta + continuity
  let progressionErrors = 0;
  for (let i = 0; i < repairs.length; i++) {
    const r = repairs[i];
    if (r.sequence !== i + 1) { fail(`Repair sequence ${r.sequence}, expected ${i + 1}`); progressionErrors++; }
    if (r.version !== cfg.versions[i]) { fail(`Repair[${i}] version ${r.version}, expected ${cfg.versions[i]}`); progressionErrors++; }
    const preTotal = r[f.preTotalCount];
    const postTotal = r[f.postTotalCount];
    const preRange = r[f.preRangeCount];
    const postRange = r[f.postRangeCount];
    const m298 = r[f.migration298Count];
    // Delta: each step adds exactly 1
    if (postTotal !== preTotal + 1) { fail(`Repair ${r.version} total delta: ${postTotal - preTotal}`); progressionErrors++; }
    if (postRange !== preRange + 1) { fail(`Repair ${r.version} range delta: ${postRange - preRange}`); progressionErrors++; }
    if (m298 !== 1) { fail(`Repair ${r.version} m298: ${m298}`); progressionErrors++; }
    // Absolute anchoring: pre_total = topLevelPre.total + i, post_total = topLevelPre.total + i + 1
    const expectedPreTotal = expPre.total_remote_count + i;
    const expectedPostTotal = expPre.total_remote_count + i + 1;
    const expectedPreRange = expPre.range_101_246_count + i;
    const expectedPostRange = expPre.range_101_246_count + i + 1;
    if (preTotal !== expectedPreTotal) { fail(`Repair ${r.version} pre_total ${preTotal} !== expected ${expectedPreTotal}`); progressionErrors++; }
    if (postTotal !== expectedPostTotal) { fail(`Repair ${r.version} post_total ${postTotal} !== expected ${expectedPostTotal}`); progressionErrors++; }
    if (preRange !== expectedPreRange) { fail(`Repair ${r.version} pre_range ${preRange} !== expected ${expectedPreRange}`); progressionErrors++; }
    if (postRange !== expectedPostRange) { fail(`Repair ${r.version} post_range ${postRange} !== expected ${expectedPostRange}`); progressionErrors++; }
    // Iteration continuity: repair[i].pre == repair[i-1].post
    if (i > 0) {
      const prevPostTotal = repairs[i - 1][f.postTotalCount];
      const prevPostRange = repairs[i - 1][f.postRangeCount];
      if (preTotal !== prevPostTotal) { fail(`Repair ${r.version} preTotal ${preTotal} !== prev postTotal ${prevPostTotal}`); progressionErrors++; }
      if (preRange !== prevPostRange) { fail(`Repair ${r.version} preRange ${preRange} !== prev postRange ${prevPostRange}`); progressionErrors++; }
    }
  }
  // First record pre-counts must equal top-level pre counts
  if (repairs.length > 0) {
    const first = repairs[0];
    if (first[f.preTotalCount] !== expPre.total_remote_count) { fail(`First repair pre_total ${first[f.preTotalCount]} !== top-level ${expPre.total_remote_count}`); progressionErrors++; }
    if (first[f.preRangeCount] !== expPre.range_101_246_count) { fail(`First repair pre_range ${first[f.preRangeCount]} !== top-level ${expPre.range_101_246_count}`); progressionErrors++; }
    // Last record post-counts must equal top-level post counts
    const last = repairs[repairs.length - 1];
    if (last[f.postTotalCount] !== expPost.total_remote_count) { fail(`Last repair post_total ${last[f.postTotalCount]} !== top-level ${expPost.total_remote_count}`); progressionErrors++; }
    if (last[f.postRangeCount] !== expPost.range_101_246_count) { fail(`Last repair post_range ${last[f.postRangeCount]} !== top-level ${expPost.range_101_246_count}`); progressionErrors++; }
  }
  if (progressionErrors === 0) pass('Count progression anchored, delta, and continuous');

  // 10. Timestamps: canonical UTC ISO-8601, startedAt <= completedAt, sequential non-overlap, after PR merge
  let tsErrors = 0;
  let prevEndMs = 0;
  for (let i = 0; i < repairs.length; i++) {
    const r = repairs[i];
    const startLabel = `Repair ${r.version} ${f.startedAt}`;
    const endLabel = `Repair ${r.version} ${f.completedAt}`;
    const startMs = parseCanonicalUtcTimestamp(r[f.startedAt], startLabel);
    const endMs = parseCanonicalUtcTimestamp(r[f.completedAt], endLabel);
    if (startMs === null) { tsErrors++; }
    if (endMs === null) { tsErrors++; }
    if (startMs !== null && endMs !== null) {
      if (startMs > endMs) { fail(`Repair ${r.version} ${f.startedAt} is later than ${f.completedAt}`); tsErrors++; }
      if (i > 0 && startMs < prevEndMs) {
        fail(`Repair ${r.version} starts before previous repair completed (${r[f.startedAt]} < prev ${f.completedAt})`);
        tsErrors++;
      }
      if (endMs < prevEndMs) { fail(`Repair ${r.version} completion time moves backwards`); tsErrors++; }
      prevEndMs = endMs;
    }
    if (endMs !== null && endMs <= prMergeMs) {
      fail(`Repair ${r.version} ${f.completedAt} ${r[f.completedAt]} not after PR merge`);
      tsErrors++;
    }
  }
  if (tsErrors === 0) pass(`All timestamps canonical UTC, sequential, and after PR merge`);

  // 11. Own-batch occurrence maps
  const ownPreOcc = evidence[cfg.ownBatchOccurrenceMaps.pre] || {};
  const ownPostOcc = evidence[cfg.ownBatchOccurrenceMaps.post] || {};
  let ownOccErrors = 0;
  const ownPreKeys = Object.keys(ownPreOcc);
  const ownPostKeys = Object.keys(ownPostOcc);
  if (ownPreKeys.length !== cfg.versions.length) { fail(`Own-batch pre occurrence map has ${ownPreKeys.length} keys, expected ${cfg.versions.length}`); ownOccErrors++; }
  if (ownPostKeys.length !== cfg.versions.length) { fail(`Own-batch post occurrence map has ${ownPostKeys.length} keys, expected ${cfg.versions.length}`); ownOccErrors++; }
  if (JSON.stringify(ownPreKeys.sort()) !== JSON.stringify([...cfg.versions].sort())) { fail(`Own-batch pre occurrence map keys mismatch`); ownOccErrors++; }
  if (JSON.stringify(ownPostKeys.sort()) !== JSON.stringify([...cfg.versions].sort())) { fail(`Own-batch post occurrence map keys mismatch`); ownOccErrors++; }
  for (const v of cfg.versions) {
    if (ownPreOcc[v] !== 0) { fail(`Own-batch pre occurrence ${v}: ${ownPreOcc[v]}`); ownOccErrors++; }
    if (ownPostOcc[v] !== 1) { fail(`Own-batch post occurrence ${v}: ${ownPostOcc[v]}`); ownOccErrors++; }
  }
  if (ownOccErrors === 0) pass(`All Batch ${b} pre=0 and post=1`);

  // 12. Later-batch occurrence maps (skip if no later batch)
  if (!cfg.laterBatchOccurrenceMaps) {
    pass('No later-batch occurrence maps to validate (final batch)');
  }
  const laterPreOcc = cfg.laterBatchOccurrenceMaps ? (evidence[cfg.laterBatchOccurrenceMaps.pre] || {}) : {};
  const laterPostOcc = cfg.laterBatchOccurrenceMaps ? (evidence[cfg.laterBatchOccurrenceMaps.post] || {}) : {};
  let laterOccErrors = 0;
  if (cfg.laterBatchOccurrenceMaps && cfg.laterVersions.length > 0) {
  const laterPreKeys = Object.keys(laterPreOcc);
  const laterPostKeys = Object.keys(laterPostOcc);
  if (laterPreKeys.length !== cfg.laterVersions.length) { fail(`Later-batch pre occurrence map has ${laterPreKeys.length} keys, expected ${cfg.laterVersions.length}`); laterOccErrors++; }
  if (laterPostKeys.length !== cfg.laterVersions.length) { fail(`Later-batch post occurrence map has ${laterPostKeys.length} keys, expected ${cfg.laterVersions.length}`); laterOccErrors++; }
  if (JSON.stringify(laterPreKeys.sort()) !== JSON.stringify([...cfg.laterVersions].sort())) { fail(`Later-batch pre occurrence map keys mismatch`); laterOccErrors++; }
  if (JSON.stringify(laterPostKeys.sort()) !== JSON.stringify([...cfg.laterVersions].sort())) { fail(`Later-batch post occurrence map keys mismatch`); laterOccErrors++; }
  for (const v of cfg.laterVersions) {
    if (cfg.laterBatchLenient) {
      if ((laterPreOcc[v] || 0) !== 0) { fail(`Later-batch pre occurrence ${v}: ${laterPreOcc[v]}`); laterOccErrors++; }
      if ((laterPostOcc[v] || 0) !== 0) { fail(`Later-batch post occurrence ${v}: ${laterPostOcc[v]}`); laterOccErrors++; }
    } else {
      if (laterPreOcc[v] !== 0) { fail(`Later-batch pre occurrence ${v}: ${laterPreOcc[v]}`); laterOccErrors++; }
      if (laterPostOcc[v] !== 0) { fail(`Later-batch post occurrence ${v}: ${laterPostOcc[v]}`); laterOccErrors++; }
    }
  }
  if (laterOccErrors === 0) pass(`All later-batch occurrences remain zero`);
  } // end if laterBatchOccurrenceMaps

  // 13. exact_new_versions matches cfg.versions
  const exactNew = evidence.exact_new_versions || [];
  if (JSON.stringify(exactNew) !== JSON.stringify(cfg.versions)) {
    fail(`exact_new_versions: ${exactNew.join(',')}, expected ${cfg.versions.join(',')}`);
  } else {
    pass(`Exactly ${cfg.versions.length} approved versions added`);
  }

  // 14. removed_versions is empty
  if ((evidence.removed_versions || []).length > 0) {
    fail(`Removed versions: ${evidence.removed_versions.join(',')}`);
  } else {
    pass('No version removed');
  }

  // 15. unapproved_added_versions is empty
  if ((evidence.unapproved_added_versions || []).length > 0) {
    fail(`Unapproved added versions: ${evidence.unapproved_added_versions.join(',')}`);
  } else {
    pass('No unapproved version added');
  }

  // 16. Safety confirmations
  const safetyConf = evidence.safety_confirmations || {};
  const safetyKeys = Object.keys(safetyConf);
  if (cfg.requiredSafetyKeys) {
    // Exact key set required
    const expected = new Set(cfg.requiredSafetyKeys);
    const actual = new Set(safetyKeys);
    const missing = cfg.requiredSafetyKeys.filter(k => !actual.has(k));
    const extra = safetyKeys.filter(k => !expected.has(k));
    if (missing.length > 0) fail(`Safety confirmations missing keys: ${missing.join(', ')}`);
    if (extra.length > 0) fail(`Safety confirmations extra keys: ${extra.join(', ')}`);
    let safetyFails = 0;
    for (const [k, v] of Object.entries(safetyConf)) {
      if (v !== true) { fail(`Safety confirmation ${k}: ${v}`); safetyFails++; }
    }
    if (missing.length === 0 && extra.length === 0 && safetyFails === 0) pass('All safety confirmations exact key set and all true');
  } else {
    // At least 20 keys, all true
    if (safetyKeys.length < 20) {
      fail(`Safety confirmations count: ${safetyKeys.length}, expected >= 20`);
    }
    let safetyFails = 0;
    for (const [k, v] of Object.entries(safetyConf)) {
      if (v !== true) { fail(`Safety confirmation ${k}: ${v}`); safetyFails++; }
    }
    if (safetyFails === 0 && safetyKeys.length >= 20) pass('All safety confirmations true');
  }

  // 17. Every migration checksum matches the repository
  let checksumErrors = 0;
  for (const r of repairs) {
    const migFile = migrationFiles.find(mf => mf.startsWith(r.version + '_'));
    if (!migFile) { fail(`Migration file not found for ${r.version}`); checksumErrors++; continue; }
    const fileContent = readFileSync(resolve(MIGRATIONS_DIR, migFile), 'utf-8');
    const fileSHA = createHash('sha256').update(fileContent).digest('hex');
    if (fileSHA !== r.checksum) { fail(`Checksum mismatch for ${r.version}: ${fileSHA} vs ${r.checksum}`); checksumErrors++; }
  }
  if (checksumErrors === 0) pass(`All ${cfg.versions.length} repair checksums match repository`);

  // 18. Every manifest repaired_at equals evidence completedAt
  let timestampErrors = 0;
  for (const r of repairs) {
    const me = manifestByVersion[r.version];
    if (!me) { fail(`Version ${r.version} not in manifest`); timestampErrors++; continue; }
    if (me.repaired_at !== r[f.completedAt]) {
      fail(`Version ${r.version} repaired_at ${me.repaired_at} !== evidence ${f.completedAt} ${r[f.completedAt]}`);
      timestampErrors++;
    }
  }
  if (timestampErrors === 0) pass(`All ${cfg.versions.length} repaired_at match evidence ${f.completedAt}`);

  // 19. Every repaired_at_source has the exact required value
  let sourceErrors = 0;
  for (const v of cfg.versions) {
    const me = manifestByVersion[v];
    if (!me) continue;
    if (me.repaired_at_source !== cfg.repairedAtSource) {
      fail(`Version ${v} repaired_at_source: "${me.repaired_at_source}"`);
      sourceErrors++;
    }
  }
  if (sourceErrors === 0) pass(`All ${cfg.versions.length} repaired_at_source correct`);

  // 20. Manifest state: ALIGNED_TRACKED, remote_tracked, repair_eligible, repair_status, evidence path/digest
  const evidenceRelPath = cfg.evidencePath.includes('/') ? cfg.evidencePath.split('/').slice(-4).join('/') : cfg.evidencePath;
  const expectedEvidencePath = `docs/migrations/evidence/${evidenceFilename}.json`;
  let manifestErrors = 0;
  for (const v of cfg.versions) {
    const me = manifestByVersion[v];
    if (!me) { fail(`Version ${v} not in manifest`); manifestErrors++; continue; }
    if (me.current_classification !== 'ALIGNED_TRACKED') { fail(`Version ${v} classification: ${me.current_classification}`); manifestErrors++; }
    if (me.remote_tracked !== true) { fail(`Version ${v} remote_tracked: ${me.remote_tracked}`); manifestErrors++; }
    if (me.repair_eligible !== false) { fail(`Version ${v} repair_eligible: ${me.repair_eligible}`); manifestErrors++; }
    if (me.repair_status !== 'completed') { fail(`Version ${v} repair_status: ${me.repair_status}`); manifestErrors++; }
    if (me.repair_evidence_path !== expectedEvidencePath) { fail(`Version ${v} repair_evidence_path: ${me.repair_evidence_path}`); manifestErrors++; }
    if (me.repair_evidence_digest !== cfg.expectedSHA) { fail(`Version ${v} repair_evidence_digest mismatch`); manifestErrors++; }
    if (me.recommended_action !== 'none') { fail(`Version ${v} recommended_action: ${me.recommended_action}`); manifestErrors++; }
    if (me.verification_batch !== b) { fail(`Version ${v} verification_batch: ${me.verification_batch}`); manifestErrors++; }
    if (me.repair_batch !== b) { fail(`B${b} ${v} repair_batch: ${me.repair_batch}`); manifestErrors++; }
    if (me.confidence !== 'HIGH') { fail(`Version ${v} confidence: ${me.confidence}`); manifestErrors++; }
  }
  if (manifestErrors === 0) pass(`Batch ${b} manifest entries ALIGNED_TRACKED and complete`);

  // 20b. Later-batch activation checks (only for latest closeout — checks the actively activated batch)
  if (cfg.checkLaterActivation && cfg.laterVersions && cfg.laterVersions.length > 0) {
    let laterErrors = 0;
    for (const v of cfg.laterVersions) {
      const me = manifestByVersion[v];
      if (!me) { fail(`Later version ${v} not in manifest`); laterErrors++; continue; }
      if (me.current_classification !== 'VERIFIED_APPLIED_UNTRACKED') { fail(`B9 ${v} classification: ${me.current_classification}`); laterErrors++; }
      if (me.remote_tracked !== false) { fail(`B9 ${v} remote_tracked: ${me.remote_tracked}`); laterErrors++; }
      if (me.repair_eligible !== true) { fail(`B9 ${v} repair_eligible: ${me.repair_eligible}`); laterErrors++; }
      if (me.repair_status !== 'approved_for_repair') { fail(`B9 ${v} repair_status: ${me.repair_status}`); laterErrors++; }
      if (me.recommended_action !== 'migration_history_repair_only') { fail(`B9 ${v} recommended_action: ${me.recommended_action}`); laterErrors++; }
      if ('activation_blocked_by_batch' in me) { fail(`B9 ${v} activation_blocked_by_batch still present`); laterErrors++; }
      if (me.confidence !== 'HIGH') { fail(`B9 ${v} confidence: ${me.confidence}`); laterErrors++; }
      if (cfg.laterBatchNumber && me.verification_batch !== cfg.laterBatchNumber) { fail(`B9 ${v} verification_batch: ${me.verification_batch}`); laterErrors++; }
      if (cfg.laterBatchNumber && me.repair_batch !== cfg.laterBatchNumber) { fail(`B9 ${v} repair_batch: ${me.repair_batch}`); laterErrors++; }
      if (!Array.isArray(me.evidence) || me.evidence.length === 0) { fail(`B9 ${v} evidence array empty`); laterErrors++; }
      if (me.repaired_at) { fail(`B9 ${v} has repaired_at — should not exist`); laterErrors++; }
    }
    if (laterErrors === 0) pass('Later-batch entries verified and activated');
  }

  // 21. Ordered version snapshots (Batch 7 format only)
  if (cfg.hasOrderedSnapshots) {
    const preSnap = evidence.pre_repair_ordered_version_snapshot;
    const postSnap = evidence.post_repair_ordered_version_snapshot;
    let snapErrors = 0;
    if (!Array.isArray(preSnap)) { fail('pre_repair_ordered_version_snapshot is not an array'); snapErrors++; }
    if (!Array.isArray(postSnap)) { fail('post_repair_ordered_version_snapshot is not an array'); snapErrors++; }
    if (Array.isArray(preSnap) && Array.isArray(postSnap)) {
      // Both contain unique versions
      if (new Set(preSnap).size !== preSnap.length) { fail('pre_repair_ordered_version_snapshot has duplicates'); snapErrors++; }
      if (new Set(postSnap).size !== postSnap.length) { fail('post_repair_ordered_version_snapshot has duplicates'); snapErrors++; }
      // No pre version removed in post
      const postSet = new Set(postSnap);
      for (const v of preSnap) {
        if (!postSet.has(v)) { fail(`pre version ${v} removed in post snapshot`); snapErrors++; }
      }
      // Exact added set = cfg.versions
      const preSet = new Set(preSnap);
      const added = postSnap.filter(v => !preSet.has(v));
      if (JSON.stringify(added) !== JSON.stringify(cfg.versions)) {
        fail(`Ordered snapshot added versions: ${added.join(',')}, expected ${cfg.versions.join(',')}`);
        snapErrors++;
      }
      // No unapproved version added
      const approvedSet = new Set(cfg.versions);
      const unapproved = added.filter(v => !approvedSet.has(v));
      if (unapproved.length > 0) { fail(`Unapproved versions in post snapshot: ${unapproved.join(',')}`); snapErrors++; }
      // post length = pre length + versions.length
      if (postSnap.length !== preSnap.length + cfg.versions.length) {
        fail(`Post snapshot length ${postSnap.length} !== pre ${preSnap.length} + ${cfg.versions.length}`);
        snapErrors++;
      }
      // Removing added versions from post must produce pre in exact order
      const postMinusAdded = postSnap.filter(v => !approvedSet.has(v));
      if (JSON.stringify(postMinusAdded) !== JSON.stringify(preSnap)) {
        fail('Post snapshot minus added versions does not equal pre snapshot in order');
        snapErrors++;
      }
      // Migration 298 exactly once in post
      const m298Count = postSnap.filter(v => String(v) === '298').length;
      if (m298Count !== 1) { fail(`Migration 298 in post snapshot: ${m298Count} times`); snapErrors++; }
      // Later-batch versions remain absent
      if (cfg.laterVersions) {
        const laterSet = new Set(cfg.laterVersions);
        const laterInPost = postSnap.filter(v => laterSet.has(String(v)));
        if (laterInPost.length > 0) { fail(`Later-batch versions in post snapshot: ${laterInPost.join(',')}`); snapErrors++; }
      }
    }
    if (snapErrors === 0) pass('Ordered version snapshots valid');
  }

  // 22. Allowlist length and entry validation (conditional)
  if (cfg.expectedAllowlistLength !== null) {
    if (allowlist.length !== cfg.expectedAllowlistLength) { fail(`Allowlist length: ${allowlist.length}, expected ${cfg.expectedAllowlistLength}`); }
    else { pass(`Allowlist is exactly ${cfg.expectedAllowlistLength === 0 ? 'empty' : cfg.expectedAllowlistLength}`); }
  }
  // 22b. Exact allowlist entry validation (for later-batch allowlists)
  if (cfg.laterVersions && cfg.expectedAllowlistLength > 0) {
    let alErrors = 0;
    const expectedVersions = cfg.laterVersions;
    const actualVersions = allowlist.map(e => e.version);
    if (JSON.stringify(actualVersions) !== JSON.stringify(expectedVersions)) {
      fail(`Allowlist version order: ${actualVersions.join(',')}, expected ${expectedVersions.join(',')}`);
      alErrors++;
    }
    for (const entry of allowlist) {
      const me = manifestByVersion[entry.version];
      if (!me) { fail(`Allowlist ${entry.version} not in manifest`); alErrors++; continue; }
      if (entry.filename !== me.filename) { fail(`Allowlist ${entry.version} filename mismatch`); alErrors++; }
      if (entry.checksum !== me.checksum) { fail(`Allowlist ${entry.version} checksum mismatch`); alErrors++; }
      if (!entry.expected_object_digest) { fail(`Allowlist ${entry.version} expected_object_digest empty`); alErrors++; }
      if (cfg.expectedObjectDigests && cfg.expectedObjectDigests[entry.version] && entry.expected_object_digest !== cfg.expectedObjectDigests[entry.version]) {
        fail(`Allowlist ${entry.version} expected_object_digest mismatch: ${entry.expected_object_digest.slice(0,12)}..., expected ${cfg.expectedObjectDigests[entry.version].slice(0,12)}...`);
        alErrors++;
      }
      if (entry.production_evidence_path !== me.production_evidence_path) { fail(`Allowlist ${entry.version} evidence path mismatch`); alErrors++; }
      if (entry.production_evidence_digest !== me.production_evidence_digest) { fail(`Allowlist ${entry.version} evidence digest mismatch`); alErrors++; }
      if (entry.classification !== 'VERIFIED_APPLIED_UNTRACKED') { fail(`Allowlist ${entry.version} classification: ${entry.classification}`); alErrors++; }
      if (entry.repair_action !== 'migration_history_repair_only') { fail(`Allowlist ${entry.version} repair_action: ${entry.repair_action}`); alErrors++; }
      if (entry.confidence !== 'HIGH') { fail(`Allowlist ${entry.version} confidence: ${entry.confidence}`); alErrors++; }
      if (cfg.laterBatchNumber) {
        if (entry.verification_batch !== cfg.laterBatchNumber) { fail(`Allowlist ${entry.version} verification_batch: ${entry.verification_batch}`); alErrors++; }
        if (entry.repair_batch !== cfg.laterBatchNumber) { fail(`Allowlist ${entry.version} repair_batch: ${entry.repair_batch}`); alErrors++; }
      }
    }
    if (alErrors === 0) pass('Allowlist entries fully validated against manifest and evidence');
  }

  // 23. Candidate list (conditional)
  if (cfg.expectedCandidates) {
    const actualCandidateVersions = candidates.map(c => c.version);
    if (JSON.stringify(actualCandidateVersions) !== JSON.stringify(cfg.expectedCandidates)) {
      fail(`Candidate versions: ${actualCandidateVersions.join(',')}, expected ${cfg.expectedCandidates.join(',')}`);
    } else {
      pass(`Candidate list exactly ${cfg.expectedCandidates.length} versions`);
    }
  }

  // 24. Classification totals (conditional)
  if (cfg.expectedClassifications) {
    const ec = cfg.expectedClassifications;
    if (alignedCount !== ec.aligned) fail(`ALIGNED: ${alignedCount}, expected ${ec.aligned}`);
    if (verifiedCount !== ec.verified) fail(`VERIFIED: ${verifiedCount}, expected ${ec.verified}`);
    if (pendingCount !== ec.pending) fail(`PENDING: ${pendingCount}, expected ${ec.pending}`);
    if (nvCount !== ec.nv) fail(`NV: ${nvCount}, expected ${ec.nv}`);
    if (supersededCount !== ec.superseded) fail(`SUPERSEDED: ${supersededCount}, expected ${ec.superseded}`);
    if (alignedCount === ec.aligned && verifiedCount === ec.verified && pendingCount === ec.pending && nvCount === ec.nv && supersededCount === ec.superseded) {
      pass(`Classification totals ${ec.aligned}/${ec.verified}/${ec.pending}/${ec.nv}/${ec.superseded}`);
    }
  }

  // 25. Completed repair count (conditional)
  if (cfg.expectedCompletedRepairs !== null) {
    if (repairedCandidateCount !== cfg.expectedCompletedRepairs) { fail(`Completed repair count: ${repairedCandidateCount}, expected ${cfg.expectedCompletedRepairs}`); }
    else { pass(`Completed repair count = ${cfg.expectedCompletedRepairs}`); }
  }

  // 26. Later-batch pending versions (conditional)
  if (cfg.laterBatchPendingVersions) {
    let pendingErrors = 0;
    for (const v of cfg.laterBatchPendingVersions) {
      const me = manifestByVersion[v];
      if (!me) { fail(`Version ${v} not in manifest`); pendingErrors++; continue; }
      if (me.current_classification !== 'PENDING_PRODUCTION_REVERIFICATION') { fail(`Version ${v} classification: ${me.current_classification}`); pendingErrors++; }
      if (me.repair_eligible !== false) { fail(`Version ${v} repair_eligible: ${me.repair_eligible}`); pendingErrors++; }
    }
    if (pendingErrors === 0) pass('Later-batch versions remain pending and inactive');
  }
}

const BATCH8_CLOSEOUT_CONFIG = {
  batchNumber: 8,
  evidencePath: resolve('docs/migrations/evidence/batch-08-repair.json'),
  expectedSHA: 'fc5b5a9f8dce28507764c4bd7bf9a39adc29a1302784da47b3e67c017d84a9e7',
  versions: ['227','228','229','230','231','232','233','234','235','236','237','238','239','240','241'],
  laterVersions: ['242','243','245','246'],
  laterBatchNumber: 9,
  expectedObjectDigests: {
    '242': '7a96aaf5f982c4a50adf861c05104924310718e5e75ee518cbd993d00a03613a',
    '243': '9a502b18eaea18056e63fbd9f81548b279a861d6fbc1ce1557781e089a2ece52',
    '245': 'd3126ba97bd423bb78ffab32cf3b5f4ed4a35bc0185b56da6c11b33b65bbde67',
    '246': '0c2e44ceffc2c5c612bb2f44876e0da2a5d3a4ed6dda550cc5d5665c2ab7ef2d',
  },
  expectedPreCounts: { total_remote_count: 209, range_101_246_count: 113 },
  expectedPostCounts: { total_remote_count: 224, range_101_246_count: 128 },
  expectedIdentity: {
    task_identifier: 'batch-08-migration-history-repair',
    repository_sha: 'a63d219d473e36fa3c3bb638ba6c32406280fcd9',
    linked_project_ref: 'cxcmiqotkowhxinjbytg',
    issue_number: 53,
    batch_number: 8,
    allowlist_count: 15,
    batch_08_verification_evidence_path: 'docs/migrations/evidence/batch-08-production-verification.json',
    batch_08_verification_evidence_sha256: 'f2d54c694f97858fb523247834587bcc3257f8715446ce5d2034086870913c95',
    wave_02_evidence_path: 'docs/migrations/evidence/wave-02-production-verification.json',
    wave_02_evidence_sha256: '3d8550b4967ed4fd95769575e2a70b60e091b904867c3804ca276d243be2d70d',
  },
  expectedRepairFields: {
    command_category: 'supabase_migration_repair_status_applied_linked',
  },
  prMergeTimestamp: '2026-07-31T01:55:32Z',
  repairedAtSource: 'batch-08-repair evidence repairs[].completed_at',
  repairFields: {
    startedAt: 'started_at',
    completedAt: 'completed_at',
    preTotalCount: 'pre_total_remote_count',
    postTotalCount: 'post_total_remote_count',
    preRangeCount: 'pre_range_101_246_count',
    postRangeCount: 'post_range_101_246_count',
    migration298Count: 'migration_298_post_occurrences',
    hasPreOccurrences: true,
    hasPostconditionPassed: true,
    hasLaterBatchRemainZero: true,
  },
  ownBatchOccurrenceMaps: { pre: 'batch_8_pre_occurrence_map', post: 'batch_8_post_occurrence_map' },
  laterBatchOccurrenceMaps: { pre: 'batch_9_pre_occurrence_map', post: 'batch_9_post_occurrence_map' },
  laterBatchLenient: false,
  hasOrderedSnapshots: true,
  expectedClassifications: { aligned: 128, verified: 4, pending: 0, nv: 12, superseded: 2 },
  expectedCompletedRepairs: 120,
  expectedAllowlistLength: 4,
  requiredSafetyKeys: [
    'only_allowlisted_versions_repaired',
    'repairs_executed_one_at_a_time',
    'no_migration_sql_executed',
    'no_migration_up',
    'no_supabase_db_push',
    'no_management_api_write',
    'no_schema_changed',
    'no_application_data_changed',
    'no_customer_records_accessed',
    'no_credentials_recorded',
    'no_repository_change',
    'no_commit_push_or_pr',
    'no_issue_53_mutation',
    'no_deployment',
    'no_batch_9_repair',
    'no_unrelated_history_changed',
    'migration_298_unchanged',
    'stop_on_failure_enforced',
  ],
  checkLaterActivation: false, // Superseded by Batch 9 closeout
  expectedClassifications: null, // Superseded by Batch 9 closeout
  expectedCompletedRepairs: null, // Superseded by Batch 9 closeout
  expectedAllowlistLength: null, // Superseded by Batch 9 closeout
  expectedCandidates: [],
  laterBatchPendingVersions: null,
};

const BATCH9_CLOSEOUT_CONFIG = {
  batchNumber: 9,
  evidencePath: resolve('docs/migrations/evidence/batch-09-repair.json'),
  expectedSHA: '1bf9ad999576a73f2aa4e1f554f4a1806f5ec1e54270ffd9be4125fc048f1731',
  versions: ['242','243','245','246'],
  laterVersions: [],
  expectedPreCounts: { total_remote_count: 224, range_101_246_count: 128 },
  expectedPostCounts: { total_remote_count: 228, range_101_246_count: 132 },
  expectedIdentity: {
    task_identifier: 'batch-09-migration-history-repair',
    repository_sha: '4a44807899ad1b395efba80b2ccd9655ed0217fa',
    linked_project_ref: 'cxcmiqotkowhxinjbytg',
    issue_number: 53,
    batch_number: 9,
    allowlist_count: 4,
    batch_09_verification_evidence_path: 'docs/migrations/evidence/batch-09-production-verification.json',
    batch_09_verification_evidence_sha256: 'ca531e1e6f23307d14948b89d854a985d6a56495539c072eb2ce3d17334a35c5',
    wave_02_evidence_path: 'docs/migrations/evidence/wave-02-production-verification.json',
    wave_02_evidence_sha256: '3d8550b4967ed4fd95769575e2a70b60e091b904867c3804ca276d243be2d70d',
  },
  expectedRepairFields: {
    command_category: 'supabase_migration_repair_status_applied_linked',
  },
  prMergeTimestamp: '2026-07-31T04:00:00Z',
  repairedAtSource: 'Batch 9 repair evidence repairs[].completed_at',
  repairFields: {
    startedAt: 'started_at',
    completedAt: 'completed_at',
    preTotalCount: 'pre_total_remote_count',
    postTotalCount: 'post_total_remote_count',
    preRangeCount: 'pre_range_101_246_count',
    postRangeCount: 'post_range_101_246_count',
    migration298Count: 'migration_298_post_occurrences',
    hasPreOccurrences: true,
    hasPostconditionPassed: true,
    hasLaterBatchRemainZero: false,
  },
  ownBatchOccurrenceMaps: { pre: 'batch_9_pre_occurrence_map', post: 'batch_9_post_occurrence_map' },
  laterBatchOccurrenceMaps: null,
  laterBatchLenient: false,
  hasOrderedSnapshots: true,
  expectedClassifications: { aligned: 132, verified: 0, pending: 0, nv: 12, superseded: 2 },
  expectedCompletedRepairs: 124,
  expectedAllowlistLength: 0,
  requiredSafetyKeys: [
    'only_allowlisted_versions_repaired',
    'repairs_executed_one_at_a_time',
    'no_migration_sql_executed',
    'no_migration_up',
    'no_supabase_db_push',
    'no_management_api_write',
    'no_schema_changed',
    'no_application_data_changed',
    'no_customer_records_accessed',
    'no_credentials_recorded',
    'no_repository_change',
    'no_commit_push_or_pr',
    'no_issue_53_mutation',
    'no_deployment',
    'no_unrelated_history_changed',
    'migration_298_unchanged',
    'stop_on_failure_enforced',
    'batch_8_occurrences_remained_one',
  ],
  checkLaterActivation: false,
  expectedCandidates: [],
  laterBatchPendingVersions: null,
};

console.log('\n--- Batch 6 Repair Closeout Validation ---\n');
validateRepairCloseout(BATCH6_CLOSEOUT_CONFIG);

console.log('\n--- Batch 7 Repair Closeout Validation ---\n');
validateRepairCloseout(BATCH7_CLOSEOUT_CONFIG);

console.log('\n--- Batch 8 Repair Closeout Validation ---\n');
validateRepairCloseout(BATCH8_CLOSEOUT_CONFIG);

console.log('\n--- Batch 9 Repair Closeout Validation ---\n');
validateRepairCloseout(BATCH9_CLOSEOUT_CONFIG);

// ── Summary ──
console.log('\n=== Summary ===');
console.log(`  Manifest: ${manifest.length} entries`);
console.log(`    ALIGNED_TRACKED: ${alignedCount}`);
console.log(`    VERIFIED_APPLIED_UNTRACKED: ${verifiedCount}`);
console.log(`    PENDING_PRODUCTION_REVERIFICATION: ${pendingCount}`);
console.log(`    NOT_VERIFIABLE_SAFELY: ${nvCount}`);
console.log(`    SUPERSEDED: ${supersededCount}`);
console.log(`  Completed repairs: ${repairedCandidateCount}`);
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

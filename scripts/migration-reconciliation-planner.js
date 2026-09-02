#!/usr/bin/env node
const { readFileSync, readdirSync, existsSync } = require('fs');
const { resolve } = require('path');
const { createHash } = require('crypto');

const MIGRATIONS_DIR = resolve(__dirname, '../supabase/migrations');
const INTENTIONALLY_ABSENT = new Set([358]);
const DEFAULT_PENDING_ALLOWLIST = [356, 357, 359, 360, 361, 362, 363];

const ReconciliationState = {
  READY: 'READY',
  REPAIR_REQUIRED: 'REPAIR_REQUIRED',
  BLOCKED: 'BLOCKED',
};

function extractVersion(f) {
  const m = f.match(/^(\d+)_.*\.sql$/);
  return m ? parseInt(m[1], 10) : null;
}

function readLocalMigrations(dir) {
  dir = dir || MIGRATIONS_DIR;
  const files = readdirSync(dir).filter(f => f.endsWith('.sql'));
  const migs = [];
  const seen = new Set();
  const dupes = [];
  for (const f of files) {
    const v = extractVersion(f);
    if (v !== null) {
      if (seen.has(v)) dupes.push(v);
      seen.add(v);
      migs.push({ version: v, filename: f });
    }
  }
  return { migrations: migs.sort((a, b) => a.version - b.version), duplicates: dupes };
}

function classifyRemoteVersions(versions) {
  const numeric = [];
  const timestamped = [];
  const unknown = [];
  const seen = new Set();
  const duplicates = [];
  const numericSeen = new Map(); // parsed int -> first raw string
  for (const v of versions) {
    const s = String(v);
    const isRawDupe = seen.has(s);
    if (isRawDupe) duplicates.push(s);
    seen.add(s);
    if (/^\d{12,}$/.test(s)) timestamped.push(s);
    else if (/^\d{1,4}$/.test(s)) {
      const parsed = parseInt(s, 10);
      if (!isRawDupe && numericSeen.has(parsed)) {
        // Normalized duplicate: e.g. '354' and '0354' both parse to 354
        // (raw string duplicates are already caught above)
        duplicates.push(s + ' (normalized duplicate of ' + numericSeen.get(parsed) + ')');
      }
      if (!numericSeen.has(parsed)) {
        numericSeen.set(parsed, s);
      }
      numeric.push(parsed);
    }
    else unknown.push(s);
  }
  return { numeric: numeric.sort((a, b) => a - b), timestamped, unknown, duplicates };
}

/**
 * Validate schema evidence strictly.
 * Returns { valid: true, present: Set, absent: Set } or { valid: false, reason: string }
 */
function validateSchemaEvidence(evidence, scopeVersions) {
  if (evidence === null || evidence === undefined) {
    return { valid: false, reason: 'Schema evidence is missing (null/undefined).' };
  }
  if (typeof evidence !== 'object' || Array.isArray(evidence)) {
    return { valid: false, reason: 'Schema evidence must be a non-array object.' };
  }
  if (Object.keys(evidence).length === 0) {
    return { valid: false, reason: 'Schema evidence is empty ({}).' };
  }
  if (!('presentMigrations' in evidence) || !('absentMigrations' in evidence)) {
    return { valid: false, reason: 'Schema evidence must contain both presentMigrations and absentMigrations.' };
  }
  if (!Array.isArray(evidence.presentMigrations)) {
    return { valid: false, reason: 'presentMigrations must be an array.' };
  }
  if (!Array.isArray(evidence.absentMigrations)) {
    return { valid: false, reason: 'absentMigrations must be an array.' };
  }
  // All entries must be numbers
  for (const v of evidence.presentMigrations) {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
      return { valid: false, reason: 'presentMigrations contains non-integer or invalid value: ' + JSON.stringify(v) + '.' };
    }
  }
  for (const v of evidence.absentMigrations) {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
      return { valid: false, reason: 'absentMigrations contains non-integer or invalid value: ' + JSON.stringify(v) + '.' };
    }
  }
  // Check for duplicates within each array
  const presentSet = new Set();
  for (const v of evidence.presentMigrations) {
    if (presentSet.has(v)) return { valid: false, reason: 'Duplicate in presentMigrations: ' + v + '.' };
    presentSet.add(v);
  }
  const absentSet = new Set();
  for (const v of evidence.absentMigrations) {
    if (absentSet.has(v)) return { valid: false, reason: 'Duplicate in absentMigrations: ' + v + '.' };
    absentSet.add(v);
  }
  // No overlap
  for (const v of presentSet) {
    if (absentSet.has(v)) {
      return { valid: false, reason: 'Migration ' + v + ' appears in both presentMigrations and absentMigrations.' };
    }
  }
  // Every scope version must be classified
  for (const v of scopeVersions) {
    if (!presentSet.has(v) && !absentSet.has(v)) {
      return { valid: false, reason: 'Migration ' + v + ' is in reconciliation scope but not classified in evidence.' };
    }
  }
  return { valid: true, present: presentSet, absent: absentSet };
}

/**
 * Validate timestamp mapping file content.
 * Returns { valid: true, mappings: Map<timestamp, mapping> } or { valid: false, reason: string }
 */
function validateTimestampMappings(mappingData, localMigrations, intentionallyAbsent, migrationsDir) {
  if (!mappingData || typeof mappingData !== 'object') {
    return { valid: false, reason: 'Mapping data must be an object.' };
  }
  if (!Array.isArray(mappingData.mappings)) {
    return { valid: false, reason: 'Mapping data must have a "mappings" array.' };
  }

  const localByVersion = new Map();
  for (const m of localMigrations) {
    localByVersion.set(m.version, m);
  }

  const result = new Map();

  for (const entry of mappingData.mappings) {
    // Required fields
    if (!entry.remoteVersion || !entry.remoteName || entry.repoVersion === undefined || !entry.localFilename) {
      return { valid: false, reason: 'Mapping entry missing required fields (remoteVersion, remoteName, repoVersion, localFilename).' };
    }
    if (typeof entry.repoVersion !== 'number' || !Number.isInteger(entry.repoVersion) || entry.repoVersion < 1) {
      return { valid: false, reason: 'Mapping repoVersion must be a positive integer.' };
    }
    if (!/^\d{12,}$/.test(String(entry.remoteVersion))) {
      return { valid: false, reason: 'Mapping remoteVersion "' + entry.remoteVersion + '" is not a valid timestamp format.' };
    }

    // Must map to a local migration
    const localMig = localByVersion.get(entry.repoVersion);
    if (!localMig) {
      return { valid: false, reason: 'Mapping repoVersion ' + entry.repoVersion + ' has no local migration file.' };
    }

    // Must not map to intentionally absent
    if (intentionallyAbsent.has(entry.repoVersion)) {
      return { valid: false, reason: 'Mapping repoVersion ' + entry.repoVersion + ' is intentionally absent — cannot map to it.' };
    }

    // Filename must match local
    if (entry.localFilename !== localMig.filename) {
      return { valid: false, reason: 'Mapping localFilename "' + entry.localFilename + '" does not match actual local filename "' + localMig.filename + '" for version ' + entry.repoVersion + '.' };
    }

    // Name mismatch check — the remoteName should match the name part of the local filename
    const localNamePart = localMig.filename.replace(/^\d+_/, '').replace(/\.sql$/, '');
    if (entry.remoteName !== localMig.filename.replace(/\.sql$/, '')) {
      // Also accept just the name part without version prefix
      if (entry.remoteName !== localNamePart && entry.remoteName !== localMig.filename.replace(/\.sql$/, '')) {
        return { valid: false, reason: 'Mapping remoteName "' + entry.remoteName + '" does not match local migration name for version ' + entry.repoVersion + '.' };
      }
    }

    // contentHash is required — must be a valid SHA-256 hex string
    if (!entry.contentHash || typeof entry.contentHash !== 'string') {
      return { valid: false, reason: 'Mapping entry for version ' + entry.repoVersion + ' is missing required contentHash.' };
    }
    if (!/^[0-9a-f]{64}$/.test(entry.contentHash)) {
      return { valid: false, reason: 'Mapping contentHash for version ' + entry.repoVersion + ' is not a valid SHA-256 hex string.' };
    }
    const filePath = resolve(migrationsDir || MIGRATIONS_DIR, localMig.filename);
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, 'utf-8');
      const actualHash = createHash('sha256').update(content).digest('hex');
      if (entry.contentHash !== actualHash) {
        return { valid: false, reason: 'Content hash mismatch for ' + localMig.filename + '. Expected ' + entry.contentHash + ', got ' + actualHash + '.' };
      }
    }

    // schemaPresent must be boolean
    if (typeof entry.schemaPresent !== 'boolean') {
      return { valid: false, reason: 'Mapping schemaPresent must be a boolean for version ' + entry.repoVersion + '.' };
    }

    // Check for duplicate remote versions in mappings
    if (result.has(entry.remoteVersion)) {
      return { valid: false, reason: 'Duplicate remoteVersion in mappings: ' + entry.remoteVersion + '.' };
    }

    // Check for duplicate repoVersion across mappings
    for (const [existingTs, existingMapping] of result.entries()) {
      if (existingMapping.repoVersion === entry.repoVersion) {
        return { valid: false, reason: 'Duplicate repoVersion ' + entry.repoVersion + ' in mappings: remoteVersions ' + existingTs + ' and ' + entry.remoteVersion + ' both map to it.' };
      }
    }

    result.set(entry.remoteVersion, entry);
  }

  return { valid: true, mappings: result };
}

function reconcile(localMigrations, remoteVersions, schemaEvidence, options) {
  options = options || {};
  const intentionallyAbsent = options.intentionallyAbsent || INTENTIONALLY_ABSENT;
  const timestampMappings = options.timestampMappings || new Map(); // Map<remoteVersion, mapping>
  const pendingSetAllowlist = options.pendingSetAllowlist || DEFAULT_PENDING_ALLOWLIST;

  const errors = [];
  const warnings = [];
  const repairSteps = [];

  // Classify remote
  const classified = classifyRemoteVersions(remoteVersions);
  if (classified.duplicates.length > 0) {
    errors.push('Duplicate remote versions: ' + classified.duplicates.join(', ') + '.');
  }
  if (classified.unknown.length > 0) {
    errors.push('Unknown remote versions: ' + classified.unknown.join(', ') + '. Manual investigation required.');
  }

  // Check local duplicates
  const localVersionSet = new Set();
  const localDupes = [];
  for (const m of localMigrations) {
    if (localVersionSet.has(m.version)) localDupes.push(m.version);
    localVersionSet.add(m.version);
  }
  if (localDupes.length > 0) {
    errors.push('Duplicate local migration versions: ' + localDupes.join(', ') + '.');
  }

  // Remote numeric versions must have local files
  for (const rv of classified.numeric) {
    if (!localVersionSet.has(rv) && !intentionallyAbsent.has(rv)) {
      errors.push('Remote version ' + rv + ' has no local migration file and is not intentionally absent.');
    }
  }

  // Determine reconciliation scope — versions in the range that exist locally minus intentionally absent
  const scopeMin = 355;
  const scopeMax = 363;
  const scopeVersions = [];
  for (const m of localMigrations) {
    if (m.version >= scopeMin && m.version <= scopeMax && !intentionallyAbsent.has(m.version)) {
      scopeVersions.push(m.version);
    }
  }

  // Validate schema evidence strictly
  const evidenceResult = validateSchemaEvidence(schemaEvidence, scopeVersions);
  if (!evidenceResult.valid) {
    errors.push(evidenceResult.reason);
    return {
      state: ReconciliationState.BLOCKED,
      executable: false,
      pendingMigrations: [],
      errors,
      warnings,
      repairSteps: [],
    };
  }
  const presentSet = evidenceResult.present;
  const absentSet = evidenceResult.absent;

  // Process timestamp mappings
  let needsRepair = false;
  for (const ts of classified.timestamped) {
    const mapping = timestampMappings.get(ts);
    if (!mapping) {
      errors.push("Unmapped timestamped version '" + ts + "'. Identify the repository migration before proceeding.");
    } else if (!mapping.schemaPresent) {
      errors.push("Timestamped '" + ts + "' maps to migration " + mapping.repoVersion + ", but schema is NOT present. Migration " + mapping.repoVersion + " must NOT be rerun without investigation.");
    } else {
      // schemaPresent true in mapping — must also be in evidence presentMigrations
      if (!presentSet.has(mapping.repoVersion)) {
        errors.push('Mapping says migration ' + mapping.repoVersion + ' schema present, but it is not in schema evidence presentMigrations.');
      } else {
        needsRepair = true;
        repairSteps.push('1. Revert timestamp: supabase migration repair ' + ts + ' --status reverted --linked');
        repairSteps.push('2. Mark applied: supabase migration repair ' + mapping.repoVersion + ' --status applied --linked');
        warnings.push("Timestamped '" + ts + "' -> repo migration " + mapping.repoVersion + ". Schema present. History repair required.");
      }
    }
  }

  // Cross-check mapping vs evidence
  for (const [ts, mapping] of timestampMappings.entries()) {
    if (classified.timestamped.includes(ts)) {
      if (mapping.schemaPresent && absentSet.has(mapping.repoVersion)) {
        errors.push('Mapping says migration ' + mapping.repoVersion + ' present, but schema evidence says absent.');
      }
      if (!mapping.schemaPresent && presentSet.has(mapping.repoVersion)) {
        errors.push('Mapping says migration ' + mapping.repoVersion + ' absent, but schema evidence says present.');
      }
    }
  }

  // Compute applied set
  const appliedSet = new Set(classified.numeric);
  for (const [ts, mapping] of timestampMappings.entries()) {
    if (classified.timestamped.includes(ts) && mapping.schemaPresent) {
      appliedSet.add(mapping.repoVersion);
    }
  }

  // Cross-check numeric history against schema evidence (both directions)
  // Direction 1: numeric version in history but schema says absent
  for (const nv of classified.numeric) {
    if (absentSet.has(nv)) {
      errors.push('Numeric history contains ' + nv + ' as applied, but schema evidence says it is absent.');
    }
  }
  // Direction 2: schema says present but not in history (and not from a timestamp mapping)
  const timestampMappedVersions = new Set();
  for (const [ts, mapping] of timestampMappings.entries()) {
    if (classified.timestamped.includes(ts) && mapping.schemaPresent) {
      timestampMappedVersions.add(mapping.repoVersion);
    }
  }
  for (const pv of presentSet) {
    if (!classified.numeric.includes(pv) && !timestampMappedVersions.has(pv)) {
      errors.push('Schema evidence says migration ' + pv + ' is present, but it is not in remote history (numeric or mapped timestamp).');
    }
  }

  // Compute pending
  const pending = [];
  for (const m of localMigrations) {
    if (intentionallyAbsent.has(m.version) || appliedSet.has(m.version)) continue;
    pending.push(m);
  }

  // Pending set allowlist check
  const pendingVersions = pending.map(m => m.version);
  const allowlistSorted = [...pendingSetAllowlist].sort((a, b) => a - b);
  const pendingSorted = [...pendingVersions].sort((a, b) => a - b);
  if (JSON.stringify(pendingSorted) !== JSON.stringify(allowlistSorted)) {
    errors.push(
      'Pending set mismatch. Expected: [' + allowlistSorted.join(', ') + ']. Got: [' + pendingSorted.join(', ') + '].'
    );
  }

  // Gap check
  for (let i = 1; i < pending.length; i++) {
    const prev = pending[i - 1].version;
    const curr = pending[i].version;
    const between = localMigrations
      .map(m => m.version)
      .filter(v => v > prev && v < curr && !intentionallyAbsent.has(v) && !appliedSet.has(v));
    if (between.length > 0) {
      errors.push('Gap: migrations ' + between.join(', ') + ' between ' + prev + ' and ' + curr + '.');
    }
  }

  if (errors.length > 0) {
    return {
      state: ReconciliationState.BLOCKED,
      executable: false,
      pendingMigrations: pending,
      errors,
      warnings,
      repairSteps: [],
    };
  }

  if (needsRepair) {
    return {
      state: ReconciliationState.REPAIR_REQUIRED,
      executable: false,
      pendingMigrations: pending,
      errors: [],
      warnings,
      repairSteps,
      note: 'Pending migrations are INFORMATIONAL ONLY — non-executable until repair completes and is re-verified.',
    };
  }

  return {
    state: ReconciliationState.READY,
    executable: true,
    pendingMigrations: pending,
    errors: [],
    warnings,
    repairSteps: [],
  };
}

module.exports = {
  extractVersion,
  readLocalMigrations,
  classifyRemoteVersions,
  validateSchemaEvidence,
  validateTimestampMappings,
  reconcile,
  ReconciliationState,
  DEFAULT_PENDING_ALLOWLIST,
  INTENTIONALLY_ABSENT,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const hIdx = args.indexOf('--remote-history-file');
  const sIdx = args.indexOf('--schema-evidence-file');
  const mIdx = args.indexOf('--timestamp-mapping-file');

  if (hIdx === -1 || sIdx === -1 || mIdx === -1) {
    console.error(
      'Usage: node scripts/migration-reconciliation-planner.js \\\n' +
      '  --remote-history-file <f> \\\n' +
      '  --schema-evidence-file <f> \\\n' +
      '  --timestamp-mapping-file <f>'
    );
    process.exit(1);
  }

  const hFile = args[hIdx + 1];
  const sFile = args[sIdx + 1];
  const mFile = args[mIdx + 1];

  if (!hFile || !existsSync(hFile)) {
    console.error('History file not found: ' + hFile);
    process.exit(1);
  }
  if (!sFile || !existsSync(sFile)) {
    console.error('Schema file not found: ' + sFile);
    process.exit(1);
  }
  if (!mFile || !existsSync(mFile)) {
    console.error('Timestamp mapping file not found: ' + mFile);
    process.exit(1);
  }

  let history, schema, mappingData;
  try {
    history = JSON.parse(readFileSync(hFile, 'utf-8'));
  } catch (e) {
    console.error('Failed to parse history file: ' + e.message);
    process.exit(1);
  }
  try {
    schema = JSON.parse(readFileSync(sFile, 'utf-8'));
  } catch (e) {
    console.error('Failed to parse schema file: ' + e.message);
    process.exit(1);
  }
  try {
    mappingData = JSON.parse(readFileSync(mFile, 'utf-8'));
  } catch (e) {
    console.error('Failed to parse mapping file: ' + e.message);
    process.exit(1);
  }

  if (!Array.isArray(history.versions)) {
    console.error('History must have { "versions": [...] }');
    process.exit(1);
  }

  console.log('Migration Reconciliation Planner — DRY RUN ONLY\n');

  const { migrations: local, duplicates } = readLocalMigrations();
  if (duplicates.length > 0) {
    console.error('FATAL: Duplicate local: ' + duplicates.join(', '));
    process.exit(1);
  }
  console.log('Local: ' + local.length + ' files');

  // Validate mapping file
  const mappingResult = validateTimestampMappings(mappingData, local, INTENTIONALLY_ABSENT);
  if (!mappingResult.valid) {
    console.error('FATAL: Invalid mapping file — ' + mappingResult.reason);
    process.exit(1);
  }

  const result = reconcile(local, history.versions, schema, {
    timestampMappings: mappingResult.mappings,
  });

  console.log('\nSTATE: ' + result.state);
  console.log('EXECUTABLE: ' + result.executable);

  if (result.warnings.length) {
    result.warnings.forEach(w => console.log('  W: ' + w));
  }
  if (result.repairSteps.length) {
    console.log('\nREPAIR STEPS:');
    result.repairSteps.forEach(s => console.log('  ' + s));
  }
  if (result.errors.length) {
    console.log('\nERRORS:');
    result.errors.forEach(e => console.log('  X: ' + e));
    process.exit(1);
  }

  const lbl = result.state === 'REPAIR_REQUIRED' ? '\nINFORMATIONAL PENDING (non-executable):' : '\nPENDING:';
  if (result.pendingMigrations.length) {
    console.log(lbl);
    result.pendingMigrations.forEach((m, i) => console.log('  ' + (i + 1) + '. ' + m.filename));
  }

  console.log('\nDRY RUN — no SQL executed. Production requires separate authorization.');

  // Exit codes: 0 = READY, 1 = BLOCKED, 2 = REPAIR_REQUIRED
  if (result.state === ReconciliationState.BLOCKED) process.exit(1);
  if (result.state === ReconciliationState.REPAIR_REQUIRED) process.exit(2);
  process.exit(0);
}

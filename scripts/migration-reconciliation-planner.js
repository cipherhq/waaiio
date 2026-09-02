#!/usr/bin/env node
const { readFileSync, readdirSync, existsSync } = require('fs');
const { resolve } = require('path');
const MIGRATIONS_DIR = resolve(__dirname, '../supabase/migrations');
const INTENTIONALLY_ABSENT = new Set([358]);
const ReconciliationState = { READY: 'READY', REPAIR_REQUIRED: 'REPAIR_REQUIRED', BLOCKED: 'BLOCKED' };
function extractVersion(f) { const m = f.match(/^(\d+)_.*\.sql$/); return m ? parseInt(m[1], 10) : null; }
function readLocalMigrations(dir) {
  dir = dir || MIGRATIONS_DIR;
  const files = readdirSync(dir).filter(f => f.endsWith('.sql'));
  const migs = [], seen = new Set(), dupes = [];
  for (const f of files) { const v = extractVersion(f); if (v !== null) { if (seen.has(v)) dupes.push(v); seen.add(v); migs.push({ version: v, filename: f }); } }
  return { migrations: migs.sort((a, b) => a.version - b.version), duplicates: dupes };
}
function classifyRemoteVersions(versions) {
  const numeric = [], timestamped = [], unknown = [], seen = new Set(), duplicates = [];
  for (const v of versions) { const s = String(v); if (seen.has(s)) duplicates.push(s); seen.add(s);
    if (/^\d{12,}$/.test(s)) timestamped.push(s); else if (/^\d{1,4}$/.test(s)) numeric.push(parseInt(s, 10)); else unknown.push(s); }
  return { numeric: numeric.sort((a, b) => a - b), timestamped, unknown, duplicates };
}
function reconcile(localMigrations, remoteVersions, schemaEvidence, options) {
  options = options || {};
  const intentionallyAbsent = options.intentionallyAbsent || INTENTIONALLY_ABSENT;
  const knownTimestampMappings = options.knownTimestampMappings || {};
  const errors = [], warnings = [], repairSteps = [];
  const classified = classifyRemoteVersions(remoteVersions);
  if (classified.duplicates.length > 0) errors.push('Duplicate remote versions: ' + classified.duplicates.join(', ') + '.');
  if (classified.unknown.length > 0) errors.push('Unknown remote versions: ' + classified.unknown.join(', ') + '. Manual investigation required.');
  const localVersionSet = new Set(); const localDupes = [];
  for (const m of localMigrations) { if (localVersionSet.has(m.version)) localDupes.push(m.version); localVersionSet.add(m.version); }
  if (localDupes.length > 0) errors.push('Duplicate local migration versions: ' + localDupes.join(', ') + '.');
  for (const rv of classified.numeric) { if (!localVersionSet.has(rv) && !intentionallyAbsent.has(rv)) errors.push('Remote version ' + rv + ' has no local migration file and is not intentionally absent.'); }
  let needsRepair = false;
  for (const ts of classified.timestamped) { const mapping = knownTimestampMappings[ts];
    if (!mapping) { errors.push("Unmapped timestamped version '" + ts + "'. Identify the repository migration before proceeding."); }
    else if (!mapping.schemaPresent) { errors.push("Timestamped '" + ts + "' maps to migration " + mapping.repoVersion + ", but schema is NOT present. Migration " + mapping.repoVersion + " must NOT be rerun without investigation."); }
    else { needsRepair = true; repairSteps.push('1. Revert timestamp: supabase migration repair --status reverted ' + ts + ' --linked');
      repairSteps.push('2. Mark applied: supabase migration repair --status applied ' + mapping.repoVersion + ' --linked');
      warnings.push("Timestamped '" + ts + "' -> repo migration " + mapping.repoVersion + ". Schema present. History repair required."); } }
  if (!schemaEvidence) { errors.push('Schema evidence is missing. Cannot validate history/schema agreement.'); }
  else { const presentSet = new Set(schemaEvidence.presentMigrations || []); const absentSet = new Set(schemaEvidence.absentMigrations || []);
    for (const v of presentSet) { if (absentSet.has(v)) errors.push('Migration ' + v + ' in both presentMigrations and absentMigrations — contradictory.'); }
    for (const [ts, mapping] of Object.entries(knownTimestampMappings)) { if (classified.timestamped.includes(ts)) {
      if (mapping.schemaPresent && absentSet.has(mapping.repoVersion)) errors.push('Mapping says migration ' + mapping.repoVersion + ' present, but schema evidence says absent.');
      if (!mapping.schemaPresent && presentSet.has(mapping.repoVersion)) errors.push('Mapping says migration ' + mapping.repoVersion + ' absent, but schema evidence says present.'); } } }
  const appliedSet = new Set(classified.numeric);
  for (const [ts, mapping] of Object.entries(knownTimestampMappings)) { if (classified.timestamped.includes(ts) && mapping.schemaPresent) appliedSet.add(mapping.repoVersion); }
  const pending = [];
  for (const m of localMigrations) { if (intentionallyAbsent.has(m.version) || appliedSet.has(m.version)) continue; pending.push(m); }
  for (let i = 1; i < pending.length; i++) { const prev = pending[i-1].version, curr = pending[i].version;
    const between = localMigrations.map(m => m.version).filter(v => v > prev && v < curr && !intentionallyAbsent.has(v) && !appliedSet.has(v));
    if (between.length > 0) errors.push('Gap: migrations ' + between.join(', ') + ' between ' + prev + ' and ' + curr + '.'); }
  if (errors.length > 0) return { state: ReconciliationState.BLOCKED, pendingMigrations: pending, errors, warnings, repairSteps: [] };
  if (needsRepair) return { state: ReconciliationState.REPAIR_REQUIRED, pendingMigrations: pending, errors: [], warnings, repairSteps, note: 'Pending migrations are INFORMATIONAL ONLY — non-executable until repair completes and is re-verified.' };
  return { state: ReconciliationState.READY, pendingMigrations: pending, errors: [], warnings, repairSteps: [] };
}
module.exports = { extractVersion, readLocalMigrations, classifyRemoteVersions, reconcile, ReconciliationState };
if (require.main === module) {
  const args = process.argv.slice(2);
  const hIdx = args.indexOf('--remote-history-file'), sIdx = args.indexOf('--schema-evidence-file');
  if (hIdx === -1 || sIdx === -1) { console.error('Usage: node scripts/migration-reconciliation-planner.js --remote-history-file <f> --schema-evidence-file <f>'); process.exit(1); }
  const hFile = args[hIdx + 1], sFile = args[sIdx + 1];
  if (!hFile || !existsSync(hFile)) { console.error('History file not found: ' + hFile); process.exit(1); }
  if (!sFile || !existsSync(sFile)) { console.error('Schema file not found: ' + sFile); process.exit(1); }
  const history = JSON.parse(readFileSync(hFile, 'utf-8')), schema = JSON.parse(readFileSync(sFile, 'utf-8'));
  if (!Array.isArray(history.versions)) { console.error('History must have { "versions": [...] }'); process.exit(1); }
  console.log('Migration Reconciliation Planner — DRY RUN ONLY\n');
  const { migrations: local, duplicates } = readLocalMigrations();
  if (duplicates.length > 0) { console.error('FATAL: Duplicate local: ' + duplicates.join(', ')); process.exit(1); }
  console.log('Local: ' + local.length + ' files');
  const KNOWN = { '20260902052231': { repoVersion: 355, schemaPresent: true } };
  const result = reconcile(local, history.versions, schema, { knownTimestampMappings: KNOWN });
  console.log('\nSTATE: ' + result.state);
  if (result.warnings.length) result.warnings.forEach(w => console.log('  W: ' + w));
  if (result.repairSteps.length) { console.log('\nREPAIR STEPS:'); result.repairSteps.forEach(s => console.log('  ' + s)); }
  if (result.errors.length) { console.log('\nERRORS:'); result.errors.forEach(e => console.log('  X: ' + e)); process.exit(1); }
  const lbl = result.state === 'REPAIR_REQUIRED' ? '\nINFORMATIONAL PENDING (non-executable):' : '\nPENDING:';
  if (result.pendingMigrations.length) { console.log(lbl); result.pendingMigrations.forEach((m,i) => console.log('  ' + (i+1) + '. ' + m.filename)); }
  console.log('\nDRY RUN — no SQL executed. Production requires separate authorization.');
}

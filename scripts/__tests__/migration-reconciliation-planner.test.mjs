import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { resolve, join } from 'path';
import { extractVersion, classifyRemoteVersions, reconcile, readLocalMigrations, ReconciliationState } from '../migration-reconciliation-planner.mjs';

function buildLocal(vs) { return vs.map(v => ({ version: v, filename: v + '_test.sql' })); }
function buildFullLocal(extras) { return buildLocal([...Array.from({length:354},(_,i)=>i+1), ...extras]); }
function remoteThrough(n) { return Array.from({length:n},(_,i)=>String(i+1)); }
const ABSENT = new Set([358]);
const SP = { presentMigrations:[355], absentMigrations:[356,357,359,360,361,362,363] };
const SA = { presentMigrations:[], absentMigrations:[355,356,357,359,360,361,362,363] };

describe('extractVersion', () => {
  it('standard', () => { expect(extractVersion('355_r.sql')).toBe(355); });
  it('3digit', () => { expect(extractVersion('001_i.sql')).toBe(1); });
  it('non-mig', () => { expect(extractVersion('README.md')).toBeNull(); });
});
describe('classifyRemoteVersions', () => {
  it('numeric', () => { expect(classifyRemoteVersions(['1','354']).numeric).toEqual([1,354]); });
  it('ts', () => { expect(classifyRemoteVersions(['20260902052231']).timestamped).toEqual(['20260902052231']); });
  it('unknown', () => { expect(classifyRemoteVersions(['abc']).unknown).toEqual(['abc']); });
  it('dupes', () => { expect(classifyRemoteVersions(['354','354']).duplicates).toEqual(['354']); });
});
describe('readLocalMigrations', () => {
  it('reads repo', () => { const{migrations,duplicates}=readLocalMigrations(); expect(migrations.length).toBeGreaterThan(100); expect(duplicates).toEqual([]); });
});
describe('reconcile', () => {
  const FL = buildFullLocal([355,356,357,359,360,361,362,363]);
  it('clean354->READY', () => { const r=reconcile(FL,remoteThrough(354),SA,{intentionallyAbsent:ABSENT}); expect(r.state).toBe('READY'); expect(r.pendingMigrations.length).toBe(8); });
  it('clean355->no rerun', () => { const r=reconcile(FL,remoteThrough(355),SP,{intentionallyAbsent:ABSENT}); expect(r.state).toBe('READY'); expect(r.pendingMigrations.find(m=>m.version===355)).toBeUndefined(); });
  it('ts355->REPAIR_REQUIRED', () => { const r=reconcile(FL,[...remoteThrough(354),'20260902052231'],SP,{intentionallyAbsent:ABSENT,knownTimestampMappings:{'20260902052231':{repoVersion:355,schemaPresent:true}}}); expect(r.state).toBe('REPAIR_REQUIRED'); expect(r.repairSteps.some(s=>s.includes('reverted'))).toBe(true); expect(r.pendingMigrations.map(m=>m.version)).toEqual([356,357,359,360,361,362,363]); });
  it('unmapped ts->BLOCKED', () => { const r=reconcile(FL,[...remoteThrough(354),'20260902052231'],SP,{intentionallyAbsent:ABSENT}); expect(r.state).toBe('BLOCKED'); });
  it('unknown remote->BLOCKED', () => { const r=reconcile(FL,[...remoteThrough(354),'abc'],SA,{intentionallyAbsent:ABSENT}); expect(r.state).toBe('BLOCKED'); });
  it('schemaPresent:false->BLOCKED', () => { const r=reconcile(FL,[...remoteThrough(354),'20260902052231'],SA,{intentionallyAbsent:ABSENT,knownTimestampMappings:{'20260902052231':{repoVersion:355,schemaPresent:false}}}); expect(r.state).toBe('BLOCKED'); expect(r.errors.some(e=>e.includes('NOT present'))).toBe(true); });
  it('no schema->BLOCKED', () => { const r=reconcile(FL,remoteThrough(354),null,{intentionallyAbsent:ABSENT}); expect(r.state).toBe('BLOCKED'); });
  it('contradictory->BLOCKED', () => { const r=reconcile(FL,remoteThrough(354),{presentMigrations:[355],absentMigrations:[355]},{intentionallyAbsent:ABSENT}); expect(r.state).toBe('BLOCKED'); });
  it('dupe local->BLOCKED', () => { const r=reconcile([...FL,{version:355,filename:'355_d.sql'}],remoteThrough(354),SA,{intentionallyAbsent:ABSENT}); expect(r.state).toBe('BLOCKED'); });
  it('dupe remote->BLOCKED', () => { const r=reconcile(FL,[...remoteThrough(354),'354'],SA,{intentionallyAbsent:ABSENT}); expect(r.state).toBe('BLOCKED'); });
  it('unknown num remote->BLOCKED', () => { const r=reconcile(FL,[...remoteThrough(354),'9999'],SA,{intentionallyAbsent:ABSENT}); expect(r.state).toBe('BLOCKED'); });
  it('prod state->REPAIR, 356-363', () => { const r=reconcile(FL,[...remoteThrough(354),'20260902052231'],SP,{intentionallyAbsent:ABSENT,knownTimestampMappings:{'20260902052231':{repoVersion:355,schemaPresent:true}}}); expect(r.state).toBe('REPAIR_REQUIRED'); expect(r.pendingMigrations.map(m=>m.version)).toEqual([356,357,359,360,361,362,363]); expect(r.note).toContain('non-executable'); });
  it('all applied->empty', () => { const r=reconcile(FL,[...remoteThrough(357),'359','360','361','362','363'],{presentMigrations:[355,356,357,359,360,361,362,363],absentMigrations:[]},{intentionallyAbsent:ABSENT}); expect(r.state).toBe('READY'); expect(r.pendingMigrations).toEqual([]); });
  it('358 skipped', () => { const r=reconcile(buildFullLocal([355,356,357,358,359]),remoteThrough(355),SP,{intentionallyAbsent:ABSENT}); expect(r.pendingMigrations.find(m=>m.version===358)).toBeUndefined(); });
  it('mapping contradiction->BLOCKED', () => { const r=reconcile(FL,[...remoteThrough(354),'20260902052231'],{presentMigrations:[],absentMigrations:[355]},{intentionallyAbsent:ABSENT,knownTimestampMappings:{'20260902052231':{repoVersion:355,schemaPresent:true}}}); expect(r.state).toBe('BLOCKED'); });
});
describe('354 regression', () => {
  it('354 items', () => { const v=remoteThrough(354); expect(v.length).toBe(354); expect(v[0]).toBe('1'); expect(v[353]).toBe('354'); });
});
describe('no write path', () => {
  it('no apply_migration', () => { expect(readFileSync(resolve('scripts/migration-reconciliation-planner.mjs'),'utf-8')).not.toContain('apply_migration'); });
  it('no DB writes', () => { const s=readFileSync(resolve('scripts/migration-reconciliation-planner.mjs'),'utf-8'); expect(s).not.toContain('INSERT INTO'); expect(s).not.toContain('createClient'); });
});
describe('CLI', () => {
  function runCLI(...a) { try { return execSync('node scripts/migration-reconciliation-planner.mjs '+a.join(' '),{encoding:'utf-8',timeout:15000}); } catch(e) { return (e.stdout||'')+'\n'+(e.stderr||''); } }
  it('refuses no files', () => { expect(runCLI()).toContain('--remote-history-file'); });
  it('prod->REPAIR_REQUIRED', () => {
    const{migrations}=readLocalMigrations(); const t354=migrations.filter(m=>m.version<=354).map(m=>String(m.version));
    const d=mkdtempSync('/tmp/r-'); writeFileSync(join(d,'h.json'),JSON.stringify({versions:[...t354,'20260902052231']})); writeFileSync(join(d,'s.json'),JSON.stringify(SP));
    const o=runCLI('--remote-history-file',join(d,'h.json'),'--schema-evidence-file',join(d,'s.json'));
    expect(o).toContain('REPAIR_REQUIRED'); expect(o).toContain('non-executable'); rmSync(d,{recursive:true});
  });
});

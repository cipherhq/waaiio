import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'fs';
import { resolve, join } from 'path';

const mod = require('../migration-reconciliation-planner.js');
const {
  extractVersion,
  classifyRemoteVersions,
  reconcile,
  readLocalMigrations,
  validateSchemaEvidence,
  validateTimestampMappings,
  ReconciliationState,
  DEFAULT_PENDING_ALLOWLIST,
  INTENTIONALLY_ABSENT,
} = mod;

// --- Helpers ---
function buildLocal(vs: number[]) {
  return vs.map(v => ({ version: v, filename: v + '_test.sql' }));
}
function buildFullLocal(extras: number[]) {
  // Mimics the real repo shape: 1-42, 56-248, 292-299, 300-351, 353-354, plus extras
  // (gaps at 43-55, 249-291, 352, 358)
  const versions: number[] = [];
  for (let i = 1; i <= 42; i++) versions.push(i);
  for (let i = 56; i <= 248; i++) versions.push(i);
  for (let i = 292; i <= 354; i++) {
    if (i === 352) continue; // historical gap
    versions.push(i);
  }
  for (const v of extras) versions.push(v);
  return buildLocal([...new Set(versions)].sort((a, b) => a - b));
}
function remoteThrough(n: number) {
  // Matches the real repo: skips 43-55, 249-291, 352
  const versions: string[] = [];
  for (let i = 1; i <= n; i++) {
    if ((i >= 43 && i <= 55) || (i >= 249 && i <= 291) || i === 352) continue;
    versions.push(String(i));
  }
  return versions;
}
const ABSENT = new Set([358]);
const SCOPE_VERSIONS = [355, 356, 357, 359, 360, 361, 362, 363, 364];
const SP = { presentMigrations: [355], absentMigrations: [356, 357, 359, 360, 361, 362, 363, 364] };
const SA = { presentMigrations: [] as number[], absentMigrations: [355, 356, 357, 359, 360, 361, 362, 363, 364] };

function buildMapping(overrides?: Partial<{ schemaPresent: boolean }>) {
  const m = new Map();
  m.set('20260902052231', {
    remoteVersion: '20260902052231',
    remoteName: '355_refund_convergence',
    repoVersion: 355,
    localFilename: '355_test.sql',
    schemaPresent: true,
    ...overrides,
  });
  return m;
}

// --- Tests ---

describe('extractVersion', () => {
  it('standard', () => expect(extractVersion('355_r.sql')).toBe(355));
  it('3digit', () => expect(extractVersion('001_i.sql')).toBe(1));
  it('non-mig', () => expect(extractVersion('README.md')).toBeNull());
  it('no underscore', () => expect(extractVersion('355.sql')).toBeNull());
  it('empty string', () => expect(extractVersion('')).toBeNull());
});

describe('classifyRemoteVersions', () => {
  it('numeric', () => expect(classifyRemoteVersions(['1', '354']).numeric).toEqual([1, 354]));
  it('ts', () => expect(classifyRemoteVersions(['20260902052231']).timestamped).toEqual(['20260902052231']));
  it('unknown', () => expect(classifyRemoteVersions(['abc']).unknown).toEqual(['abc']));
  it('dupes', () => expect(classifyRemoteVersions(['354', '354']).duplicates).toEqual(['354']));
  it('normalized numeric dupes', () => {
    const r = classifyRemoteVersions(['354', '0354']);
    expect(r.duplicates.length).toBe(1);
    expect(r.duplicates[0]).toContain('normalized duplicate');
  });
  it('normalized numeric dupes with leading zeros', () => {
    const r = classifyRemoteVersions(['1', '001', '01']);
    expect(r.duplicates.length).toBe(2);
    expect(r.duplicates.every((d: string) => d.includes('normalized duplicate'))).toBe(true);
  });
  it('mixed', () => {
    const r = classifyRemoteVersions(['1', '20260902052231', 'abc', '354']);
    expect(r.numeric).toEqual([1, 354]);
    expect(r.timestamped).toEqual(['20260902052231']);
    expect(r.unknown).toEqual(['abc']);
  });
});

describe('readLocalMigrations', () => {
  it('reads repo with correct count', () => {
    const r = readLocalMigrations();
    expect(r.migrations.length).toBeGreaterThan(100);
    expect(r.duplicates).toEqual([]);
  });

  it('real repo has gaps at 43-55, 249-291, 352, 358', () => {
    const r = readLocalMigrations();
    const versions = new Set(r.migrations.map((m: { version: number }) => m.version));
    // Verify known gaps
    for (let i = 43; i <= 55; i++) expect(versions.has(i)).toBe(false);
    for (let i = 249; i <= 291; i++) expect(versions.has(i)).toBe(false);
    expect(versions.has(352)).toBe(false);
    expect(versions.has(358)).toBe(false);
    // Verify key present versions
    expect(versions.has(1)).toBe(true);
    expect(versions.has(354)).toBe(true);
    expect(versions.has(355)).toBe(true);
    expect(versions.has(363)).toBe(true);
  });
});

describe('validateSchemaEvidence', () => {
  it('null evidence -> invalid', () => {
    const r = validateSchemaEvidence(null, SCOPE_VERSIONS);
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('missing');
  });

  it('undefined evidence -> invalid', () => {
    const r = validateSchemaEvidence(undefined, SCOPE_VERSIONS);
    expect(r.valid).toBe(false);
  });

  it('{} empty evidence -> invalid', () => {
    const r = validateSchemaEvidence({}, SCOPE_VERSIONS);
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('empty');
  });

  it('array evidence -> invalid', () => {
    const r = validateSchemaEvidence([1, 2, 3], SCOPE_VERSIONS);
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('non-array object');
  });

  it('string evidence -> invalid', () => {
    const r = validateSchemaEvidence('hello', SCOPE_VERSIONS);
    expect(r.valid).toBe(false);
  });

  it('missing presentMigrations -> invalid', () => {
    const r = validateSchemaEvidence({ absentMigrations: [355] }, SCOPE_VERSIONS);
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('presentMigrations');
  });

  it('missing absentMigrations -> invalid', () => {
    const r = validateSchemaEvidence({ presentMigrations: [355] }, SCOPE_VERSIONS);
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('absentMigrations');
  });

  it('presentMigrations not array -> invalid', () => {
    const r = validateSchemaEvidence({ presentMigrations: 'foo', absentMigrations: [] }, SCOPE_VERSIONS);
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('must be an array');
  });

  it('absentMigrations not array -> invalid', () => {
    const r = validateSchemaEvidence({ presentMigrations: [], absentMigrations: 'foo' }, SCOPE_VERSIONS);
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('must be an array');
  });

  it('non-integer in presentMigrations -> invalid', () => {
    const r = validateSchemaEvidence({ presentMigrations: [355.5], absentMigrations: [] }, SCOPE_VERSIONS);
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('non-integer');
  });

  it('string in absentMigrations -> invalid', () => {
    const r = validateSchemaEvidence({ presentMigrations: [], absentMigrations: ['355'] }, SCOPE_VERSIONS);
    expect(r.valid).toBe(false);
  });

  it('duplicate in presentMigrations -> invalid', () => {
    const r = validateSchemaEvidence(
      { presentMigrations: [355, 355], absentMigrations: [356, 357, 359, 360, 361, 362, 363, 364] },
      SCOPE_VERSIONS
    );
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('Duplicate');
  });

  it('overlap between present and absent -> invalid', () => {
    const r = validateSchemaEvidence(
      { presentMigrations: [355], absentMigrations: [355, 356, 357, 359, 360, 361, 362, 363, 364] },
      SCOPE_VERSIONS
    );
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('both');
  });

  it('scope version not classified -> invalid', () => {
    // Missing 363 from both arrays
    const r = validateSchemaEvidence(
      { presentMigrations: [355], absentMigrations: [356, 357, 359, 360, 361, 362] },
      SCOPE_VERSIONS
    );
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('363');
    expect(r.reason).toContain('not classified');
  });

  it('valid complete evidence -> valid', () => {
    const r = validateSchemaEvidence(SP, SCOPE_VERSIONS);
    expect(r.valid).toBe(true);
    expect(r.present).toBeInstanceOf(Set);
    expect(r.absent).toBeInstanceOf(Set);
  });

  it('all absent evidence -> valid', () => {
    const r = validateSchemaEvidence(SA, SCOPE_VERSIONS);
    expect(r.valid).toBe(true);
  });
});

describe('reconcile — executability field', () => {
  const FL = buildFullLocal([355, 356, 357, 359, 360, 361, 362, 363, 364]);

  it('READY includes executable: true', () => {
    const r = reconcile(FL, [...remoteThrough(354), '355'], SP, {
      intentionallyAbsent: ABSENT,
      pendingSetAllowlist: DEFAULT_PENDING_ALLOWLIST,
    });
    expect(r.state).toBe('READY');
    expect(r.executable).toBe(true);
  });

  it('REPAIR_REQUIRED includes executable: false', () => {
    const r = reconcile(FL, [...remoteThrough(354), '20260902052231'], SP, {
      intentionallyAbsent: ABSENT,
      timestampMappings: buildMapping(),
      pendingSetAllowlist: DEFAULT_PENDING_ALLOWLIST,
    });
    expect(r.state).toBe('REPAIR_REQUIRED');
    expect(r.executable).toBe(false);
  });

  it('BLOCKED includes executable: false', () => {
    const r = reconcile(FL, remoteThrough(354), null, {
      intentionallyAbsent: ABSENT,
    });
    expect(r.state).toBe('BLOCKED');
    expect(r.executable).toBe(false);
  });
});

describe('reconcile — schema evidence validation', () => {
  const FL = buildFullLocal([355, 356, 357, 359, 360, 361, 362, 363, 364]);

  it('{} empty evidence -> BLOCKED', () => {
    const r = reconcile(FL, remoteThrough(354), {}, { intentionallyAbsent: ABSENT });
    expect(r.state).toBe('BLOCKED');
    expect(r.errors.some((e: string) => e.includes('empty'))).toBe(true);
  });

  it('null evidence -> BLOCKED', () => {
    const r = reconcile(FL, remoteThrough(354), null, { intentionallyAbsent: ABSENT });
    expect(r.state).toBe('BLOCKED');
  });

  it('string instead of array in evidence -> BLOCKED', () => {
    const r = reconcile(FL, remoteThrough(354), { presentMigrations: 'foo', absentMigrations: [] }, {
      intentionallyAbsent: ABSENT,
    });
    expect(r.state).toBe('BLOCKED');
  });

  it('missing presentMigrations key -> BLOCKED', () => {
    const r = reconcile(FL, remoteThrough(354), { absentMigrations: SCOPE_VERSIONS }, {
      intentionallyAbsent: ABSENT,
    });
    expect(r.state).toBe('BLOCKED');
  });

  it('contradictory evidence -> BLOCKED', () => {
    const r = reconcile(FL, remoteThrough(354), {
      presentMigrations: [355],
      absentMigrations: [355, 356, 357, 359, 360, 361, 362, 363, 364],
    }, { intentionallyAbsent: ABSENT });
    expect(r.state).toBe('BLOCKED');
    expect(r.errors.some((e: string) => e.includes('both'))).toBe(true);
  });
});

describe('reconcile — history/schema disagreement', () => {
  const FL = buildFullLocal([355, 356, 357, 359, 360, 361, 362, 363, 364]);

  it('mapping says present but evidence says absent -> BLOCKED', () => {
    const r = reconcile(FL, [...remoteThrough(354), '20260902052231'], {
      presentMigrations: [] as number[],
      absentMigrations: [355, 356, 357, 359, 360, 361, 362, 363, 364],
    }, {
      intentionallyAbsent: ABSENT,
      timestampMappings: buildMapping({ schemaPresent: true }),
      pendingSetAllowlist: DEFAULT_PENDING_ALLOWLIST,
    });
    expect(r.state).toBe('BLOCKED');
    expect(r.errors.some((e: string) => e.includes('not in schema evidence presentMigrations') || e.includes('absent'))).toBe(true);
  });

  it('mapping says absent but evidence says present -> BLOCKED', () => {
    const r = reconcile(FL, [...remoteThrough(354), '20260902052231'], {
      presentMigrations: [355],
      absentMigrations: [356, 357, 359, 360, 361, 362, 363, 364],
    }, {
      intentionallyAbsent: ABSENT,
      timestampMappings: buildMapping({ schemaPresent: false }),
      pendingSetAllowlist: DEFAULT_PENDING_ALLOWLIST,
    });
    expect(r.state).toBe('BLOCKED');
    expect(r.errors.some((e: string) => e.includes('absent') && e.includes('present'))).toBe(true);
  });
});

describe('reconcile — normalized numeric duplicate BLOCKED', () => {
  const FL = buildFullLocal([355, 356, 357, 359, 360, 361, 362, 363, 364]);

  it('354 and 0354 -> BLOCKED', () => {
    const r = reconcile(FL, [...remoteThrough(353), '354', '0354'], SA, {
      intentionallyAbsent: ABSENT,
      pendingSetAllowlist: [355, 356, 357, 359, 360, 361, 362, 363, 364],
    });
    expect(r.state).toBe('BLOCKED');
    expect(r.errors.some((e: string) => e.includes('Duplicate remote versions') && e.includes('normalized duplicate'))).toBe(true);
  });

  it('1 and 001 -> BLOCKED', () => {
    const r = reconcile(FL, [...remoteThrough(354), '001'], SA, {
      intentionallyAbsent: ABSENT,
    });
    expect(r.state).toBe('BLOCKED');
    expect(r.errors.some((e: string) => e.includes('normalized duplicate'))).toBe(true);
  });
});

describe('reconcile — numeric history vs schema cross-check', () => {
  const FL = buildFullLocal([355, 356, 357, 359, 360, 361, 362, 363, 364]);

  it('numeric 355 in history but schema says absent -> BLOCKED', () => {
    const r = reconcile(FL, [...remoteThrough(354), '355'], SA, {
      intentionallyAbsent: ABSENT,
      pendingSetAllowlist: DEFAULT_PENDING_ALLOWLIST,
    });
    expect(r.state).toBe('BLOCKED');
    expect(r.errors.some((e: string) => e.includes('Numeric history contains 355') && e.includes('absent'))).toBe(true);
  });

  it('schema says 355 present but not in history -> BLOCKED', () => {
    const r = reconcile(FL, remoteThrough(354), SP, {
      intentionallyAbsent: ABSENT,
      pendingSetAllowlist: [355, 356, 357, 359, 360, 361, 362, 363, 364],
    });
    expect(r.state).toBe('BLOCKED');
    expect(r.errors.some((e: string) => e.includes('Schema evidence says migration 355 is present') && e.includes('not in remote history'))).toBe(true);
  });

  it('numeric 355 in history AND schema says present -> no error from cross-check', () => {
    const r = reconcile(FL, [...remoteThrough(354), '355'], SP, {
      intentionallyAbsent: ABSENT,
      pendingSetAllowlist: DEFAULT_PENDING_ALLOWLIST,
    });
    expect(r.state).toBe('READY');
    expect(r.errors).toEqual([]);
  });

  it('schema present via timestamp mapping does not trigger direction-2 error', () => {
    const r = reconcile(FL, [...remoteThrough(354), '20260902052231'], SP, {
      intentionallyAbsent: ABSENT,
      timestampMappings: buildMapping(),
      pendingSetAllowlist: DEFAULT_PENDING_ALLOWLIST,
    });
    // Should be REPAIR_REQUIRED, not BLOCKED — the timestamp mapping accounts for 355
    expect(r.state).toBe('REPAIR_REQUIRED');
    expect(r.errors).toEqual([]);
  });
});

describe('reconcile — pending set allowlist', () => {
  const FL = buildFullLocal([355, 356, 357, 359, 360, 361, 362, 363, 364]);

  it('exact match -> passes', () => {
    const r = reconcile(FL, remoteThrough(354), SA, {
      intentionallyAbsent: ABSENT,
      pendingSetAllowlist: [355, 356, 357, 359, 360, 361, 362, 363, 364],
    });
    expect(r.state).toBe('READY');
  });

  it('mismatch -> BLOCKED', () => {
    // Default allowlist is [356..363 minus 358] but pending is [355..363 minus 358]
    const r = reconcile(FL, remoteThrough(354), SA, {
      intentionallyAbsent: ABSENT,
      pendingSetAllowlist: DEFAULT_PENDING_ALLOWLIST, // expects 356-363, but 355 is also pending
    });
    expect(r.state).toBe('BLOCKED');
    expect(r.errors.some((e: string) => e.includes('Pending set mismatch'))).toBe(true);
  });

  it('extra pending version -> BLOCKED', () => {
    const FL2 = buildFullLocal([355, 356, 357, 359, 360, 361, 362, 363, 999]);
    const r = reconcile(FL2, remoteThrough(354), {
      presentMigrations: [] as number[],
      absentMigrations: [355, 356, 357, 359, 360, 361, 362, 363, 364],
    }, {
      intentionallyAbsent: ABSENT,
      pendingSetAllowlist: DEFAULT_PENDING_ALLOWLIST,
    });
    expect(r.state).toBe('BLOCKED');
  });
});

describe('reconcile — core scenarios', () => {
  const FL = buildFullLocal([355, 356, 357, 359, 360, 361, 362, 363, 364]);

  it('clean 354 -> READY with 8 pending', () => {
    const r = reconcile(FL, remoteThrough(354), SA, {
      intentionallyAbsent: ABSENT,
      pendingSetAllowlist: [355, 356, 357, 359, 360, 361, 362, 363, 364],
    });
    expect(r.state).toBe('READY');
    expect(r.pendingMigrations.length).toBe(9);
  });

  it('clean 355 applied -> no rerun', () => {
    const r = reconcile(FL, [...remoteThrough(354), '355'], SP, {
      intentionallyAbsent: ABSENT,
      pendingSetAllowlist: DEFAULT_PENDING_ALLOWLIST,
    });
    expect(r.state).toBe('READY');
    expect(r.pendingMigrations.find((m: any) => m.version === 355)).toBeUndefined();
    expect(r.pendingMigrations.length).toBe(8);
  });

  it('ts 355 -> REPAIR_REQUIRED', () => {
    const r = reconcile(FL, [...remoteThrough(354), '20260902052231'], SP, {
      intentionallyAbsent: ABSENT,
      timestampMappings: buildMapping(),
      pendingSetAllowlist: DEFAULT_PENDING_ALLOWLIST,
    });
    expect(r.state).toBe('REPAIR_REQUIRED');
    expect(r.repairSteps.some((s: string) => s.includes('reverted'))).toBe(true);
    expect(r.pendingMigrations.map((m: any) => m.version)).toEqual([356, 357, 359, 360, 361, 362, 363, 364]);
  });

  it('unmapped ts -> BLOCKED', () => {
    const r = reconcile(FL, [...remoteThrough(354), '20260902052231'], SP, {
      intentionallyAbsent: ABSENT,
      pendingSetAllowlist: DEFAULT_PENDING_ALLOWLIST,
    });
    expect(r.state).toBe('BLOCKED');
  });

  it('unknown remote -> BLOCKED', () => {
    const r = reconcile(FL, [...remoteThrough(354), 'abc'], SA, {
      intentionallyAbsent: ABSENT,
    });
    expect(r.state).toBe('BLOCKED');
  });

  it('schemaPresent: false -> BLOCKED', () => {
    const r = reconcile(FL, [...remoteThrough(354), '20260902052231'], SA, {
      intentionallyAbsent: ABSENT,
      timestampMappings: buildMapping({ schemaPresent: false }),
    });
    expect(r.state).toBe('BLOCKED');
    expect(r.errors.some((e: string) => e.includes('NOT present'))).toBe(true);
  });

  it('duplicate local -> BLOCKED', () => {
    const r = reconcile([...FL, { version: 355, filename: '355_d.sql' }], remoteThrough(354), SA, {
      intentionallyAbsent: ABSENT,
    });
    expect(r.state).toBe('BLOCKED');
  });

  it('duplicate remote -> BLOCKED', () => {
    const r = reconcile(FL, [...remoteThrough(354), '354'], SA, {
      intentionallyAbsent: ABSENT,
    });
    expect(r.state).toBe('BLOCKED');
  });

  it('unknown numeric remote -> BLOCKED', () => {
    const r = reconcile(FL, [...remoteThrough(354), '9999'], SA, {
      intentionallyAbsent: ABSENT,
    });
    expect(r.state).toBe('BLOCKED');
  });

  it('prod scenario -> REPAIR_REQUIRED with 356-363 pending', () => {
    const r = reconcile(FL, [...remoteThrough(354), '20260902052231'], SP, {
      intentionallyAbsent: ABSENT,
      timestampMappings: buildMapping(),
      pendingSetAllowlist: DEFAULT_PENDING_ALLOWLIST,
    });
    expect(r.state).toBe('REPAIR_REQUIRED');
    expect(r.pendingMigrations.map((m: any) => m.version)).toEqual([356, 357, 359, 360, 361, 362, 363, 364]);
    expect(r.note).toContain('non-executable');
  });

  it('all applied -> empty pending', () => {
    const allApplied = [
      ...remoteThrough(357),
      '359', '360', '361', '362', '363', '364',
    ];
    const r = reconcile(FL, allApplied, {
      presentMigrations: [355, 356, 357, 359, 360, 361, 362, 363, 364],
      absentMigrations: [],
    }, {
      intentionallyAbsent: ABSENT,
      pendingSetAllowlist: [], // no pending expected
    });
    expect(r.state).toBe('READY');
    expect(r.pendingMigrations).toEqual([]);
  });

  it('358 always skipped', () => {
    const FL2 = buildFullLocal([355, 356, 357, 358, 359, 360, 361, 362, 363, 364]);
    const r = reconcile(FL2, [...remoteThrough(354), '355'], SP, {
      intentionallyAbsent: ABSENT,
      pendingSetAllowlist: DEFAULT_PENDING_ALLOWLIST,
    });
    expect(r.pendingMigrations.find((m: any) => m.version === 358)).toBeUndefined();
  });
});

describe('reconcile — mapping validation edge cases', () => {
  const FL = buildFullLocal([355, 356, 357, 359, 360, 361, 362, 363, 364]);

  it('mapping to non-local migration -> BLOCKED via validateTimestampMappings', () => {
    const result = validateTimestampMappings(
      {
        mappings: [{
          remoteVersion: '20260902052231',
          remoteName: '9999_nonexistent',
          repoVersion: 9999,
          localFilename: '9999_nonexistent.sql',
          schemaPresent: true,
        }],
      },
      FL,
      ABSENT,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('no local migration');
  });

  it('mapping to intentionally-absent migration -> BLOCKED', () => {
    const FL2 = buildFullLocal([355, 356, 357, 358, 359, 360, 361, 362, 363, 364]);
    const result = validateTimestampMappings(
      {
        mappings: [{
          remoteVersion: '20260902052231',
          remoteName: '358_test',
          repoVersion: 358,
          localFilename: '358_test.sql',
          schemaPresent: true,
        }],
      },
      FL2,
      ABSENT,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('intentionally absent');
  });

  it('mapping name mismatch -> BLOCKED', () => {
    const result = validateTimestampMappings(
      {
        mappings: [{
          remoteVersion: '20260902052231',
          remoteName: 'wrong_name_here',
          repoVersion: 355,
          localFilename: '355_test.sql',
          schemaPresent: true,
        }],
      },
      FL,
      ABSENT,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('remoteName');
  });

  it('mapping missing required fields -> BLOCKED', () => {
    const result = validateTimestampMappings(
      { mappings: [{ remoteVersion: '20260902052231' }] },
      FL,
      ABSENT,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('missing required fields');
  });

  it('mapping non-timestamp remoteVersion -> BLOCKED', () => {
    const result = validateTimestampMappings(
      {
        mappings: [{
          remoteVersion: '355',
          remoteName: '355_test',
          repoVersion: 355,
          localFilename: '355_test.sql',
          schemaPresent: true,
        }],
      },
      FL,
      ABSENT,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('not a valid timestamp');
  });

  it('mapping not an object -> invalid', () => {
    const result = validateTimestampMappings(null, FL, ABSENT);
    expect(result.valid).toBe(false);
  });

  it('mapping without mappings array -> invalid', () => {
    const result = validateTimestampMappings({ foo: 'bar' }, FL, ABSENT);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('mappings');
  });

  it('mapping schemaPresent not boolean -> invalid', () => {
    const result = validateTimestampMappings(
      {
        mappings: [{
          remoteVersion: '20260902052231',
          remoteName: '355_test',
          repoVersion: 355,
          localFilename: '355_test.sql',
          contentHash: 'a'.repeat(64),
          schemaPresent: 'yes',
        }],
      },
      FL,
      ABSENT,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('boolean');
  });

  it('valid mapping -> valid', () => {
    const result = validateTimestampMappings(
      {
        mappings: [{
          remoteVersion: '20260902052231',
          remoteName: '355_test',
          repoVersion: 355,
          localFilename: '355_test.sql',
          contentHash: 'a'.repeat(64), // valid SHA-256 format; file doesn't exist so content check skipped
          schemaPresent: true,
        }],
      },
      FL,
      ABSENT,
    );
    expect(result.valid).toBe(true);
    expect(result.mappings).toBeInstanceOf(Map);
    expect(result.mappings.size).toBe(1);
  });

  it('missing contentHash -> invalid', () => {
    const result = validateTimestampMappings(
      {
        mappings: [{
          remoteVersion: '20260902052231',
          remoteName: '355_test',
          repoVersion: 355,
          localFilename: '355_test.sql',
          schemaPresent: true,
        }],
      },
      FL,
      ABSENT,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('missing required contentHash');
  });

  it('malformed contentHash -> invalid', () => {
    const result = validateTimestampMappings(
      {
        mappings: [{
          remoteVersion: '20260902052231',
          remoteName: '355_test',
          repoVersion: 355,
          localFilename: '355_test.sql',
          contentHash: 'not-a-sha256',
          schemaPresent: true,
        }],
      },
      FL,
      ABSENT,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('not a valid SHA-256');
  });

  it('duplicate repoVersion across mappings -> invalid', () => {
    const result = validateTimestampMappings(
      {
        mappings: [
          {
            remoteVersion: '20260902052231',
            remoteName: '355_test',
            repoVersion: 355,
            localFilename: '355_test.sql',
            contentHash: 'a'.repeat(64),
            schemaPresent: true,
          },
          {
            remoteVersion: '20260902099999',
            remoteName: '355_test',
            repoVersion: 355,
            localFilename: '355_test.sql',
            contentHash: 'a'.repeat(64),
            schemaPresent: true,
          },
        ],
      },
      FL,
      ABSENT,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Duplicate repoVersion 355');
  });

  it('duplicate remoteVersion -> invalid', () => {
    const result = validateTimestampMappings(
      {
        mappings: [
          {
            remoteVersion: '20260902052231',
            remoteName: '355_test',
            repoVersion: 355,
            localFilename: '355_test.sql',
            contentHash: 'a'.repeat(64),
            schemaPresent: true,
          },
          {
            remoteVersion: '20260902052231',
            remoteName: '355_test',
            repoVersion: 355,
            localFilename: '355_test.sql',
            contentHash: 'a'.repeat(64),
            schemaPresent: true,
          },
        ],
      },
      FL,
      ABSENT,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Duplicate remoteVersion');
  });
});

describe('no write path', () => {
  it('no apply_migration', () => {
    expect(readFileSync(resolve('scripts/migration-reconciliation-planner.js'), 'utf-8')).not.toContain('apply_migration');
  });
  it('no DB writes', () => {
    const s = readFileSync(resolve('scripts/migration-reconciliation-planner.js'), 'utf-8');
    expect(s).not.toContain('INSERT INTO');
    expect(s).not.toContain('createClient');
  });
});

describe('CLI exit codes', () => {
  function writeTempFiles(dir: string, history: object, schema: object, mapping: object) {
    writeFileSync(join(dir, 'h.json'), JSON.stringify(history));
    writeFileSync(join(dir, 's.json'), JSON.stringify(schema));
    writeFileSync(join(dir, 'm.json'), JSON.stringify(mapping));
  }

  function runCLI(args: string): { stdout: string; stderr: string; exitCode: number } {
    try {
      const stdout = execSync('node scripts/migration-reconciliation-planner.js ' + args, {
        encoding: 'utf-8',
        timeout: 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { stdout, stderr: '', exitCode: 0 };
    } catch (e: any) {
      return {
        stdout: e.stdout || '',
        stderr: e.stderr || '',
        exitCode: e.status ?? 1,
      };
    }
  }

  it('refuses no files -> exit 1', () => {
    const r = runCLI('');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('--timestamp-mapping-file');
  });

  it('missing mapping file -> exit 1', () => {
    const d = mkdtempSync('/tmp/r-');
    writeFileSync(join(d, 'h.json'), JSON.stringify({ versions: ['1'] }));
    writeFileSync(join(d, 's.json'), JSON.stringify(SP));
    const r = runCLI(
      '--remote-history-file ' + join(d, 'h.json') +
      ' --schema-evidence-file ' + join(d, 's.json') +
      ' --timestamp-mapping-file ' + join(d, 'NONEXISTENT.json')
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('not found');
    rmSync(d, { recursive: true });
  });

  it('READY -> exit 0', () => {
    const d = mkdtempSync('/tmp/r-');
    const local = readLocalMigrations();
    const through354 = local.migrations
      .filter((m: any) => m.version <= 354)
      .map((m: any) => String(m.version));
    // 355 is applied numerically
    const history = { versions: [...through354, '355'] };
    writeTempFiles(d, history, SP, { mappings: [] });
    const r = runCLI(
      '--remote-history-file ' + join(d, 'h.json') +
      ' --schema-evidence-file ' + join(d, 's.json') +
      ' --timestamp-mapping-file ' + join(d, 'm.json')
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('READY');
    expect(r.stdout).toContain('EXECUTABLE: true');
    rmSync(d, { recursive: true });
  });

  it('REPAIR_REQUIRED -> exit 2', () => {
    const d = mkdtempSync('/tmp/r-');
    const local = readLocalMigrations();
    const through354 = local.migrations
      .filter((m: any) => m.version <= 354)
      .map((m: any) => String(m.version));
    const history = { versions: [...through354, '20260902052231'] };
    const m355 = local.migrations.find((m: any) => m.version === 355);
    const { createHash: ch } = require('crypto');
    const content355 = readFileSync(resolve('supabase/migrations', m355.filename), 'utf-8');
    const hash355 = ch('sha256').update(content355).digest('hex');
    const mapping = {
      mappings: [{
        remoteVersion: '20260902052231',
        remoteName: m355.filename.replace(/\.sql$/, ''),
        repoVersion: 355,
        localFilename: m355.filename,
        contentHash: hash355,
        schemaPresent: true,
      }],
    };
    writeTempFiles(d, history, SP, mapping);
    const r = runCLI(
      '--remote-history-file ' + join(d, 'h.json') +
      ' --schema-evidence-file ' + join(d, 's.json') +
      ' --timestamp-mapping-file ' + join(d, 'm.json')
    );
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain('REPAIR_REQUIRED');
    expect(r.stdout).toContain('EXECUTABLE: false');
    expect(r.stdout).toContain('non-executable');
    rmSync(d, { recursive: true });
  });

  it('BLOCKED -> exit 1', () => {
    const d = mkdtempSync('/tmp/r-');
    const local = readLocalMigrations();
    const through354 = local.migrations
      .filter((m: any) => m.version <= 354)
      .map((m: any) => String(m.version));
    const history = { versions: [...through354, '20260902052231'] };
    // No mapping for the timestamp -> unmapped -> BLOCKED
    writeTempFiles(d, history, SP, { mappings: [] });
    const r = runCLI(
      '--remote-history-file ' + join(d, 'h.json') +
      ' --schema-evidence-file ' + join(d, 's.json') +
      ' --timestamp-mapping-file ' + join(d, 'm.json')
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('BLOCKED');
    rmSync(d, { recursive: true });
  });
});

describe('validateTimestampMappings with real files', () => {
  it('contentHash verification against real migration file', () => {
    const local = readLocalMigrations();
    const m355 = local.migrations.find((m: any) => m.version === 355);
    const { createHash } = require('crypto');
    const content = readFileSync(resolve('supabase/migrations', m355.filename), 'utf-8');
    const correctHash = createHash('sha256').update(content).digest('hex');

    // Correct hash
    const good = validateTimestampMappings(
      {
        mappings: [{
          remoteVersion: '20260902052231',
          remoteName: m355.filename.replace(/\.sql$/, ''),
          repoVersion: 355,
          localFilename: m355.filename,
          contentHash: correctHash,
          schemaPresent: true,
        }],
      },
      local.migrations,
      ABSENT,
      resolve('supabase/migrations'),
    );
    expect(good.valid).toBe(true);

    // Wrong hash
    const bad = validateTimestampMappings(
      {
        mappings: [{
          remoteVersion: '20260902052231',
          remoteName: m355.filename.replace(/\.sql$/, ''),
          repoVersion: 355,
          localFilename: m355.filename,
          contentHash: 'deadbeef'.repeat(8), // 64 chars, valid format but wrong hash
          schemaPresent: true,
        }],
      },
      local.migrations,
      ABSENT,
      resolve('supabase/migrations'),
    );
    expect(bad.valid).toBe(false);
    expect(bad.reason).toContain('hash mismatch');
  });
});

describe('354 regression', () => {
  it('remoteThrough(354) produces correct versions with gaps', () => {
    const v = remoteThrough(354);
    // Should NOT contain 43-55, 249-291, 352
    expect(v.includes('43')).toBe(false);
    expect(v.includes('55')).toBe(false);
    expect(v.includes('249')).toBe(false);
    expect(v.includes('291')).toBe(false);
    expect(v.includes('352')).toBe(false);
    // Should contain boundaries
    expect(v.includes('1')).toBe(true);
    expect(v.includes('42')).toBe(true);
    expect(v.includes('56')).toBe(true);
    expect(v.includes('248')).toBe(true);
    expect(v.includes('292')).toBe(true);
    expect(v.includes('354')).toBe(true);
  });
});

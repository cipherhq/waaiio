import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { loadLock, loadLockMap, ledgerSnapshot, verifyLedger, verifyCatalog, verifyM430Absent, loadM430, postBootstrapMigrations, admitDatabase } from '../release-v3/admission.mjs';
import { catalogMap, catalogAggregate, applyDeltas, validateDelta, compareCatalogs, diffCatalog, CATALOG_QUERY_SHA256, ORACLE } from '../release-v3/catalog-oracle.mjs';
import { canonicalJson } from '../release-v3/common.mjs';
import { GUARD_BODY_SHA256 } from '../release-v3/db-observe.mjs';
const GUARD = { enabled: 'A', event: 'login', body_sha256: GUARD_BODY_SHA256, owner: 'postgres', language: 'plpgsql', definer: false, config: ['search_path=pg_catalog'] };
const REPLICA = { in_recovery: true, replica_guard: GUARD, replica_freshness: { receive_lsn: '0/5000060', replay_lsn: '0/5000060', replay_age_seconds: 12 } };

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const h = (n: number) => sha(String(n));
const row = (version: string, name: string, statement: string | null = 'x', count: number | null = 1) =>
  ({ version, name, statement_count: count, statement_sha256: statement === null ? null : sha(statement), row_sha256: sha(`${version}:${name}:${statement}`) });

const baseRows = [row('1', 'one'), row('2', 'two', null, null), row('20261103223154', '508_business_control_columns_guard')];
const baseCatalog = catalogMap([{ identity: 'function:public.a()', digest: h(1) }, { identity: 'table:public.t', digest: h(2) }, { identity: 'column:public.t.c', digest: h(3) }]);
const lockEnv = (rows = baseRows, catalog = baseCatalog) => ({ project_ref: 'cxcmiqotkowhxinjbytg', catalog: { count: catalog.size, sha256: catalogAggregate(catalog) }, ledger: ledgerSnapshot(rows), catalog_map: null });
const delta = (name: string, file: string, changes: unknown[]) => ({ schema_version: 1, migration: `${name}.sql`, migration_sha256: sha(file), query_sha256: CATALOG_QUERY_SHA256,
  postgres_major: 17, applied_as: 'one-whole-file-statement', changes });
const m509file = 'create function public.b() returns int language sql as $$select 1$$;';
const m509 = { name: '509_add_b', path: 'supabase/migrations/509_add_b.sql', sha256: sha(m509file),
  delta: delta('509_add_b', m509file, [{ identity: 'function:public.b()', operation: 'add', after_sha256: h(9), after: { owner: 'postgres' } }]) };

describe('committed lock, oracle outputs and the M508 spike regression', () => {
  const lock = loadLock();
  it('the lock is the post-M508 bootstrap with the current queries; certified merchant 2b578c5b (deploy run 41937185420) and admin bdc007a8', () => {
    expect(lock.bootstrap_migration).toBe('508_business_control_columns_guard.sql');
    expect(lock.certified).toEqual({ merchant: '2b578c5bef4411aaf35bc6b60f61237620915c3a', admin: 'bdc007a8f93febeee8ce054d075d48894afd37bb' });
    expect(lock.environments.production).toMatchObject({ project_ref: 'cxcmiqotkowhxinjbytg', catalog: { count: 6288 }, ledger: { count: 406 } });
    // Owner decision 2026-11-04 (option A): staging grants release_observer USAGE on schema public, so the
    // staging lock records the new schema:public ACL (#875).
    expect(lock.observed.staging_public_usage).toMatchObject({ changed_identity: 'schema:public',
      previous_digest: '070c88e2814f7ad1e4866a6498450d699904a0ba6fc4dcf9808f521beda0fe62',
      new_digest: 'a895bb3ae86a9e04638d702d3b81c31efe1cb633fc434372a367cf3037a59f2f',
      previous_catalog: { count: 6400, sha256: '80f4ec206aa8cd301e76a46b0095e05c395ef3ea7f9b4b22db0a91425111354f' } });
    // Owner decision 2026-11-04 (#813 option A, staging plan S1): the staging entry then leaves out #813's
    // 91 catalog objects and 2 ledger rows (scripts/release-v3/staging-813-teardown.sql removes them).
    expect(lock.environments.staging).toEqual({ project_ref: 'tqjvrzopvtczxfxiwmnz', catalog_map: 'scripts/release-v3/lock-catalog-staging.json',
      catalog: { count: 6309, sha256: '567d514762deea655bf2b944d23ee84e26fb506b083c0eedc558ec0f235d9638' },
      ledger: { count: 442, sha256: 'dca1b4e090e9876be8f73d210771c905234c2d473f4b98fa15aa7966e74fe5b6' } });
    expect(lock.observed.staging_813_teardown.previous).toEqual({
      catalog: { count: 6400, sha256: '12ff1745a19c0fda57d11971782d58cca353c0fd9f73b438786de899d69df463' },
      ledger: { count: 444, sha256: 'adcdf3e9893b6ea4fd5940a66375af4a96ba963ba4efaad9f1ad38fe17ab9be5' } });
  });
  it('rejects a lock made with another catalog query or with extra keys', () => {
    const text = readFileSync('scripts/release-v3/lock.json', 'utf8');
    expect(() => loadLock(text.replace(CATALOG_QUERY_SHA256, 'f'.repeat(64)))).toThrow('different query');
    const extra = JSON.parse(text); extra.override = true;
    expect(() => loadLock(JSON.stringify(extra))).toThrow('Release lock is invalid or was made with a different query');
  });
  it('the PG17 oracle delta for M508 equals the change measured in production (bot-code-lock contract)', () => {
    const file = readFileSync('supabase/migrations/508_business_control_columns_guard.sql');
    const d = validateDelta(JSON.parse(readFileSync('supabase/catalog-deltas/508_business_control_columns_guard.json', 'utf8')), '508_business_control_columns_guard.sql', sha(file));
    const measured = JSON.parse(readFileSync('scripts/bot-code-lock-contracts.json', 'utf8')).catalog.production.patches;
    expect(d.changes.map((c: { identity: string; operation: string }) => [c.identity, c.operation])).toEqual([
      ['function:public.guard_business_insert()', 'add'], ['function:public.guard_server_managed_columns()', 'modify'], ['trigger:public.businesses.trg_guard_business_insert', 'add']]);
    for (const c of d.changes) {
      const p = measured.find((x: { identity: string }) => x.identity === c.identity);
      if (p.operation === 'add') expect(c.after).toEqual(p.value);
      else expect(c.after.body_sha256).toBe(p.fields.body_sha256);
    }
    // Digests read from live production (read-only connector, 2026-11-03).
    expect(Object.fromEntries(d.changes.map((c: { identity: string; after_sha256: string }) => [c.identity, c.after_sha256]))).toEqual({
      'function:public.guard_business_insert()': '42e8833707aeafe9e6f638f052fbdc52af0f096ad58028a2620b5b63358d05e2',
      'function:public.guard_server_managed_columns()': 'c1e52d9ad3a8a245ba792ab05396be0c3c7e38214f6e8a0b09235824d164cf56',
      'trigger:public.businesses.trg_guard_business_insert': '29acb85b9591345154320d177574878b3199ad2362f6e06597672559ca1554e4' });
  });
  it('the lock maps match the approved lock digests, and the lock records the schema 9 tie-out', () => {
    expect(loadLockMap(lock.environments.production).size).toBe(6288);
    const stagingMap = loadLockMap(lock.environments.staging);
    expect(stagingMap.size).toBe(6309);
    expect(stagingMap.get('schema:public')).toBe('a895bb3ae86a9e04638d702d3b81c31efe1cb633fc434372a367cf3037a59f2f');
    expect([...stagingMap.keys()].filter(id => /merchant_notification|merchant_(order|booking|reservation|payment)_alert|merchant_(recipient|delivery)_owner_read/.test(id))).toEqual([]);
    expect(lock.observed.bootstrap_release).toMatchObject({ manifest_sha256: 'efd245eba525d00d561621d43b0be513e984e7626e95498b365f97ac46206a50', deploy_run_id: 41749354633 });
    const edited = JSON.parse(readFileSync('scripts/release-v3/lock-catalog-production.json', 'utf8'));
    edited.objects['table:public.businesses'] = 'f'.repeat(64);
    const dir = mkdtempSync(join(tmpdir(), 'v3-map-')); mkdirSync(join(dir, 'scripts/release-v3'), { recursive: true });
    writeFileSync(join(dir, 'scripts/release-v3/lock-catalog-production.json'), JSON.stringify(edited));
    expect(() => loadLockMap(lock.environments.production, new URL(`file://${dir}/`))).toThrow('Lock catalog map does not match the approved lock digest');
    rmSync(dir, { recursive: true, force: true });
  });
  it('the M430 list is bound to the exact bytes of the 430 file', () => {
    expect(() => loadM430(readFileSync('scripts/release-v3/m430-identities.json', 'utf8'), Buffer.from('edited 430'))).toThrow('M430 identity list is invalid');
  });
  it('the generated M430 list covers the known shared-number objects', () => {
    const m430 = loadM430();
    expect(m430.source_sha256).toBe(sha(readFileSync(`supabase/migrations/${ORACLE.m430_file}`)));
    expect(m430.added_identities).toEqual(expect.arrayContaining(['function:public.allocate_shared_channel(p_business_id uuid, p_country_code text)',
      'function:public.reassign_shared_channel(p_business_id uuid, p_new_channel_id uuid)', 'function:public.transition_to_shared(p_business_id uuid)']));
  });
});

describe('ledger admission (complete set, exact statements)', () => {
  it('accepts the lock ledger with no admitted migrations', () => expect(verifyLedger(baseRows, lockEnv(), [], 'production')).toMatchObject({ count: 3, additions: [] }));
  it('accepts one admitted migration applied as one exact whole-file statement', () => {
    const rows = [...baseRows, { ...row('20261110', '509_add_b'), statement_sha256: m509.sha256 }];
    expect(verifyLedger(rows, lockEnv(), [m509], 'production').additions).toEqual(['509_add_b']);
  });
  it('fails closed when a merged migration is missing from the ledger (merged but not applied)', () =>
    expect(() => verifyLedger(baseRows, lockEnv(), [m509], 'production')).toThrow('merged but not applied'));
  it('fails on a ledger statement sha mismatch', () => {
    const rows = [...baseRows, { ...row('20261110', '509_add_b'), statement_sha256: sha('different bytes') }];
    expect(() => verifyLedger(rows, lockEnv(), [m509], 'production')).toThrow('not the exact reviewed file');
  });
  it('fails when the migration was applied as several statements', () => {
    const rows = [...baseRows, { ...row('20261110', '509_add_b'), statement_count: 2, statement_sha256: null }];
    expect(() => verifyLedger(rows, lockEnv(), [m509], 'production')).toThrow('not the exact reviewed file');
  });
  it('fails on a stale baseline: an unknown ledger row or a changed historic row', () => {
    expect(() => verifyLedger([...baseRows, row('20261111', 'manual_fix')], lockEnv(), [], 'production')).toThrow('stale baseline or unknown ledger row');
    expect(() => verifyLedger([row('1', 'one', 'changed'), ...baseRows.slice(1)], lockEnv(), [], 'production')).toThrow('stale baseline');
    expect(() => verifyLedger(baseRows.slice(1), lockEnv(), [], 'production')).toThrow('stale baseline');
  });
  it('fails when M430 is recorded in the production ledger (staging may keep it)', () => {
    const rows = [...baseRows, row('20261012131222', '430_shared_number_tenant_isolation')];
    expect(() => verifyLedger(rows, lockEnv(rows), [], 'production')).toThrow('M430');
    expect(() => verifyLedger(rows, lockEnv(rows), [], 'staging')).not.toThrow();
  });
});

describe('catalog admission (lock + reviewed deltas, exact equality)', () => {
  it('accepts the exact lock catalog and rejects any drift', () => {
    expect(verifyCatalog(baseCatalog, lockEnv(), [], 'production', null).sha256).toBe(catalogAggregate(baseCatalog));
    const drift = new Map(baseCatalog); drift.set('column:public.t.c', h(99));
    expect(() => verifyCatalog(drift, lockEnv(), [], 'production', null)).toThrow('differs from the approved lock');
    const extra = new Map(baseCatalog); extra.set('policy:public.t.p', h(5));
    expect(() => verifyCatalog(extra, lockEnv(), [], 'production', null)).toThrow('differs');
  });
  it('requires the lock catalog map once a migration changes the catalog (fails closed until bootstrapped)', () => {
    const after = new Map(baseCatalog); after.set('function:public.b()', h(9));
    expect(() => verifyCatalog(after, lockEnv(), [m509], 'production', null)).toThrow('not bootstrapped');
    expect(verifyCatalog(after, lockEnv(), [m509], 'production', baseCatalog).count).toBe(4);
  });
  it('names differing objects when production differs from lock + deltas', () => {
    const after = new Map(baseCatalog); after.set('function:public.b()', h(10));
    expect(() => verifyCatalog(after, lockEnv(), [m509], 'production', baseCatalog)).toThrow('function:public.b()');
  });
  it('applies deltas strictly: add must be new, modify/remove must exist', () => {
    const add = delta('x', 'x', [{ identity: 'table:public.t', operation: 'add', after_sha256: h(1), after: {} }]);
    expect(() => applyDeltas(baseCatalog, [add])).toThrow('adds an existing object');
    expect(() => applyDeltas(baseCatalog, [delta('x', 'x', [{ identity: 'table:public.zz', operation: 'remove' }])])).toThrow('removes a missing');
    expect(() => applyDeltas(baseCatalog, [delta('x', 'x', [{ identity: 'table:public.zz', operation: 'modify', after_sha256: h(1), after: {} }])])).toThrow('modifies a missing');
    const removed = applyDeltas(baseCatalog, [delta('x', 'x', [{ identity: 'column:public.t.c', operation: 'remove' }])]);
    expect(compareCatalogs(removed, baseCatalog)).toEqual(['column:public.t.c']);
  });
  it('rejects deltas from another query, another PostgreSQL major, other file bytes, or unsorted', () => {
    const good = delta('509_add_b', m509file, []);
    expect(() => validateDelta({ ...good, query_sha256: 'a'.repeat(64) }, '509_add_b.sql', sha(m509file))).toThrow('stale');
    expect(() => validateDelta({ ...good, postgres_major: 16 }, '509_add_b.sql', sha(m509file))).toThrow('PostgreSQL 17');
    expect(() => validateDelta(good, '509_add_b.sql', sha('edited'))).toThrow('stale');
    const unsorted = delta('509_add_b', m509file, [{ identity: 'table:public.b', operation: 'remove' }, { identity: 'table:public.a', operation: 'remove' }]);
    expect(() => validateDelta(unsorted, '509_add_b.sql', sha(m509file))).toThrow('Invalid catalog delta entry');
  });
  it('diffCatalog reports adds, modifies and removes in C order', () => {
    const before = [{ identity: 'table:public.a', digest: h(1), value: {} }, { identity: 'table:public.b', digest: h(2), value: {} }];
    const after = [{ identity: 'table:public.b', digest: h(3), value: { v: 1 } }, { identity: 'table:public.c', digest: h(4), value: { v: 2 } }];
    expect(diffCatalog(before, after).map((c: { identity: string; operation: string }) => [c.identity, c.operation])).toEqual([['table:public.a', 'remove'], ['table:public.b', 'modify'], ['table:public.c', 'add']]);
  });
});

describe('M430 is never in production', () => {
  const m430 = { added_identities: ['function:public.allocate_shared_channel(p_business_id uuid, p_country_code text)'] };
  it('passes when absent and fails when any M430 object is present', () => {
    expect(verifyM430Absent(baseCatalog, m430)).toEqual({ checked: 1, present: 0 });
    const withM430 = new Map(baseCatalog); withM430.set(m430.added_identities[0], h(7));
    expect(() => verifyM430Absent(withM430, m430)).toThrow('M430 objects present in production');
  });
  it('admitDatabase applies the M430 check to production only', () => {
    const lock = { environments: { production: lockEnv(), staging: { ...lockEnv(), project_ref: 'tqjvrzopvtczxfxiwmnz' } } };
    const withM430 = new Map(baseCatalog); withM430.set(m430.added_identities[0], h(7));
    const stagingLock = { environments: { ...lock.environments, staging: { ...lockEnv(baseRows, withM430), project_ref: 'tqjvrzopvtczxfxiwmnz' } } };
    expect(() => admitDatabase({ observation: { environment: 'production', project_ref: 'cxcmiqotkowhxinjbytg', ledger: baseRows, catalog: withM430, ...REPLICA }, lock: { environments: { production: lockEnv(baseRows, withM430) } }, migrations: [], lockMap: null, m430 })).toThrow('M430');
    expect(admitDatabase({ observation: { environment: 'staging', project_ref: 'tqjvrzopvtczxfxiwmnz', ledger: baseRows, catalog: withM430 }, lock: stagingLock, migrations: [], lockMap: null, m430 }).m430).toBeUndefined();
    expect(() => admitDatabase({ observation: { environment: 'production', project_ref: 'tqjvrzopvtczxfxiwmnz', ledger: baseRows, catalog: baseCatalog, ...REPLICA }, lock, migrations: [], lockMap: null, m430 })).toThrow('wrong project');
  });
});

describe('production is observed only on a guarded read replica', () => {
  const lock = { environments: { production: lockEnv() } };
  const obs = (over: Record<string, unknown>) => ({ environment: 'production', project_ref: 'cxcmiqotkowhxinjbytg', ledger: baseRows, catalog: baseCatalog, ...REPLICA, ...over });
  it('accepts a replica with the reviewed, enabled guard', () => expect(admitDatabase({ observation: obs({}), lock, migrations: [], lockMap: null, m430: { added_identities: [] } }).environment).toBe('production'));
  it.each([
    [{ in_recovery: false }, 'must run on a read replica'],
    [{ replica_guard: null }, 'replica-only login guard is missing'],
    [{ replica_guard: { ...GUARD, enabled: 'D' } }, 'replica-only login guard is missing, disabled'],
    [{ replica_guard: { ...GUARD, enabled: 'O' } }, 'replica-only login guard is missing, disabled'],
    [{ replica_guard: { ...GUARD, body_sha256: 'f'.repeat(64) } }, 'not the reviewed version'],
    [{ replica_guard: { ...GUARD, event: 'ddl_command_start' } }, 'replica-only login guard'],
    [{ replica_guard: { ...GUARD, owner: 'release_observer' } }, 'not the reviewed version'],
    [{ replica_guard: { ...GUARD, definer: true } }, 'not the reviewed version'],
    [{ replica_guard: { ...GUARD, config: null } }, 'not the reviewed version'],
    [{ replica_freshness: null }, 'replica is not caught up'],
    [{ replica_freshness: { receive_lsn: '0/6000000', replay_lsn: '0/5000060', replay_age_seconds: 12 } }, 'replica is not caught up'],
    [{ replica_freshness: { receive_lsn: '0/5000060', replay_lsn: '0/5000060', replay_age_seconds: 66 * 60 } }, 'replica is not caught up'],
    [{ replica_freshness: { receive_lsn: null, replay_lsn: null, replay_age_seconds: null } }, 'replica is not caught up'],
  ])('refuses %j', (over, message) => expect(() => admitDatabase({ observation: obs(over), lock, migrations: [], lockMap: null, m430: { added_identities: [] } })).toThrow(message));
  it('the freshness limit is the Owner-set 65 minutes: an hour-old replay passes, 65 min + 1 s does not', () => {
    const ok = obs({ replica_freshness: { receive_lsn: '0/5000060', replay_lsn: '0/5000060', replay_age_seconds: 60 * 60 } });
    expect(admitDatabase({ observation: ok, lock, migrations: [], lockMap: null, m430: { added_identities: [] } }).environment).toBe('production');
    const late = obs({ replica_freshness: { receive_lsn: '0/5000060', replay_lsn: '0/5000060', replay_age_seconds: 65 * 60 + 1 } });
    expect(() => admitDatabase({ observation: late, lock, migrations: [], lockMap: null, m430: { added_identities: [] } })).toThrow('replica is not caught up');
  });
  it('staging needs no replica', () => {
    const stagingLock = { environments: { staging: { ...lockEnv(), project_ref: 'tqjvrzopvtczxfxiwmnz' } } };
    expect(admitDatabase({ observation: { environment: 'staging', project_ref: 'tqjvrzopvtczxfxiwmnz', ledger: baseRows, catalog: baseCatalog, in_recovery: false, replica_guard: null }, lock: stagingLock, migrations: [], lockMap: null, m430: { added_identities: [] } }).environment).toBe('staging');
  });
});

describe('post-bootstrap migrations read from the target commit', { timeout: 60_000 }, () => {
  function repo(files: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'v3-adm-'));
    const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
    g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
    for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c); }
    g('add', '-A'); g('commit', '-qm', 'c'); return { dir, target: g('rev-parse', 'HEAD') };
  }
  const lock = { bootstrap_migration: '508_business_control_columns_guard.sql' };
  const base = { 'supabase/migrations/430_shared_number_tenant_isolation.sql': 'm430', 'supabase/migrations/508_business_control_columns_guard.sql': 'm508' };
  it('returns nothing when the bootstrap migration is the last one', () => {
    const r = repo(base);
    expect(postBootstrapMigrations(r.dir, r.target, lock, [])).toEqual([]);
    rmSync(r.dir, { recursive: true, force: true });
  });
  it('admits a later migration only with its committed delta', () => {
    const withDelta = repo({ ...base, 'supabase/migrations/509_add_b.sql': m509file, 'supabase/catalog-deltas/509_add_b.json': canonicalJson(m509.delta) });
    expect(postBootstrapMigrations(withDelta.dir, withDelta.target, lock, []).map((m: { name: string; sha256: string }) => [m.name, m.sha256])).toEqual([['509_add_b', m509.sha256]]);
    const noDelta = repo({ ...base, 'supabase/migrations/509_add_b.sql': m509file });
    expect(() => postBootstrapMigrations(noDelta.dir, noDelta.target, lock, [])).toThrow('Catalog delta missing');
    const stale = repo({ ...base, 'supabase/migrations/509_add_b.sql': `${m509file}\n-- edited`, 'supabase/catalog-deltas/509_add_b.json': canonicalJson(m509.delta) });
    expect(() => postBootstrapMigrations(stale.dir, stale.target, lock, [])).toThrow('stale');
    for (const r of [withDelta, noDelta, stale]) rmSync(r.dir, { recursive: true, force: true });
  });
  it('never admits migration 430 (by number or name), and rejects edits to migrations inside the lock', () => {
    const r = repo(base);
    expect(() => postBootstrapMigrations(r.dir, r.target, lock, ['supabase/migrations/430_shared_number_tenant_isolation.sql'])).toThrow('inside the lock');
    expect(() => postBootstrapMigrations(r.dir, r.target, lock, ['supabase/migrations/508_business_control_columns_guard.sql'])).toThrow('inside the lock');
    const renamed = repo({ ...base, 'supabase/migrations/530_shared_number_tenant_isolation.sql': 'x' });
    expect(() => postBootstrapMigrations(renamed.dir, renamed.target, lock, [])).toThrow('never admit migration 430');
    const numbered = repo({ ...base, 'supabase/migrations/430b_other.sql': 'x' });
    expect(() => postBootstrapMigrations(numbered.dir, numbered.target, { bootstrap_migration: '430_shared_number_tenant_isolation.sql' }, [])).toThrow('never admit migration 430');
    for (const x of [r, renamed, numbered]) rmSync(x.dir, { recursive: true, force: true });
  });
});

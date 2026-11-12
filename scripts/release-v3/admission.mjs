// Database admission for Release V3 (RELEASE_GATE_V2.md §9.2, §9.5).
//
// Expected state of an environment = the Owner-approved lock (bootstrap state)
// plus every migration after the lock, each:
//  - present in the repository at the target with a committed catalog delta;
//  - applied in that environment as ONE ledger row whose single statement is
//    the exact file bytes (merged but not applied fails closed).
// The live ledger minus those rows must equal the lock's ledger digest, and the
// live catalog must equal lock + deltas exactly. Production must also contain
// no M430 object and no M430 ledger row.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fail, sha256, byteCompare, exactKeys, HASH, SHA } from './common.mjs';
import { CATALOG_QUERY_SHA256, ORACLE, catalogMap, catalogAggregate, validateDelta, applyDeltas, compareCatalogs } from './catalog-oracle.mjs';
import { LEDGER_QUERY_SHA256, ENVIRONMENTS, requireReplica } from './db-observe.mjs';

const here = file => new URL(file, import.meta.url);
const M430_NAMES = ['430_shared_number_tenant_isolation', 'shared_number_tenant_isolation'];
const MIGRATION = /^supabase\/migrations\/(([0-9]{3})[a-z]?_[a-z0-9_]+)\.sql$/;

export function loadLock(text = readFileSync(here('./lock.json'), 'utf8')) {
  let lock; try { lock = JSON.parse(text); } catch { fail('Release lock is not valid JSON'); }
  const keys = ['schema_version', 'bootstrap_migration', 'certified', 'catalog_query_sha256', 'ledger_query_sha256', 'environments', 'observed', 'reviewed_prs'];
  if (!(exactKeys(lock, keys) || exactKeys(lock, [...keys, 'recertified']))
    || lock.schema_version !== 1 || !/^[0-9]{3}_[a-z0-9_]+\.sql$/.test(lock.bootstrap_migration || '')
    || !exactKeys(lock.certified, ['merchant', 'admin']) || !SHA.test(lock.certified.merchant) || !SHA.test(lock.certified.admin)
    || lock.catalog_query_sha256 !== CATALOG_QUERY_SHA256 || lock.ledger_query_sha256 !== LEDGER_QUERY_SHA256
    || !exactKeys(lock.environments, Object.keys(ENVIRONMENTS))) fail('Release lock is invalid or was made with a different query');
  for (const [name, env] of Object.entries(lock.environments)) {
    if (!exactKeys(env, ['project_ref', 'catalog', 'ledger', 'catalog_map']) || env.project_ref !== ENVIRONMENTS[name].project_ref
      || !exactKeys(env.catalog, ['count', 'sha256']) || !Number.isSafeInteger(env.catalog.count) || !HASH.test(env.catalog.sha256)
      || !exactKeys(env.ledger, ['count', 'sha256']) || !Number.isSafeInteger(env.ledger.count) || !HASH.test(env.ledger.sha256)
      || !(env.catalog_map === null || env.catalog_map === `scripts/release-v3/lock-catalog-${name}.json`)) fail(`Release lock entry for ${name} is invalid`);
  }
  // Optional re-certification of the last release's deployments (docs: "Recovery").
  if ('recertified' in lock) {
    const re = lock.recertified;
    if (!exactKeys(re, ['after_deploy_run', 'sha', 'merchant_deployment_sha256', 'admin_deployment_sha256', 'reason'])
      || !Number.isSafeInteger(re.after_deploy_run) || re.after_deploy_run <= 0 || !SHA.test(re.sha)
      || !HASH.test(re.merchant_deployment_sha256) || !HASH.test(re.admin_deployment_sha256)
      || typeof re.reason !== 'string' || !re.reason.trim() || re.reason.length > 500) fail('Release lock re-certification is invalid');
  }
  if (!lock.reviewed_prs || typeof lock.reviewed_prs !== 'object' || Object.entries(lock.reviewed_prs).some(([n, sha]) => !/^[1-9][0-9]*$/.test(n) || !SHA.test(sha))) fail('Release lock review records are invalid');
  return lock;
}

// Ledger snapshot: sha256 over "version\trow_sha256\n" in C order.
export function ledgerSnapshot(rows) {
  const sorted = [...rows].sort((a, b) => byteCompare(a.version, b.version));
  return { count: sorted.length, sha256: sha256(sorted.map(r => `${r.version}\t${r.row_sha256}\n`).join('')) };
}

const gitShow = (repository, revision, path) => execFileSync('git', ['show', `${revision}:${path}`], { cwd: repository, maxBuffer: 64 * 1024 * 1024 });

// Migrations after the lock's bootstrap, read from the target commit.
export function postBootstrapMigrations(repository, target, lock, changedPaths) {
  const files = execFileSync('git', ['ls-tree', '--name-only', target, 'supabase/migrations/'], { cwd: repository, encoding: 'utf8' })
    .split('\n').filter(Boolean).filter(p => p.endsWith('.sql')).sort(byteCompare);
  const bootstrap = `supabase/migrations/${lock.bootstrap_migration}`;
  const index = files.indexOf(bootstrap);
  if (index < 0) fail('Lock bootstrap migration is missing at the target');
  // Migrations up to the bootstrap are immutable and already inside the lock.
  for (const path of changedPaths) {
    if (path.startsWith('supabase/migrations/') && byteCompare(path, bootstrap) <= 0) fail(`Release changes a migration inside the lock: ${path}`);
  }
  return files.slice(index + 1).map(path => {
    const match = MIGRATION.exec(path);
    if (!match) fail(`Unrecognised migration path ${path}`);
    const name = match[1];
    if (Number(match[2]) === 430 || name.replace(/^[0-9]{3}[a-z]?_/, '') === 'shared_number_tenant_isolation') fail('A release may never admit migration 430');
    const bytes = gitShow(repository, target, path);
    const fileSha = sha256(bytes);
    const deltaPath = `${ORACLE.delta_dir}/${name}.json`;
    let delta;
    try { delta = JSON.parse(gitShow(repository, target, deltaPath).toString('utf8')); } catch { fail(`Catalog delta missing for ${name}`); }
    validateDelta(delta, `${name}.sql`, fileSha);
    return { name, path, sha256: fileSha, delta };
  });
}

export function verifyLedger(rows, lockEnv, migrations, environment) {
  const admitted = new Map(migrations.map(m => [m.name, m]));
  const additions = rows.filter(r => admitted.has(r.name));
  for (const migration of migrations) {
    const found = additions.filter(r => r.name === migration.name);
    if (found.length === 0) fail(`Migration ${migration.name} is merged but not applied in ${environment}`);
    if (found.length !== 1 || found[0].statement_count !== 1 || found[0].statement_sha256 !== migration.sha256) fail(`Ledger row for ${migration.name} in ${environment} is not the exact reviewed file`);
  }
  if (environment === 'production' && rows.some(r => M430_NAMES.includes(r.name))) fail('M430 is recorded in the production ledger');
  const baseline = ledgerSnapshot(rows.filter(r => !admitted.has(r.name)));
  if (baseline.count !== lockEnv.ledger.count || baseline.sha256 !== lockEnv.ledger.sha256) fail(`${environment} ledger differs from the lock plus admitted migrations (stale baseline or unknown ledger row)`);
  return { count: rows.length, sha256: ledgerSnapshot(rows).sha256, additions: migrations.map(m => m.name) };
}

export function loadLockMap(lockEnv, root = new URL('../../', import.meta.url)) {
  if (!lockEnv.catalog_map) return null;
  const file = new URL(lockEnv.catalog_map, root);
  if (!existsSync(file)) fail('Lock catalog map file is missing');
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  if (doc?.schema_version !== 1 || doc.query_sha256 !== CATALOG_QUERY_SHA256 || doc.lock_catalog_sha256 !== lockEnv.catalog.sha256) fail('Lock catalog map header is invalid');
  const map = catalogMap(Object.entries(doc.objects || {}).map(([identity, digest]) => ({ identity, digest })));
  if (map.size !== lockEnv.catalog.count || catalogAggregate(map) !== lockEnv.catalog.sha256) fail('Lock catalog map does not match the approved lock digest');
  return map;
}

export function verifyCatalog(observed, lockEnv, migrations, environment, lockMap) {
  const changes = migrations.reduce((n, m) => n + m.delta.changes.length, 0);
  if (!changes) {
    if (observed.size !== lockEnv.catalog.count || catalogAggregate(observed) !== lockEnv.catalog.sha256) fail(`${environment} catalog differs from the approved lock`);
  } else {
    if (!lockMap) fail(`${environment} lock catalog map is not bootstrapped; releases with catalog changes are blocked until it is`);
    const expected = applyDeltas(lockMap, migrations.map(m => m.delta));
    const differing = compareCatalogs(expected, observed);
    if (differing.length) fail(`${environment} catalog differs from lock + reviewed deltas: ${differing.slice(0, 10).join(', ')}${differing.length > 10 ? ` (+${differing.length - 10} more)` : ''}`);
  }
  return { count: observed.size, sha256: catalogAggregate(observed) };
}

// The list is bound to the exact bytes of the 430 file it was generated from.
export function loadM430(text = readFileSync(here('./m430-identities.json'), 'utf8'), m430File = readFileSync(here(`../../supabase/migrations/${ORACLE.m430_file}`))) {
  const doc = JSON.parse(text);
  if (!exactKeys(doc, ['schema_version', 'source', 'source_sha256', 'query_sha256', 'added_identities']) || doc.schema_version !== 1
    || doc.source !== ORACLE.m430_file || doc.source_sha256 !== sha256(m430File) || doc.query_sha256 !== CATALOG_QUERY_SHA256
    || !Array.isArray(doc.added_identities) || !doc.added_identities.length) fail('M430 identity list is invalid');
  return doc;
}
export function verifyM430Absent(observed, m430) {
  const present = m430.added_identities.filter(id => observed.has(id));
  if (present.length) fail(`M430 objects present in production: ${present.join(', ')}`);
  return { checked: m430.added_identities.length, present: 0 };
}

// Full database admission for one environment.
export function admitDatabase({ observation, lock, migrations, lockMap, m430 }) {
  const environment = observation.environment, lockEnv = lock.environments[environment];
  if (!lockEnv || observation.project_ref !== lockEnv.project_ref) fail('Observation is for the wrong project');
  requireReplica(environment, observation);
  const ledger = verifyLedger(observation.ledger, lockEnv, migrations, environment);
  const catalog = verifyCatalog(observation.catalog, lockEnv, migrations, environment, lockMap);
  const result = { environment, project_ref: lockEnv.project_ref, ledger, catalog };
  if (environment === 'production') result.m430 = verifyM430Absent(observation.catalog, m430);
  return result;
}

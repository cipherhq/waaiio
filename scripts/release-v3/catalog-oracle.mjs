// Release V3 differential catalog oracle.
//
// Production cannot be rebuilt by replaying migrations, so the gate never
// compares production with a replayed database. Instead:
//  1. each migration after the lock's bootstrap gets a committed catalog delta,
//     generated here in disposable PostgreSQL 17 (the objects it adds, modifies
//     or removes, with their exact after-values);
//  2. CI regenerates every delta and requires byte equality (`check`);
//  3. the gate applies the deltas to the Owner-approved production lock and
//     requires exact equality with the live production catalog.
// Any difference fails closed. A wrong replay can only cause a false failure,
// never a silent pass, because the comparison is against live production.
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { fail, sha256, canonicalJson, byteCompare, exactKeys, HASH } from './common.mjs';

const here = file => new URL(file, import.meta.url);
export const CATALOG_QUERY = readFileSync(here('./catalog-v3.sql'), 'utf8');
export const CATALOG_QUERY_SHA256 = sha256(readFileSync(here('./catalog-v3.sql')));
export const ORACLE = Object.freeze({
  postgres_major: 17,
  // M430 stays on staging only, so the production-emulating replay skips it.
  // Its added objects are recorded separately (m430-identities.json).
  m430_file: '430_shared_number_tenant_isolation.sql',
  // Deltas are generated for this migration and every later one. 508 is the
  // last migration inside the bootstrap lock; its delta is kept as the oracle's
  // standing proof (it must equal the change measured in production).
  first_delta_version: 508,
  delta_dir: 'supabase/catalog-deltas',
  m430_list: 'scripts/release-v3/m430-identities.json',
});
const MIGRATION = /^([0-9]{3})[a-z]?_[a-z0-9_]+\.sql$/;
const IDENTITY = /^(schema|table|column|constraint|index|trigger|policy|function|type|publication):\S/;

export function migrationFiles(repoRoot) {
  const names = readdirSync(join(repoRoot, 'supabase/migrations')).filter(n => n.endsWith('.sql')).sort(byteCompare);
  return names.map(name => {
    const match = MIGRATION.exec(name);
    if (!match) fail(`Unrecognised migration file name: ${name}`);
    return { name, version: Number(match[1]), path: `supabase/migrations/${name}` };
  });
}

// rows: [{identity, digest}] from catalog-v3.sql. Returns Map identity -> digest.
export function catalogMap(rows) {
  if (!Array.isArray(rows) || rows.length > 50000) fail('Invalid catalog reading');
  const map = new Map();
  for (const row of rows) {
    if (!row || typeof row.identity !== 'string' || !IDENTITY.test(row.identity) || !HASH.test(row.digest || '')
      || map.has(row.identity)) fail('Invalid or duplicate catalog object');
    map.set(row.identity, row.digest);
  }
  return map;
}
// Equal to: SELECT encode(sha256(convert_to(string_agg(identity||E'\t'||digest||E'\n',''
//   ORDER BY identity COLLATE "C"),'UTF8')),'hex') FROM (catalog-v3.sql) q;
export function catalogAggregate(map) {
  return sha256([...map.keys()].sort(byteCompare).map(id => `${id}\t${map.get(id)}\n`).join(''));
}

export async function readCatalog(client) {
  const result = await client.query(CATALOG_QUERY);
  return result.rows.map(r => ({ identity: r.identity, digest: r.digest, value: r.value }));
}

export function diffCatalog(beforeRows, afterRows) {
  const before = catalogMap(beforeRows), after = catalogMap(afterRows);
  const values = new Map(afterRows.map(r => [r.identity, r.value]));
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort(byteCompare);
  const changes = [];
  for (const identity of ids) {
    const b = before.get(identity), a = after.get(identity);
    if (b === a) continue;
    if (b === undefined) changes.push({ identity, operation: 'add', after_sha256: a, after: values.get(identity) });
    else if (a === undefined) changes.push({ identity, operation: 'remove' });
    else changes.push({ identity, operation: 'modify', after_sha256: a, after: values.get(identity) });
  }
  return changes;
}

export function deltaDocument(migration, fileBytes, changes) {
  return { schema_version: 1, migration: migration.name, migration_sha256: sha256(fileBytes),
    query_sha256: CATALOG_QUERY_SHA256, postgres_major: ORACLE.postgres_major, applied_as: 'one-whole-file-statement', changes };
}

// Structural validation of a committed delta (used by the gate and by tests).
export function validateDelta(delta, migrationName, migrationSha256) {
  if (!exactKeys(delta, ['schema_version', 'migration', 'migration_sha256', 'query_sha256', 'postgres_major', 'applied_as', 'changes'])
    || delta.schema_version !== 1 || delta.migration !== migrationName || delta.migration_sha256 !== migrationSha256
    || delta.query_sha256 !== CATALOG_QUERY_SHA256 || delta.postgres_major !== ORACLE.postgres_major
    || delta.applied_as !== 'one-whole-file-statement' || !Array.isArray(delta.changes)) fail(`Catalog delta for ${migrationName} is missing, stale or not from PostgreSQL ${ORACLE.postgres_major}`);
  let previous = null;
  for (const change of delta.changes) {
    const keys = change?.operation === 'remove' ? ['identity', 'operation'] : ['identity', 'operation', 'after_sha256', 'after'];
    if (!exactKeys(change, keys) || !IDENTITY.test(change.identity) || !['add', 'modify', 'remove'].includes(change.operation)
      || (change.operation !== 'remove' && (!HASH.test(change.after_sha256 || '') || !change.after || typeof change.after !== 'object'))
      || (previous !== null && byteCompare(previous, change.identity) >= 0)) fail(`Invalid catalog delta entry in ${migrationName}`);
    previous = change.identity;
  }
  return delta;
}

// Applies deltas, in migration order, to a lock map. Strict: an add must be new,
// a modify/remove must exist. Returns a new map.
export function applyDeltas(lockMap, deltas) {
  const map = new Map(lockMap);
  for (const delta of deltas) for (const change of delta.changes) {
    const present = map.has(change.identity);
    if (change.operation === 'add') { if (present) fail(`Catalog delta adds an existing object: ${change.identity}`); map.set(change.identity, change.after_sha256); }
    else if (change.operation === 'modify') { if (!present) fail(`Catalog delta modifies a missing object: ${change.identity}`); map.set(change.identity, change.after_sha256); }
    else { if (!present) fail(`Catalog delta removes a missing object: ${change.identity}`); map.delete(change.identity); }
  }
  return map;
}

// Exact equality; returns a short, sorted list of differing identities.
export function compareCatalogs(expected, observed) {
  const ids = [...new Set([...expected.keys(), ...observed.keys()])].sort(byteCompare);
  return ids.filter(id => expected.get(id) !== observed.get(id));
}

// ---- Disposable PostgreSQL 17 generation (CI and local; never production) ----
function psqlFile(url, file, atomic) {
  execFileSync('psql', [url, '-q', '-v', 'ON_ERROR_STOP=1', ...(atomic ? ['-1'] : []), '-f', file], { stdio: ['ignore', 'ignore', 'inherit'] });
}
async function connect(url) {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}
export async function generate({ serverUrl, repoRoot, allowMajor = ORACLE.postgres_major }) {
  const admin = await connect(serverUrl);
  const major = Math.floor(Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num) / 10000);
  if (major !== allowMajor) fail(`Catalog oracle requires PostgreSQL ${allowMajor}; server is ${major}`);
  const database = 'waaiio_release_oracle';
  await admin.query(`DROP DATABASE IF EXISTS ${database}`);
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.end();
  const url = new URL(serverUrl); url.pathname = `/${database}`;
  const dbUrl = url.toString();
  execFileSync('bash', [join(repoRoot, 'scripts/ci-bootstrap-test-db.sh'), dbUrl], { cwd: repoRoot, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, CI_BOOTSTRAP_PREREQUISITES_ONLY: '1' } });
  const client = await connect(dbUrl);
  try {
    const deltas = [];
    let m430 = null, defaults = false;
    for (const migration of migrationFiles(repoRoot)) {
      const file = join(repoRoot, migration.path), bytes = readFileSync(file);
      if (migration.name === ORACLE.m430_file) {
        // Record what M430 adds, then roll it back: production never has it.
        const before = await readCatalog(client);
        await client.query('BEGIN');
        try { await client.query(bytes.toString('utf8')); m430 = diffCatalog(before, await readCatalog(client)); }
        finally { await client.query('ROLLBACK'); }
        continue;
      }
      if (migration.version < ORACLE.first_delta_version) { psqlFile(dbUrl, file, migration.name.startsWith('383_')); continue; }
      // History is replayed exactly as CI does (no default privileges: production's
      // historic ACL repairs cannot be replayed, e.g. M419 asserts anon has no
      // SELECT). Production's default privileges apply from the first delta on,
      // so objects that new migrations create get production's ACLs.
      if (!defaults) { await client.query(readFileSync(here('./oracle-supabase-defaults.sql'), 'utf8')); defaults = true; }
      // Production applies each new migration as one whole-file statement.
      const before = await readCatalog(client);
      await client.query(bytes.toString('utf8'));
      deltas.push(deltaDocument(migration, bytes, diffCatalog(before, await readCatalog(client))));
    }
    if (!m430) fail('M430 file not found');
    const added = m430.filter(c => c.operation === 'add').map(c => c.identity);
    if (!added.length) fail('M430 added no objects; the oracle replay is wrong');
    return { deltas, m430: { schema_version: 1, source: ORACLE.m430_file,
      source_sha256: sha256(readFileSync(join(repoRoot, 'supabase/migrations', ORACLE.m430_file))),
      query_sha256: CATALOG_QUERY_SHA256, added_identities: added } };
  } finally { await client.end(); }
}

export function expectedFiles(result) {
  const files = { [ORACLE.m430_list]: canonicalJson(result.m430) };
  for (const delta of result.deltas) files[`${ORACLE.delta_dir}/${delta.migration.replace(/\.sql$/, '.json')}`] = canonicalJson(delta);
  return files;
}
// Byte-compares generated files with the repository. Also rejects committed
// delta files that no migration produced.
export function checkFiles(repoRoot, files) {
  const problems = [];
  for (const [path, text] of Object.entries(files)) {
    const full = join(repoRoot, path);
    if (!existsSync(full)) problems.push(`missing ${path}`);
    else if (readFileSync(full, 'utf8') !== text) problems.push(`differs ${path}`);
  }
  const dir = join(repoRoot, ORACLE.delta_dir);
  if (existsSync(dir)) for (const name of readdirSync(dir)) {
    if (!files[`${ORACLE.delta_dir}/${name}`]) problems.push(`unexpected ${ORACLE.delta_dir}/${name}`);
  }
  return problems;
}

async function main() {
  const [command] = process.argv.slice(2);
  const serverUrl = process.env.ORACLE_DATABASE_URL, repoRoot = resolve(process.env.REPO_ROOT || '.');
  if (!serverUrl || !['write', 'check'].includes(command)) fail('Usage: ORACLE_DATABASE_URL=postgresql://... node catalog-oracle.mjs write|check');
  const local = process.env.RELEASE_V3_ORACLE_LOCAL_MAJOR ? Number(process.env.RELEASE_V3_ORACLE_LOCAL_MAJOR) : ORACLE.postgres_major;
  const files = expectedFiles(await generate({ serverUrl, repoRoot, allowMajor: local }));
  if (command === 'write') {
    if (local !== ORACLE.postgres_major) fail('Only PostgreSQL 17 output may be written');
    for (const [path, text] of Object.entries(files)) { mkdirSync(join(repoRoot, path, '..'), { recursive: true }); writeFileSync(join(repoRoot, path), text); }
    console.log(`Wrote ${Object.keys(files).length} oracle files.`);
  } else {
    const problems = checkFiles(repoRoot, files);
    if (problems.length && process.env.ORACLE_OUTPUT_DIR) {
      for (const [path, text] of Object.entries(files)) { const out = join(resolve(process.env.ORACLE_OUTPUT_DIR), path); mkdirSync(join(out, '..'), { recursive: true }); writeFileSync(out, text); }
    }
    if (problems.length) { console.error(problems.join('\n')); fail('Committed catalog deltas differ from the PostgreSQL 17 oracle'); }
    console.log(`Catalog oracle: ${Object.keys(files).length} committed files match PostgreSQL ${local}.`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

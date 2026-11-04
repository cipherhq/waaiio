// Read-only database observation through the release_observer login.
// Uses the psql client (no npm dependency in credential-bearing jobs). The
// connection URL is passed to psql through PG* environment variables, never
// on the command line, and is never logged.
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fail, sha256, HASH } from './common.mjs';
import { catalogMap, CATALOG_QUERY } from './catalog-oracle.mjs';

const here = file => new URL(file, import.meta.url);
export const LEDGER_QUERY = readFileSync(here('./ledger-v3.sql'), 'utf8');
export const LEDGER_QUERY_SHA256 = sha256(readFileSync(here('./ledger-v3.sql')));
export const OBSERVER_ROLE = 'release_observer';
// Production reads go to a read replica (Owner decision 2026-11-04): the server
// enforces read-only there, and release-observer-replica-guard.sql refuses the
// same login on the primary. Staging has no replica and no such exposure.
export const ENVIRONMENTS = Object.freeze({
  production: { project_ref: 'cxcmiqotkowhxinjbytg', secret: 'RELEASE_OBSERVER_PRODUCTION_URL', replica: true },
  staging: { project_ref: 'tqjvrzopvtczxfxiwmnz', secret: 'RELEASE_OBSERVER_STAGING_URL', replica: false },
});
// The reviewed guard body, read from the SQL file the Owner applies.
const GUARD_SQL = readFileSync(here('./release-observer-replica-guard.sql'), 'utf8');
const GUARD_BODY = /AS \$\$([\s\S]*?)\$\$;/.exec(GUARD_SQL)?.[1];
if (!GUARD_BODY) throw new Error('Replica guard body not found');
export const GUARD_BODY_SHA256 = sha256(Buffer.from(GUARD_BODY, 'utf8'));

const strip = sql => sql.split('\n').filter(line => !line.startsWith('--')).join('\n').trim().replace(/;$/, '');
// One read-only transaction returns one JSON document.
export const OBSERVATION_SQL = `BEGIN TRANSACTION READ ONLY;
SELECT json_build_object(
 'current_user', current_user,
 'transaction_read_only', current_setting('transaction_read_only'),
 'default_transaction_read_only', current_setting('default_transaction_read_only'),
 'statement_timeout', current_setting('statement_timeout'),
 'role_flags', (SELECT json_build_object('super', rolsuper, 'bypassrls', rolbypassrls, 'createrole', rolcreaterole, 'createdb', rolcreatedb, 'replication', rolreplication) FROM pg_roles WHERE rolname = current_user),
 'role_memberships', (SELECT count(*) FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = current_user),
 'in_recovery', pg_is_in_recovery(),
 'replica_freshness', json_build_object('receive_lsn', pg_last_wal_receive_lsn()::text, 'replay_lsn', pg_last_wal_replay_lsn()::text,
   'replay_age_seconds', extract(epoch FROM clock_timestamp() - pg_last_xact_replay_timestamp())),
 'replica_guard', (SELECT json_build_object('enabled', t.evtenabled, 'event', t.evtevent, 'body_sha256', encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex'),
   'owner', pg_get_userbyid(p.proowner), 'language', l.lanname, 'definer', p.prosecdef, 'config', p.proconfig)
   FROM pg_event_trigger t JOIN pg_proc p ON p.oid = t.evtfoid JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
   WHERE t.evtname = 'release_observer_replica_only' AND n.nspname = 'release_ops' AND p.proname = 'release_observer_replica_only'),
 'server_version_num', current_setting('server_version_num'),
 'observed_at', clock_timestamp(),
 'catalog', (SELECT coalesce(json_agg(json_build_object('identity', identity, 'digest', digest) ORDER BY identity COLLATE "C"), '[]'::json) FROM (${strip(CATALOG_QUERY)}) catalog),
 'ledger', (SELECT coalesce(json_agg(json_build_object('version', version, 'name', name, 'statement_count', statement_count, 'statement_sha256', statement_sha256, 'row_sha256', row_sha256) ORDER BY version COLLATE "C"), '[]'::json) FROM (${strip(LEDGER_QUERY)}) ledger)
);
COMMIT;
`;

export function connectionEnvironment(url, projectRef, base = process.env) {
  let parsed;
  try { parsed = new URL(url); } catch { fail('Observer connection URL is malformed'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || !parsed.username || !parsed.password) fail('Observer connection URL is incomplete');
  const user = decodeURIComponent(parsed.username);
  // Supabase's pooler names the login "<role>.<project ref>".
  // Bind the secret to its environment: a swapped staging/production URL stops here.
  if (user !== OBSERVER_ROLE && user !== `${OBSERVER_ROLE}.${projectRef}` && !user.startsWith(`${OBSERVER_ROLE}.${projectRef}-rr-`)) fail('Observer connection must use the release_observer login');
  // Replica endpoints carry the project ref as `<ref>-rr-…` (confirm when the
  // replica is created; anything else fails closed).
  if (user !== `${OBSERVER_ROLE}.${projectRef}` && !parsed.hostname.split('.').some(label => label === projectRef || label.startsWith(`${projectRef}-rr-`))
    && !user.startsWith(`${OBSERVER_ROLE}.${projectRef}-rr-`)) fail('Observer connection is not for the expected project');
  const ssl = parsed.searchParams.get('sslmode') || 'require';
  if (!['require', 'verify-ca', 'verify-full'].includes(ssl)) fail('Observer connection must use TLS');
  return { PATH: base.PATH, HOME: base.HOME, PGHOST: parsed.hostname, PGPORT: parsed.port || '5432', PGUSER: user,
    PGPASSWORD: decodeURIComponent(parsed.password), PGDATABASE: decodeURIComponent(parsed.pathname.slice(1) || 'postgres'),
    PGSSLMODE: ssl, PGCONNECT_TIMEOUT: '15', PGAPPNAME: 'waaiio-release-v3-observer' };
}

// Validates the raw observation and returns maps. Fails closed on anything
// that does not prove a read-only, non-privileged observer session.
export function parseObservation(text, { major = 17 } = {}) {
  let doc;
  try { doc = JSON.parse(String(text).trim().split('\n').filter(Boolean).at(-1)); } catch { fail('Database observation is not valid JSON'); }
  const flags = doc?.role_flags;
  if (doc?.current_user !== OBSERVER_ROLE || doc.transaction_read_only !== 'on' || doc.default_transaction_read_only !== 'on'
    || !flags || Object.values(flags).some(v => v !== false) || doc.role_memberships !== 0) fail('Database observation was not made by a forced read-only release_observer session');
  const version = Number(doc.server_version_num);
  if (!Number.isSafeInteger(version) || Math.floor(version / 10000) !== major) fail(`Database observation is not PostgreSQL ${major}`);
  if (!Number.isFinite(Date.parse(doc.observed_at))) fail('Database observation has no time');
  const catalog = catalogMap(doc.catalog);
  if (!Array.isArray(doc.ledger)) fail('Ledger reading missing');
  const versions = new Set();
  for (const row of doc.ledger) {
    if (!row || typeof row.version !== 'string' || !row.version || versions.has(row.version) || typeof row.name !== 'string' && row.name !== null
      || !HASH.test(row.row_sha256 || '') || !(row.statement_sha256 === null || HASH.test(row.statement_sha256))
      || !(row.statement_count === null || Number.isSafeInteger(row.statement_count))) fail('Invalid ledger row');
    versions.add(row.version);
  }
  if (typeof doc.in_recovery !== 'boolean') fail('Database observation has no recovery state');
  return { observed_at: doc.observed_at, catalog, ledger: doc.ledger, in_recovery: doc.in_recovery, replica_guard: doc.replica_guard ?? null,
    replica_freshness: doc.replica_freshness ?? null };
}

// Longest accepted gap since the replica last replayed a primary commit.
// Owner decision 2026-11-04: 65 minutes. The production primary commits at
// least hourly (pg_cron), so a healthy replica is never refused in quiet
// periods. The receive = replay check still applies on every read, but a
// replica cut off from the primary passes it, so it is refused only after
// 65 minutes (see docs/RELEASE_V3_GATE.md).
export const REPLICA_MAX_REPLAY_AGE_SECONDS = 65 * 60;
// Production must be observed on a replica that carries the reviewed guard.
export function requireReplica(environment, observation) {
  if (!ENVIRONMENTS[environment]?.replica) return true;
  const guard = observation.replica_guard;
  if (observation.in_recovery !== true) fail(`${environment} observation must run on a read replica`);
  if (!guard || guard.event !== 'login' || guard.enabled !== 'A' || guard.body_sha256 !== GUARD_BODY_SHA256 || guard.owner !== 'postgres'
    || guard.language !== 'plpgsql' || guard.definer !== false || JSON.stringify(guard.config) !== '["search_path=pg_catalog"]') fail(`${environment} replica-only login guard is missing, disabled or not the reviewed version`);
  // A stalled or lagging replica would show the same old state on every read.
  // Require that it has replayed everything it received, recently.
  const fresh = observation.replica_freshness;
  if (!fresh || typeof fresh.receive_lsn !== 'string' || fresh.receive_lsn !== fresh.replay_lsn
    || typeof fresh.replay_age_seconds !== 'number' || !(fresh.replay_age_seconds >= 0) || fresh.replay_age_seconds > REPLICA_MAX_REPLAY_AGE_SECONDS) fail(`${environment} replica is not caught up (replay lag or stall)`);
  return true;
}

export function observeDatabase(environment, env = process.env, run = execFileSync) {
  const config = ENVIRONMENTS[environment];
  if (!config) fail('Unknown environment');
  const url = env[config.secret];
  if (!url) fail(`${config.secret} is not configured`);
  const pgEnv = connectionEnvironment(url, config.project_ref, env);
  // Optional server-certificate verification: with the provider CA configured,
  // the connection must verify the certificate and host name.
  let caDir = null;
  if (env.RELEASE_OBSERVER_CA_PEM) {
    if (!/-----BEGIN CERTIFICATE-----/.test(env.RELEASE_OBSERVER_CA_PEM)) fail('Observer CA certificate is malformed');
    caDir = mkdtempSync(join(tmpdir(), 'release-observer-ca-'));
    writeFileSync(join(caDir, 'ca.pem'), env.RELEASE_OBSERVER_CA_PEM, { mode: 0o600 });
    Object.assign(pgEnv, { PGSSLROOTCERT: join(caDir, 'ca.pem'), PGSSLMODE: 'verify-full' });
  }
  let output;
  try {
    output = run('psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-f', '-'], { input: OBSERVATION_SQL,
      env: pgEnv, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    // Never echo psql's error text: it can include connection details.
    fail(`${environment} read-only observation failed; no retry with any other credential`);
  } finally { if (caDir) rmSync(caDir, { recursive: true, force: true }); }
  const observation = { environment, project_ref: config.project_ref, ...parseObservation(output) };
  requireReplica(environment, observation);
  return observation;
}

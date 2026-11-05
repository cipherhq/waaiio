import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { prepare, deploy, captureLockMaps, validateDispatchRun } from '../release-gate-v3.mjs';
import { observeProject, checkProductionConsistency, observeHoldFlags, validateMainCI, validateJobs, hashId, PROJECTS, REQUIRED_CI_JOBS } from '../release-v3/platform.mjs';
import { buildPacket, packetBytes, packetDigest, acceptPacket, verifySingleUse, verifyRecordComment, verifyPullRequestReviews, APPROVAL_LINE, parseCommentUrl, PACKET_TTL_MS } from '../release-v3/packet.mjs';
import { parseObservation, connectionEnvironment, OBSERVATION_SQL, observeDatabase } from '../release-v3/db-observe.mjs';
import { ledgerSnapshot } from '../release-v3/admission.mjs';
import { catalogMap, catalogAggregate, CATALOG_QUERY_SHA256 } from '../release-v3/catalog-oracle.mjs';
import { LEDGER_QUERY_SHA256, GUARD_BODY_SHA256 } from '../release-v3/db-observe.mjs';
import { canonicalJson } from '../release-v3/common.mjs';

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const P = PROJECTS.production, S = PROJECTS.staging;
type Json = Record<string, unknown>;
const response = (status: number, body?: unknown, headers: Record<string, string> = {}) => ({
  ok: status >= 200 && status < 300, status, headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  json: async () => body, arrayBuffer: async () => (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))),
});

// ---------------- unit rules ----------------
describe('admin pin and production consistency (carried-over rules)', () => {
  const project = (kind: 'merchant' | 'admin', targetId: string) => ({ id: P[kind].project, rootDirectory: P[kind].root || null, framework: P[kind].framework,
    autoAssignCustomDomains: kind === 'merchant', buildCommand: null, installCommand: null, outputDirectory: null,
    commandForIgnoringBuildStep: kind === 'merchant' ? 'exit 0' : null, targets: { production: { id: targetId } } });
  const dep = (id: string, projectId: string, createdAt: number, extra: Json = {}) => ({ id, projectId, meta: { githubCommitSha: 'b'.repeat(40) }, readyState: 'READY', source: 'cli', target: 'production', createdAt, ...extra });
  function reader(map: Record<string, unknown>, calls: string[]) { return async (path: string) => { calls.push(path); if (!(path in map)) throw new Error(`unexpected ${path}`); return map[path]; }; }

  it('REGRESSION (run 41706465115): the admin pin is targets.production.id, never the newest deployment in a list', async () => {
    const calls: string[] = [];
    const read = reader({
      [`/v9/projects/${P.admin.project}`]: project('admin', 'dpl_pinOlder'),
      '/v4/aliases/admin.waaiio.com': { deploymentId: 'dpl_serving' },
      '/v13/deployments/dpl_serving': dep('dpl_serving', P.admin.project, 200),
      '/v13/deployments/dpl_pinOlder': dep('dpl_pinOlder', P.admin.project, 100),
      // A newer deployment exists in the project's list; the gate must never use it.
      [`/v6/deployments?projectId=${P.admin.project}`]: { deployments: [dep('dpl_newest', P.admin.project, 999)] },
    }, calls);
    const observed = await observeProject(read, 'production', 'admin');
    expect(observed.target.id).toBe('dpl_pinOlder');
    expect(calls.some(c => c.includes('/v6/deployments'))).toBe(false);
    expect(checkProductionConsistency(observed)).toBe(true);
  });
  it('a production admin target newer than the serving deployment is unapproved', () => {
    const serving = { id: 'dpl_s', project_id: P.admin.project, sha: 'b'.repeat(40), ready_state: 'READY', source: 'cli', target: 'production', created_at: 200, error_link: null };
    expect(() => checkProductionConsistency({ kind: 'admin', serving, target: { ...serving, id: 'dpl_new', created_at: 300 } })).toThrow('newer than serving');
    expect(checkProductionConsistency({ kind: 'admin', serving, target: serving })).toBe(true);
  });
  it('merchant divergence is allowed only for a newer canceled ignored-build-step Git attempt', () => {
    const serving = { id: 'dpl_s', project_id: P.merchant.project, sha: 'b'.repeat(40), ready_state: 'READY', source: 'cli', target: 'production', created_at: 200, error_link: null };
    const canceled = { ...serving, id: 'dpl_g', ready_state: 'CANCELED', source: 'git', created_at: 300, error_link: 'https://vercel.com/docs/project-configuration/git-settings#ignored-build-step' };
    expect(checkProductionConsistency({ kind: 'merchant', serving, target: canceled })).toBe(true);
    expect(() => checkProductionConsistency({ kind: 'merchant', serving, target: { ...canceled, ready_state: 'READY' } })).toThrow('divergence');
    expect(() => checkProductionConsistency({ kind: 'merchant', serving, target: { ...canceled, error_link: null } })).toThrow('divergence');
  });
  it('rejects a changed production project policy', async () => {
    const p = { ...project('merchant', 'dpl_x'), autoAssignCustomDomains: false };
    await expect(observeProject(reader({ [`/v9/projects/${P.merchant.project}`]: p }, []), 'production', 'merchant')).rejects.toThrow('policy changed');
  });
  it('payout and channel-operation hold flags must be absent from production', async () => {
    const read = async () => ({ envs: [{ key: 'ENABLE_FIRST_SHARED_ASSIGNMENT', target: ['production'] }, { key: 'ENABLE_PAYOUTS', target: ['preview'] }] });
    expect(await observeHoldFlags(read, 'merchant')).toMatchObject({ hold_flags_absent: true });
    const set = async () => ({ envs: [{ key: 'ENABLE_PAYOUTS', target: ['production', 'preview'] }] });
    expect(await observeHoldFlags(set, 'merchant')).toMatchObject({ hold_flags_absent: false, present: ['ENABLE_PAYOUTS'] });
  });
  it('requires the newest exact push-main CI run to be green with every job successful', () => {
    const T = 'c'.repeat(40), r = (id: number, conclusion: string | null, status = 'completed') => ({ id, head_sha: T, head_branch: 'main', event: 'push', path: '.github/workflows/ci.yml', status, conclusion, run_attempt: 1 });
    expect(validateMainCI({ workflow_runs: [r(1, 'success')] }, T)).toEqual({ run_id: 1, run_attempt: 1 });
    expect(() => validateMainCI({ workflow_runs: [r(1, 'success'), r(2, null, 'in_progress')] }, T)).toThrow('Green exact');
    expect(() => validateJobs({ total_count: 2, jobs: [{ name: 'A', conclusion: 'success' }, { name: 'B', conclusion: 'skipped' }] })).toThrow('CI jobs not successful: B');
    const all = REQUIRED_CI_JOBS.map(name => ({ name, conclusion: 'success' }));
    expect(validateJobs({ total_count: all.length, jobs: all })).toHaveLength(15);
    const noPaymentShard = all.filter(j => j.name !== 'Migration validation (shard b)');
    expect(() => validateJobs({ total_count: noPaymentShard.length, jobs: noPaymentShard })).toThrow('Required CI jobs missing: Migration validation (shard b)');
  });
  it('dispatch runs must be Owner workflow_dispatch runs of the exact workflow on main', () => {
    const run = { repository: { full_name: 'cipherhq/waaiio' }, path: '.github/workflows/release-prepare.yml', event: 'workflow_dispatch', head_branch: 'main', actor: { login: 'cipherhq' }, triggering_actor: { login: 'cipherhq' }, status: 'completed', conclusion: 'success', head_sha: 'a'.repeat(40) };
    expect(validateDispatchRun(run, '.github/workflows/release-prepare.yml')).toBe(run);
    for (const bad of [{ path: '.github/workflows/other.yml' }, { triggering_actor: { login: 'someone' } }, { head_branch: 'feature' }, { conclusion: 'failure' }, { event: 'push' }])
      expect(() => validateDispatchRun({ ...run, ...bad }, '.github/workflows/release-prepare.yml')).toThrow('Untrusted');
  });
});

describe('packet approval binding', () => {
  const packet = () => buildPacket({ prepare: { run_id: '1', run_attempt: 1, gate_sha: 'a'.repeat(40) }, target: { sha: 'c'.repeat(40), tree: 'd'.repeat(40), ci: {} },
    baseline: { merchant: { sha: 'b'.repeat(40), deployment_sha256: 'e'.repeat(64) }, admin: { sha: 'b'.repeat(40), deployment_sha256: 'f'.repeat(64) } },
    admin_pin: { deployment_sha256: '1'.repeat(64), descriptor_sha256: '2'.repeat(64) }, lane: { lane: 'standard' }, changes: {}, pull_requests: [], migrations: [],
    database: { production: { catalog: { sha256: '3'.repeat(64) }, ledger: { sha256: '4'.repeat(64) } } }, staging: {}, permanent_checks: { m430_absent: true, hold_flags_absent: true }, lock_sha256: '5'.repeat(64) }, Date.parse('2026-11-04T00:00:00Z'));
  it('accepts the exact approved bytes within 24 hours', () => {
    const p = packet(), bytes = packetBytes(p);
    expect(acceptPacket(bytes, packetDigest(p), Date.parse('2026-11-04T23:00:00Z')).target.sha).toBe('c'.repeat(40));
  });
  it('rejects other bytes, an expired packet and non-canonical JSON', () => {
    const p = packet(), bytes = packetBytes(p);
    expect(() => acceptPacket(bytes, 'a'.repeat(64), Date.parse('2026-11-04T01:00:00Z'))).toThrow('differ from the approved');
    expect(() => acceptPacket(bytes, packetDigest(p), Date.parse('2026-11-04T00:00:00Z') + PACKET_TTL_MS + 1)).toThrow('expired');
    const loose = Buffer.from(JSON.stringify(p));
    expect(() => acceptPacket(loose, sha(loose), Date.parse('2026-11-04T01:00:00Z'))).toThrow('canonical');
  });
  it('a packet without M430 absence or hold flags cannot be built', () => {
    expect(() => buildPacket({ ...packet(), permanent_checks: { m430_absent: false, hold_flags_absent: true } } as never)).toThrow('Release packet is incomplete');
  });
  it('an approval is single-use, including re-runs of the same deploy', () => {
    const d = 'a'.repeat(64);
    expect(verifySingleUse({ total_count: 1, workflow_runs: [{ id: 9, display_title: `Release deploy ${d}` }] }, d, '9', 1)).toBe(true);
    expect(() => verifySingleUse({ total_count: 2, workflow_runs: [{ id: 8, display_title: `Release deploy ${d}` }, { id: 9, display_title: `Release deploy ${d}` }] }, d, '9', 1)).toThrow('already used');
    expect(() => verifySingleUse({ total_count: 1, workflow_runs: [] }, d, '9', 2)).toThrow('re-running');
    expect(() => verifySingleUse({ total_count: 150, workflow_runs: [] }, d, '9', 1)).toThrow('incomplete');
  });
  it('approval records must name this packet and come from the repository account', () => {
    const d = 'a'.repeat(64);
    expect(parseCommentUrl('https://github.com/cipherhq/waaiio/issues/221#issuecomment-123')).toBe('123');
    expect(() => parseCommentUrl('https://github.com/other/repo/issues/1#issuecomment-1')).toThrow('A GitHub comment URL in cipherhq/waaiio is required');
    expect(verifyRecordComment({ id: 1, created_at: 'x', user: { login: 'cipherhq' }, body: `Owner said yes.\nRelease-Approval: v1 packet=${d} decision=APPROVED` }, APPROVAL_LINE, d, 'x').comment_id).toBe(1);
    expect(() => verifyRecordComment({ user: { login: 'cipherhq' }, body: `Release-Approval: v1 packet=${'b'.repeat(64)} decision=APPROVED` }, APPROVAL_LINE, d, 'x')).toThrow('not found');
    expect(() => verifyRecordComment({ user: { login: 'someone' }, body: `Release-Approval: v1 packet=${d} decision=APPROVED` }, APPROVAL_LINE, d, 'x')).toThrow('not found');
  });
  it('full-lane PRs need two distinct review records on the exact merged head', () => {
    const H = 'h'.repeat(0) + '9'.repeat(40), rec = (r: string, head = H) => ({ user: { login: 'cipherhq' }, body: `Release-Review-Record: v1 verdict=APPROVED head=${head} reviewer=${r}` });
    const pr = { number: 1, head_sha: H, required_reviews: 2 };
    expect(verifyPullRequestReviews(pr, [rec('rev-a'), rec('rev-b')]).recorded_reviews).toBe(2);
    expect(() => verifyPullRequestReviews(pr, [rec('rev-a'), rec('rev-a')])).toThrow('1 of 2');
    expect(() => verifyPullRequestReviews(pr, [rec('rev-a'), rec('rev-b', '8'.repeat(40))])).toThrow('1 of 2');
    expect(verifyPullRequestReviews(pr, [], { 1: H }).recorded_reviews).toBe('lock');
    expect(() => verifyPullRequestReviews(pr, [], { 1: '8'.repeat(40) })).toThrow('different head');
  });
});

describe('read-only observer session', () => {
  const doc = (over: Json = {}) => JSON.stringify({ current_user: 'release_observer', transaction_read_only: 'on', default_transaction_read_only: 'on', statement_timeout: '1min',
    role_flags: { super: false, bypassrls: false, createrole: false, createdb: false, replication: false }, role_memberships: 0, in_recovery: true, replica_guard: null, server_version_num: '170006', observed_at: '2026-11-04T00:00:00Z',
    catalog: [{ identity: 'table:public.t', digest: 'a'.repeat(64) }], ledger: [{ version: '1', name: 'x', statement_count: 1, statement_sha256: 'b'.repeat(64), row_sha256: 'c'.repeat(64) }], ...over });
  it('accepts a forced read-only, unprivileged PostgreSQL 17 release_observer session', () => expect(parseObservation(doc()).catalog.size).toBe(1));
  it.each([
    [{ current_user: 'postgres' }, 'not made by a forced read-only release_observer session'], [{ default_transaction_read_only: 'off' }, 'forced read-only'],
    [{ transaction_read_only: 'off' }, 'forced read-only'], [{ role_flags: { super: true, bypassrls: false, createrole: false, createdb: false, replication: false } }, 'forced read-only'],
    [{ server_version_num: '160013' }, 'not PostgreSQL 17'],
    [{ role_memberships: 1 }, 'forced read-only'],
    [{ in_recovery: 'yes' }, 'no recovery state'],
  ])('rejects %j', (over, message) => expect(() => parseObservation(doc(over))).toThrow(message));
  it('connection settings: release_observer login only, bound to its project, TLS required, password never on the command line', () => {
    const env = connectionEnvironment('postgresql://release_observer.cxcmiqotkowhxinjbytg:pw%40x@aws-0-x.pooler.supabase.com:5432/postgres?sslmode=require', 'cxcmiqotkowhxinjbytg', { PATH: '/bin' });
    expect(env).toMatchObject({ PGUSER: 'release_observer.cxcmiqotkowhxinjbytg', PGPASSWORD: 'pw@x', PGSSLMODE: 'require', PGDATABASE: 'postgres' });
    expect(() => connectionEnvironment('postgresql://postgres.cxcmiqotkowhxinjbytg:pw@h:5432/postgres', 'cxcmiqotkowhxinjbytg')).toThrow('release_observer');
    expect(() => connectionEnvironment('postgresql://release_observer.tqjvrzopvtczxfxiwmnz:pw@h:5432/postgres', 'cxcmiqotkowhxinjbytg')).toThrow('Observer connection must use the release_observer login');
    expect(() => connectionEnvironment('postgresql://release_observer.cxcmiqotkowhxinjbytg:pw@h:5432/postgres?sslmode=disable', 'cxcmiqotkowhxinjbytg')).toThrow('TLS');
    // Read-replica endpoints carry the ref as `<ref>-rr-…`.
    expect(connectionEnvironment('postgresql://release_observer:pw@db.cxcmiqotkowhxinjbytg-rr-us-east-1-abcde.supabase.co:5432/postgres', 'cxcmiqotkowhxinjbytg').PGUSER).toBe('release_observer');
    expect(connectionEnvironment('postgresql://release_observer.cxcmiqotkowhxinjbytg-rr-us-east-1-abcde:pw@aws-0-x.pooler.supabase.com:5432/postgres', 'cxcmiqotkowhxinjbytg').PGUSER).toBe('release_observer.cxcmiqotkowhxinjbytg-rr-us-east-1-abcde');
    expect(() => connectionEnvironment('postgresql://release_observer:pw@db.tqjvrzopvtczxfxiwmnz-rr-us-east-1-abcde.supabase.co:5432/postgres', 'cxcmiqotkowhxinjbytg')).toThrow('not for the expected project');
  });
  it('psql gets the credentials through the environment and errors are not echoed', () => {
    let seen: { args: string[]; env: Json } | null = null;
    const run = (_: string, args: string[], opts: { env: Json }) => { seen = { args, env: opts.env }; throw new Error('psql: password authentication failed for user release_observer at secret-host'); };
    expect(() => observeDatabase('production', { RELEASE_OBSERVER_PRODUCTION_URL: 'postgresql://release_observer.cxcmiqotkowhxinjbytg:pw@h:5432/postgres' }, run as never)).toThrow(/^production read-only observation failed; no retry/);
    expect(seen!.args.join(' ')).not.toContain('pw');
    expect(seen!.env.PGPASSWORD).toBe('pw');
  });
  it('the observation SQL runs inside one READ ONLY transaction', () => expect(OBSERVATION_SQL.startsWith('BEGIN TRANSACTION READ ONLY;')).toBe(true));
  it('with the CA configured, the connection must verify the certificate and host name', () => {
    let seen: Json | null = null;
    const run = (_: string, __: string[], opts: { env: Json }) => { seen = { ...opts.env, ca: readFileSync(String(opts.env.PGSSLROOTCERT), 'utf8') }; throw new Error('x'); };
    const pem = '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n';
    expect(() => observeDatabase('production', { RELEASE_OBSERVER_PRODUCTION_URL: 'postgresql://release_observer.cxcmiqotkowhxinjbytg:pw@h:5432/postgres', RELEASE_OBSERVER_CA_PEM: pem }, run as never)).toThrow('read-only observation failed');
    expect(seen).toMatchObject({ PGSSLMODE: 'verify-full', ca: pem });
    expect(() => observeDatabase('production', { RELEASE_OBSERVER_PRODUCTION_URL: 'postgresql://release_observer.cxcmiqotkowhxinjbytg:pw@h:5432/postgres', RELEASE_OBSERVER_CA_PEM: 'nope' }, run as never)).toThrow('Observer CA certificate is malformed');
  });
});

// ---------------- end to end: prepare and deploy ----------------
const B_FILES: Record<string, string> = {
  'supabase/migrations/430_shared_number_tenant_isolation.sql': readFileSync('supabase/migrations/430_shared_number_tenant_isolation.sql', 'utf8'),
  'supabase/migrations/508_business_control_columns_guard.sql': 'm508',
  'components/ui/A.tsx': 'export const A = 1;\n',
  'lib/payments/x.ts': 'export const x = 1;\n',
};
const M430_ID = 'function:public.allocate_shared_channel(p_business_id uuid, p_country_code text)';
const prodRows = [{ version: '1', name: 'one', statement_count: 1, statement_sha256: sha('1'), row_sha256: sha('r1') }, { version: '2', name: '508_business_control_columns_guard', statement_count: 1, statement_sha256: sha('m508'), row_sha256: sha('r2') }];
const stagingRows = [...prodRows, { version: '3', name: '430_shared_number_tenant_isolation', statement_count: 1, statement_sha256: sha('m430-bytes'), row_sha256: sha('r3') }];
const prodCatalog = () => catalogMap([{ identity: 'table:public.t', digest: sha('t') }]);
const stagingCatalog = () => catalogMap([{ identity: 'table:public.t', digest: sha('t') }, { identity: M430_ID, digest: sha('m') }]);

interface Repo { dir: string; B: string; T: string; G: string; M?: string; S?: string; }
// `mid` adds a commit (#899) between baseline and target; `side` adds a commit S off the baseline that is merged
// after `mid`, so S and M are not on one line of history. `certified` overrides the lock's certified SHAs.
function buildRepo(targetFiles: Record<string, string>, opts: { mid?: Record<string, string>; side?: Record<string, string>; certified?: (r: { B: string; M?: string; S?: string }) => { merchant: string; admin: string } } = {}): Repo {
  const dir = mkdtempSync(join(tmpdir(), 'v3-e2e-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  const write = (files: Record<string, string>) => { for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c); } };
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  write(B_FILES); g('add', '-A'); g('commit', '-qm', 'baseline'); const B = g('rev-parse', 'HEAD');
  let M: string | undefined, S: string | undefined;
  if (opts.side) { g('checkout', '-qb', 'side'); write(opts.side); g('add', '-A'); g('commit', '-qm', 'side'); S = g('rev-parse', 'HEAD'); g('checkout', '-q', 'main'); }
  if (opts.mid) { write(opts.mid); g('add', '-A'); g('commit', '-qm', 'mid (#899)'); M = g('rev-parse', 'HEAD'); }
  if (opts.side) g('merge', '-q', '--no-ff', 'side', '-m', 'merge side');
  write(targetFiles); g('add', '-A'); g('commit', '-qm', 'target (#900)'); const T = g('rev-parse', 'HEAD');
  const lock = { schema_version: 1, bootstrap_migration: '508_business_control_columns_guard.sql', certified: opts.certified ? opts.certified({ B, M, S }) : { merchant: B, admin: B }, catalog_query_sha256: CATALOG_QUERY_SHA256, ledger_query_sha256: LEDGER_QUERY_SHA256,
    environments: { production: { project_ref: 'cxcmiqotkowhxinjbytg', catalog: { count: 1, sha256: catalogAggregate(prodCatalog()) }, ledger: ledgerSnapshot(prodRows), catalog_map: null },
      staging: { project_ref: 'tqjvrzopvtczxfxiwmnz', catalog: { count: 2, sha256: catalogAggregate(stagingCatalog()) }, ledger: ledgerSnapshot(stagingRows), catalog_map: null } },
    observed: {}, reviewed_prs: {} };
  write({ 'scripts/release-v3/lock.json': canonicalJson(lock), 'scripts/release-v3/m430-identities.json': readFileSync('scripts/release-v3/m430-identities.json', 'utf8') });
  g('add', '-A'); g('commit', '-qm', 'gate (#901)'); const G = g('rev-parse', 'HEAD');
  g('update-ref', 'refs/remotes/origin/main', G);
  return { dir, B, T, G, M, S };
}
function clone(repo: Repo, sha: string) {
  const dir = mkdtempSync(join(tmpdir(), 'v3-src-'));
  execFileSync('git', ['clone', '-q', repo.dir, dir]); execFileSync('git', ['checkout', '-q', sha], { cwd: dir });
  return dir;
}

// A stateful fake of GitHub, Vercel and the public endpoints.
function world(repo: Repo, over: Partial<{ reviews: string[]; prodServingSha: string; adminTargetCreated: number; holdFlag: boolean; ciConclusion: string; deployRuns: Json[]; skipDomainMovesTarget: boolean; adminServingSha: string }> = {}) {
  const state = {
    merchant: { serving: 'dpl_m1', target: 'dpl_m1' }, admin: { serving: 'dpl_a1', target: 'dpl_a0' },
    deployments: {
      dpl_m1: { id: 'dpl_m1', projectId: P.merchant.project, meta: { githubCommitSha: over.prodServingSha ?? repo.B }, readyState: 'READY', source: 'cli', target: 'production', createdAt: 100 },
      dpl_a1: { id: 'dpl_a1', projectId: P.admin.project, meta: { githubCommitSha: over.adminServingSha ?? repo.B }, readyState: 'READY', source: 'cli', target: 'production', createdAt: 200 },
      dpl_a0: { id: 'dpl_a0', projectId: P.admin.project, meta: { githubCommitSha: '0'.repeat(40) }, readyState: 'READY', source: 'cli', target: 'production', createdAt: over.adminTargetCreated ?? 50 },
      dpl_s1: { id: 'dpl_s1', projectId: S.merchant.project, meta: { githubCommitSha: repo.T }, readyState: 'READY', source: 'git', target: 'production', createdAt: 10 },
      dpl_s2: { id: 'dpl_s2', projectId: S.admin.project, meta: { githubCommitSha: repo.T }, readyState: 'READY', source: 'git', target: 'production', createdAt: 10 },
    } as Record<string, Json>,
    hostnames: {} as Record<string, string>, aliasPosts: 0, listCalls: 0, artifacts: {} as Record<string, Buffer>, artifactMeta: [] as Json[], comments: {} as Record<string, Json>,
  };
  const projectBody = (env: 'production' | 'staging', kind: 'merchant' | 'admin') => {
    const c = (env === 'production' ? P : S)[kind];
    return { id: c.project, rootDirectory: c.root || null, framework: c.framework, autoAssignCustomDomains: kind === 'merchant', buildCommand: null, installCommand: null, outputDirectory: null,
      commandForIgnoringBuildStep: kind === 'merchant' ? 'exit 0' : null, targets: { production: { id: env === 'production' ? state[kind].target : (kind === 'merchant' ? 'dpl_s1' : 'dpl_s2') } } };
  };
  const reviewers = over.reviews ?? ['rev-a'];
  const fetchImpl = async (url: string, opts: { method?: string; body?: string } = {}) => {
    const u = new URL(url), path = u.pathname + (u.search ? u.search.replace(/[?&]teamId=[^&]+/, '').replace(/^&/, '?') : '');
    if (u.host === 'api.vercel.com') {
      if (opts.method === 'POST') { const id = u.pathname.split('/')[3]; state.aliasPosts++; state.admin.serving = id; return response(200, {}); }
      if (u.pathname.startsWith('/v6/deployments')) { state.listCalls++; return response(200, { deployments: [] }); }
      for (const env of ['production', 'staging'] as const) for (const kind of ['merchant', 'admin'] as const) {
        const c = (env === 'production' ? P : S)[kind];
        if (u.pathname === `/v9/projects/${c.project}`) return response(200, projectBody(env, kind));
        if (u.pathname === `/v4/aliases/${c.alias}`) return response(200, { deploymentId: env === 'production' ? state[kind].serving : (kind === 'merchant' ? 'dpl_s1' : 'dpl_s2') });
        if (u.pathname === `/v10/projects/${c.project}/env`) return response(200, { envs: over.holdFlag && kind === 'merchant' ? [{ key: 'ENABLE_PAYOUTS', target: ['production'] }] : [{ key: 'ENABLE_FIRST_SHARED_ASSIGNMENT', target: ['production'] }] });
      }
      const m = /^\/v13\/deployments\/(.+)$/.exec(u.pathname);
      if (m) { const id = state.hostnames[m[1]] ?? m[1]; return state.deployments[id] ? response(200, state.deployments[id]) : response(404); }
      throw new Error(`unexpected vercel ${url}`);
    }
    if (u.host === 'api.github.com') {
      const p = u.pathname.replace('/repos/cipherhq/waaiio', ''), q = u.search;
      if (p === '/actions/workflows/ci.yml/runs') return response(200, { workflow_runs: [{ id: 11, head_sha: repo.T, head_branch: 'main', event: 'push', path: '.github/workflows/ci.yml', status: 'completed', conclusion: over.ciConclusion ?? 'success', run_attempt: 1 }] });
      if (p === '/actions/runs/11/attempts/1/jobs') return response(200, { total_count: REQUIRED_CI_JOBS.length, jobs: REQUIRED_CI_JOBS.map(name => ({ name, conclusion: 'success' })) });
      if (p === '/actions/workflows/release-deploy.yml/runs') return response(200, q.includes('status=success') ? { total_count: 0, workflow_runs: [] } : { total_count: (over.deployRuns ?? []).length, workflow_runs: over.deployRuns ?? [] });
      if (p === `/commits/${repo.T}/pulls`) return response(200, [{ number: 900, merge_commit_sha: repo.T, base: { ref: 'main' }, merged_at: 'x', head: { sha: '9'.repeat(40) } }]);
      if (repo.M && p === `/commits/${repo.M}/pulls`) return response(200, [{ number: 899, merge_commit_sha: repo.M, base: { ref: 'main' }, merged_at: 'x', head: { sha: '8'.repeat(40) } }]);
      if (p === '/issues/900/comments') return response(200, reviewers.map(r => ({ user: { login: 'cipherhq' }, body: `Release-Review-Record: v1 verdict=APPROVED head=${'9'.repeat(40)} reviewer=${r}` })));
      if (p === '/issues/899/comments') return response(200, reviewers.map(r => ({ user: { login: 'cipherhq' }, body: `Release-Review-Record: v1 verdict=APPROVED head=${'8'.repeat(40)} reviewer=${r}` })));
      if (p === '/actions/runs/55') return response(200, { id: 55, run_attempt: 1, repository: { full_name: 'cipherhq/waaiio' }, path: '.github/workflows/release-prepare.yml', event: 'workflow_dispatch', head_branch: 'main', actor: { login: 'cipherhq' }, triggering_actor: { login: 'cipherhq' }, status: 'completed', conclusion: 'success', head_sha: repo.G });
      if (p === '/actions/runs/55/artifacts') return response(200, { total_count: state.artifactMeta.length, artifacts: state.artifactMeta });
      const art = /^\/actions\/artifacts\/([0-9]+)\/zip$/.exec(p);
      if (art) return response(302, null, { location: `https://blob.example/${art[1]}` });
      const com = /^\/issues\/comments\/([0-9]+)$/.exec(p);
      if (com) return state.comments[com[1]] ? response(200, state.comments[com[1]]) : response(404);
      throw new Error(`unexpected github ${url}`);
    }
    if (u.host === 'blob.example') return response(200, state.artifacts[u.pathname.slice(1)]);
    // Public endpoints.
    const kindOf = (host: string) => ({ 'www.waaiio.com': ['production', 'merchant'], 'admin.waaiio.com': ['production', 'admin'], 'staging.waaiio.com': ['staging', 'merchant'], 'admin-staging.waaiio.com': ['staging', 'admin'] } as Record<string, [string, 'merchant' | 'admin']>)[host];
    const k = kindOf(u.host);
    if (k && u.pathname === '/api/release-identity') {
      const id = k[0] === 'production' ? state.merchant.serving : 'dpl_s1', d = state.deployments[id] as { meta: { githubCommitSha: string }; projectId: string };
      return response(200, { sha: d.meta.githubCommitSha, projectId: d.projectId, deploymentId: id, vercelEnv: 'production', supabaseProjectRef: k[0] === 'production' ? 'cxcmiqotkowhxinjbytg' : 'tqjvrzopvtczxfxiwmnz' });
    }
    if (k) return response(200, 'ok');
    throw new Error(`unexpected ${url}`);
  };
  // Simulates `vercel deploy --prod`: merchant moves its domain and production target. Admin (--skip-domain)
  // leaves its production target on the old pin, as Vercel did in run 41937185420, unless the test says otherwise.
  const run = (cmd: string, args: string[], opts: { cwd: string }) => {
    if (cmd !== 'vercel') throw new Error('unexpected command');
    const kind = args.includes('--skip-domain') ? 'admin' : 'merchant', id = `dpl_${kind}New`, host = `${kind}-new.vercel.app`;
    state.deployments[id] = { id, projectId: P[kind].project, meta: { githubCommitSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: opts.cwd, encoding: 'utf8' }).trim() }, readyState: 'READY', source: 'cli', target: 'production', createdAt: 1000 };
    state.hostnames[host] = id;
    if (kind === 'merchant' || over.skipDomainMovesTarget) state[kind].target = id;
    if (kind === 'merchant') state.merchant.serving = id;
    return `Production: https://${host}\n`;
  };
  return { state, fetchImpl, run };
}
const observeWith = (prod = prodCatalog(), rows = prodRows) => (environment: string) => environment === 'production'
  ? { environment, project_ref: 'cxcmiqotkowhxinjbytg', observed_at: '2026-11-04T00:00:00Z', catalog: prod, ledger: rows, in_recovery: true, replica_guard: { enabled: 'A', event: 'login', body_sha256: GUARD_BODY_SHA256, owner: 'postgres', language: 'plpgsql', definer: false, config: ['search_path=pg_catalog'] }, replica_freshness: { receive_lsn: '0/5000060', replay_lsn: '0/5000060', replay_age_seconds: 12 } }
  : { environment, project_ref: 'tqjvrzopvtczxfxiwmnz', observed_at: '2026-11-04T00:00:00Z', catalog: stagingCatalog(), ledger: stagingRows, in_recovery: false, replica_guard: null };
const baseEnv = (repo: Repo, over: Json = {}) => ({ GITHUB_ACTOR: 'cipherhq', GITHUB_TRIGGERING_ACTOR: 'cipherhq', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: 'cipherhq/waaiio',
  GITHUB_REF: 'refs/heads/main', GITHUB_SHA: repo.G, GITHUB_TOKEN: 'gh', VERCEL_TOKEN: 'vt', GITHUB_RUN_ID: '55', GITHUB_RUN_ATTEMPT: '1', TARGET_SHA: repo.T, PATH: process.env.PATH, HOME: process.env.HOME, ...over });
const NOW = Date.parse('2026-11-04T01:00:00Z');

describe('prepare (end to end, faked platforms)', { timeout: 60_000 }, () => {
  const repos: Repo[] = [];
  const make = (files: Record<string, string>, opts: Parameters<typeof buildRepo>[1] = {}) => { const r = buildRepo(files, opts); repos.push(r); return r; };
  afterAll(() => { for (const r of repos) rmSync(r.dir, { recursive: true, force: true }); });

  it('derives a standard-lane packet from facts: baseline, target, lane, PRs, database, staging, holds', async () => {
    const repo = make({ 'components/ui/A.tsx': 'export const A = 2;\n' });
    const w = world(repo);
    const packet = await prepare({ env: baseEnv(repo), control: repo.dir, now: NOW, fetchImpl: w.fetchImpl as never, observe: observeWith() as never });
    expect(packet).toMatchObject({ schema_version: 8, policy: 'release-v3-reusable-v1', target: { sha: repo.T }, lane: { lane: 'standard' }, migrations: [],
      baseline: { merchant: { sha: repo.B, deployment_sha256: hashId('dpl_m1') }, admin: { sha: repo.B, deployment_sha256: hashId('dpl_a1') } },
      admin_pin: { deployment_sha256: hashId('dpl_a0') }, permanent_checks: { m430_absent: true, hold_flags_absent: true }, changes: { files: ['components/ui/A.tsx'] } });
    expect(packet.pull_requests).toMatchObject([{ number: 900, lane: 'standard', required_reviews: 1, recorded_reviews: 1 }]);
    expect(JSON.stringify(packet)).not.toContain('dpl_');
    expect(w.state.listCalls).toBe(0);
  });
  it('a payment path makes the release full and requires two review records per PR', async () => {
    const repo = make({ 'lib/payments/x.ts': 'export const x = 2;\n' });
    await expect(prepare({ env: baseEnv(repo), control: repo.dir, now: NOW, fetchImpl: world(repo).fetchImpl as never, observe: observeWith() as never })).rejects.toThrow('1 of 2');
    const packet = await prepare({ env: baseEnv(repo), control: repo.dir, now: NOW, fetchImpl: world(repo, { reviews: ['rev-a', 'rev-b'] }).fetchImpl as never, observe: observeWith() as never });
    expect(packet.lane.lane).toBe('full');
    expect(packet.changes.payment_paths).toEqual(['lib/payments/x.ts']);
  });
  it('an unknown path makes the release full', async () => {
    const repo = make({ 'weird/new-thing.cfg': 'x' });
    const packet = await prepare({ env: baseEnv(repo), control: repo.dir, now: NOW, fetchImpl: world(repo, { reviews: ['rev-a', 'rev-b'] }).fetchImpl as never, observe: observeWith() as never });
    expect(packet.lane).toMatchObject({ lane: 'full', reasons: ['weird/new-thing.cfg: not on the standard allowlist'] });
  });
  it('fails on a stale baseline: production serves something other than the certified release', async () => {
    const repo = make({ 'components/ui/A.tsx': 'export const A = 3;\n' });
    await expect(prepare({ env: baseEnv(repo), control: repo.dir, now: NOW, fetchImpl: world(repo, { prodServingSha: repo.T }).fetchImpl as never, observe: observeWith() as never })).rejects.toThrow('stale or uncertified baseline');
  });
  it('after a partial deploy, a lock re-certification (merchant newer, admin older) counts every change since the older baseline', async () => {
    const repo = make({ 'components/ui/A.tsx': 'export const A = 7;\n' }, { mid: { 'components/ui/B.tsx': 'export const B = 1;\n' }, certified: ({ B, M }) => ({ merchant: M!, admin: B }) });
    const packet = await prepare({ env: baseEnv(repo), control: repo.dir, now: NOW, fetchImpl: world(repo, { prodServingSha: repo.M }).fetchImpl as never, observe: observeWith() as never });
    expect(packet.baseline).toMatchObject({ merchant: { sha: repo.M, certified_by: 'lock' }, admin: { sha: repo.B, certified_by: 'lock' } });
    expect(packet.changes.files).toEqual(['components/ui/A.tsx', 'components/ui/B.tsx']);
    expect(packet.pull_requests.map((p: Json) => p.number)).toEqual([899, 900]);
  });
  it('mixed baselines certified by the lock but not on one line of history fail closed', async () => {
    const repo = make({ 'components/ui/A.tsx': 'export const A = 6;\n' }, { mid: { 'components/ui/B.tsx': 'export const B = 3;\n' }, side: { 'components/ui/C.tsx': 'export const C = 1;\n' }, certified: ({ M, S }) => ({ merchant: M!, admin: S! }) });
    await expect(prepare({ env: baseEnv(repo), control: repo.dir, now: NOW, fetchImpl: world(repo, { prodServingSha: repo.M, adminServingSha: repo.S }).fetchImpl as never, observe: observeWith() as never })).rejects.toThrow('not on one line of history');
  });
  it('mixed baselines that the lock does not certify still fail as a stale baseline', async () => {
    const repo = make({ 'components/ui/A.tsx': 'export const A = 8;\n' }, { mid: { 'components/ui/B.tsx': 'export const B = 2;\n' } });
    await expect(prepare({ env: baseEnv(repo), control: repo.dir, now: NOW, fetchImpl: world(repo, { prodServingSha: repo.M }).fetchImpl as never, observe: observeWith() as never })).rejects.toThrow('stale or uncertified baseline');
  });
  it('fails when the admin production target is newer than what admin serves', async () => {
    const repo = make({ 'components/ui/A.tsx': 'export const A = 4;\n' });
    await expect(prepare({ env: baseEnv(repo), control: repo.dir, now: NOW, fetchImpl: world(repo, { adminTargetCreated: 500 }).fetchImpl as never, observe: observeWith() as never })).rejects.toThrow('newer than serving');
  });
  it('fails when M430 is present in production', async () => {
    const repo = make({ 'components/ui/A.tsx': 'export const A = 5;\n' });
    const withM430 = prodCatalog(); withM430.set(M430_ID, sha('m'));
    await expect(prepare({ env: baseEnv(repo), control: repo.dir, now: NOW, fetchImpl: world(repo).fetchImpl as never, observe: observeWith(withM430) as never })).rejects.toThrow(/M430|differs from the approved lock/);
  });
  it('fails closed when a merged migration is not applied in production', async () => {
    const file = 'select 1;';
    const delta = { schema_version: 1, migration: '509_x.sql', migration_sha256: sha(file), query_sha256: CATALOG_QUERY_SHA256, postgres_major: 17, applied_as: 'one-whole-file-statement', changes: [] };
    const repo = make({ 'supabase/migrations/509_x.sql': file, 'supabase/catalog-deltas/509_x.json': canonicalJson(delta) });
    await expect(prepare({ env: baseEnv(repo), control: repo.dir, now: NOW, fetchImpl: world(repo, { reviews: ['a1b2', 'c3d4'] }).fetchImpl as never, observe: observeWith() as never })).rejects.toThrow('merged but not applied in production');
    const applied = [...prodRows, { version: '9', name: '509_x', statement_count: 1, statement_sha256: sha('other'), row_sha256: sha('r9') }];
    await expect(prepare({ env: baseEnv(repo), control: repo.dir, now: NOW, fetchImpl: world(repo, { reviews: ['a1b2', 'c3d4'] }).fetchImpl as never, observe: observeWith(prodCatalog(), applied) as never })).rejects.toThrow('not the exact reviewed file');
  });
  it('fails when a payout hold flag is set, when CI is not green, or when not dispatched by the Owner from main', async () => {
    const repo = make({ 'components/ui/A.tsx': 'export const A = 6;\n' });
    await expect(prepare({ env: baseEnv(repo), control: repo.dir, now: NOW, fetchImpl: world(repo, { holdFlag: true }).fetchImpl as never, observe: observeWith() as never })).rejects.toThrow('hold flag');
    await expect(prepare({ env: baseEnv(repo), control: repo.dir, now: NOW, fetchImpl: world(repo, { ciConclusion: 'failure' }).fetchImpl as never, observe: observeWith() as never })).rejects.toThrow('CI');
    await expect(prepare({ env: baseEnv(repo, { GITHUB_TRIGGERING_ACTOR: 'other' }), control: repo.dir, now: NOW, fetchImpl: world(repo).fetchImpl as never, observe: observeWith() as never })).rejects.toThrow('Owner dispatch');
    await expect(prepare({ env: baseEnv(repo, { GITHUB_REF: 'refs/heads/feature' }), control: repo.dir, now: NOW, fetchImpl: world(repo).fetchImpl as never, observe: observeWith() as never })).rejects.toThrow('Owner dispatch');
    await expect(prepare({ env: baseEnv(repo, { RAISE_LANE: 'standard' }), control: repo.dir, now: NOW, fetchImpl: world(repo).fetchImpl as never, observe: observeWith() as never })).rejects.toThrow('never lowered');
  });
  it('refuses a production observation made on the primary instead of the replica', async () => {
    const repo = make({ 'components/ui/A.tsx': 'export const A = 8;\n' });
    const onPrimary = (environment: string) => ({ ...observeWith()(environment), ...(environment === 'production' ? { in_recovery: false } : {}) });
    await expect(prepare({ env: baseEnv(repo), control: repo.dir, now: NOW, fetchImpl: world(repo).fetchImpl as never, observe: onPrimary as never })).rejects.toThrow('production observation must run on a read replica');
  });
  it('captures lock maps only while the live catalog still equals the lock', async () => {
    const repo = make({ 'components/ui/A.tsx': 'export const A = 7;\n' });
    const maps = await captureLockMaps({ env: baseEnv(repo), control: repo.dir, observe: observeWith() as never });
    expect(maps.production.objects).toEqual({ 'table:public.t': sha('t') });
    const drifted = prodCatalog(); drifted.set('table:public.new', sha('n'));
    await expect(captureLockMaps({ env: baseEnv(repo), control: repo.dir, observe: observeWith(drifted) as never })).rejects.toThrow('no longer equals the lock');
  });
});

describe('deploy (end to end, faked platforms)', { timeout: 60_000 }, () => {
  let repo: Repo, sources: { merchant: string; admin: string };
  beforeAll(() => { repo = buildRepo({ 'components/ui/A.tsx': 'export const A = 9;\n' }); sources = { merchant: clone(repo, repo.T), admin: clone(repo, repo.T) }; });
  afterAll(() => { for (const d of [repo.dir, sources.merchant, sources.admin]) rmSync(d, { recursive: true, force: true }); });

  async function approved(w: ReturnType<typeof world>, r: Repo = repo) {
    const packet = await prepare({ env: baseEnv(r), control: r.dir, now: NOW, fetchImpl: w.fetchImpl as never, observe: observeWith() as never });
    const dir = mkdtempSync(join(tmpdir(), 'v3-zip-'));
    writeFileSync(join(dir, 'packet.json'), packetBytes(packet));
    execFileSync('zip', ['-q', '-X', 'a.zip', 'packet.json'], { cwd: dir });
    const zip = readFileSync(join(dir, 'a.zip')); rmSync(dir, { recursive: true, force: true });
    w.state.artifacts['5'] = zip;
    w.state.artifactMeta = [{ id: 5, name: 'release-packet-55-1', expired: false, digest: `sha256:${sha(zip)}`, workflow_run: { id: 55 } }];
    const digest = packetDigest(packet);
    w.state.comments['123'] = { id: 123, user: { login: 'cipherhq' }, created_at: '2026-11-04T01:30:00Z', body: `Owner approval, verbatim: "approve".\nRelease-Approval: v1 packet=${digest} decision=APPROVED` };
    return { packet, digest };
  }
  const deployEnv = (digest: string, over: Json = {}, r: Repo = repo) => baseEnv(r, { GITHUB_RUN_ID: '77', PREPARE_RUN_ID: '55', PACKET_SHA256: digest, APPROVAL_COMMENT_URL: 'https://github.com/cipherhq/waaiio/issues/221#issuecomment-123', ...over });

  it('re-checks, deploys merchant then admin, assigns the admin alias once and returns a record', async () => {
    const w = world(repo);
    const { digest } = await approved(w);
    const record = await deploy({ env: deployEnv(digest), control: repo.dir, sources, now: NOW + 3600_000, fetchImpl: w.fetchImpl as never, observe: observeWith() as never, run: w.run as never, pause: async () => {} });
    expect(record).toMatchObject({ packet_sha256: digest, target_sha: repo.T, merchant_deployment_sha256: hashId('dpl_merchantNew'), admin_deployment_sha256: hashId('dpl_adminNew') });
    expect(w.state.aliasPosts).toBe(1);
    expect(w.state.admin.serving).toBe('dpl_adminNew');
  });
  it('deploys from a mixed-baseline packet (lock re-certification after a partial deploy), per-project baselines', async () => {
    const mixed = buildRepo({ 'components/ui/A.tsx': 'export const A = 10;\n' }, { mid: { 'components/ui/B.tsx': 'export const B = 4;\n' }, certified: ({ B, M }) => ({ merchant: M!, admin: B }) });
    const src = { merchant: clone(mixed, mixed.T), admin: clone(mixed, mixed.T) };
    try {
      const w = world(mixed, { prodServingSha: mixed.M });
      const { packet, digest } = await approved(w, mixed);
      expect(packet.baseline).toMatchObject({ merchant: { sha: mixed.M }, admin: { sha: mixed.B } });
      const record = await deploy({ env: deployEnv(digest, {}, mixed), control: mixed.dir, sources: src, now: NOW + 3600_000, fetchImpl: w.fetchImpl as never, observe: observeWith() as never, run: w.run as never, pause: async () => {} });
      expect(record).toMatchObject({ target_sha: mixed.T, merchant_deployment_sha256: hashId('dpl_merchantNew'), admin_deployment_sha256: hashId('dpl_adminNew') });
      expect(w.state.merchant.serving).toBe('dpl_merchantNew');
      expect(w.state.admin.serving).toBe('dpl_adminNew');
      expect(w.state.aliasPosts).toBe(1);
    } finally { for (const d of [mixed.dir, src.merchant, src.admin]) rmSync(d, { recursive: true, force: true }); }
  });
  it('REGRESSION (run 41937185420): admin --skip-domain leaves the production target on the approved pin, and the deploy completes', async () => {
    const w = world(repo);
    const { digest } = await approved(w);
    await deploy({ env: deployEnv(digest), control: repo.dir, sources, now: NOW + 3600_000, fetchImpl: w.fetchImpl as never, observe: observeWith() as never, run: w.run as never, pause: async () => {} });
    expect(w.state.admin.target).toBe('dpl_a0');
    expect(w.state.admin.serving).toBe('dpl_adminNew');
    expect(w.state.aliasPosts).toBe(1);
  });
  it('also completes if the admin production target moves to the new candidate itself', async () => {
    const w = world(repo, { skipDomainMovesTarget: true });
    const { digest } = await approved(w);
    await deploy({ env: deployEnv(digest), control: repo.dir, sources, now: NOW + 3600_000, fetchImpl: w.fetchImpl as never, observe: observeWith() as never, run: w.run as never, pause: async () => {} });
    expect(w.state.admin.target).toBe('dpl_adminNew');
    expect(w.state.aliasPosts).toBe(1);
  });
  it('stops before any deployment when production changed after approval', async () => {
    const w = world(repo);
    const { digest } = await approved(w);
    const drifted = prodCatalog(); drifted.set('table:public.surprise', sha('s'));
    let deploys = 0; const run = (...a: unknown[]) => { deploys++; return (w.run as never as (...x: unknown[]) => string)(...a); };
    await expect(deploy({ env: deployEnv(digest), control: repo.dir, sources, now: NOW + 3600_000, fetchImpl: w.fetchImpl as never, observe: observeWith(drifted) as never, run: run as never, pause: async () => {} })).rejects.toThrow(/differs|changed/);
    expect(deploys).toBe(0);
  });
  it('stops on a wrong digest, an expired packet, a missing approval record, a reused approval or a mismatched target', async () => {
    const w = world(repo);
    const { digest } = await approved(w);
    const go = (env: Json, now = NOW + 3600_000, ww = w) => deploy({ env, control: repo.dir, sources, now, fetchImpl: ww.fetchImpl as never, observe: observeWith() as never, run: w.run as never, pause: async () => {} });
    await expect(go(deployEnv('a'.repeat(64)))).rejects.toThrow('approved sha256');
    await expect(go(deployEnv(digest), NOW + 25 * 3600_000)).rejects.toThrow('expired');
    await expect(go(deployEnv(digest, { APPROVAL_COMMENT_URL: 'https://github.com/cipherhq/waaiio/issues/221#issuecomment-999' }))).rejects.toThrow('404');
    await expect(go(deployEnv(digest, { TARGET_SHA: repo.B }))).rejects.toThrow('differs from the approved packet target');
    const reused = world(repo, { deployRuns: [{ id: 70, display_title: `Release deploy ${digest}` }, { id: 77, display_title: `Release deploy ${digest}` }] });
    Object.assign(reused.state, { artifacts: w.state.artifacts, artifactMeta: w.state.artifactMeta, comments: w.state.comments });
    await expect(go(deployEnv(digest), NOW + 3600_000, reused)).rejects.toThrow('already used');
    expect(w.state.aliasPosts).toBe(0);
  });
  it('stops when a deployment reports the wrong database project (runtime identity)', async () => {
    const w = world(repo);
    const original = w.fetchImpl;
    const swapped = async (url: string, opts?: Record<string, unknown>) => {
      const res = await original(url, opts as never);
      if (url === 'https://staging.waaiio.com/api/release-identity') { const body = await res.json() as Json; return response(200, { ...body, supabaseProjectRef: 'cxcmiqotkowhxinjbytg' }); }
      return res;
    };
    await expect(prepare({ env: baseEnv(repo), control: repo.dir, now: NOW, fetchImpl: swapped as never, observe: observeWith() as never })).rejects.toThrow('staging merchant runtime identity mismatch');
  });
  it('a full-lane packet needs a recorded Owner staging acceptance for that packet', async () => {
    const full = buildRepo({ 'lib/payments/x.ts': 'export const x = 9;\n' });
    const src = { merchant: clone(full, full.T), admin: clone(full, full.T) };
    const w = world(full, { reviews: ['rev-a', 'rev-b'] });
    const packet = await prepare({ env: baseEnv(full), control: full.dir, now: NOW, fetchImpl: w.fetchImpl as never, observe: observeWith() as never });
    const dir = mkdtempSync(join(tmpdir(), 'v3-zip-')); writeFileSync(join(dir, 'packet.json'), packetBytes(packet)); execFileSync('zip', ['-q', '-X', 'a.zip', 'packet.json'], { cwd: dir });
    const zip = readFileSync(join(dir, 'a.zip')); rmSync(dir, { recursive: true, force: true });
    const digest = packetDigest(packet);
    Object.assign(w.state, { artifacts: { 5: zip }, artifactMeta: [{ id: 5, name: 'release-packet-55-1', expired: false, digest: `sha256:${sha(zip)}`, workflow_run: { id: 55 } }],
      comments: { 123: { id: 123, user: { login: 'cipherhq' }, created_at: '2026-11-04T01:30:00Z', body: `Release-Approval: v1 packet=${digest} decision=APPROVED` },
        124: { id: 124, user: { login: 'cipherhq' }, created_at: '2026-11-04T01:40:00Z', body: `Release-Staging-Acceptance: v1 packet=${digest} decision=ACCEPTED` } } });
    const env = baseEnv(full, { GITHUB_RUN_ID: '77', PREPARE_RUN_ID: '55', PACKET_SHA256: digest, APPROVAL_COMMENT_URL: 'https://github.com/cipherhq/waaiio/issues/221#issuecomment-123' });
    await expect(deploy({ env, control: full.dir, sources: src, now: NOW + 3600_000, fetchImpl: w.fetchImpl as never, observe: observeWith() as never, run: w.run as never, pause: async () => {} })).rejects.toThrow('GitHub comment URL');
    const record = await deploy({ env: { ...env, STAGING_ACCEPTANCE_COMMENT_URL: 'https://github.com/cipherhq/waaiio/issues/221#issuecomment-124' }, control: full.dir, sources: src, now: NOW + 3600_000, fetchImpl: w.fetchImpl as never, observe: observeWith() as never, run: w.run as never, pause: async () => {} });
    expect(record.target_sha).toBe(full.T);
    for (const d of [full.dir, src.merchant, src.admin]) rmSync(d, { recursive: true, force: true });
  });
  it('stops when a gate contract file (the lock) changed after the packet was prepared', async () => {
    const w = world(repo);
    const { digest } = await approved(w);
    const g = (...a: string[]) => execFileSync('git', a, { cwd: repo.dir, encoding: 'utf8' }).trim();
    const lock = JSON.parse(readFileSync(join(repo.dir, 'scripts/release-v3/lock.json'), 'utf8'));
    lock.reviewed_prs = { 999: 'a'.repeat(40) };
    writeFileSync(join(repo.dir, 'scripts/release-v3/lock.json'), canonicalJson(lock));
    g('commit', '-qam', 'lock edit'); const G2 = g('rev-parse', 'HEAD'); g('update-ref', 'refs/remotes/origin/main', G2);
    try {
      await expect(deploy({ env: deployEnv(digest, { GITHUB_SHA: G2 }), control: repo.dir, sources, now: NOW + 3600_000, fetchImpl: w.fetchImpl as never, observe: observeWith() as never, run: w.run as never, pause: async () => {} }))
        .rejects.toThrow('Gate rules changed since the packet was prepared');
    } finally { g('reset', '-q', '--hard', repo.G); g('update-ref', 'refs/remotes/origin/main', repo.G); }
  });
  it('stops before the admin alias when the admin production target moved unexpectedly', async () => {
    const w = world(repo);
    const { digest } = await approved(w);
    const run = (cmd: string, args: string[], opts: { cwd: string }) => {
      const out = w.run(cmd, args, opts);
      // Someone else's newer admin deployment becomes the production target.
      if (args.includes('--skip-domain')) { w.state.deployments.dpl_other = { ...w.state.deployments.dpl_adminNew, id: 'dpl_other', createdAt: 2000 }; w.state.admin.target = 'dpl_other'; }
      return out;
    };
    await expect(deploy({ env: deployEnv(digest), control: repo.dir, sources, now: NOW + 3600_000, fetchImpl: w.fetchImpl as never, observe: observeWith() as never, run: run as never, pause: async () => {} })).rejects.toThrow('Admin production target changed');
    expect(w.state.aliasPosts).toBe(0);
  });
});

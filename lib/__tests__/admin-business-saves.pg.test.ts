import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { NextRequest } from 'next/server';
const url = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_PG_TESTS === 'true' && !url) throw new Error('Disposable PostgreSQL required');
const suite = url ? describe : describe.skip;
const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const grant = '11111111-2222-3333-4444-555555555555';
const admin = { id: 'admin', userId: 'admin', sessionId: 'session', role: 'admin', aal: 'aal2', bearerToken: 'synthetic', email: '' } as const;
const f = vi.hoisted(() => ({ pool: null as pg.Pool | null, audit: vi.fn() }));
vi.mock('@/lib/admin-auth', () => ({ requirePlatformAdmin: async () => admin }));
vi.mock('@/lib/admin-audit', () => ({ logAdminAudit: (...args: unknown[]) => f.audit(...args) }));
// Real PostgreSQL transport for the actual handlers/step-up helper, not hosted PostgREST.
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({ from: (table: string) => {
  if (!['businesses', 'admin_step_up_authorizations'].includes(table)) throw new Error('Unexpected table');
  let patch: Record<string, unknown> | null = null;
  let columns = '*'; const predicates: string[] = []; const args: unknown[] = [];
  const col = (name: string) => { if (!/^[a-z_]+$/.test(name)) throw new Error('Bad column'); return '"' + name + '"'; };
  const condition = (key: string, op: string, value: unknown) => { args.push(value); predicates.push(`${col(key)} ${op} $${args.length}`); return q; };
  const run = async () => {
    const values = [...args];
    const set = patch ? Object.entries(patch).map(([key, value]) => { values.push(value); return `${col(key)} = $${values.length}`; }).join(', ') : '';
    const projection = columns.split(',').map(s => s.trim() === '*' ? '*' : col(s.trim())).join(',');
    const where = predicates.length ? ` WHERE ${predicates.join(' AND ')}` : '';
    try {
      const result = await f.pool!.query(patch ? `UPDATE public.${table} SET ${set}${where} RETURNING ${projection}` : `SELECT ${projection} FROM public.${table}${where}`, values);
      return { data: result.rows, error: null };
    } catch (error) { return { data: null, error }; }
  };
  const q = {
    select: (value: string) => { columns = value; return q; }, update: (value: Record<string, unknown>) => { patch = value; return q; },
    eq: (key: string, value: unknown) => condition(key, '=', value), gt: (key: string, value: unknown) => condition(key, '>', value),
    is: (key: string, _value: null) => { predicates.push(`${col(key)} IS NULL`); return q; },
    not: (key: string, _op: string, _value: null) => { predicates.push(`${col(key)} IS NOT NULL`); return q; },
    maybeSingle: async () => { const r = await run(); return { ...r, data: r.data?.length === 1 ? r.data[0] : null }; },
    then: (resolve: (r: Awaited<ReturnType<typeof run>>) => unknown, reject?: (e: unknown) => unknown) => run().then(resolve, reject),
  }; return q;
} }) }));
import { consumeStepUp, hashOperationParams } from '@/lib/admin-step-up';
import { POST as status } from '@/app/api/admin/businesses/[id]/status/route';
import { POST as profile } from '@/app/api/admin/businesses/[id]/profile/route';
const params = { business_id: id, previous_status: 'active', status: 'pending' };
const prior = readFileSync('supabase/migrations/454_settlement_force_reconciliation.sql', 'utf8');
const priorConstraint = prior.slice(prior.indexOf('ALTER TABLE'), prior.indexOf('-- §2.'));
const migration = readFileSync('supabase/migrations/494_business_status_step_up.sql', 'utf8');
suite('M494 and admin saves with disposable PostgreSQL', () => {
  beforeAll(async () => {
    const target = new URL(url!);
    const isolatedCi = process.env.GITHUB_ACTIONS === 'true' && target.username === 'test_runner' && /^\/pg_test_\d+$/.test(target.pathname);
    if (!['localhost', '127.0.0.1'].includes(target.hostname) || (target.pathname !== '/admin_save_test' && !isolatedCi)) throw new Error('Disposable local database only');
    f.pool = new pg.Pool({ connectionString: url });
    await f.pool.query(`DROP TABLE IF EXISTS public.admin_step_up_authorizations, public.businesses CASCADE;
      CREATE TABLE public.admin_step_up_authorizations(id uuid PRIMARY KEY, action_type text NOT NULL, admin_user_id text, session_id text, target_id uuid, params_hash text, verified_at timestamptz, expires_at timestamptz, consumed_at timestamptz);
      CREATE TABLE public.businesses(id uuid PRIMARY KEY, name varchar(200), category text, city varchar(50), status text);`);
    await f.pool.query(priorConstraint); await f.pool.query(migration);
  });
  afterAll(async () => { await f.pool?.query('DROP TABLE public.admin_step_up_authorizations, public.businesses'); await f.pool?.end(); });
  beforeEach(async () => {
    f.audit.mockReset().mockResolvedValue({});
    await f.pool!.query('TRUNCATE public.admin_step_up_authorizations, public.businesses');
    await f.pool!.query('INSERT INTO businesses VALUES ($1,$2,$3,$4,$5)', [id, 'Before', 'restaurant', 'Lagos', 'active']);
    await f.pool!.query(`INSERT INTO admin_step_up_authorizations VALUES ($1,'business_status','admin','session',$2,$3,now(),now()+interval '5 minutes',null)`, [grant, id, hashOperationParams(params)]);
  });
  it('validates the final CHECK and preserves every previous action', async () => {
    const actions = [...priorConstraint.matchAll(/'([a-z_]+)'/g)].map(m => m[1]); expect(actions).toHaveLength(17);
    for (const action of actions) await f.pool!.query('INSERT INTO admin_step_up_authorizations(id,action_type) VALUES(gen_random_uuid(),$1)', [action]);
    expect((await f.pool!.query("SELECT convalidated FROM pg_constraint WHERE conname='admin_step_up_authorizations_action_type_check'")).rows).toEqual([{ convalidated: true }]);
    await expect(f.pool!.query("INSERT INTO admin_step_up_authorizations(id,action_type) VALUES(gen_random_uuid(),'unknown')")).rejects.toMatchObject({ code: '23514' });
  });
  it('reruns safely and supports rollback to the previous constraint', async () => {
    await f.pool!.query(migration); await f.pool!.query('DELETE FROM admin_step_up_authorizations'); await f.pool!.query(priorConstraint);
    await expect(f.pool!.query("INSERT INTO admin_step_up_authorizations(id,action_type) VALUES(gen_random_uuid(),'business_status')")).rejects.toMatchObject({ code: '23514' });
    await f.pool!.query(migration);
  });
  it('permits exactly one concurrent consumption and denies replay', async () => {
    const results = await Promise.allSettled([consumeStepUp(admin, grant, 'business_status', id, params), consumeStepUp(admin, grant, 'business_status', id, params)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    await expect(consumeStepUp(admin, grant, 'business_status', id, params)).rejects.toThrow();
  });
  it('rejects mismatched and expired authorization without changing status', async () => {
    await expect(consumeStepUp(admin, grant, 'business_status', id, { ...params, status: 'suspended' })).rejects.toThrow();
    await f.pool!.query("UPDATE admin_step_up_authorizations SET expires_at=now()-interval '1 second'");
    await expect(consumeStepUp(admin, grant, 'business_status', id, params)).rejects.toThrow();
    expect((await f.pool!.query('SELECT status FROM businesses')).rows[0].status).toBe('active');
  });
  it('allows one of two concurrent status changes from the same previous status', async () => {
    const second = '99999999-2222-3333-4444-555555555555';
    await f.pool!.query(`INSERT INTO admin_step_up_authorizations SELECT $1,action_type,admin_user_id,session_id,target_id,params_hash,verified_at,expires_at,consumed_at FROM admin_step_up_authorizations WHERE id=$2`, [second, grant]);
    const run = (stepUpId: string) => status(new NextRequest('https://local.test/api/admin', { method: 'POST', body: JSON.stringify({ previous_status: 'active', status: 'pending', stepUpId }) }), { params: Promise.resolve({ id }) });
    const results = await Promise.all([run(grant), run(second)]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    expect(f.audit.mock.calls.filter(([entry]) => entry.action === 'change_business_status')).toHaveLength(1);
    expect((await f.pool!.query('SELECT status FROM businesses WHERE id=$1', [id])).rows[0].status).toBe('pending');
  });
  it('executes actual profile and status handlers and reads persisted values independently', async () => {
    const request = (body: unknown) => new NextRequest('https://local.test/api/admin', { method: 'POST', body: JSON.stringify(body) });
    expect((await profile(request({ field: 'name', value: 'After' }), { params: Promise.resolve({ id }) })).status).toBe(200);
    expect((await status(request({ previous_status: 'active', status: 'pending', stepUpId: grant }), { params: Promise.resolve({ id }) })).status).toBe(200);
    expect((await f.pool!.query('SELECT name,status FROM businesses WHERE id=$1', [id])).rows).toEqual([{ name: 'After', status: 'pending' }]);
    expect(f.audit.mock.calls.filter(([entry]) => ['edit_business_field','change_business_status'].includes(entry.action))).toHaveLength(2);
  });
});

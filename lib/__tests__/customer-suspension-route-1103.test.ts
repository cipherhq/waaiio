// #1103: /api/admin/customers/suspension with the real requirePlatformAdmin and
// the real consumeStepUp. Only Supabase Auth, the session check and the
// svc_set_customer_suspension RPC are synthetic; step-up grants live in an
// in-memory table so consumption is a real conditional update.
// The RPC's own SQL (atomic change + audit row) is proved on PostgreSQL in
// customer-suspensions-547.pg.test.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createMemoryDb } from './helpers/memory-db';
import { hashOperationParams } from '@/lib/admin-step-up';

const f = vi.hoisted(() => ({
  role: 'admin' as string, aal: 'aal2', db: null as any,
  rpcCalls: [] as Array<[string, any]>,
  rpcResult: { data: { changed: true }, error: null } as { data: any; error: any },
}));

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({
  auth: {
    getClaims: async (token: string) => token === 'good'
      ? { data: { claims: { sub: 'admin-1', aal: f.aal, session_id: 'sess-1' } } } : { error: new Error('invalid') },
    getUser: async () => ({ data: { user: { id: 'admin-1', email: 'a@x.test', app_metadata: { role: f.role } } } }),
  },
  rpc: (name: string, args: any) => {
    if (name === 'check_session_exists') return { maybeSingle: async () => ({ data: { session_exists: true }, error: null }) };
    f.rpcCalls.push([name, args]);
    return Promise.resolve(f.rpcResult);
  },
  from: (table: string) => f.db.from(table),
}) }));
vi.mock('@/lib/supabase/server', () => ({ createClient: () => { throw new Error('cookie client not expected'); } }));

import { GET, POST } from '@/app/api/admin/customers/suspension/route';

const PHONE = '2348012345678';
const future = () => new Date(Date.now() + 120_000).toISOString();

function grant(params: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  f.db.tables.admin_step_up_authorizations.push({
    id: 'su-1', admin_user_id: 'admin-1', session_id: 'sess-1', action_type: 'customer_suspension', target_id: PHONE,
    params_hash: hashOperationParams(params), verified_at: new Date().toISOString(), consumed_at: null, expires_at: future(), ...extra,
  });
}

const req = (method: 'GET' | 'POST', body?: unknown, token = 'good') => new NextRequest('https://app.test/api/admin/customers/suspension', {
  method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const suspendBody = { phone: PHONE, suspended: true, reason: 'Abusive messages', stepUpId: 'su-1' };
const suspendParams = { phone: PHONE, suspended: true, reason: 'Abusive messages' };

beforeEach(() => {
  f.role = 'admin'; f.aal = 'aal2'; f.rpcCalls = []; f.rpcResult = { data: { changed: true }, error: null };
  f.db = createMemoryDb({
    admin_step_up_authorizations: [], admin_audit_logs: [],
    customer_suspensions: [{ id: 'sus-0', phone: '2348000000000', reason: 'spam', suspended_at: '2026-11-17T00:00:00Z' }],
  });
});

describe('POST suspend/unsuspend', () => {
  it('suspends with a consumed, operation-bound step-up and the audited RPC', async () => {
    grant(suspendParams);
    const res = await POST(req('POST', { ...suspendBody }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ suspended: true, phone: PHONE });
    expect(f.rpcCalls).toEqual([['svc_set_customer_suspension', {
      p_actor_id: 'admin-1', p_phone: PHONE, p_suspend: true, p_reason: 'Abusive messages', p_ip: null,
    }]]);
    expect(f.db.tables.admin_step_up_authorizations[0].consumed_at).toEqual(expect.any(String));
    // The step-up consumption is audited as well (the change itself is audited inside the RPC).
    await vi.waitFor(() => expect(f.db.tables.admin_audit_logs.map((r: any) => r.action)).toContain('step_up_consumed'));
  });

  it('unsuspends with its own step-up; a reason is optional', async () => {
    grant({ phone: PHONE, suspended: false, reason: null });
    const res = await POST(req('POST', { phone: PHONE, suspended: false, stepUpId: 'su-1' }));
    expect(res.status).toBe(200);
    expect(f.rpcCalls[0][1]).toMatchObject({ p_suspend: false, p_reason: null });
  });

  it.each([
    ['support', 'aal2'], ['finance', 'aal2'], ['operations', 'aal2'], ['customer', 'aal2'], ['admin', 'aal1'],
  ])('refuses role %s at %s with 403 and changes nothing', async (role, aal) => {
    f.role = role; f.aal = aal; grant(suspendParams);
    expect((await POST(req('POST', suspendBody))).status).toBe(403);
    expect(f.rpcCalls).toEqual([]);
    expect(f.db.tables.admin_step_up_authorizations[0].consumed_at).toBeNull();
  });

  it('refuses an invalid token with 403', async () => {
    expect((await POST(req('POST', suspendBody, 'forged'))).status).toBe(403);
    expect(f.rpcCalls).toEqual([]);
  });

  it.each([
    ['missing step-up', {}, { ...suspendBody, stepUpId: undefined }],
    ['already consumed', { consumed_at: new Date().toISOString() }, suspendBody],
    ['unverified', { verified_at: null }, suspendBody],
    ['expired', { expires_at: new Date(Date.now() - 1000).toISOString() }, suspendBody],
    ['another action', { action_type: 'messaging_suspension' }, suspendBody],
    ['another number', { target_id: '2348000000000' }, suspendBody],
    ['another session', { session_id: 'sess-2' }, suspendBody],
    ['different reason', {}, { ...suspendBody, reason: 'Something else' }],
    ['unsuspend instead', {}, { ...suspendBody, suspended: false }],
  ])('refuses a %s step-up with 403 step_up_required and no change', async (_label, extra, body) => {
    grant(suspendParams, extra);
    const res = await POST(req('POST', body));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('step_up_required');
    expect(f.rpcCalls).toEqual([]);
  });

  it('a step-up works once: a replay is refused', async () => {
    grant(suspendParams);
    expect((await POST(req('POST', suspendBody))).status).toBe(200);
    expect((await POST(req('POST', suspendBody))).status).toBe(403);
    expect(f.rpcCalls).toHaveLength(1);
  });

  it.each([
    ['a local-format number', { phone: '08012345678' }],
    ['a + prefix', { phone: '+2348012345678' }],
    ['spaces', { phone: '234 801 234 5678' }],
    ['no phone', { phone: undefined }],
    ['a non-boolean flag', { suspended: 'yes' }],
    ['no reason', { reason: undefined }],
    ['a two-letter reason', { reason: ' ab ' }],
    ['a 501-letter reason', { reason: 'x'.repeat(501) }],
    ['a non-text reason', { reason: 42 }],
  ])('rejects %s with 400 before consuming the step-up', async (_label, patch) => {
    grant(suspendParams);
    expect((await POST(req('POST', { ...suspendBody, ...patch }))).status).toBe(400);
    expect(f.db.tables.admin_step_up_authorizations[0].consumed_at).toBeNull();
    expect(f.rpcCalls).toEqual([]);
  });

  it('reports 409 when nothing changed (already suspended / not suspended)', async () => {
    grant(suspendParams);
    f.rpcResult = { data: { changed: false, suspended: true }, error: null };
    const res = await POST(req('POST', suspendBody));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'This number is already suspended', suspended: true });
  });

  it('reports 500 and no success when the RPC fails', async () => {
    grant(suspendParams);
    f.rpcResult = { data: null, error: { message: 'boom' } };
    const res = await POST(req('POST', suspendBody));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Unable to save the suspension');
  });
});

describe('GET suspended numbers', () => {
  it.each(['admin', 'support'])('%s can list them', async role => {
    f.role = role;
    const res = await GET(req('GET'));
    expect(res.status).toBe(200);
    expect((await res.json()).suspensions).toEqual([expect.objectContaining({ phone: '2348000000000', reason: 'spam', suspended_at: '2026-11-17T00:00:00Z' })]);
  });

  it.each(['finance', 'operations', 'customer'])('%s cannot', async role => {
    f.role = role;
    expect((await GET(req('GET'))).status).toBe(403);
  });

  it('shows an error, not an empty list, when the read fails', async () => {
    f.db.failReads.add('customer_suspensions');
    const res = await GET(req('GET'));
    expect(res.status).toBe(500);
  });
});

// #1166 r7 F4, F5, F5a, F6, F6a, S4: /api/admin/customers/suspension with
// emails, using the real requirePlatformAdmin and the real consumeStepUp.
// Only Supabase Auth, the session check and the svc_set_customer_block RPC
// are synthetic; step-up grants live in an in-memory table so consumption is a
// real conditional update. The RPC's SQL (one transaction, one audit row per
// item) is proved on PostgreSQL in customer-email-blocks-559.pg.test.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createMemoryDb } from './helpers/memory-db';
import { hashOperationParams } from '@/lib/admin-step-up';

const f = vi.hoisted(() => ({
  role: 'admin' as string, db: null as any,
  rpcCalls: [] as Array<[string, any]>,
  rpcResult: null as { data: any; error: any } | null,
}));

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({
  auth: {
    getClaims: async (token: string) => token === 'good'
      ? { data: { claims: { sub: 'admin-1', aal: 'aal2', session_id: 'sess-1' } } } : { error: new Error('invalid') },
    getUser: async () => ({ data: { user: { id: 'admin-1', email: 'a@x.test', app_metadata: { role: f.role } } } }),
  },
  rpc: (name: string, args: any) => {
    if (name === 'check_session_exists') return { maybeSingle: async () => ({ data: { session_exists: true }, error: null }) };
    f.rpcCalls.push([name, args]);
    if (f.rpcResult) return Promise.resolve(f.rpcResult);
    // Default: every requested item changes.
    return Promise.resolve({ data: {
      phone: args.p_phone_action ? { changed: true, suspended: args.p_phone_action === 'block' } : null,
      emails: [...args.p_block_emails, ...args.p_unblock_emails].map((email: string) => ({ email, changed: true })),
    }, error: null });
  },
  from: (table: string) => f.db.from(table),
}) }));
vi.mock('@/lib/supabase/server', () => ({ createClient: () => { throw new Error('cookie client not expected'); } }));

import { GET, POST } from '@/app/api/admin/customers/suspension/route';

const PHONE = '2348012345678';
const future = () => new Date(Date.now() + 120_000).toISOString();

function grant(target: string, params: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  f.db.tables.admin_step_up_authorizations.push({
    id: 'su-1', admin_user_id: 'admin-1', session_id: 'sess-1', action_type: 'customer_suspension', target_id: target,
    params_hash: hashOperationParams(params), verified_at: new Date().toISOString(), consumed_at: null, expires_at: future(), ...extra,
  });
}
const req = (method: 'GET' | 'POST', body?: unknown) => new NextRequest('https://app.test/api/admin/customers/suspension', {
  method, headers: { Authorization: 'Bearer good', 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const EMAILS = ['ada@example.com', 'b@example.com'];
const blockParams = { phone: PHONE, suspended: true, reason: 'Abusive messages', emails: EMAILS };
const blockBody = { ...blockParams, stepUpId: 'su-1' };

beforeEach(() => {
  f.role = 'admin'; f.rpcCalls = []; f.rpcResult = null;
  f.db = createMemoryDb({
    admin_step_up_authorizations: [], admin_audit_logs: [],
    customer_suspensions: [{ id: 'sus-0', phone: '2348000000000', reason: 'spam', suspended_at: '2026-11-17T00:00:00Z' }],
    customer_email_blocks: [{ id: 'eb-0', email: 'solo@example.com', phone: null, reason: 'fraud', blocked_at: '2026-11-18T00:00:00Z' }],
  });
});

describe('POST with emails: block a number and emails (F4)', () => {
  it('blocks the number and the emails with one consumed step-up bound to all of them', async () => {
    grant(PHONE, blockParams);
    const res = await POST(req('POST', blockBody));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ suspended: true, phone: PHONE, phoneChanged: true, emails: EMAILS });
    expect(f.rpcCalls).toEqual([['svc_set_customer_block', {
      p_actor_id: 'admin-1', p_phone: PHONE, p_phone_action: 'block', p_block_emails: EMAILS, p_unblock_emails: [],
      p_reason: 'Abusive messages', p_ip: null,
    }]]);
    expect(f.db.tables.admin_step_up_authorizations[0].consumed_at).toEqual(expect.any(String));
  });

  it('binds the emails trimmed, lower-cased, de-duplicated and sorted', async () => {
    grant(PHONE, blockParams);
    const res = await POST(req('POST', { ...blockBody, emails: [' B@Example.com', 'ada@example.com', 'ADA@example.com '] }));
    expect(res.status).toBe(200);
    expect(f.rpcCalls[0][1].p_block_emails).toEqual(EMAILS);
  });

  it.each([
    ['one more email ticked', { emails: [...EMAILS, 'c@example.com'] }],
    ['one email unticked', { emails: ['ada@example.com'] }],
    ['no emails', { emails: [] }],
    ['another reason', { reason: 'Other' }],
    ['unblock instead', { suspended: false }],
  ])('refuses a step-up for a different set (%s) with 403 and no change', async (_label, patch) => {
    grant(PHONE, blockParams);
    const res = await POST(req('POST', { ...blockBody, ...patch }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('step_up_required');
    expect(f.rpcCalls).toEqual([]);
    expect(f.db.tables.admin_step_up_authorizations[0].consumed_at).toBeNull();
  });

  it('a step-up granted without emails (the #1103 binding) does not authorize an email change', async () => {
    grant(PHONE, { phone: PHONE, suspended: true, reason: 'Abusive messages' });
    expect((await POST(req('POST', blockBody))).status).toBe(403);
    expect(f.rpcCalls).toEqual([]);
  });

  it('a step-up works once', async () => {
    grant(PHONE, blockParams);
    expect((await POST(req('POST', blockBody))).status).toBe(200);
    expect((await POST(req('POST', blockBody))).status).toBe(403);
    expect(f.rpcCalls).toHaveLength(1);
  });

  it.each(['support', 'finance', 'operations', 'customer'])('refuses role %s with 403', async role => {
    f.role = role; grant(PHONE, blockParams);
    expect((await POST(req('POST', blockBody))).status).toBe(403);
    expect(f.rpcCalls).toEqual([]);
  });

  it.each([
    ['an invalid email', { emails: ['not-an-email'] }],
    ['a non-list', { emails: 'ada@example.com' }],
    ['a non-text email', { emails: [42] }],
    ['too many emails', { emails: Array.from({ length: 51 }, (_, i) => `u${i}@example.com`) }],
    ['a local-format number', { phone: '08012345678' }],
    ['no number and no emails', { phone: null, emails: [] }],
    ['a missing number field', { phone: undefined }],
    ['no reason when blocking', { reason: undefined }],
    ['a two-letter reason', { reason: 'ab' }],
    ['a non-boolean flag', { suspended: 'yes' }],
  ])('rejects %s with 400 before consuming the step-up', async (_label, patch) => {
    grant(PHONE, blockParams);
    expect((await POST(req('POST', { ...blockBody, ...patch }))).status).toBe(400);
    expect(f.db.tables.admin_step_up_authorizations[0].consumed_at).toBeNull();
    expect(f.rpcCalls).toEqual([]);
  });

  it('adding emails to an already blocked number succeeds; the number is reported unchanged', async () => {
    grant(PHONE, blockParams);
    f.rpcResult = { data: { phone: { changed: false, suspended: true }, emails: [{ email: 'ada@example.com', changed: true }, { email: 'b@example.com', changed: false }] }, error: null };
    const res = await POST(req('POST', blockBody));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ suspended: true, phone: PHONE, phoneChanged: false, emails: ['ada@example.com'] });
  });

  it('reports 409 when nothing changed', async () => {
    grant(PHONE, blockParams);
    f.rpcResult = { data: { phone: { changed: false }, emails: EMAILS.map(email => ({ email, changed: false })) }, error: null };
    const res = await POST(req('POST', blockBody));
    expect(res.status).toBe(409);
    // A change that includes the number keeps the #1103 wording.
    expect(await res.json()).toEqual({ error: 'This number is already suspended', suspended: true });
  });

  it('reports 500 and no success when the RPC fails', async () => {
    grant(PHONE, blockParams);
    f.rpcResult = { data: null, error: { message: 'boom' } };
    const res = await POST(req('POST', blockBody));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Unable to save the change');
  });
});

describe('POST with emails: email-only changes (F5a, F6)', () => {
  it('blocks emails with no number; the target is the first email of the sorted set', async () => {
    const params = { phone: null, suspended: true, reason: 'Fraud', emails: EMAILS };
    grant('ada@example.com', params);
    const res = await POST(req('POST', { ...params, emails: ['b@example.com', 'Ada@example.com'], stepUpId: 'su-1' }));
    expect(res.status).toBe(200);
    expect(f.rpcCalls[0][1]).toMatchObject({ p_phone: null, p_phone_action: null, p_block_emails: EMAILS, p_unblock_emails: [] });
  });

  it('a single email change is bound to that email as the target', async () => {
    const params = { phone: null, suspended: false, reason: null, emails: ['solo@example.com'] };
    grant('b@example.com', params); // wrong target
    expect((await POST(req('POST', { ...params, stepUpId: 'su-1' }))).status).toBe(403);
    f.db.tables.admin_step_up_authorizations = [];
    grant('solo@example.com', params);
    const res = await POST(req('POST', { ...params, stepUpId: 'su-1' }));
    expect(res.status).toBe(200);
    expect(f.rpcCalls[0][1]).toMatchObject({ p_phone: null, p_phone_action: null, p_block_emails: [], p_unblock_emails: ['solo@example.com'], p_reason: null });
  });
});

describe('POST with emails: emails linked to an already blocked number (F6)', () => {
  const params = { phone: null, linkPhone: PHONE, suspended: true, reason: 'Same person', emails: ['new@example.com'] };

  it('blocks the emails linked to the number with no action on the number', async () => {
    grant('new@example.com', params);
    const res = await POST(req('POST', { ...params, stepUpId: 'su-1' }));
    expect(res.status).toBe(200);
    expect(f.rpcCalls[0][1]).toMatchObject({ p_phone: PHONE, p_phone_action: null, p_block_emails: ['new@example.com'], p_unblock_emails: [] });
  });

  it('a grant without the link does not authorize a linked change, and the reverse', async () => {
    const { linkPhone: _l, ...unlinked } = params;
    grant('new@example.com', unlinked);
    expect((await POST(req('POST', { ...params, stepUpId: 'su-1' }))).status).toBe(403);
    f.db.tables.admin_step_up_authorizations = [];
    grant('new@example.com', params);
    expect((await POST(req('POST', { ...unlinked, stepUpId: 'su-1' }))).status).toBe(403);
    expect(f.rpcCalls).toEqual([]);
  });

  it.each([
    ['with a number', { phone: PHONE }],
    ['when unblocking', { suspended: false }],
    ['with no emails', { emails: [] }],
    ['a local-format link', { linkPhone: '08012345678' }],
    ['a non-text link', { linkPhone: 42 }],
  ])('rejects linkPhone %s with 400 before consuming the step-up', async (_label, patch) => {
    grant('new@example.com', params);
    expect((await POST(req('POST', { ...params, ...patch, stepUpId: 'su-1' }))).status).toBe(400);
    expect(f.db.tables.admin_step_up_authorizations[0].consumed_at).toBeNull();
    expect(f.rpcCalls).toEqual([]);
  });
});

describe('POST with emails: reason length in characters', () => {
  it('counts characters as the database does', async () => {
    grant(PHONE, { ...blockParams, reason: '😀😀' });
    expect((await POST(req('POST', { ...blockBody, reason: '😀😀' }))).status).toBe(400);
    f.db.tables.admin_step_up_authorizations = [];
    grant(PHONE, { ...blockParams, reason: '😀😀😀' });
    expect((await POST(req('POST', { ...blockBody, reason: '😀😀😀' }))).status).toBe(200);
  });
});

describe('POST with emails: unblock a number (F6a)', () => {
  it('unblocks the number and only the ticked emails', async () => {
    const params = { phone: PHONE, suspended: false, reason: null, emails: ['ada@example.com'] };
    grant(PHONE, params);
    const res = await POST(req('POST', { ...params, stepUpId: 'su-1' }));
    expect(res.status).toBe(200);
    expect(f.rpcCalls[0][1]).toMatchObject({ p_phone: PHONE, p_phone_action: 'unblock', p_block_emails: [], p_unblock_emails: ['ada@example.com'] });
  });

  it('unblocks the number alone when no email is ticked', async () => {
    const params = { phone: PHONE, suspended: false, reason: null, emails: [] };
    grant(PHONE, params);
    expect((await POST(req('POST', { ...params, stepUpId: 'su-1' }))).status).toBe(200);
    expect(f.rpcCalls[0][1]).toMatchObject({ p_phone_action: 'unblock', p_unblock_emails: [] });
  });
});

describe('POST without emails: the #1103 phone-only change is unchanged', () => {
  it('still uses svc_set_customer_suspension with the #1103 binding', async () => {
    f.rpcResult = { data: { changed: true }, error: null };
    grant(PHONE, { phone: PHONE, suspended: true, reason: 'Abusive messages' });
    const res = await POST(req('POST', { phone: PHONE, suspended: true, reason: 'Abusive messages', stepUpId: 'su-1' }));
    expect(res.status).toBe(200);
    expect(f.rpcCalls[0][0]).toBe('svc_set_customer_suspension');
  });
});

describe('GET (F5)', () => {
  it.each(['admin', 'support'])('%s gets blocked numbers and blocked emails', async role => {
    f.role = role;
    const res = await GET(req('GET'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.suspensions).toEqual([expect.objectContaining({ phone: '2348000000000', reason: 'spam' })]);
    expect(body.emailBlocks).toEqual([expect.objectContaining({ email: 'solo@example.com', phone: null, reason: 'fraud', blocked_at: '2026-11-18T00:00:00Z' })]);
  });

  it.each(['finance', 'operations', 'customer'])('%s cannot', async role => {
    f.role = role;
    expect((await GET(req('GET'))).status).toBe(403);
  });

  it('a failed email read is an error, not an empty list', async () => {
    f.db.failReads.add('customer_email_blocks');
    const res = await GET(req('GET'));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Unable to load blocked emails');
  });
});

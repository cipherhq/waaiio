import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  role: 'admin', aal: 'aal2', subject: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', session: true, claimsError: false, userError: false,
  cookieToken: undefined as string | undefined, event: {} as Record<string, unknown>,
  operations: new Map<string, unknown>(), mutationFailure: null as string | null,
  mutationError: false, readError: false, rpc: vi.fn(), from: vi.fn(),
}));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({
  auth: {
    getClaims: vi.fn(async () => ({ data: { claims: { sub: h.subject, aal: h.aal, session_id: 'session-1' } }, error: h.claimsError ? new Error('invalid') : null })),
    getUser: vi.fn(async () => ({ data: { user: { id: h.userId, email: 'admin@example.test', app_metadata: { role: h.role } } }, error: h.userError ? new Error('revoked') : null })),
  }, rpc: h.rpc, from: h.from,
}) }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({
  auth: { getSession: async () => ({ data: { session: h.cookieToken ? { access_token: h.cookieToken } : null } }) },
}) }));
vi.mock('@/lib/channels/channel-resolver', () => ({ ChannelResolver: class { async resolveByBusinessId() { return null; } } }));
import { GET, PUT, OPTIONS } from '@/app/api/admin/events/[id]/route';

const EVENT = '11111111-1111-4111-8111-111111111111';
const BUSINESS = '22222222-2222-4222-8222-222222222222';
const OP = '33333333-3333-4333-8333-333333333333';
const REV = '2026-10-30T00:00:00.000Z';
const context = { params: Promise.resolve({ id: EVENT }) };
function body() { return {
  business_id: BUSINESS, expected_updated_at: REV, operation_id: OP,
  changes: { name: 'Updated event', date: '2026-11-12', time: '18:30', venue: 'New venue', price: 1200, status: 'published' },
}; }
function request(method: string, value?: unknown, token: string | null = 'Bearer valid', query = '', origin = 'https://admin-staging.waaiio.com') {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Origin: origin };
  if (token !== null) headers.Authorization = token;
  return new NextRequest('https://example.test/api/admin/events/' + EVENT + query, {
    method, headers, ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
}
beforeEach(() => {
  h.role = 'admin'; h.aal = 'aal2'; h.subject = h.userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  h.session = true; h.claimsError = h.userError = false; h.cookieToken = undefined;
  h.event = { id: EVENT, business_id: BUSINESS, name: 'Original', date: '2026-11-01', time: '10:00:00', venue: 'Original venue', price: 100, status: 'published', updated_at: REV };
  h.operations.clear(); h.mutationFailure = null; h.mutationError = h.readError = false;
  h.rpc.mockReset().mockImplementation((name: string, args: Record<string, any>) => {
    if (name === 'check_session_exists') return { maybeSingle: async () => ({ data: { session_exists: h.session }, error: null }) };
    if (name !== 'mutate_event') throw new Error('Unexpected RPC: ' + name);
    if (h.mutationError) return Promise.resolve({ data: null, error: new Error('database') });
    if (h.mutationFailure) return Promise.resolve({ data: { success: false, reason: h.mutationFailure }, error: null });
    const old = h.operations.get(args.p_operation_id) as Record<string, unknown> | undefined;
    if (old) return Promise.resolve({ data: { ...old, replayed: true }, error: null });
    h.event = { ...h.event, ...args.p_changes, updated_at: '2026-10-30T00:01:00.000Z' };
    const result = { success: true, event: { ...h.event }, operation_id: args.p_operation_id, cancelled: h.event.status === 'cancelled', counts: { cancelled_tickets: 0, recipients: 0, refunds_pending: 0 } };
    h.operations.set(args.p_operation_id, result);
    return Promise.resolve({ data: result, error: null });
  });
  h.from.mockReset().mockImplementation((table: string) => {
    const filters: Record<string, unknown> = {};
    const chain: any = {
      select: vi.fn(() => chain), eq: vi.fn((key, value) => { filters[key] = value; return chain; }),
      order: vi.fn(() => chain), range: vi.fn(async () => ({ data: [], error: null })),
      insert: vi.fn(async () => ({ error: null })),
      maybeSingle: vi.fn(async () => {
        if (h.readError) return { data: null, error: new Error('read failed') };
        if (table === 'events') return { data: h.event, error: null };
        if (table === 'event_mutation_operations') {
          const result = h.operations.get(String(filters.id));
          return { data: result ? { response_payload: result } : null, error: null };
        }
        return { data: null, error: null };
      }),
    };
    return chain;
  });
});
function mutations() { return h.rpc.mock.calls.filter(([name]) => name === 'mutate_event'); }

describe('Admin Event actual handler and actual platform authorization', () => {
  it('persists all six fields using bearer-only authority and reads the committed operation back', async () => {
    const response = await PUT(request('PUT', body()), context);
    expect(response.status).toBe(200);
    const saved = await response.json();
    expect(saved.committed).toBe(true);
    expect(saved.event).toMatchObject(body().changes);
    expect(mutations()[0][1]).toMatchObject({ p_actor_id: h.userId, p_actor_kind: 'admin', p_business_id: BUSINESS });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://admin-staging.waaiio.com');
    const read = await GET(request('GET', undefined, 'Bearer valid', '?operation_id=' + OP), context);
    expect((await read.json()).event).toMatchObject(body().changes);
    expect(mutations()).toHaveLength(1);
  });
  it.each([
    ['missing token', () => {}, null],
    ['malformed token', () => { h.cookieToken = 'valid-cookie'; }, 'Basic invalid'],
    ['forged token', () => { h.claimsError = true; h.cookieToken = 'valid-cookie'; }, 'Bearer invalid'],
    ['revoked token', () => { h.userError = true; }, 'Bearer valid'],
    ['missing session', () => { h.session = false; }, 'Bearer valid'],
    ['subject mismatch', () => { h.subject = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; }, 'Bearer valid'],
    ['AAL1', () => { h.aal = 'aal1'; }, 'Bearer valid'],
    ['operations role', () => { h.role = 'operations'; }, 'Bearer valid'],
    ['finance role', () => { h.role = 'finance'; }, 'Bearer valid'],
    ['user role', () => { h.role = 'user'; }, 'Bearer valid'],
  ] as const)('denies %s before event mutation', async (_name, setup, token) => {
    setup();
    expect((await PUT(request('PUT', body(), token), context)).status).toBe(403);
    expect(mutations()).toHaveLength(0);
  });
  it('denies unsupported origin before mutation and returns bounded preflight headers', async () => {
    expect((await PUT(request('PUT', body(), 'Bearer valid', '', 'https://untrusted.test'), context)).status).toBe(403);
    expect(mutations()).toHaveLength(0);
    const preflight = await OPTIONS(request('OPTIONS'));
    expect(preflight.headers.get('Access-Control-Allow-Methods')).toBe('GET, PUT, OPTIONS');
    expect(preflight.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });
  it.each([
    ['extra field', { ...body(), actor_id: h.userId }],
    ['invalid date', { ...body(), changes: { ...body().changes, date: '2026-02-30' } }],
    ['combined date/time', { ...body(), changes: { ...body().changes, date: '2026-11-12T18:30:00' } }],
    ['invalid time', { ...body(), changes: { ...body().changes, time: '25:30' } }],
    ['fractional price', { ...body(), changes: { ...body().changes, price: 1.5 } }],
    ['negative price', { ...body(), changes: { ...body().changes, price: -1 } }],
    ['unsupported status', { ...body(), changes: { ...body().changes, status: 'active' } }],
    ['missing field', { ...body(), changes: { name: 'Only name' } }],
    ['forbidden event field', { ...body(), changes: { ...body().changes, business_id: BUSINESS } }],
    ['invalid revision', { ...body(), expected_updated_at: 'yesterday' }],
  ])('rejects %s without mutation', async (_name, value) => {
    expect((await PUT(request('PUT', value), context)).status).toBe(400);
    expect(mutations()).toHaveLength(0);
  });
  it.each(['revision_conflict', 'operation_conflict', 'event_cancellation_final'])('reports %s without false success', async code => {
    h.mutationFailure = code;
    const response = await PUT(request('PUT', body()), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ success: false, code });
    expect(h.event.name).toBe('Original');
  });
  it('reports mismatched business identity as denied', async () => {
    h.mutationFailure = 'identity_mismatch';
    expect((await PUT(request('PUT', body()), context)).status).toBe(403);
  });
  it('reports unconfirmed database outcome without a committed flag', async () => {
    h.mutationError = true;
    const response = await PUT(request('PUT', body()), context);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ success: false, code: 'persistence_unconfirmed' });
  });
  it('zero/absent persistence result is never success', async () => {
    h.rpc.mockImplementation((name: string) => name === 'check_session_exists'
      ? { maybeSingle: async () => ({ data: { session_exists: true }, error: null }) }
      : Promise.resolve({ data: null, error: null }));
    expect((await PUT(request('PUT', body()), context)).status).toBe(500);
  });
  it('lost-response recovery is read-only and a missing operation is explicit', async () => {
    await PUT(request('PUT', body()), context);
    expect((await GET(request('GET', undefined, 'Bearer valid', '?operation_id=' + OP), context)).status).toBe(200);
    expect((await GET(request('GET', undefined, 'Bearer valid', '?operation_id=44444444-4444-4444-8444-444444444444'), context)).status).toBe(404);
    expect(mutations()).toHaveLength(1);
  });
  it('recovers a committed save after its database response was lost', async () => {
    const original = h.rpc.getMockImplementation()!;
    h.rpc.mockImplementation((name: string, args: Record<string, unknown>) => {
      const value = original(name, args);
      return name === 'mutate_event'
        ? Promise.resolve(value).then(() => ({ data: null, error: new Error('lost response') }))
        : value;
    });
    expect((await PUT(request('PUT', body()), context)).status).toBe(500);
    const recovered = await GET(request('GET', undefined, 'Bearer valid', '?operation_id=' + OP), context);
    expect(recovered.status).toBe(200);
    expect((await recovered.json()).event).toMatchObject(body().changes);
    expect(mutations()).toHaveLength(1);
  });
  it('rejects a success envelope containing a stale event result', async () => {
    const original = h.rpc.getMockImplementation()!;
    h.rpc.mockImplementation((name: string, args: Record<string, unknown>) => {
      const value = original(name, args);
      return name === 'mutate_event'
        ? Promise.resolve(value).then((result: any) => ({ ...result, data: { ...result.data, event: { ...result.data.event, venue: 'Old venue' } } }))
        : value;
    });
    expect((await PUT(request('PUT', body()), context)).status).toBe(500);
  });
  it('readback failure is not an empty successful result', async () => {
    h.readError = true;
    expect((await GET(request('GET'), context)).status).toBe(503);
  });
});

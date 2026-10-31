import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const grant = '11111111-2222-3333-4444-555555555555';
const f = vi.hoisted(() => ({
  role: 'admin', aal: 'aal2', session: true, validToken: true,
  before: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', name: 'Before', city: 'Lagos', category: 'restaurant', status: 'active' } as Record<string, unknown> | null,
  categoryError: false, readError: false, writeError: false, zero: false, savedValue: null as string | null,
  writes: [] as Array<{ table: string; values: Record<string, unknown>; filters: Record<string, unknown> }>,
  stepUp: null as Record<string, unknown> | null,
  audit: vi.fn(),
}));
vi.mock('@/lib/admin-audit', () => ({ logAdminAudit: (...args: unknown[]) => f.audit(...args) }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({
  auth: {
    getClaims: async () => ({ data: { claims: f.validToken ? { sub: 'admin', aal: f.aal, session_id: 'session' } : null }, error: null }),
    getUser: async () => ({ data: { user: { id: 'admin', app_metadata: { role: f.role } } }, error: null }),
  },
  rpc: () => ({ maybeSingle: async () => ({ data: { session_exists: f.session }, error: null }) }),
  from: (table: string) => {
    const filters: Record<string, unknown> = {};
    let values: Record<string, unknown> | null = null;
    const run = async () => {
      if (table === 'category_templates') return { data: ['restaurant', 'mall_vendor', 'instagram_vendor'].includes(String(filters.key)) ? { key: filters.key } : null, error: f.categoryError ? { message: 'unavailable' } : null };
      if (table === 'admin_step_up_authorizations') {
        if (!f.stepUp || Object.entries(filters).some(([key, value]) => f.stepUp![key] !== value)) return { data: [], error: null };
        f.stepUp = null;
        return { data: [{ id: 'grant' }], error: null };
      }
      if (table !== 'businesses') throw new Error('Unexpected table ' + table);
      if (!values) return { data: f.before, error: f.readError ? { message: 'read failed' } : null };
      f.writes.push({ table, values, filters: { ...filters } });
      const field = Object.keys(values)[0];
      return { data: f.zero ? null : { ...f.before, ...values, ...(f.savedValue !== null ? { [field]: f.savedValue } : {}) }, error: f.writeError ? { message: 'write failed' } : null };
    };
    const q = {
      select: (_columns: string) => q,
      update: (patch: Record<string, unknown>) => { values = patch; return q; },
      eq: (key: string, value: unknown) => { filters[key] = value; return q; },
      is: (key: string, value: unknown) => { filters[key] = value; return q; },
      not: () => q, gt: () => q,
      maybeSingle: run,
      then: (resolve: (r: Awaited<ReturnType<typeof run>>) => unknown, reject?: (e: unknown) => unknown) => run().then(resolve, reject),
    };
    return q;
  },
}) }));
import { POST as profile, OPTIONS } from '@/app/api/admin/businesses/[id]/profile/route';
import { POST as status } from '@/app/api/admin/businesses/[id]/status/route';
import { hashOperationParams } from '@/lib/admin-step-up';
function request(body: unknown) {
  return new NextRequest('https://staging.example/api/admin/businesses/' + id, {
    method: 'POST', headers: { authorization: 'Bearer synthetic', origin: 'https://admin-staging.waaiio.com' }, body: JSON.stringify(body),
  });
}
function call(handler = profile, body: unknown = { field: 'name', value: 'After' }, businessId = id) {
  return handler(request(body), { params: Promise.resolve({ id: businessId }) });
}
const statusBody = () => ({ previous_status: 'active', status: 'pending', stepUpId: grant });
function authorize(overrides: Record<string, unknown> = {}) {
  f.stepUp = { id: grant, admin_user_id: 'admin', session_id: 'session', action_type: 'business_status',
    target_id: id, consumed_at: null,
    params_hash: hashOperationParams({ business_id: id, previous_status: 'active', status: 'pending' }), ...overrides };
}
beforeEach(() => {
  f.role = 'admin'; f.aal = 'aal2'; f.session = true; f.validToken = true;
  f.before = { id, name: 'Before', city: 'Lagos', category: 'restaurant', status: 'active' };
  f.categoryError = false; f.readError = false; f.writeError = false; f.zero = false; f.savedValue = null;
  f.writes.length = 0; f.stepUp = null; f.audit.mockReset().mockResolvedValue({});
});
for (const [name, handler, body] of [['profile', profile, () => ({ field: 'name', value: 'After' })], ['status', status, statusBody]] as const) {
  describe(name + ' actual handler with real admin authorization', () => {
    it.each(['support', 'finance', 'operations', 'merchant'])('denies %s before writes', async role => {
      f.role = role; expect((await call(handler, body())).status).toBe(403); expect(f.writes).toEqual([]);
    });
    it('denies AAL1', async () => { f.aal = 'aal1'; expect((await call(handler, body())).status).toBe(403); expect(f.writes).toEqual([]); });
    it('denies revoked sessions', async () => { f.session = false; expect((await call(handler, body())).status).toBe(403); expect(f.writes).toEqual([]); });
    it('denies invalid bearer tokens without cookie fallback', async () => { f.validToken = false; expect((await call(handler, body())).status).toBe(403); expect(f.writes).toEqual([]); });
    it('rejects invalid IDs', async () => { expect((await call(handler, body(), 'invalid')).status).toBe(400); expect(f.writes).toEqual([]); });
    it('reports missing business', async () => { f.before = null; expect((await call(handler, body())).status).toBe(404); expect(f.writes).toEqual([]); });
    it('reports read failures', async () => { f.readError = true; expect((await call(handler, body())).status).toBe(500); expect(f.writes).toEqual([]); });
    it('does not audit a failed write', async () => { authorize(); f.writeError = true; expect((await call(handler, body())).status).toBe(500); expect(f.audit.mock.calls.some(([a]) => a.action.startsWith('edit_') || a.action === 'change_business_status')).toBe(false); });
    it('does not accept or audit zero rows', async () => { authorize(); f.zero = true; expect((await call(handler, body())).status).toBe(409); expect(f.audit.mock.calls.some(([a]) => a.action.startsWith('edit_') || a.action === 'change_business_status')).toBe(false); });
    it('returns persisted truth and audit warning after audit failure', async () => {
      authorize(); f.savedValue = name === 'profile' ? 'Persisted' : 'pending'; f.audit.mockResolvedValue({ error: 'audit unavailable' });
      const res = await call(handler, body()); expect(res.status).toBe(200);
      const data = await res.json(); expect(data.auditRecorded).toBe(false); expect(data.business[name === 'profile' ? 'name' : 'status']).toBe(f.savedValue);
    });
    it.each([null, [], {}, { field: 'name', value: 'After', owner_id: 'other' }])('rejects invalid bodies %j', async value => { expect((await call(handler, value)).status).toBe(400); expect(f.writes).toEqual([]); });
  });
}
describe('profile field contract', () => {
  it('reports catalog failure as unavailable without writes', async () => { f.categoryError = true; expect((await call(profile, { field: 'category', value: 'restaurant' })).status).toBe(503); expect(f.writes).toEqual([]); });
  it.each([['name', ' After '], ['city', ''], ['category', 'restaurant'], ['category', 'mall_vendor'], ['category', 'instagram_vendor']])('saves only %s and audits persisted values', async (field, value) => {
    const res = await call(profile, { field, value }); expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ business: { id, [field]: value.trim() }, auditRecorded: true });
    expect(f.writes).toEqual([{ table: 'businesses', values: { [field]: value.trim() }, filters: { id, [field]: f.before![field] } }]);
    expect(f.audit).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'admin', entityId: id, action: 'edit_business_field', details: expect.objectContaining({ field, new_value: value.trim() }) }));
  });
  it.each([{ field: 'status', value: 'active' }, { field: 'name', value: '' }, { field: 'name', value: 'x'.repeat(201) }, { field: 'city', value: 'x'.repeat(51) }, { field: 'category', value: 'unknown' }])('rejects %j', async body => { expect((await call(profile, body)).status).toBe(400); expect(f.writes).toEqual([]); });
  it('returns staging CORS on denial and preflight', async () => {
    f.role = 'support'; expect((await call()).headers.get('Access-Control-Allow-Origin')).toBe('https://admin-staging.waaiio.com');
    expect((await OPTIONS(request({}))).status).toBe(204);
  });
});
describe('status action binding and persistence', () => {
  it('requires step-up', async () => { expect((await call(status, statusBody())).status).toBe(403); expect(f.writes).toEqual([]); });
  it.each([{ action_type: 'messaging_suspension' }, { target_id: 'other' }, { session_id: 'other' }, { admin_user_id: 'other' }, { params_hash: 'different' }])('rejects mismatched grant %j', async override => { authorize(override); expect((await call(status, statusBody())).status).toBe(403); expect(f.writes).toEqual([]); });
  it('allows exact authorization once, persists only status, rejects replay', async () => {
    authorize(); expect((await call(status, statusBody())).status).toBe(200);
    expect(f.writes).toEqual([{ table: 'businesses', values: { status: 'pending' }, filters: { id, status: 'active' } }]);
    expect((await call(status, statusBody())).status).toBe(403); expect(f.writes).toHaveLength(1);
  });
  it('rejects stale previous status before consuming authorization', async () => { authorize(); f.before!.status = 'suspended'; expect((await call(status, statusBody())).status).toBe(409); expect(f.stepUp).not.toBeNull(); expect(f.writes).toEqual([]); });
});

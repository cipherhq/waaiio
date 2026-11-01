import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({
  user: 'owner' as string | null, owner: 'owner', sub: 'owner', session: 'session',
  candidate: 'candidate-selected', candidateStatus: 'ready', targetError: false,
  rpc: vi.fn(), prepare: vi.fn(), queries: [] as { table: string; filters: Record<string, unknown> }[],
}));
function from(table: string) {
  const filters: Record<string, unknown> = {};
  state.queries.push({ table, filters });
  const value = () => {
    if (table === 'businesses') return { id: 'business', owner_id: state.owner, wa_method: 'dedicated', country_code: 'GH' };
    if (table === 'whatsapp_channel_candidates') return filters.id === state.candidate && filters.business_id === 'business' && (!filters.status || filters.status === state.candidateStatus)
      ? { id: state.candidate, status: state.candidateStatus, business_id: 'business' } : null;
    return null;
  };
  const chain: Record<string, any> = {
    select: () => chain, eq: (key: string, val: unknown) => { filters[key] = val; return chain; },
    is: (key: string, val: unknown) => { filters[key] = val; return chain; },
    in: (key: string, val: unknown) => { filters[key] = val; return chain; },
    single: async () => ({ data: table === 'businesses' && filters.owner_id && filters.owner_id !== state.owner ? null : value() }),
    maybeSingle: async () => ({ data: value() }),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [{ id: 'shared-selected' }] }).then(resolve),
  };
  return chain;
}
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ from,
  auth: { getUser: async () => ({ data: { user: state.user ? { id: state.user } : null } }),
    getSession: async () => ({ data: { session: { access_token: 'token' } } }) },
}) }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({ from, rpc: state.rpc,
  auth: { getClaims: async () => ({ data: { claims: { sub: state.sub, session_id: state.session } } }) },
}) }));
vi.mock('@/lib/merchant-step-up', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/merchant-step-up')>(), prepareMerchantStepUp: state.prepare,
}));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }));

import { POST as prepare } from '@/app/api/settings/whatsapp-channel/step-up/prepare/route';
import { DELETE as disconnect, GET as preview } from '@/app/api/settings/whatsapp-channel/route';
import { POST as finish } from '@/app/api/whatsapp/add-number/finish/route';
import { hashOperationParams } from '@/lib/admin-step-up';
import { canonicalMerchantParams } from '@/lib/merchant-step-up';
const request = (body: object, method = 'POST') => new NextRequest('http://localhost/api/settings/whatsapp-channel?business_id=business', {
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
beforeEach(() => {
  vi.clearAllMocks(); Object.assign(state, { user: 'owner', owner: 'owner', sub: 'owner', session: 'session', candidate: 'candidate-selected', candidateStatus: 'ready', targetError: false, queries: [] });
  state.prepare.mockResolvedValue({ stepUpId: 'step-up' });
  state.rpc.mockImplementation(async (name: string) => name === 'channel_change_shared_target'
    ? { data: state.targetError ? null : { id: 'shared-selected', phone_number: '+23412345678', country_code: 'NG', phone_number_id: 'private-provider-id' }, error: state.targetError ? { message: 'target_at_capacity' } : null }
    : { data: { ok: true, channel_id: 'promoted' } });
});

describe('merchant channel HTTP handlers', () => {
  it.each([prepare, finish, disconnect])('denies unauthenticated mutations', async handler => {
    state.user = null;
    expect((await handler(request({}, handler === disconnect ? 'DELETE' : 'POST'))).status).toBe(401);
    expect(state.rpc).not.toHaveBeenCalled();
  });
  it('requires an explicitly selected candidate without selecting latest', async () => {
    expect((await prepare(request({ business_id: 'business', action_type: 'channel_number_change' }))).status).toBe(400);
    expect(state.prepare).not.toHaveBeenCalled();
  });
  it('binds preparation to the selected ready candidate and server session', async () => {
    const response = await prepare(request({ business_id: 'business', action_type: 'channel_number_change', candidate_id: state.candidate, session_id: 'forged', params: {} }));
    expect(response.status).toBe(200);
    expect(state.prepare).toHaveBeenCalledWith('owner', 'business', 'session', 'token', 'channel_number_change', state.candidate,
      { action: 'channel_number_change', business_id: 'business', candidate_id: state.candidate });
  });
  it.each(['other-tenant-candidate', 'obsolete-candidate'])('denies non-selected or unavailable candidate %s', async candidate_id => {
    expect((await prepare(request({ business_id: 'business', action_type: 'channel_number_change', candidate_id }))).status).toBe(409);
    expect(state.prepare).not.toHaveBeenCalled();
  });
  it('denies unready selected candidate', async () => {
    state.candidateStatus = 'validating';
    expect((await prepare(request({ business_id: 'business', action_type: 'channel_number_change', candidate_id: state.candidate }))).status).toBe(409);
  });
  it('denies mismatched verified identity', async () => {
    state.sub = 'different';
    expect((await prepare(request({ business_id: 'business', action_type: 'channel_disconnect', target_channel_id: 'shared-selected' }))).status).toBe(401);
    expect(state.prepare).not.toHaveBeenCalled();
  });
  it('does not prepare a disconnect without an explicit target', async () => {
    expect((await prepare(request({ business_id: 'business', action_type: 'channel_disconnect' }))).status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });
  it('does not authorize an ineligible shared destination', async () => {
    state.targetError = true;
    expect((await prepare(request({ business_id: 'business', action_type: 'channel_disconnect', target_channel_id: 'shared-selected' }))).status).toBe(409);
    expect(state.prepare).not.toHaveBeenCalled();
  });
  it('binds disconnect preparation and execution to the same destination and params', async () => {
    const body = { business_id: 'business', action_type: 'channel_disconnect', target_channel_id: 'shared-selected', country_code: 'US' };
    expect((await prepare(request(body))).status).toBe(200);
    const params = state.prepare.mock.calls[0][6];
    expect(params).toEqual({ action: 'channel_disconnect', business_id: 'business', target_channel_id: 'shared-selected' });
    expect(state.prepare.mock.calls[0][5]).toBe('shared-selected');
    expect((await disconnect(request({ ...body, stepUpId: 'step-up' }, 'DELETE'))).status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith('disconnect_with_merchant_auth', {
      p_business_id: 'business', p_step_up_id: 'step-up', p_owner_user_id: 'owner',
      p_expected_target_channel_id: 'shared-selected', p_session_id: 'session', p_params_hash: hashOperationParams(params),
    });
  });
  it('cannot execute disconnect with an omitted destination', async () => {
    expect((await disconnect(request({ business_id: 'business', stepUpId: 'step-up' }, 'DELETE'))).status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });
  it('fails closed on invalid or replayed authorization', async () => {
    state.rpc.mockResolvedValue({ error: { message: 'disconnect_auth: step_up_invalid' } });
    expect((await disconnect(request({ business_id: 'business', stepUpId: 'used', target_channel_id: 'shared-selected' }, 'DELETE'))).status).toBe(403);
  });
  it('denies cross-owner disconnect before service RPC', async () => {
    state.owner = 'another-owner';
    expect((await disconnect(request({ business_id: 'business', stepUpId: 'step-up', target_channel_id: 'shared-selected' }, 'DELETE'))).status).toBe(404);
    expect(state.rpc).not.toHaveBeenCalled();
  });
  it('previews safe destinations with authoritative GH-to-NG routing', async () => {
    const response = await preview(new NextRequest('http://localhost/api/settings/whatsapp-channel?business_id=business&country_code=US'));
    expect(response.status).toBe(200);
    expect((await response.json()).shared_targets).toEqual([{ id: 'shared-selected', phone_number: '+23412345678', country_code: 'NG' }]);
    expect(state.queries.find(query => Array.isArray(query.filters.country_code))?.filters.country_code).toEqual(['GH', 'NG']);
  });
  it('continues a ready replacement through atomic promotion', async () => {
    expect((await finish(request({ business_id: 'business', candidate_id: state.candidate, step_up_id: 'step-up' }))).status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith('promote_candidate_with_merchant_auth', expect.objectContaining({
      p_candidate_id: state.candidate, p_session_id: 'session',
      p_params_hash: hashOperationParams(canonicalMerchantParams('channel_number_change', 'business', state.candidate)),
    }));
  });
  it('rejects missing destination and binds different destinations to different authorizations', () => {
    expect(() => canonicalMerchantParams('channel_disconnect', 'business')).toThrow('target_channel_id required');
    expect(hashOperationParams(canonicalMerchantParams('channel_disconnect', 'business', 'one')))
      .not.toBe(hashOperationParams(canonicalMerchantParams('channel_disconnect', 'business', 'two')));
  });
});

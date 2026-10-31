import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), auth: vi.fn(), query: vi.fn(), limit: vi.fn() }));
vi.mock('@/lib/api-auth', () => ({ authenticateRequest: mocks.auth }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({ rpc: mocks.rpc, from: mocks.query }) }));
vi.mock('@/lib/rate-limit', () => ({ rateLimitResponseAsync: mocks.limit, getRateLimitKey: () => 'test' }));
import { PUT, GET } from '@/app/api/parties/[partyId]/questions/route';
import { POST } from '@/app/api/rsvp/[token]/route';
import { completePartyRsvp } from '@/lib/parties/rsvp-completion';
const partyId='00000000-0000-4000-a489-000000000005';
const req = (path: string, body?: unknown) => new NextRequest(`http://localhost${path}`, { method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body), headers: {'Content-Type':'application/json'} }) });
beforeEach(() => {
  vi.resetAllMocks(); mocks.limit.mockResolvedValue(null);
  mocks.auth.mockResolvedValue({user:{id:'verified-owner'},service:{rpc:mocks.rpc}});
  mocks.rpc.mockResolvedValue({data:{revision:1,questions:[],responses:[]},error:null});
  const chain = {select:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),single:vi.fn().mockResolvedValue({data:{id:'invite',party_id:partyId},error:null})};
  mocks.query.mockReturnValue(chain);
});
describe('Party question and web RSVP HTTP routes', () => {
  it('passes only authenticated actor and validated questions to SQL', async () => {
    const res=await PUT(req('/questions',{revision:0,questions:[],actor:'forged'}),{params:Promise.resolve({partyId})});
    expect(res.status).toBe(200); expect(mocks.rpc).toHaveBeenCalledWith('party_questions_489',{p_actor:'verified-owner',p_party:partyId,p_payload:{revision:0,questions:[]}});
  });
  it('reports tenant denial without returning responses', async () => {
    mocks.rpc.mockResolvedValue({error:{code:'42501'}});
    const res=await GET(req('/questions'),{params:Promise.resolve({partyId})}); expect(res.status).toBe(403); expect(await res.json()).not.toHaveProperty('responses');
  });
  it('rejects oversized definitions before SQL', async () => {
    const res=await PUT(req('/questions',{revision:0,questions:[],padding:'x'.repeat(17000)}),{params:Promise.resolve({partyId})});
    expect(res.status).toBe(413); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('uses bearer token authority and returns canonical stored response', async () => {
    mocks.rpc.mockResolvedValue({data:{status:'accepted',custom_answers:{access:false},saved_answer_revision:2},error:null});
    const res=await POST(req('/rsvp/token',{status:'accepted',revision:2,answers:{access:false},business_id:'forged',invite_id:'forged'}),{params:Promise.resolve({token:'valid-token-489'})});
    expect(res.status).toBe(200); expect((await res.json()).saved.saved_answer_revision).toBe(2);
    expect(mocks.rpc).toHaveBeenCalledWith('complete_party_rsvp_489',{p_token:'valid-token-489',p_payload:{status:'accepted',plus_ones:0,revision:2,answers:{access:false}},p_sender:null,p_business:null});
  });
  it('preserves historical answers for Maybe despite stale draft fields', async () => {
    await POST(req('/rsvp/token',{status:'maybe',revision:-9,answers:{removed:'draft'}}),{params:Promise.resolve({token:'valid-token-489'})});
    expect(mocks.rpc.mock.calls[0][1].p_payload).toEqual({status:'maybe',plus_ones:0});
  });
  it('returns stale conflict instead of success', async () => {
    mocks.rpc.mockResolvedValue({error:{code:'40001'}});
    const res=await POST(req('/rsvp/token',{status:'accepted',revision:0,answers:{}}),{params:Promise.resolve({token:'valid-token-489'})});
    expect(res.status).toBe(409); expect((await res.json()).stale).toBe(true);
  });
  it('includes verified sender and business for bot completion', async () => {
    await completePartyRsvp({rpc:mocks.rpc} as never,'token',{status:'declined'},{sender:'15551234567',businessId:'verified-biz'});
    expect(mocks.rpc.mock.calls[0][1]).toMatchObject({p_sender:'15551234567',p_business:'verified-biz'});
  });
  it('preserves the ordinary Event RSVP update path', async () => {
    const update=vi.fn().mockReturnValue({eq:vi.fn().mockResolvedValue({error:null})});
    mocks.query.mockReturnValue({select:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),single:vi.fn().mockResolvedValue({data:{id:'event-invite',party_id:null,status:'pending',plus_ones:0},error:null}),update});
    const res=await POST(req('/rsvp/token',{status:'accepted',plus_ones:1}),{params:Promise.resolve({token:'event-token-489'})});
    expect(res.status).toBe(200);expect(update).toHaveBeenCalledWith(expect.objectContaining({status:'accepted',plus_ones:1}));expect(mocks.rpc).not.toHaveBeenCalled();
  });

});

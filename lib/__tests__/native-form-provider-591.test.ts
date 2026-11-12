import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFlowAsset, uploadFlowJson, publishFlow, getFlowStatus, MetaFlowApiError } from '@/lib/whatsapp-forms/meta-flow-asset';
import { MetaCloudService } from '@/lib/channels/meta-cloud';
const request = vi.fn(); const token = 'server-only-test-token';
beforeEach(() => { request.mockReset(); vi.stubEnv('WHATSAPP_NATIVE_FORMS_ENABLED','true'); vi.stubEnv('META_GRAPH_API_VERSION','v22.0'); vi.stubGlobal('fetch',request); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe('#591 provider HTTP adapter contract (no external egress)', () => {
  it('uses fixed Meta host, server authorization, no redirects and the declared category', async () => {
    request.mockResolvedValue(Response.json({id:'123'}));
    expect(await createFlowAsset(token,'987','Signup',['SIGN_UP'])).toMatchObject({flowId:'123'});
    expect(request).toHaveBeenCalledWith('https://graph.facebook.com/v22.0/987/flows',expect.objectContaining({method:'POST',redirect:'error',cache:'no-store',headers:expect.objectContaining({Authorization:`Bearer ${token}`}),body:JSON.stringify({name:'Signup',categories:['SIGN_UP']})}));
  });
  it('uploads multipart Flow JSON, and treats validation errors as rejection', async () => {
    request.mockResolvedValue(Response.json({success:true,validation_errors:[{error:'invalid'}]}));
    expect((await uploadFlowJson(token,'123',{version:'7.3',screens:[]})).success).toBe(false);
    const body = request.mock.calls[0][1].body as FormData;
    expect(body.get('asset_type')).toBe('FLOW_JSON'); expect(body.get('name')).toBe('flow.json');
    expect(await (body.get('file') as Blob).text()).toBe(JSON.stringify({version:'7.3',screens:[]}));
  });
  it('never retries ambiguous publication mutations or exposes raw provider errors', async () => {
    request.mockRejectedValue(new Error(`private ${token}`));
    await expect(publishFlow(token,'123')).rejects.toThrow('Check provider state'); expect(request).toHaveBeenCalledTimes(1);
    request.mockResolvedValue(Response.json({error:{message:`private ${token}`,code:100}},{status:400}));
    await expect(publishFlow(token,'123')).rejects.toThrow('Meta rejected');
  });
  it('verifies status identity and returns provider account binding', async () => {
    request.mockResolvedValue(Response.json({id:'123',status:'PUBLISHED',whatsapp_business_account:{id:'987'}}));
    expect(await getFlowStatus(token,'123')).toMatchObject({status:'PUBLISHED',wabaId:'987'});
    request.mockResolvedValue(Response.json({id:'999',status:'PUBLISHED'}));
    await expect(getFlowStatus(token,'123')).rejects.toBeInstanceOf(MetaFlowApiError);
  });
  it('disabled flag or invalid IDs prevent network calls', async () => {
    vi.stubEnv('WHATSAPP_NATIVE_FORMS_ENABLED','false');
    await expect(publishFlow(token,'123')).rejects.toThrow('not authorized');
    await expect(getFlowStatus(token,'../123')).rejects.toThrow('valid flow ID'); expect(request).not.toHaveBeenCalled();
  });
});

describe('#591 native Flow message HTTP body (no external egress)', () => {
  const message = { to: '12025550123', bodyText: 'Complete this form.', flowId: '123', flowCta: 'Open form', screen: 'FORM', flowToken: 'signed-test-token' };
  const service = () => new MetaCloudService({ accessToken: token, phoneNumberId: '456', wabaId: '987' });

  it.each([
    { label: 'native static form', overrides: {} },
    { label: 'legacy onboarding', overrides: { screen: 'WELCOME', flowToken: 'onboarding-test-token' } },
    { label: 'explicit empty data', overrides: { data: {} } },
  ])('omits optional empty data for $label without changing the other message fields', async ({ overrides }) => {
    request.mockResolvedValue(Response.json({ messages: [{ id: 'wamid.test' }] }));
    const input = { ...message, ...overrides };
    expect(await service().sendFlow(input)).toEqual({ messageId: 'wamid.test' });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe('https://graph.facebook.com/v22.0/456/messages');
    const body = JSON.parse(request.mock.calls[0][1].body);
    expect(body).toEqual({
      messaging_product: 'whatsapp', to: input.to, type: 'interactive',
      interactive: { type: 'flow', body: { text: input.bodyText }, action: { name: 'flow', parameters: {
        flow_message_version: '3', flow_id: input.flowId, flow_cta: input.flowCta,
        flow_action: 'navigate', flow_token: input.flowToken, flow_action_payload: { screen: input.screen },
      } } },
    });
  });

  it('preserves populated screen data and sends only once', async () => {
    request.mockResolvedValue(Response.json({ messages: [{ id: 'wamid.test' }] }));
    const data = { product_name: 'Workshop', quantity: 1, optional_updates: false };
    await service().sendFlow({ ...message, data });
    expect(request).toHaveBeenCalledTimes(1);
    const parameters = JSON.parse(request.mock.calls[0][1].body).interactive.action.parameters;
    expect(parameters.flow_action_payload).toEqual({ screen: 'FORM', data });
    expect(parameters.flow_token).toBe(message.flowToken);
  });
});

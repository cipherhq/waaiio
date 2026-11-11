import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFlowAsset, uploadFlowJson, publishFlow, getFlowStatus, MetaFlowApiError } from '@/lib/whatsapp-forms/meta-flow-asset';
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

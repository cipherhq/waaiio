import {beforeEach,it,expect,vi} from 'vitest';
import {createHmac} from 'node:crypto';
const m=vi.hoisted(()=>({send:vi.fn()}));
vi.mock('./public-destination',()=>({sendPublicWebhook:m.send}));
import {dispatchWebhook} from './dispatcher';
beforeEach(()=>vi.clearAllMocks());
function client(){
 const insert=vi.fn().mockResolvedValue({});const update=vi.fn(()=>({eq:vi.fn().mockResolvedValue({})}));
 const eq=vi.fn().mockReturnThis();const from=vi.fn(table=>table==='webhook_deliveries'?{insert}:{select:()=>({eq,then:(resolve:(v:unknown)=>unknown)=>Promise.resolve({data:[{id:'endpoint',url:'https://example.com',secret:'secret',events:['event.created'],is_active:true}]}).then(resolve)}),update});
 // Chain must preserve the selected query across both scope predicates.
 from.mockImplementation(table=>{const chain={eq:vi.fn(()=>chain),then:(resolve:(v:unknown)=>unknown)=>Promise.resolve({data:[{id:'endpoint',url:'https://example.com',secret:'secret',events:['event.created'],is_active:true}]}).then(resolve)};return table==='webhook_deliveries'?{insert}:{select:()=>chain,update}});
 return {service:{from} as unknown as Parameters<typeof dispatchWebhook>[0],insert,update};
}
it('keeps webhook envelope/HMAC and successful delivery record',async()=>{
 const c=client();m.send.mockResolvedValue({status:204,text:''});await dispatchWebhook(c.service,'business','event.created',{id:'event'});
 const [url,headers,body]=m.send.mock.calls[0];expect(url).toBe('https://example.com');expect(JSON.parse(body)).toMatchObject({event:'event.created',data:{id:'event'}});expect(headers['X-Webhook-Signature']).toBe(createHmac('sha256','secret').update(body).digest('hex'));expect(c.insert).toHaveBeenCalledWith(expect.objectContaining({success:true,response_status:204}));
});
it('records blocked destination as failed without escaping caller',async()=>{const c=client();m.send.mockRejectedValue(new Error('Webhook destination is not public'));await expect(dispatchWebhook(c.service,'business','event.created',{})).resolves.toBeUndefined();expect(c.insert).toHaveBeenCalledWith(expect.objectContaining({success:false,response_status:null}))});

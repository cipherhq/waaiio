import {beforeEach,it,expect,vi} from 'vitest';
import {NextRequest} from 'next/server';
const m=vi.hoisted(()=>({user:true,owner:true,upload:vi.fn(),insert:vi.fn(),remove:vi.fn(),bucket:vi.fn(),signature:vi.fn()}));
vi.mock('@/lib/rate-limit',()=>({rateLimitResponseAsync:async()=>null,getRateLimitKey:()=>''}));
vi.mock('@/lib/security/validate-file',()=>({validateFileSignature:m.signature}));
vi.mock('@/lib/supabase/server',()=>({createClient:async()=>({auth:{getUser:async()=>({data:{user:m.user?{id:'owner'}:null}})},from:(table:string)=>{const filters:Record<string,string>={};const chain={select:()=>chain,eq:(k:string,v:string)=>{filters[k]=v;return chain},maybeSingle:async()=>({data:m.owner&&filters.owner_id==='owner'?{id:'business'}:null}),insert:m.insert};return chain}})}));
vi.mock('@/lib/supabase/service',()=>({createServiceClient:()=>({storage:{from:m.bucket}})}));
import {POST} from '@/app/api/verification/upload/route';
beforeEach(()=>{vi.clearAllMocks();m.user=true;m.owner=true;m.signature.mockReturnValue('application/pdf');m.upload.mockResolvedValue({error:null});m.remove.mockResolvedValue({});m.bucket.mockReturnValue({upload:m.upload,remove:m.remove});m.insert.mockReturnValue({select:()=>({single:async()=>({data:{id:'doc'},error:null})})})});
function request(){const form=new FormData();form.set('file',new File(['%PDF-1.4 synthetic'],'id.pdf',{type:'application/pdf'}));form.set('business_id','business');form.set('type','government_id');return new NextRequest('https://staging.example/api/verification/upload',{method:'POST',body:form})}
it('owner upload writes a private business-scoped object and durable locator',async()=>{const res=await POST(request());expect(res.status).toBe(200);expect(m.bucket).toHaveBeenCalledWith('verification-documents');expect(m.upload.mock.calls[0][0]).toMatch(/^business\/[a-f0-9-]+\.pdf$/);expect(m.insert).toHaveBeenCalledWith(expect.objectContaining({business_id:'business',status:'pending',file_url:expect.stringMatching(/^storage:\/\/verification-documents\/business\//)}))});
it('anonymous cannot upload',async()=>{m.user=false;expect((await POST(request())).status).toBe(401);expect(m.upload).not.toHaveBeenCalled()});
it('other business owner cannot upload',async()=>{m.owner=false;expect((await POST(request())).status).toBe(403);expect(m.upload).not.toHaveBeenCalled()});
it('invalid content denied before private storage write',async()=>{m.signature.mockReturnValue(null);expect((await POST(request())).status).toBe(400);expect(m.upload).not.toHaveBeenCalled()});
it('record failure removes only newly uploaded private object',async()=>{m.insert.mockReturnValue({select:()=>({single:async()=>({error:{message:'failed'}})})});expect((await POST(request())).status).toBe(500);expect(m.remove).toHaveBeenCalledWith([m.upload.mock.calls[0][0]])});
it('preserves valid image uploads through actual image sanitization',async()=>{
 const sharp=(await import('sharp')).default;
 const image=await sharp({create:{width:2,height:2,channels:3,background:{r:255,g:255,b:255}}}).png().toBuffer();
 const form=new FormData();form.set('file',new File([new Uint8Array(image)],'identity.png',{type:'image/png'}));form.set('business_id','business');form.set('type','government_id');
 m.signature.mockReturnValue('image/png');
 const res=await POST(new NextRequest('https://staging.example/api/verification/upload',{method:'POST',body:form}));
 expect(res.status).toBe(200);expect(m.bucket).toHaveBeenCalledWith('verification-documents');expect(m.upload.mock.calls[0][2].contentType).toMatch(/^image\//);
});

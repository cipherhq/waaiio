import {beforeEach,it,expect,vi} from 'vitest';
import {NextRequest} from 'next/server';
const m=vi.hoisted(()=>({user:'owner' as string|null,owner:true,doc:true,admin:false,sign:vi.fn(),from:vi.fn(),auth:vi.fn()}));
vi.mock('@/lib/supabase/server',()=>({createClient:async()=>({auth:{getUser:async()=>({data:{user:m.user?{id:m.user}:null}})},from:m.from})}));
vi.mock('@/lib/supabase/service',()=>({createServiceClient:()=>({from:m.from,storage:{from:()=>({createSignedUrl:m.sign})}})}));
vi.mock('@/lib/admin-auth',()=>({requirePlatformAdmin:m.auth}));
import {GET as merchant} from '@/app/api/verification/document/route';
import {GET as admin} from '@/app/api/admin/verification/document/route';
const business='11111111-1111-4111-a111-111111111111';
const req=(path='/api/verification/document?id=doc')=>new NextRequest(`https://staging.example${path}`);
beforeEach(()=>{
 vi.clearAllMocks();m.user='owner';m.owner=true;m.doc=true;
 vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','https://synthetic.supabase.co');
 m.auth.mockResolvedValue(null);m.sign.mockResolvedValue({data:{signedUrl:'https://synthetic.supabase.co/signed'},error:null});
 m.from.mockImplementation(table=>{
  const filters:Record<string,string>={};
  const chain={select:()=>chain,eq:(key:string,value:string)=>{filters[key]=value;return chain},maybeSingle:async()=>({data:table==='businesses'?(m.owner&&filters.owner_id==='owner'&&filters.id===business?{id:business}:null):(m.doc&&filters.id==='doc'?{business_id:business,file_url:`storage://verification-documents/${business}/file.pdf`}:null)})};return chain;
 });
});
it('anonymous merchant denied before signing',async()=>{m.user=null;expect((await merchant(req())).status).toBe(401);expect(m.sign).not.toHaveBeenCalled()});
it('other business owner denied even if a document row is returned',async()=>{m.user='other';m.owner=false;expect((await merchant(req())).status).toBe(403);expect(m.sign).not.toHaveBeenCalled()});
it('owner gets short lived signed redirect without caching',async()=>{const res=await merchant(req());expect(res.status).toBe(307);expect(res.headers.get('location')).toContain('/signed');expect(res.headers.get('cache-control')).toContain('no-store');expect(m.sign).toHaveBeenCalledWith(`${business}/file.pdf`,300)});
it('missing document denied without signing',async()=>{m.doc=false;expect((await merchant(req())).status).toBe(404);expect(m.sign).not.toHaveBeenCalled()});
it('unverified admin denied through canonical auth helper',async()=>{expect((await admin(req('/api/admin/verification/document?id=doc'))).status).toBe(403);expect(m.auth).toHaveBeenCalledWith(expect.anything(),{requiredRole:'admin'});expect(m.sign).not.toHaveBeenCalled()});
it('verified full admin can sign document for review',async()=>{m.auth.mockResolvedValue({role:'admin',aal:'aal2'});const res=await admin(req('/api/admin/verification/document?id=doc'));expect(res.status).toBe(200);expect(await res.json()).toEqual({url:'https://synthetic.supabase.co/signed'});expect(res.headers.get('cache-control')).toContain('no-store')});
it('storage signing failure returns unavailable without a URL',async()=>{m.sign.mockResolvedValue({error:{message:'internal'}});const res=await merchant(req());expect(res.status).toBe(404);expect(await res.json()).toEqual({error:'Document unavailable'})});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const state=vi.hoisted(()=>({ user:{id:'owner'} as {id:string}|null, allowed:true, rpc:vi.fn(), from:vi.fn() }));
vi.mock('@/lib/supabase/server',()=>({createClient:async()=>({auth:{getUser:async()=>({data:{user:state.user}})}})}));
vi.mock('@/lib/supabase/service',()=>({createServiceClient:()=>({rpc:state.rpc,from:state.from})}));
vi.mock('@/lib/capabilities/api-guard',()=>({requireCapability:async()=>state.allowed?{allowed:true}:{allowed:false,status:403,denial:{error:'Forbidden'}}}));
import { GET, POST, PATCH } from '@/app/api/seating-holds/route';
const business='11111111-1111-1111-1111-111111111111';
const group='22222222-2222-2222-2222-222222222222';
const resource='33333333-3333-3333-3333-333333333333';
const payload={businessId:business,groupId:group,resourceIds:[resource],start:'2035-11-02T18:00',end:'2035-11-02T20:00',wholeResource:false,seats:2,label:'VIP'};
const request=(body:unknown)=>new NextRequest('http://localhost/api/seating-holds',{method:'POST',body:JSON.stringify(body)});
beforeEach(()=>{state.user={id:'owner'};state.allowed=true;state.rpc.mockReset().mockResolvedValue({data:[],error:null});state.from.mockReset();});
describe('seating holds HTTP handlers',()=>{
  it('loads all tenant-scoped pages and fails closed on a query error',async()=>{
    const chain={select:vi.fn(),eq:vi.fn(),is:vi.fn(),order:vi.fn(),range:vi.fn()};
    for(const key of ['select','eq','is','order'] as const) chain[key].mockReturnValue(chain);
    chain.range.mockResolvedValueOnce({data:Array.from({length:500},(_,id)=>({id,starts_at:'2035-11-02T18:00'})),error:null})
      .mockResolvedValueOnce({data:[{id:500,starts_at:'2035-11-02T19:00'}],error:null});
    state.from.mockReturnValue(chain);
    const response=await GET(new NextRequest(`http://localhost/api/seating-holds?businessId=${business}`));
    expect((await response.json()).data).toHaveLength(501);
    expect(chain.eq).toHaveBeenCalledWith('business_id',business);
    expect(chain.is).toHaveBeenCalledWith('released_at',null);
    expect(chain.range).toHaveBeenNthCalledWith(2,500,999);
    chain.range.mockResolvedValueOnce({data:null,error:{message:'unavailable'}});
    expect((await GET(new NextRequest(`http://localhost/api/seating-holds?businessId=${business}`))).status).toBe(500);
  });
  it('requires authentication and owner capability before invoking mutation',async()=>{
    state.user=null; expect((await POST(request(payload))).status).toBe(401);
    state.user={id:'owner'};state.allowed=false;expect((await POST(request(payload))).status).toBe(403);
    expect(state.rpc).not.toHaveBeenCalled();
  });
  it('derives immutable actor from authenticated identity and passes exact resource snapshot',async()=>{
    expect((await POST(request({...payload,actorId:'attacker'}))).status).toBe(201);
    expect(state.rpc).toHaveBeenCalledWith('create_seating_hold',expect.objectContaining({p_actor_id:'owner',p_business_id:business,p_resource_ids:[resource],p_seats:2}));
  });
  it('rejects invalid calendar intervals and seat values before mutation',async()=>{
    for(const invalid of [{start:'2035-02-31T18:00'},{seats:0},{seats:2.5},{resourceIds:[]},{end:payload.start}]) {
      expect((await POST(request({...payload,...invalid}))).status).toBe(400);
    }
    expect(state.rpc).not.toHaveBeenCalled();
  });
  it('reports a concurrent conflict and uses scoped release',async()=>{
    state.rpc.mockResolvedValueOnce({error:{code:'23514'}});
    expect((await POST(request(payload))).status).toBe(409);
    expect((await PATCH(request({businessId:business,groupId:group}))).status).toBe(200);
    expect(state.rpc).toHaveBeenLastCalledWith('release_seating_hold',{p_business_id:business,p_actor_id:'owner',p_group_id:group});
  });
});

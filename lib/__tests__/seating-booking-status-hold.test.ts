import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const state=vi.hoisted(()=>({ updateError:null as null|{code:string}, resolve:vi.fn(), update:vi.fn() }));
vi.mock('@/lib/supabase/server',()=>({createClient:async()=>({auth:{getUser:async()=>({data:{user:{id:'owner'}}})}})}));
vi.mock('@/lib/supabase/service',()=>({createServiceClient:()=>({from:()=>({
  select:()=>({eq:()=>({single:async()=>({data:{id:'booking',business_id:'business',status:'cancelled',guest_phone:null,checked_in_at:null,
    businesses:{owner_id:'owner',name:'Venue',country_code:'NG'}}})})}),
  update:(value:unknown)=>{state.update(value);return {eq:async()=>({error:state.updateError})};},
})})}));
vi.mock('@/lib/capabilities/api-guard',()=>({requireAnyCapability:async()=>({allowed:true})}));
vi.mock('@/lib/channels/channel-resolver',()=>({ChannelResolver:class {resolveByBusinessId=state.resolve;}}));
vi.mock('@/lib/payments/proactive-localization',()=>({resolveProactiveLocalization:vi.fn()}));
vi.mock('@/lib/waitlist/auto-notify',()=>({notifyWaitlistOnSlotOpen:vi.fn()}));
vi.mock('@/lib/logger',()=>({logger:{error:vi.fn()}}));
import { PATCH } from '@/app/api/bookings/[id]/status/route';
beforeEach(()=>{state.updateError=null;state.update.mockClear();state.resolve.mockClear();});
describe('booking status route respects database hold authority',()=>{
  it.each(['40001','23514'])('returns a failure without sending notification for database rejection %s',async(code)=>{
    state.updateError={code};
    const result=await PATCH(new NextRequest('http://localhost/api/bookings/booking/status',{method:'PATCH',body:JSON.stringify({action:'check_in'})}),{params:Promise.resolve({id:'booking'})});
    expect(result.status).toBe(500);
    expect(await result.json()).toEqual({error:'Failed to update booking'});
    expect(state.update).toHaveBeenCalledWith(expect.objectContaining({status:'in_progress'}));
    expect(state.resolve).not.toHaveBeenCalled();
  });
  it('preserves successful check-in when the database accepts occupancy',async()=>{
    const result=await PATCH(new NextRequest('http://localhost/api/bookings/booking/status',{method:'PATCH',body:JSON.stringify({action:'check_in',notify_customer:false})}),{params:Promise.resolve({id:'booking'})});
    expect(result.status).toBe(200);
  });
});

import { describe, it, expect, vi } from 'vitest';
import { rsvpFlow } from '@/lib/bot/flows/rsvp.flow';
import type { FlowContext } from '@/lib/bot/flows/types';
const step=(id:string)=>rsvpFlow.steps.find(s=>s.id===id)!;
function ctx() {
  const rpc=vi.fn().mockResolvedValue({data:{status:'accepted'},error:null});
  const context={from:'15551234567',copyLang:'en',supabase:{rpc},business:{id:'business',subscription_tier:'business'},session:{business_id:'business',session_data:{rsvp_party_id:'party',rsvp_invite_id:'invite',rsvp_token:'token',rsvp_response:'accepted',rsvp_revision:1,rsvp_questions:[{id:'access',label:'Access?',type:'yes_no',required:true}],rsvp_question_index:0}}} as unknown as FlowContext;
  return {context,rpc};
}
describe('executed Party RSVP flow steps',()=>{
  it('collects false and advances through the registered question step',async()=>{
    const {context}=ctx(); expect(await step('rsvp_questions').skipIf!(context)).toBe(false);
    expect((await step('rsvp_questions').prompt(context))[0]).toMatchObject({type:'text'});
    const result=await step('rsvp_questions').validate('no',context); expect(result.valid).toBe(true); Object.assign(context.session.session_data,result.data);
    expect(result.data?.rsvp_answers).toEqual({access:false}); expect(await step('rsvp_questions').next(context)).toBe('rsvp_confirmed');
  });
  it('does not emit success or end retry state when authority fails',async()=>{
    const {context,rpc}=ctx(); rpc.mockResolvedValue({error:{code:'23514'}});
    const messages=await step('rsvp_confirmed').prompt(context);
    expect(JSON.stringify(messages)).not.toContain("You're in"); expect(JSON.stringify(messages)).toContain('capacity');
    expect(await step('rsvp_confirmed').next(context)).toBe('rsvp_confirmed');
    expect(rpc.mock.calls[0][1]).toMatchObject({p_sender:'15551234567',p_business:'business'});
  });
  it('allows unchanged companions at capacity but denies a genuine increase',async()=>{
    const {context}=ctx(); context.session.session_data.rsvp_max_plus_ones=3;
    const filters:Record<string,unknown>={};
    context.supabase={from:(table:string)=>{
      const q:any={select:()=>q,eq:(k:string,v:unknown)=>{filters[k]=v;return q;},neq:(k:string,v:unknown)=>{filters['not_'+k]=v;return q;},single:async()=>({data:{max_guests:3}}),in:async()=>({data:[{plus_ones:0}]})}; return q;
    }} as never;
    expect((await step('rsvp_plus_ones').validate('2',context)).valid).toBe(true);
    expect(filters).toMatchObject({business_id:'business',not_id:'invite'});
    expect((await step('rsvp_plus_ones').validate('3',context)).valid).toBe(false);
  });
});

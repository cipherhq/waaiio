import { describe, it, expect, vi, beforeEach } from 'vitest';
const mocks=vi.hoisted(()=>({execute:vi.fn().mockResolvedValue(undefined)}));
vi.mock('@/lib/bot/flows/executor',()=>({FlowExecutor:class {execute=mocks.execute;}}));
vi.mock('@/lib/countries',()=>({loadCountries:vi.fn().mockResolvedValue([])}));
vi.mock('@/lib/rate-limit',()=>({checkRateLimitAsync:vi.fn().mockResolvedValue({allowed:true})}));
vi.mock('@/lib/platformSettings',()=>({loadPlatformSettings:vi.fn().mockResolvedValue({bot_rate_limit_per_minute:30})}));
vi.mock('@/lib/bot/launch-optin',()=>({handleLaunchOptIn:vi.fn().mockResolvedValue(false)}));
vi.mock('@/lib/bot/translations',()=>({createOverridesLoader:()=>({get:async()=>({}),empty:{}}),runWithTranslationOverrides:(_x:unknown,fn:()=>unknown)=>fn()}));
vi.mock('@/lib/bot/flows/shared/notify-owner',()=>({notifyOwnerGeneric:vi.fn().mockResolvedValue(undefined)}));
vi.mock('@sentry/nextjs',()=>({captureException:vi.fn(),captureMessage:vi.fn()}));
import { BotService } from '@/lib/bot/bot.service';
const biz={id:'business',name:'Host',slug:'host',category:'events',flow_type:'ticketing',subscription_tier:'business',metadata:{},country_code:'US'};
const party={id:'party',name:'Party',date:'2027-01-01',allow_plus_ones:false,ask_dietary:false,question_definitions:[{id:'access',label:'Access?',type:'yes_no',required:true}],question_revision:1,businesses:biz};
function harness(phone='15551234567') {
 const calls:Record<string,unknown>[]=[]; const updates:string[]=[];
 const sender={sendText:vi.fn().mockResolvedValue({success:true}),bindBusiness:vi.fn()};
 const rpc=vi.fn().mockResolvedValue({data:{status:'maybe'},error:null});
 const db={rpc,from:(table:string)=>{
   const filters:Record<string,unknown>={}; let columns=''; let inserted:Record<string,unknown>|undefined;
   const data=()=> table==='platform_settings'?{value:false}:table==='bot_sessions'?(inserted?{id:'session',version:0,...inserted}:null):table==='event_invites'?(filters.event_id?null:{id:'00000000-0000-4000-a489-000000000007',party_id:'party',business_id:'business',guest_phone:phone,invite_token:'a'.repeat(24),status:'maybe',plus_ones:0,custom_answers:{},parties:party}):null;
   const q:any={select:(s:string)=>{columns=s;return q;},eq:(k:string,v:unknown)=>{filters[k]=v;return q;},not:(k:string)=>{filters[k]=true;return q;},or:()=>q,in:()=>q,order:()=>q,limit:()=>q,gte:()=>q,lt:(k:string,v:unknown)=>{filters[k]=v;return q;},is:()=>q,update:()=>{updates.push(table);return q;},insert:(v:Record<string,unknown>)=>{inserted=v;calls.push(v);return q;},single:async()=>({data:data(),error:null}),maybeSingle:async()=>({data:data(),error:null}),then:(resolve:(v:unknown)=>unknown)=>Promise.resolve({data:data(),error:null}).then(resolve)};
   return q;
 }};
 const intelligence={isTimedOut:()=>({timedOut:false}),containsProfanity:()=>false};
 const bot=new BotService(db as never,sender as never,{} as never,intelligence as never);
 return {bot,sender,rpc,calls,updates};
}
beforeEach(()=>vi.clearAllMocks());
describe('real BotService Party RSVP entry',()=>{
 it('rejects mismatched sender before shared completion or session creation',async()=>{
   const h=harness('15559999999'); await h.bot.handleMessage('15551234567','rsvp_yes_00000000-0000-4000-a489-000000000007','text');
   expect(h.rpc).not.toHaveBeenCalled(); expect(h.calls).toHaveLength(0); expect(mocks.execute).not.toHaveBeenCalled();
   expect(h.sender.sendText).toHaveBeenCalledWith(expect.objectContaining({text:expect.stringContaining('Invitation unavailable')}));
 });
 it('routes Accepted button through question collection without direct RSVP mutation',async()=>{
   const h=harness(); await h.bot.handleMessage('15551234567','rsvp_yes_00000000-0000-4000-a489-000000000007','text');
   expect(h.rpc).not.toHaveBeenCalled(); expect(mocks.execute).toHaveBeenCalledTimes(1); expect(h.updates).not.toContain('event_invites');
   expect(h.calls[0]).toMatchObject({business_id:'business',current_step:'rsvp_plus_ones',session_data:{rsvp_token:'a'.repeat(24),rsvp_response:'accepted',rsvp_revision:1,rsvp_questions:party.question_definitions}});
 });
});

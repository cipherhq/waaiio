import { describe, expect, it, vi } from 'vitest';
import { calculateTaxQuote } from '../calculation';
import type { FlowContext } from '@/lib/bot/flows/types';
const h=vi.hoisted(()=>({order:vi.fn(),booking:vi.fn()}));
vi.mock('@/lib/tax/server-quote',async importOriginal=>({...await importOriginal<object>(),quoteOrderTax:h.order,quoteBookingTax:h.booking}));
const tax=calculateTaxQuote({enabled:true,label:'Tax',rateBps:750,priceMode:'exclusive'},'USD',[{id:'a',description:'Item',quantity:1,unitAmount:1000}]);
function context(data:Record<string,unknown>):FlowContext {
 const chain:any={};for(const name of ['select','in','eq']) chain[name]=()=>chain;
 chain.then=(resolve:(value:unknown)=>unknown)=>Promise.resolve({data:[{id:'p',name:'Product',price:10,is_active:true,track_inventory:false}],error:null}).then(resolve);
 return {session:{id:'session',user_id:'user',session_data:data},business:{id:'business',name:'Shop',country_code:'US',category:'salon',metadata:{}},
  from:'15550000001',copyLang:'en',supabase:{from:()=>chain,rpc:vi.fn().mockResolvedValue({data:0,error:null})},sender:{sendText:vi.fn()},t:async(text:string)=>text} as unknown as FlowContext;
}
describe('actual bot tax confirmation steps',()=>{
 it('renders the authoritative ordering breakdown and saves the exact accepted snapshot',async()=>{
  const {orderingFlow}=await import('@/lib/bot/flows/ordering.flow');
  const ctx=context({cart:[{product_id:'p',name:'Product',price:10,quantity:1}]});
  h.order.mockResolvedValue({server_total:10.75,server_discount:0,server_volume_discount:0,server_addons_total:0,tax_snapshot:tax});
  const step=orderingFlow.steps.find(step=>step.id==='review_order_summary')!;
  const messages=await step.prompt!(ctx);expect(JSON.stringify(messages)).toContain('Before tax:');expect(JSON.stringify(messages)).toContain('Tax:');expect(JSON.stringify(messages)).toContain('10.75');
  expect(ctx.session.session_data._tax_snapshot).toEqual(tax);expect(ctx.session.session_data._calc_total).toBe(10.75);
  h.order.mockRejectedValue(new Error('unavailable'));
  expect(JSON.stringify(await step.prompt!(ctx))).not.toContain('confirm_order');
 });
 it('renders scheduling gross/deposit, binds snapshot into confirmation, and returns changed terms to review',async()=>{
  const {schedulingFlow}=await import('@/lib/bot/flows/scheduling.flow');
  const ctx=context({service_id:'s',service_name:'Service',service_price:10,service_deposit:3,date:'2030-01-01',time:'12:00',party_size:1});
  h.booking.mockResolvedValue({total:10.75,deposit:3.23,tax_snapshot:tax});
  const step=schedulingFlow.steps.find(step=>step.id==='confirmation')!;
  expect(JSON.stringify(await step.prompt!(ctx))).toContain('3.23');
  const accepted=await step.validate!('confirm',ctx);
  expect((accepted.data?._604_confirmation as any).terms.tax_snapshot).toEqual(tax);
  ctx.session.session_data._tax_reconfirm=true;
  const transition=schedulingFlow.steps.find(step=>step.id==='create_booking')!.nextAfterPrompt;
  expect(typeof transition).toBe('function');
  expect(typeof transition==='function' ? await transition(ctx) : transition).toBe('confirmation');
 });
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const h=vi.hoisted(()=>({ payment:vi.fn(), rpc:vi.fn(), result:{data:null,error:null} as {data:unknown;error:unknown} }));
function chain(data: unknown) {
  const c: Record<string, unknown>={};
  for (const method of ['select','eq','limit','is','update']) c[method]=vi.fn(()=>c);
  c.single=vi.fn(async()=>({data,error:null}));
  c.maybeSingle=c.single;
  return c;
}
vi.mock('@/lib/rate-limit',()=>({rateLimitResponseAsync:vi.fn(async()=>null),getRateLimitKey:vi.fn(()=> '604')}));
vi.mock('@/lib/otp-token',()=>({verifyOtpToken:vi.fn(()=> 'guest@example.test')}));
vi.mock('@/lib/logger',()=>({logger:{error:vi.fn(),withContext:()=>({error:vi.fn()})}}));
vi.mock('@/lib/errors',()=>({safeLogErrorContext:()=>({})}));
vi.mock('@/lib/bot/flows/shared/payment',()=>({initializePayment:h.payment}));
vi.mock('@/lib/supabase/service',()=>({createServiceClient:()=>({
 from:(table:string)=>chain(table==='businesses'?{
   id:'business',name:'Business',slug:'business',country_code:'NG',operating_hours:{},metadata:{},subscription_tier:'growth'
 }:table==='services'?{
   id:'service',name:'Service',price:1000,deposit_amount:200,duration_minutes:30,buffer_minutes:0,max_capacity:1,metadata:{}
 }:table==='profiles'?{id:'customer'}:null),
 rpc:h.rpc,
})}));
const body={businessSlug:'business',serviceId:'service',date:'2027-12-01',time:'10:00',
 guestName:'Guest',guestEmail:'guest@example.test',guestPhone:'+2348000000604',otpToken:'verified',
 expectedTerms:{price:1000,deposit:200,country:'NG',quantity:1}};
async function submit(overrides:Record<string,unknown>={}) {
 const {POST}=await import('@/app/api/bookings/public/create/route');
 return POST(new NextRequest('https://example.test/api/bookings/public/create',{method:'POST',body:JSON.stringify({...body,...overrides})}));
}
describe('core604 actual public booking handler',()=>{
 beforeEach(()=>{
   vi.clearAllMocks();
   h.result={data:{booking_id:'booking',reference_code:'REF',slot_available:true,committed_total:1000,committed_deposit:200},error:null};
   h.rpc.mockImplementation(()=>({single:async()=>h.result}));
   h.payment.mockResolvedValue({url:'https://checkout.example.test',reference:'payment'});
 });
 it('passes expected terms but uses the committed payment amount',async()=>{
   expect((await submit()).status).toBe(200);
   expect(h.rpc).toHaveBeenCalledWith('book_slot_authoritative_604',expect.objectContaining({
     p_total_amount:1000,p_deposit_amount:200,p_expected_terms:{...body.expectedTerms,discount:0,source:'public'}
   }));
   expect(h.payment).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({bookingId:'booking',amount:200}));
 });
 it('uses returned original amounts on an idempotent replay',async()=>{
   h.result={data:{booking_id:'original',reference_code:'OLD',slot_available:true,committed_total:1000,committed_deposit:100},error:null};
   expect((await submit()).status).toBe(200);
   expect(h.payment).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({bookingId:'original',amount:100}));
 });
 it.each([
   undefined,{price:999,deposit:200,country:'NG',quantity:1},
   {price:1000,deposit:100,country:'NG',quantity:1},
   {price:1000,deposit:200,country:'US',quantity:1},
   {price:1000,deposit:200,country:'NG',quantity:2}
 ])('requires reconfirmation when accepted terms mismatch: %j',async expectedTerms=>{
   const response=await submit({expectedTerms});
   expect(response.status).toBe(409);
   expect(await response.json()).toMatchObject({code:'terms_changed',currentTerms:body.expectedTerms});
   expect(h.rpc).not.toHaveBeenCalled();expect(h.payment).not.toHaveBeenCalled();
 });
 it('does not initialize a provider after an atomic terms rejection',async()=>{
   h.result={data:null,error:{message:'terms_changed'}};
   expect((await submit()).status).toBe(409);expect(h.payment).not.toHaveBeenCalled();
 });
 it('fails closed when an older schema omits committed amounts',async()=>{
   h.result={data:{booking_id:'booking',reference_code:'REF',slot_available:true},error:null};
   expect((await submit()).status).toBe(503);expect(h.payment).not.toHaveBeenCalled();
 });
 it('does not call a provider for a zero-upfront committed booking',async()=>{
   h.result={data:{booking_id:'booking',reference_code:'REF',slot_available:true,committed_total:1000,committed_deposit:0},error:null};
   expect((await submit()).status).toBe(200);expect(h.payment).not.toHaveBeenCalled();
 });
});

describe('core604 rendered public form reconfirmation',()=>{
 afterEach(async()=>{
   const {cleanup}=await import('@testing-library/react');
   cleanup();vi.unstubAllGlobals();
 });
 it('submits displayed terms and requires a new confirmation after refresh',async()=>{
   const React=await import('react');
   const {render,screen,fireEvent,waitFor}=await import('@testing-library/react');
   const {default:BookingForm}=await import('@/app/b/[slug]/BookingForm');
   const submitted: Array<Record<string,unknown>>=[];
   vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{
     if(url.includes('/slots')) return {ok:true,json:async()=>({slots:[{time:'10:00',available:1}]})};
     if(url.includes('action=verify')) return {ok:true,json:async()=>({verified:true,otpToken:'verified'})};
     if(url.includes('/email-otp')) return {ok:true,json:async()=>({challengeId:'challenge'})};
     submitted.push(JSON.parse(String(init?.body)));
     return {ok:false,json:async()=>({code:'terms_changed',error:'Review the updated terms',
       currentTerms:{price:1200,deposit:300,country:'NG',quantity:1}})};
   }));
   render(React.createElement(BookingForm,{
     business:{id:'business',name:'Business',slug:'business',country_code:'NG',operating_hours:{},
       logo_url:null,description:null,address:null},
     services:[{id:'service',name:'Service',description:null,price:1000,deposit_amount:200,duration_minutes:30,image_url:null,is_dropoff:false}]
   }));
   fireEvent.click(screen.getByRole('button',{name:/Service.*1,000/}));
   fireEvent.click(screen.getAllByRole('button')[2]);
   fireEvent.click(await screen.findByRole('button',{name:'10:00'}));
   fireEvent.change(screen.getByPlaceholderText('John Doe'),{target:{value:'Guest'}});
   fireEvent.change(screen.getByPlaceholderText('john@example.com'),{target:{value:'guest@example.test'}});
   fireEvent.click(screen.getByRole('button',{name:'Verify'}));
   fireEvent.change(await screen.findByPlaceholderText('6-digit code'),{target:{value:'123456'}});
   fireEvent.click(screen.getByRole('button',{name:'Verify'}));
   await screen.findByRole('button',{name:'Change'});
   fireEvent.click(screen.getByRole('button',{name:'Continue'}));
   fireEvent.click(screen.getByRole('checkbox'));
   fireEvent.click(screen.getByRole('button',{name:/Pay.*200/}));
   await screen.findByText('Review the updated terms');
   expect(submitted[0].expectedTerms).toEqual({price:1000,deposit:200,country:'NG',quantity:1});
   expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
   expect((screen.getByRole('button',{name:/Pay.*300/}) as HTMLButtonElement).disabled).toBe(true);
   expect(submitted).toHaveLength(1);
   fireEvent.click(screen.getByRole('checkbox'));
   fireEvent.click(screen.getByRole('button',{name:/Pay.*300/}));
   await waitFor(()=>expect(submitted).toHaveLength(2));
   expect(submitted[1].expectedTerms).toEqual({price:1200,deposit:300,country:'NG',quantity:1});
 });
});

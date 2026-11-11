import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { calculateTaxQuote } from '../calculation';
import { isSafePurchaseAmount, isTaxTermsChanged, quoteBookingTax, quoteOrderTax } from '../server-quote';
const snapshot=calculateTaxQuote({enabled:true,label:'VAT',rateBps:750,priceMode:'exclusive'},'USD',[{id:'a',description:'Item',quantity:1,unitAmount:1000}]);
const client=(data:unknown,error:unknown=null)=>({rpc:vi.fn().mockResolvedValue({data,error})});
describe('authoritative tax preview boundaries',()=>{
 it('uses validated read-only order authority and checks the gross against its snapshot',async()=>{
  const db=client({is_preview:true,created:false,server_total:10.75,server_discount:0,server_volume_discount:0,tax_snapshot:snapshot});
  const input={businessId:'b',userId:null,sessionId:'s',items:[{product_id:'p',quantity:1}],shippingCost:0};
  expect((await quoteOrderTax(db as unknown as SupabaseClient,input)).tax_snapshot).toEqual(snapshot);
  expect(db.rpc).toHaveBeenCalledWith('create_order_atomic',expect.objectContaining({p_preview:true,p_validate_products:true}));
  db.rpc.mockResolvedValue({data:{is_preview:true,created:false,server_total:10,tax_snapshot:snapshot},error:null});
  await expect(quoteOrderTax(db as unknown as SupabaseClient,input)).rejects.toThrow(/reconcile/);
 });
 it('fails closed on RPC failure and invalid booking deposit, never fabricates a fallback',async()=>{
  const input={businessId:'b',serviceId:'s',partySize:1,addons:[],expectedTerms:{}};
  await expect(quoteBookingTax(client(null,{message:'tax_terms_changed'}) as unknown as SupabaseClient,input)).rejects.toThrow('tax_terms_changed');
  await expect(quoteBookingTax(client({total:10.75,deposit:11,tax_snapshot:snapshot}) as unknown as SupabaseClient,input)).rejects.toThrow(/deposit/);
 });
 it('allows exact cent amounts and rejects malformed or unsafe money',()=>{
  for(const amount of [0,3.23,1088.75,100]) expect(isSafePurchaseAmount(amount)).toBe(true);
  for(const amount of [NaN,Infinity,-1,1.001,Number.MAX_SAFE_INTEGER,'3.23']) expect(isSafePurchaseAmount(amount)).toBe(false);
  expect(isTaxTermsChanged({message:'tax_terms_changed'})).toBe(true);
  expect(isTaxTermsChanged(new Error('price_changed'))).toBe(true);
  expect(isTaxTermsChanged(new Error('network'))).toBe(false);
 });
});

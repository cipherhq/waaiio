import { describe, expect, it } from 'vitest';
import { productImageMessages } from '../shared/product-images';
describe('selected product gallery', () => {
  it('includes primary and every unique gallery image in order', () => {
    expect(productImageMessages('https://img/a', ['https://img/b','https://img/a','https://img/c'], 'Product').map(m => (m as any).imageUrl)).toEqual(['https://img/a','https://img/b','https://img/c']);
  });
  it('keeps variant first while preserving primary and gallery', () => {
    expect(productImageMessages('https://img/variant', ['https://img/main','https://img/extra'], 'Blue').map(m => (m as any).imageUrl)).toEqual(['https://img/variant','https://img/main','https://img/extra']);
  });
  it('supports existing single-image and gallery-only products', () => {
    expect(productImageMessages('https://img/a', undefined, 'A')).toHaveLength(1);
    expect(productImageMessages(null, ['https://img/a'], 'A')).toHaveLength(1);
  });
  it('does not emit invalid or empty image payloads', () => {
    expect(productImageMessages(null, [null, '', 'javascript:bad'], 'A')).toEqual([]);
  });
});

import { createMockContext, getStep } from './helpers';
import { orderingFlow } from '../ordering.flow';
import { vi } from 'vitest';
import { getEffectiveCapabilities, canPerformAction } from '@/lib/capabilities/policy';

it('quick-add emits the primary and gallery before checkout without changing cart quantity', async () => {
  const ctx = createMockContext();
  ctx.business!.metadata = { ordering_browse_by_category: true };
  Object.assign(ctx.session.session_data, { current_product_id:'p',current_product_name:'Photo product',current_product_price:100,current_quantity:1,current_product_image_url:'https://images.test/one',current_product_gallery_urls:['https://images.test/two'] });
  const messages = await getStep(orderingFlow,'add_to_cart').prompt(ctx);
  expect(messages.filter(m=>m.type==='image')).toHaveLength(2);
  expect(ctx.session.session_data.cart).toEqual([{product_id:'p',name:'Photo product',price:100,quantity:1}]);
});
it('smart-intent auto-add emits all cart product images once, scoped to the business',async()=>{
  const ctx=createMockContext();ctx.business!.metadata={ordering_browse_by_category:true};
  Object.assign(ctx.session.session_data,{_auto_added_to_cart:true,_skip_browse:true,cart:[{product_id:'p',name:'Product',quantity:1,price:100}]});
  const q:any={select:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),in:vi.fn().mockResolvedValue({data:[{id:'p',name:'Product',image_url:'https://images.test/one',gallery_urls:['https://images.test/two']}]})};ctx.supabase.from=vi.fn().mockReturnValue(q);
  const step=getStep(orderingFlow,'continue_or_checkout');
  expect((await step.prompt(ctx)).filter(m=>m.type==='image')).toHaveLength(2);
  expect(q.eq).toHaveBeenCalledWith('business_id',ctx.business!.id);
  expect((await step.prompt(ctx)).filter(m=>m.type==='image')).toHaveLength(0);
});
it('seating denies new free bookings, allows Pro, and retains management after downgrade',()=>{
  for(const tier of ['free','growth']) {
    const result=getEffectiveCapabilities({configuredCapabilities:[{capability:'table_reservation',is_enabled:true}],overrides:[],tier,trialEndsAt:null,hasTrialCredit:false});
    expect(result.effective.includes('table_reservation')).toBe(tier==='growth');
    expect(canPerformAction({action:'manage_existing',capability:'table_reservation',effectiveCapabilities:result.effective}).allowed).toBe(true);
  }
});

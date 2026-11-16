import { describe, expect, it } from 'vitest';
import { checkoutProgress, forwardCheckoutProgress, hasCheckoutReply, withCheckoutReply } from '@/lib/messaging/checkout-reply-progress';
import type { FlowContext } from '@/lib/bot/flows/types';
function context() {
  return { supabase: {}, from: '+2348000001060', business: { id: 'b1' }, session: { id: 's1', business_id: 'b1', session_data: { active_capability: 'ordering', cart: [{ product_id: 'p1', price: 2, quantity: 1 }] } } } as unknown as FlowContext;
}
describe('checkout response scope', () => {
  it('requires exact database, business, customer and session identities', async () => {
    const ctx = context(); const proof = checkoutProgress(ctx, 'select_delivery_zone', 'collect_address');
    await withCheckoutReply(proof, async () => {
      expect(hasCheckoutReply(ctx.supabase, 'b1', ctx.from, 's1')).toBe(true);
      for (const [db, biz, phone, session] of [[{}, 'b1', ctx.from, 's1'], [ctx.supabase, 'other', ctx.from, 's1'], [ctx.supabase, 'b1', '+234999', 's1'], [ctx.supabase, 'b1', ctx.from, 'other']] as const) expect(hasCheckoutReply(db, biz, phone, session)).toBe(false);
    });
    expect(hasCheckoutReply(ctx.supabase, 'b1', ctx.from, 's1')).toBe(false);
  });
  it('closes inherited detached work even when the response throws', async () => {
    const ctx = context(); let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    let detached!: Promise<boolean>;
    await expect(withCheckoutReply(checkoutProgress(ctx, 'select_delivery_zone', 'collect_address'), async () => {
      detached = gate.then(() => hasCheckoutReply(ctx.supabase, 'b1', ctx.from, 's1'));
      throw new Error('send failed');
    })).rejects.toThrow('send failed');
    release(); expect(await detached).toBe(false);
  });
  it('reevaluates cart validity when repricing removes all items', async () => {
    const ctx = context();
    await withCheckoutReply(checkoutProgress(ctx, 'collect_email', 'review_order_summary'), async () => {
      expect(hasCheckoutReply(ctx.supabase, 'b1', ctx.from, 's1')).toBe(true);
      ctx.session.session_data.cart = [];
      expect(hasCheckoutReply(ctx.supabase, 'b1', ctx.from, 's1')).toBe(false);
    });
  });
  it.each([
    ['continue_or_checkout', 'browse_catalog'], ['review_order_summary', 'edit_order_menu'],
    ['review_order_summary', 'browse_catalog'], ['confirm_address', 'collect_address'],
    ['select_delivery_zone', 'select_delivery_zone'], ['collect_address', 'process_order'],
  ])('does not allow non-forward edge %s → %s', (source, target) => {
    expect(checkoutProgress(context(), source, target, { _action: 'checkout', _order_action: 'confirm', address_confirmed: true })).toBeUndefined();
  });
  it('requires fresh validated action rather than a saved action marker', () => {
    const ctx = context(); ctx.session.session_data._action = 'checkout';
    expect(checkoutProgress(ctx, 'continue_or_checkout', 'apply_promo')).toBeUndefined();
  });
  it('does not recover allowance after an unexpected skip edge', () => {
    const p = checkoutProgress(context(), 'continue_or_checkout', 'apply_promo', { _action: 'checkout' });
    const bad = forwardCheckoutProgress(p, 'apply_promo', 'browse_catalog');
    expect(bad).toBeUndefined(); expect(forwardCheckoutProgress(bad, 'select_delivery_zone', 'collect_address')).toBeUndefined();
  });
});

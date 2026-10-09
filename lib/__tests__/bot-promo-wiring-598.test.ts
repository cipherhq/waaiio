/** #598: execute actual bot order and service promo steps with query fixtures. */
import { describe, expect, it, vi } from 'vitest';
import { orderingFlow } from '@/lib/bot/flows/ordering.flow';
import { schedulingFlow } from '@/lib/bot/flows/scheduling.flow';
import { createMockContext, getStep } from '@/lib/bot/flows/__tests__/helpers';

const businessId = 'test-business-id';
const now = Date.now();
const promo = {
  id: 'promo-1', code: 'SAVE20', business_id: businessId, is_active: true,
  discount_type: 'percentage', discount_value: 20, min_order_amount: 0,
  max_uses: 10, current_uses: 0,
  valid_from: new Date(now - 86400000).toISOString(),
  valid_until: new Date(now + 86400000).toISOString(),
  applicable_services: ['item-a'], applicable_flow_types: ['ordering'],
};
function query(data: any = null, count = 0): any {
  const q: any = {
    select: vi.fn(() => q), eq: vi.fn(() => q), not: vi.fn(() => q),
    maybeSingle: vi.fn(async () => ({ data, error: null })),
    then: (resolve: any, reject: any) => Promise.resolve({ data, count, error: null }).then(resolve, reject),
  };
  return q;
}
function setup(flow: 'ordering' | 'scheduling', attrs: Record<string, unknown>) {
  const ctx = createMockContext();
  ctx.session.session_data = flow === 'ordering'
    ? { cart: [{ product_id: 'item-a', price: 1000, quantity: 1, name: 'Product A' }] }
    : { service_id: 'item-a', service_price: 1000 };
  const promoRow = { ...promo, applicable_flow_types: [flow], ...attrs };
  vi.mocked(ctx.supabase.from).mockImplementation(((table: string) =>
    table === 'promo_codes' ? query(promoRow) : query([], 0)) as any);
  return ctx;
}

describe('#598 bot promo code authorization at actual flow step', () => {
  for (const [flow, definition] of [['ordering', orderingFlow], ['scheduling', schedulingFlow]] as const) {
    it.each(['apply_promo', 'enter_promo_code'])(`${flow} %s accepts an eligible scoped promo`, async stepName => {
      const ctx = setup(flow, {});
      const result = await getStep(definition, stepName).validate('SAVE20', ctx);
      expect(result.valid).toBe(true);
      expect(flow === 'ordering' ? result.data?.discount_amount : result.data?._promo_discount).toBe(200);
    });

    it.each(['apply_promo', 'enter_promo_code'])(`${flow} %s rejects a promo for another item`, async stepName => {
      const ctx = setup(flow, { applicable_services: ['other-item'] });
      const result = await getStep(definition, stepName).validate('SAVE20', ctx);
      expect(result.valid).toBe(false);
      expect(result.errorMessage).toMatch(/selected products or services/);
    });

    it.each(['apply_promo', 'enter_promo_code'])(`${flow} %s rejects a future-dated code`, async stepName => {
      const ctx = setup(flow, { valid_from: new Date(now + 86400000).toISOString() });
      const result = await getStep(definition, stepName).validate('SAVE20', ctx);
      expect(result.valid).toBe(false);
      expect(result.errorMessage).toMatch(/not yet active/);
    });

    it.each(['apply_promo', 'enter_promo_code'])(`${flow} %s rejects codes meant for another flow`, async stepName => {
      const ctx = setup(flow, { applicable_flow_types: [flow === 'ordering' ? 'scheduling' : 'ordering'] });
      const result = await getStep(definition, stepName).validate('SAVE20', ctx);
      expect(result.valid).toBe(false);
      expect(result.errorMessage).toMatch(/type of checkout/);
    });
  }
});

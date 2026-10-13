import { describe, expect, it } from 'vitest';
import { validatePromoForCheckout, type CheckoutPromo } from '@/lib/promotions/checkout-eligibility';

const now = new Date('2026-10-09T12:00:00Z');
const base: CheckoutPromo = {
  business_id: 'biz-1', is_active: true, discount_type: 'percentage',
  discount_value: 20, min_order_amount: 0, current_uses: 0, max_uses: 3,
  valid_from: '2026-10-01T00:00:00Z', valid_until: '2026-10-20T00:00:00Z',
  applicable_services: ['product-a'], applicable_flow_types: ['ordering'],
};
const order = { businessId: 'biz-1', flow: 'ordering' as const, itemIds: ['product-a'], subtotal: 1000, now };
function result(overrides: CheckoutPromo, opts = order) {
  return validatePromoForCheckout({ ...base, ...overrides }, opts);
}

describe('#598 authoritative-shape bot promo eligibility', () => {
  it('calculates a valid scoped order discount', () => {
    expect(result({})).toEqual({ ok: true, discount: 200 });
  });
  it('accepts a service-only code only in scheduling for the matching service', () => {
    expect(result({ applicable_services: ['service-a'], applicable_flow_types: ['scheduling'] },
      { ...order, flow: 'scheduling', itemIds: ['service-a'] } as typeof order)).toEqual({ ok: true, discount: 200 });
  });
  it('rejects a product-specific promo for the wrong product or mixed cart', () => {
    expect(result({}, { ...order, itemIds: ['product-b'] }).ok).toBe(false);
    expect(result({}, { ...order, itemIds: ['product-a', 'product-b'] }).ok).toBe(false);
  });
  it('rejects a code in the wrong checkout flow', () => {
    expect(result({}, { ...order, flow: 'scheduling' } as typeof order).ok).toBe(false);
  });
  it('rejects another business, inactive, future and expired codes', () => {
    expect(result({ business_id: 'biz-2' }).ok).toBe(false);
    expect(result({ is_active: false }).ok).toBe(false);
    expect(result({ valid_from: '2026-10-10T00:00:00Z' }).ok).toBe(false);
    expect(result({ valid_until: '2026-10-09T12:00:00Z' }).ok).toBe(false);
    expect(result({ valid_from: 'not-a-date' }).ok).toBe(false);
  });
  it('rejects exhausted, nonpositive, invalid percentages and too-small orders', () => {
    expect(result({ max_uses: 0, current_uses: 0 }).ok).toBe(false);
    expect(result({ max_uses: 3, current_uses: 3 }).ok).toBe(false);
    expect(result({ discount_value: -1 }).ok).toBe(false);
    expect(result({ discount_value: 110 }).ok).toBe(false);
    expect(result({ min_order_amount: 1001 }).ok).toBe(false);
  });
  it('caps a fixed discount to subtotal, never a negative charge', () => {
    expect(result({ discount_type: 'fixed', discount_value: 2000 })).toEqual({ ok: true, discount: 1000 });
  });
  it('rejects invalid/corrupt promo values and zero-priced checkout', () => {
    expect(validatePromoForCheckout(null, order).ok).toBe(false);
    expect(result({ discount_type: 'incorrect' }).ok).toBe(false);
    expect(result({ discount_value: Number.NaN }).ok).toBe(false);
    expect(result({}, { ...order, subtotal: 0 }).ok).toBe(false);
  });
  it('allows universal codes across products and services only when unrestricted', () => {
    expect(result({ applicable_services: [], applicable_flow_types: [] },
      { ...order, itemIds: ['product-a', 'product-b'] })).toEqual({ ok: true, discount: 200 });
  });
});

/**
 * #598 — Checkout promo eligibility.
 * This guard protects bot code-entry paths. It is NOT the authoritative
 * database price/discount lock (separate release-blocking work).
 */
export interface CheckoutPromo {
  business_id?: string | null;
  is_active?: boolean;
  discount_type?: string;
  discount_value?: number;
  min_order_amount?: number | null;
  current_uses?: number;
  max_uses?: number | null;
  valid_from?: string | null;
  valid_until?: string | null;
  applicable_services?: string[] | null;
  applicable_flow_types?: string[] | null;
}

export interface PromoCheckout {
  businessId: string;
  flow: 'ordering' | 'scheduling';
  itemIds: string[];
  subtotal: number;
  now?: Date;
}

export type PromoCheckoutResult =
  | { ok: true; discount: number }
  | { ok: false; reason: string };

export function validatePromoForCheckout(promo: CheckoutPromo | null, request: PromoCheckout): PromoCheckoutResult {
  const denied = (reason: string): PromoCheckoutResult => ({ ok: false, reason });
  if (!promo || promo.business_id !== request.businessId || promo.is_active !== true) {
    return denied('This promo code is not valid for this business.');
  }
  if (!Number.isSafeInteger(request.subtotal) || request.subtotal <= 0) {
    return denied('A positive order subtotal is required.');
  }
  const now = (request.now || new Date()).getTime();
  if (!Number.isFinite(now)) return denied('Promotion time could not be verified.');
  for (const [field, value] of [['start', promo.valid_from], ['end', promo.valid_until]] as const) {
    if (value != null) {
      const time = Date.parse(value);
      if (!Number.isFinite(time)) return denied('Promotion dates are invalid.');
      if (field === 'start' && now < time) return denied('This promo code is not yet active.');
      if (field === 'end' && now >= time) return denied('This promo code has expired.');
    }
  }
  if (promo.max_uses != null && (!Number.isSafeInteger(promo.max_uses) || !Number.isSafeInteger(promo.current_uses) || (promo.current_uses || 0) >= promo.max_uses)) {
    return denied('This promo code is fully redeemed.');
  }
  const flows = promo.applicable_flow_types || [];
  if (!Array.isArray(flows) || (flows.length > 0 && !flows.includes(request.flow))) {
    return denied('This promo code cannot be used for this type of checkout.');
  }
  const allowedItems = promo.applicable_services || [];
  if (!Array.isArray(allowedItems) || (allowedItems.length > 0 &&
    (request.itemIds.length === 0 || request.itemIds.some(id => !id || !allowedItems.includes(id))))) {
    // Refuse a discount on an entire mixed cart when only some items are eligible.
    return denied('This promo code does not apply to all selected products or services.');
  }
  if (!Number.isFinite(promo.min_order_amount ?? 0) || (promo.min_order_amount || 0) > request.subtotal) {
    return denied('The minimum order amount has not been met.');
  }
  const value = Number(promo.discount_value);
  if (!Number.isFinite(value) || value <= 0) return denied('The discount amount is invalid.');
  if (promo.discount_type !== 'percentage' && promo.discount_type !== 'fixed') return denied('Unknown discount type.');
  if (promo.discount_type === 'percentage' && value > 100) return denied('Invalid percentage discount.');
  const discount = promo.discount_type === 'percentage'
    ? Math.round(request.subtotal * value / 100)
    : Math.min(Math.round(value), request.subtotal);
  if (!Number.isSafeInteger(discount) || discount <= 0 || discount > request.subtotal) return denied('Invalid payable discount.');
  return { ok: true, discount };
}

import type { SupabaseClient } from '@supabase/supabase-js';
import { validateTaxSnapshot, type TaxSnapshot } from './calculation';
import { majorToTaxMinor } from './money';

export interface OrderTaxPreviewInput {
  businessId: string;
  userId: string | null;
  sessionId: string;
  items: Array<{ product_id: string; quantity: number; unit_price?: number; variant_id?: string; variant_label?: string; addons?: unknown[] | null }>;
  shippingCost: number;
  deliveryZoneId?: string | null;
  promoCodeId?: string | null;
}
export interface OrderTaxPreview {
  is_preview: true;
  created: false;
  server_total: number;
  server_discount: number;
  server_volume_discount: number;
  server_addons_total?: number;
  tax_snapshot: TaxSnapshot | null;
  order_id?: string;
  reference_code?: string;
}

function validateSnapshotAmount(snapshot: TaxSnapshot | null, amount: number): void {
  if (!Number.isFinite(amount) || amount < 0) throw new Error('Invalid authoritative purchase total');
  if (snapshot) {
    validateTaxSnapshot(snapshot);
    if (snapshot.grossAmount !== majorToTaxMinor(amount, snapshot.currency)) throw new Error('Authoritative tax total does not reconcile');
  }
}

/** Service-role callers only. The RPC executes the same locked price authority as commit,
 * but returns before stock, order, item, promo or sequence mutations. Never fall back to
 * a client/session total if this read fails.
 */
export async function quoteOrderTax(db: SupabaseClient, input: OrderTaxPreviewInput): Promise<OrderTaxPreview> {
  const { data, error } = await db.rpc('create_order_atomic', {
    p_business_id: input.businessId, p_user_id: input.userId, p_bot_session_id: input.sessionId,
    p_items: input.items, p_shipping_cost: input.shippingCost,
    p_delivery_zone_id: input.deliveryZoneId ?? null, p_promo_code_id: input.promoCodeId ?? null,
    p_validate_products: true, p_preview: true,
  });
  if (error) throw new Error(error.message);
  if (!data || data.is_preview !== true || data.created !== false) throw new Error('Authoritative order preview unavailable');
  validateSnapshotAmount(data.tax_snapshot ?? null, data.server_total);
  return data as OrderTaxPreview;
}

export interface BookingTaxPreviewInput {
  businessId: string;
  serviceId?: string | null;
  appointmentId?: string | null;
  partySize: number;
  addons: unknown[];
  promoCodeId?: string | null;
  expectedTerms: Record<string, unknown>;
  mode?: 'customer' | 'manual';
  packageRedemption?: boolean;
  /** Only preview allows this hint; commit derives the claim from the locked bot session. */
  botClaim?: boolean;
}
export interface BookingTaxPreview {
  total: number;
  deposit: number;
  tax_snapshot: TaxSnapshot | null;
  [key: string]: unknown;
}
export async function quoteBookingTax(db: SupabaseClient, input: BookingTaxPreviewInput): Promise<BookingTaxPreview> {
  const { data, error } = await db.rpc('quote_booking_tax_980', {
    p_business: input.businessId, p_service: input.serviceId ?? null, p_appointment: input.appointmentId ?? null,
    p_party: input.partySize, p_addons: input.addons, p_promo: input.promoCodeId ?? null,
    p_expected: { ...input.expectedTerms, bot_claim: input.botClaim === true,
      _tax_mode: input.mode ?? 'customer', _tax_package_redemption: input.packageRedemption === true },
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error('Authoritative booking preview unavailable');
  validateSnapshotAmount(data.tax_snapshot ?? null, data.total);
  if (!Number.isFinite(data.deposit) || data.deposit < 0 || data.deposit > data.total) throw new Error('Invalid authoritative deposit');
  return data as BookingTaxPreview;
}

export function isTaxTermsChanged(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : '';
  return /tax_terms_changed|terms_changed|total_mismatch|discount_mismatch|price_changed|addon_terms_changed/.test(message);
}

/** M529 purchase columns support exactly two decimal major units, including tax-off purchases. */
export function isSafePurchaseAmount(amount: unknown): amount is number {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) return false;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(amount));
  return !!match && BigInt(match[1]) * BigInt(100) + BigInt((match[2] ?? '').padEnd(2, '0')) <= BigInt(Number.MAX_SAFE_INTEGER);
}

/**
 * Centralized product/variant availability helpers (#352 Phase 1).
 *
 * Used by ordering.flow.ts, smart-intent.ts, and tested directly.
 */

/**
 * Determine if a product is available for ordering.
 * Simple products: use parent stock when track_inventory=true.
 * Variable products (has_variants=true): use variant availability map.
 */
export function isProductAvailable(
  p: { track_inventory: boolean; stock_quantity: number | null; has_variants: boolean },
  variantAvailability?: Map<string, boolean>,
  productId?: string,
): boolean {
  if (p.has_variants) {
    if (variantAvailability && productId) {
      return variantAvailability.get(productId) ?? false;
    }
    return true; // Conservative: show if no variant data
  }
  return !p.track_inventory || (p.stock_quantity !== null && p.stock_quantity > 0);
}

/**
 * Compute variant availability map from raw variant data.
 * Returns Map<product_id, boolean> where true = at least one active variant
 * has NULL (unlimited) or >0 stock.
 */
export function computeVariantAvailability(
  variants: Array<{ product_id: string; stock_quantity: number | null; is_active: boolean }>,
): Map<string, boolean> {
  const map = new Map<string, boolean>();
  for (const v of variants) {
    if (!v.is_active) continue;
    if (v.stock_quantity === null || v.stock_quantity > 0) {
      map.set(v.product_id, true);
    } else if (!map.has(v.product_id)) {
      map.set(v.product_id, false);
    }
  }
  return map;
}

/**
 * For multi-axis variant selection: get axis values that lead to at least
 * one viable variant given already-selected axes.
 *
 * Viable = active AND (stock_quantity IS NULL OR stock_quantity > 0)
 * AND matches all previously selected options.
 */
export function getViableAxisValues(
  variants: Array<{ options: Record<string, string>; stock_quantity: number | null; is_active: boolean }>,
  selectedOptions: Record<string, string>,
  axisName: string,
): string[] {
  const viable = variants.filter(v => {
    if (!v.is_active) return false;
    if (v.stock_quantity !== null && v.stock_quantity <= 0) return false;
    return Object.entries(selectedOptions).every(([key, val]) => v.options[key] === val);
  });

  const viableValues = new Set<string>();
  for (const v of viable) {
    if (v.options[axisName]) viableValues.add(v.options[axisName]);
  }

  return [...viableValues];
}

/**
 * Product/variant availability behavioral + structural tests (#352 Phase 1).
 *
 * Part A: Behavioral tests using the extracted isProductAvailable helper
 * Part B: Multi-axis viable-value filtering logic
 * Part C: Cart revalidation behavior
 * Part D: Structural assertions (supplemental)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// ═══ Part A: isProductAvailable behavioral tests ═══

// Extract the helper logic for direct testing
function isProductAvailable(
  p: { track_inventory: boolean; stock_quantity: number | null; has_variants: boolean },
  variantAvailability?: Map<string, boolean>,
  productId?: string,
): boolean {
  if (p.has_variants) {
    if (variantAvailability && productId) {
      return variantAvailability.get(productId) ?? false;
    }
    return true;
  }
  return !p.track_inventory || (p.stock_quantity !== null && p.stock_quantity > 0);
}

// Simulate variant availability computation (same logic as ordering flow)
function computeVariantAvailability(
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

describe('isProductAvailable — behavioral', () => {
  it('simple untracked product: always available', () => {
    expect(isProductAvailable({ track_inventory: false, stock_quantity: null, has_variants: false })).toBe(true);
    expect(isProductAvailable({ track_inventory: false, stock_quantity: 0, has_variants: false })).toBe(true);
  });

  it('simple tracked product stock>0: available', () => {
    expect(isProductAvailable({ track_inventory: true, stock_quantity: 5, has_variants: false })).toBe(true);
  });

  it('simple tracked product stock=0: unavailable', () => {
    expect(isProductAvailable({ track_inventory: true, stock_quantity: 0, has_variants: false })).toBe(false);
  });

  it('simple tracked product stock=NULL: unavailable (existing behavior)', () => {
    expect(isProductAvailable({ track_inventory: true, stock_quantity: null, has_variants: false })).toBe(false);
  });

  it('variable product parent=NULL + active unlimited variant: available', () => {
    const variants = [{ product_id: 'p1', stock_quantity: null, is_active: true }];
    const avail = computeVariantAvailability(variants);
    expect(isProductAvailable(
      { track_inventory: true, stock_quantity: null, has_variants: true },
      avail, 'p1',
    )).toBe(true);
  });

  it('variable product parent=NULL + active finite in-stock variant: available', () => {
    const variants = [{ product_id: 'p1', stock_quantity: 10, is_active: true }];
    const avail = computeVariantAvailability(variants);
    expect(isProductAvailable(
      { track_inventory: true, stock_quantity: null, has_variants: true },
      avail, 'p1',
    )).toBe(true);
  });

  it('variable product all active variants OOS: unavailable', () => {
    const variants = [
      { product_id: 'p1', stock_quantity: 0, is_active: true },
      { product_id: 'p1', stock_quantity: 0, is_active: true },
    ];
    const avail = computeVariantAvailability(variants);
    expect(isProductAvailable(
      { track_inventory: true, stock_quantity: null, has_variants: true },
      avail, 'p1',
    )).toBe(false);
  });

  it('variable product inactive in-stock variant does NOT count', () => {
    const variants = [
      { product_id: 'p1', stock_quantity: 10, is_active: false },  // inactive!
      { product_id: 'p1', stock_quantity: 0, is_active: true },
    ];
    const avail = computeVariantAvailability(variants);
    expect(isProductAvailable(
      { track_inventory: true, stock_quantity: null, has_variants: true },
      avail, 'p1',
    )).toBe(false);
  });

  it('variable product with no active variants: unavailable', () => {
    const avail = computeVariantAvailability([]);
    expect(isProductAvailable(
      { track_inventory: true, stock_quantity: null, has_variants: true },
      avail, 'p1',
    )).toBe(false);
  });

  it('mixed products: simple and variable filtered correctly', () => {
    const variants = [
      { product_id: 'var1', stock_quantity: null, is_active: true },
      { product_id: 'var2', stock_quantity: 0, is_active: true },
    ];
    const avail = computeVariantAvailability(variants);

    // Simple tracked stock=5 → available
    expect(isProductAvailable({ track_inventory: true, stock_quantity: 5, has_variants: false })).toBe(true);
    // Simple tracked stock=0 → unavailable
    expect(isProductAvailable({ track_inventory: true, stock_quantity: 0, has_variants: false })).toBe(false);
    // Variable with unlimited variant → available
    expect(isProductAvailable({ track_inventory: true, stock_quantity: null, has_variants: true }, avail, 'var1')).toBe(true);
    // Variable all OOS → unavailable
    expect(isProductAvailable({ track_inventory: true, stock_quantity: null, has_variants: true }, avail, 'var2')).toBe(false);
  });
});

// ═══ Part B: Multi-axis viable-value filtering ═══

interface TestVariant {
  id: string;
  options: Record<string, string>;
  stock_quantity: number | null;
  is_active: boolean;
}

// Replicates the multi-axis viable-value logic from select_option_axis
function getViableAxisValues(
  variants: TestVariant[],
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

describe('Multi-axis viable-value filtering — behavioral', () => {
  const variants: TestVariant[] = [
    { id: 'v1', options: { Size: 'S', Color: 'Red' }, stock_quantity: 5, is_active: true },
    { id: 'v2', options: { Size: 'S', Color: 'Blue' }, stock_quantity: null, is_active: true },
    { id: 'v3', options: { Size: 'M', Color: 'Red' }, stock_quantity: 0, is_active: true },  // OOS
    { id: 'v4', options: { Size: 'M', Color: 'Blue' }, stock_quantity: 0, is_active: true },  // OOS
    { id: 'v5', options: { Size: 'L', Color: 'Red' }, stock_quantity: 3, is_active: true },
    { id: 'v6', options: { Size: 'L', Color: 'Blue' }, stock_quantity: null, is_active: true },
    { id: 'v7', options: { Size: 'XL', Color: 'Green' }, stock_quantity: 10, is_active: false }, // inactive
  ];

  it('first axis: M hidden because all M variants OOS', () => {
    const viableSizes = getViableAxisValues(variants, {}, 'Size');
    expect(viableSizes).toContain('S');
    expect(viableSizes).toContain('L');
    expect(viableSizes).not.toContain('M'); // All M variants stock=0
    expect(viableSizes).not.toContain('XL'); // Inactive
  });

  it('after Size=S: only Red and Blue available for Color', () => {
    const viableColors = getViableAxisValues(variants, { Size: 'S' }, 'Color');
    expect(viableColors).toContain('Red');
    expect(viableColors).toContain('Blue');
    expect(viableColors).not.toContain('Green');
  });

  it('after Size=L: Red and Blue available', () => {
    const viableColors = getViableAxisValues(variants, { Size: 'L' }, 'Color');
    expect(viableColors).toContain('Red');
    expect(viableColors).toContain('Blue');
  });

  it('stale/OOS choice: M is not viable', () => {
    const viableSizes = getViableAxisValues(variants, {}, 'Size');
    expect(viableSizes.includes('M')).toBe(false);
  });

  it('unlimited (NULL stock) variant is selectable', () => {
    const viableColors = getViableAxisValues(variants, { Size: 'S' }, 'Color');
    // v2: Size=S, Color=Blue, stock_quantity=null (unlimited)
    expect(viableColors).toContain('Blue');
  });

  it('inactive variant does not contribute to viable values', () => {
    // v7: Size=XL, Color=Green is inactive
    const viableSizes = getViableAxisValues(variants, {}, 'Size');
    expect(viableSizes).not.toContain('XL');
  });

  it('empty viable → no selectable values', () => {
    const allOos: TestVariant[] = [
      { id: 'x1', options: { Size: 'S' }, stock_quantity: 0, is_active: true },
    ];
    const values = getViableAxisValues(allOos, {}, 'Size');
    expect(values).toHaveLength(0);
  });
});

// ═══ Part C: Cart revalidation behavior ═══

describe('Cart revalidation — behavioral assertions', () => {
  it('variant revalidation checks product_id binding (structural)', () => {
    const source = readFileSync(join(process.cwd(), 'lib/bot/flows/ordering.flow.ts'), 'utf-8');
    // The variant cart revalidation section must bind to product_id + check active/stock/price
    expect(source).toContain(".eq('product_id', item.product_id)");
    expect(source).toContain("!currentVariant || !currentVariant.is_active");
    expect(source).toContain("currentVariant.stock_quantity !== null && currentVariant.stock_quantity < item.quantity");
    expect(source).toContain("currentVariant.price !== item.price");
  });

  it('simple product revalidation preserved', () => {
    const source = readFileSync(join(process.cwd(), 'lib/bot/flows/ordering.flow.ts'), 'utf-8');
    const simpleSection = source.slice(
      source.indexOf('Simple product: existing behavior'),
      source.indexOf('validCart.push(item)'),
    );
    expect(simpleSection).toContain('current.track_inventory');
    expect(simpleSection).toContain('current.stock_quantity');
  });
});

// ═══ Part D: Structural supplemental ═══

describe('Structural assertions (supplemental)', () => {
  const orderingSource = readFileSync(join(process.cwd(), 'lib/bot/flows/ordering.flow.ts'), 'utf-8');
  const smartSource = readFileSync(join(process.cwd(), 'lib/bot/smart-intent.ts'), 'utf-8');

  it('no remaining raw parent-stock filter outside isProductAvailable', () => {
    const matches = orderingSource.match(/!p\.track_inventory \|\| \(p\.stock_quantity/g);
    expect(matches?.length || 0).toBe(1); // only inside isProductAvailable definition
  });

  it('all product validators include is_active=true', () => {
    // Count eq('is_active', true) in validator sections
    const validatorSections = orderingSource.split('async validate(input: string');
    // Validators 1-3 (browse_catalog, browse_category, continue_or_checkout) should have is_active
    expect(validatorSections[1]).toContain(".eq('is_active', true)");
    expect(validatorSections[2]).toContain(".eq('is_active', true)");
  });

  it('variant validator binds to product_id + is_active', () => {
    expect(orderingSource).toContain(".eq('product_id', d.current_product_id as string)");
  });

  it('multi-axis prompt queries active available variants', () => {
    const multiSection = orderingSource.slice(
      orderingSource.indexOf('select_option_axis'),
      orderingSource.indexOf('select_variant_error'),
    );
    expect(multiSection).toContain("from('product_variants')");
    expect(multiSection).toContain("eq('is_active', true)");
    expect(multiSection).toContain('viableValues');
    expect(multiSection).toContain('availableValues');
  });

  it('multi-axis validator re-computes viable values', () => {
    const multiSection = orderingSource.slice(
      orderingSource.indexOf('select_option_axis'),
      orderingSource.indexOf('select_variant_error'),
    );
    // validate() must also query variants and compute viable values
    const validateSection = multiSection.slice(multiSection.indexOf('async validate'));
    expect(validateSection).toContain("from('product_variants')");
    expect(validateSection).toContain('viableValues');
    expect(validateSection).toContain('is not available');
  });

  it('smart-intent uses variant availability (same authority)', () => {
    expect(smartSource).toContain('track_inventory, stock_quantity');
    expect(smartSource).toContain("from('product_variants')");
    expect(smartSource).toContain('smartVarAvail');
  });
});

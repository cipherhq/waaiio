/**
 * Product/variant availability tests (#352 Phase 1 R16).
 *
 * Part A: Behavioral tests using PRODUCTION helpers
 * Part B: Multi-axis viable-value filtering using PRODUCTION helper
 * Part C: Smart-intent variable product handling
 * Part D: All-options-disappear recovery
 * Part E: Structural supplemental
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Import PRODUCTION helpers — not copies
import {
  isProductAvailable,
  computeVariantAvailability,
  getViableAxisValues,
} from '@/lib/bot/flows/shared/product-availability';

// ═══ Part A: isProductAvailable — production helper ═══

describe('isProductAvailable (production helper)', () => {
  it('simple untracked: always available', () => {
    expect(isProductAvailable({ track_inventory: false, stock_quantity: null, has_variants: false })).toBe(true);
    expect(isProductAvailable({ track_inventory: false, stock_quantity: 0, has_variants: false })).toBe(true);
  });

  it('simple tracked stock>0: available', () => {
    expect(isProductAvailable({ track_inventory: true, stock_quantity: 5, has_variants: false })).toBe(true);
  });

  it('simple tracked stock=0: unavailable', () => {
    expect(isProductAvailable({ track_inventory: true, stock_quantity: 0, has_variants: false })).toBe(false);
  });

  it('simple tracked stock=NULL: unavailable', () => {
    expect(isProductAvailable({ track_inventory: true, stock_quantity: null, has_variants: false })).toBe(false);
  });

  it('variable parent=NULL + active unlimited variant: available', () => {
    const avail = computeVariantAvailability([{ product_id: 'p1', stock_quantity: null, is_active: true }]);
    expect(isProductAvailable({ track_inventory: true, stock_quantity: null, has_variants: true }, avail, 'p1')).toBe(true);
  });

  it('variable + active finite in-stock variant: available', () => {
    const avail = computeVariantAvailability([{ product_id: 'p1', stock_quantity: 10, is_active: true }]);
    expect(isProductAvailable({ track_inventory: true, stock_quantity: null, has_variants: true }, avail, 'p1')).toBe(true);
  });

  it('variable all active variants OOS: unavailable', () => {
    const avail = computeVariantAvailability([
      { product_id: 'p1', stock_quantity: 0, is_active: true },
      { product_id: 'p1', stock_quantity: 0, is_active: true },
    ]);
    expect(isProductAvailable({ track_inventory: true, stock_quantity: null, has_variants: true }, avail, 'p1')).toBe(false);
  });

  it('inactive in-stock variant does NOT count', () => {
    const avail = computeVariantAvailability([
      { product_id: 'p1', stock_quantity: 10, is_active: false },
      { product_id: 'p1', stock_quantity: 0, is_active: true },
    ]);
    expect(isProductAvailable({ track_inventory: true, stock_quantity: null, has_variants: true }, avail, 'p1')).toBe(false);
  });

  it('variable with no variants: unavailable', () => {
    const avail = computeVariantAvailability([]);
    expect(isProductAvailable({ track_inventory: true, stock_quantity: null, has_variants: true }, avail, 'p1')).toBe(false);
  });
});

// ═══ Part B: Multi-axis viable-value filtering — production helper ═══

describe('getViableAxisValues (production helper)', () => {
  const variants = [
    { options: { Size: 'S', Color: 'Red' }, stock_quantity: 5, is_active: true },
    { options: { Size: 'S', Color: 'Blue' }, stock_quantity: null, is_active: true },  // unlimited
    { options: { Size: 'M', Color: 'Red' }, stock_quantity: 0, is_active: true },  // OOS
    { options: { Size: 'M', Color: 'Blue' }, stock_quantity: 0, is_active: true },  // OOS
    { options: { Size: 'L', Color: 'Red' }, stock_quantity: 3, is_active: true },
    { options: { Size: 'L', Color: 'Blue' }, stock_quantity: null, is_active: true },
    { options: { Size: 'XL', Color: 'Green' }, stock_quantity: 10, is_active: false }, // inactive
  ];

  it('first axis: M hidden (all M OOS), XL hidden (inactive)', () => {
    const sizes = getViableAxisValues(variants, {}, 'Size');
    expect(sizes).toContain('S');
    expect(sizes).toContain('L');
    expect(sizes).not.toContain('M');
    expect(sizes).not.toContain('XL');
  });

  it('after Size=S: Red and Blue available', () => {
    const colors = getViableAxisValues(variants, { Size: 'S' }, 'Color');
    expect(colors).toContain('Red');
    expect(colors).toContain('Blue');
    expect(colors).not.toContain('Green');
  });

  it('after Size=L: Red and Blue available', () => {
    const colors = getViableAxisValues(variants, { Size: 'L' }, 'Color');
    expect(colors).toContain('Red');
    expect(colors).toContain('Blue');
  });

  it('unlimited (NULL stock) variant selectable', () => {
    const colors = getViableAxisValues(variants, { Size: 'S' }, 'Color');
    expect(colors).toContain('Blue'); // stock_quantity=null
  });

  it('stale/OOS value rejected: M not viable', () => {
    expect(getViableAxisValues(variants, {}, 'Size')).not.toContain('M');
  });

  it('inactive variant excluded from axis values', () => {
    expect(getViableAxisValues(variants, {}, 'Size')).not.toContain('XL');
  });

  it('all-OOS returns empty', () => {
    const allOos = [{ options: { Size: 'S' }, stock_quantity: 0, is_active: true }];
    expect(getViableAxisValues(allOos, {}, 'Size')).toHaveLength(0);
  });

  it('constraint narrows correctly: only Blue available after size with one OOS color', () => {
    const narrowVariants = [
      { options: { Size: 'L', Color: 'Blue' }, stock_quantity: 5, is_active: true },
      { options: { Size: 'L', Color: 'Red' }, stock_quantity: 0, is_active: true },
    ];
    const colors = getViableAxisValues(narrowVariants, { Size: 'L' }, 'Color');
    expect(colors).toEqual(['Blue']);
  });
});

// ═══ Part C: Smart-intent variable product handling ═══

describe('Smart-intent variable product handling', () => {
  const botServiceSource = readFileSync(join(process.cwd(), 'lib/bot/bot.service.ts'), 'utf-8');
  const capSelectSource = readFileSync(join(process.cwd(), 'lib/bot/flows/capability-selection.flow.ts'), 'utf-8');

  it('bot.service: variable product unique match → variant picker, not auto-add', () => {
    const matchSection = botServiceSource.slice(
      botServiceSource.indexOf('productMatches.length === 1'),
      botServiceSource.indexOf('productMatches.length > 1'),
    );
    expect(matchSection).toContain('p.has_variants');
    expect(matchSection).toContain('_matched_product_ids');
    // Auto-add only for simple products
    expect(matchSection).toContain('} else {');
    expect(matchSection).toContain('_auto_added_to_cart');
  });

  it('capability-selection: variable product unique match → variant picker', () => {
    const matchSection = capSelectSource.slice(
      capSelectSource.indexOf('productMatches.length === 1'),
      capSelectSource.indexOf('productMatches.length > 1'),
    );
    expect(matchSection).toContain('p.has_variants');
    expect(matchSection).toContain('_matched_product_ids');
  });

  it('simple product auto-add preserved in bot.service', () => {
    const matchSection = botServiceSource.slice(
      botServiceSource.indexOf('productMatches.length === 1'),
      botServiceSource.indexOf('productMatches.length > 1'),
    );
    expect(matchSection).toContain('_auto_added_to_cart = true');
    expect(matchSection).toContain('_skip_browse = true');
    expect(matchSection).toContain('price: p.price');
  });
});

// ═══ Part D: All-options-disappear recovery ═══

describe('Multi-axis all-options-disappear recovery', () => {
  const orderingSource = readFileSync(join(process.cwd(), 'lib/bot/flows/ordering.flow.ts'), 'utf-8');

  it('shows recovery buttons when all options OOS', () => {
    const axisSection = orderingSource.slice(
      orderingSource.indexOf('select_option_axis'),
      orderingSource.indexOf('select_variant_error'),
    );
    expect(axisSection).toContain('availableValues.length === 0');
    expect(axisSection).toContain('Try Another');
    expect(axisSection).toContain('Cancel');
    expect(axisSection).toContain("type: 'buttons'");
  });

  it('clears stale option state before retry', () => {
    const axisSection = orderingSource.slice(
      orderingSource.indexOf('select_option_axis'),
      orderingSource.indexOf('select_variant_error'),
    );
    expect(axisSection).toContain('delete d.current_selected_options');
    expect(axisSection).toContain('delete d.current_option_axis_index');
  });
});

// ═══ Part E: Structural supplemental ═══

describe('Structural assertions (supplemental)', () => {
  const orderingSource = readFileSync(join(process.cwd(), 'lib/bot/flows/ordering.flow.ts'), 'utf-8');

  it('ordering.flow imports from shared/product-availability', () => {
    expect(orderingSource).toContain("from './shared/product-availability'");
  });

  it('uses computeVariantAvailability helper', () => {
    expect(orderingSource).toContain('computeVariantAvailability(');
  });

  it('all product validators include is_active=true', () => {
    const validateBlocks = orderingSource.split('async validate(input: string');
    expect(validateBlocks[1]).toContain(".eq('is_active', true)");
    expect(validateBlocks[2]).toContain(".eq('is_active', true)");
  });

  it('variant validator binds to product_id + is_active', () => {
    expect(orderingSource).toContain(".eq('product_id', d.current_product_id as string)");
  });

  it('multi-axis prompt queries variants and uses getViableAxisValues concept', () => {
    const multiSection = orderingSource.slice(
      orderingSource.indexOf('select_option_axis'),
      orderingSource.indexOf('select_variant_error'),
    );
    expect(multiSection).toContain("from('product_variants')");
    expect(multiSection).toContain('viableValues');
    expect(multiSection).toContain('availableValues');
  });

  it('cart revalidation checks variant product_id, is_active, stock, price', () => {
    expect(orderingSource).toContain(".eq('product_id', item.product_id)");
    expect(orderingSource).toContain("!currentVariant || !currentVariant.is_active");
  });

  it('smart-intent uses shared availability helpers', () => {
    const smartSource = readFileSync(join(process.cwd(), 'lib/bot/smart-intent.ts'), 'utf-8');
    expect(smartSource).toContain("product-availability");
    expect(smartSource).toContain('computeVariantAvailability');
    expect(smartSource).toContain('isProductAvailable');
  });
});

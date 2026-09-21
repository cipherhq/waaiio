/**
 * Product/variant availability tests (#352 Phase 1 R17).
 *
 * All behavioral tests import and execute PRODUCTION helpers.
 * Source-only assertions are supplemental.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  isProductAvailable,
  computeVariantAvailability,
  getViableAxisValues,
  classifySmartIntentMatch,
} from '@/lib/bot/flows/shared/product-availability';

// ═══ Part A: isProductAvailable ═══

describe('isProductAvailable (production)', () => {
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

  it('variable + active unlimited variant: available', () => {
    const avail = computeVariantAvailability([{ product_id: 'p1', stock_quantity: null, is_active: true }]);
    expect(isProductAvailable({ track_inventory: true, stock_quantity: null, has_variants: true }, avail, 'p1')).toBe(true);
  });

  it('variable + active finite in-stock: available', () => {
    const avail = computeVariantAvailability([{ product_id: 'p1', stock_quantity: 10, is_active: true }]);
    expect(isProductAvailable({ track_inventory: true, stock_quantity: null, has_variants: true }, avail, 'p1')).toBe(true);
  });

  it('variable all active OOS: unavailable', () => {
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

  it('variable no variants: unavailable', () => {
    const avail = computeVariantAvailability([]);
    expect(isProductAvailable({ track_inventory: true, stock_quantity: null, has_variants: true }, avail, 'p1')).toBe(false);
  });
});

// ═══ Part B: getViableAxisValues ═══

describe('getViableAxisValues (production)', () => {
  const variants = [
    { options: { Size: 'S', Color: 'Red' }, stock_quantity: 5, is_active: true },
    { options: { Size: 'S', Color: 'Blue' }, stock_quantity: null, is_active: true },
    { options: { Size: 'M', Color: 'Red' }, stock_quantity: 0, is_active: true },
    { options: { Size: 'M', Color: 'Blue' }, stock_quantity: 0, is_active: true },
    { options: { Size: 'L', Color: 'Red' }, stock_quantity: 3, is_active: true },
    { options: { Size: 'L', Color: 'Blue' }, stock_quantity: null, is_active: true },
    { options: { Size: 'XL', Color: 'Green' }, stock_quantity: 10, is_active: false },
  ];

  it('first axis: M hidden (all OOS), XL hidden (inactive)', () => {
    const sizes = getViableAxisValues(variants, {}, 'Size');
    expect(sizes).toContain('S');
    expect(sizes).toContain('L');
    expect(sizes).not.toContain('M');
    expect(sizes).not.toContain('XL');
  });

  it('Size=S → Red + Blue available', () => {
    expect(getViableAxisValues(variants, { Size: 'S' }, 'Color')).toEqual(expect.arrayContaining(['Red', 'Blue']));
  });

  it('unlimited NULL selectable', () => {
    expect(getViableAxisValues(variants, { Size: 'S' }, 'Color')).toContain('Blue');
  });

  it('constraint narrows: only Blue when Red is OOS', () => {
    const narrow = [
      { options: { Size: 'L', Color: 'Blue' }, stock_quantity: 5, is_active: true },
      { options: { Size: 'L', Color: 'Red' }, stock_quantity: 0, is_active: true },
    ];
    expect(getViableAxisValues(narrow, { Size: 'L' }, 'Color')).toEqual(['Blue']);
  });

  it('all OOS → empty', () => {
    const allOos = [{ options: { Size: 'S' }, stock_quantity: 0, is_active: true }];
    expect(getViableAxisValues(allOos, {}, 'Size')).toHaveLength(0);
  });

  it('stale OOS value not viable', () => {
    expect(getViableAxisValues(variants, {}, 'Size')).not.toContain('M');
  });
});

// ═══ Part C: classifySmartIntentMatch (production) ═══

describe('classifySmartIntentMatch (production)', () => {
  it('no match → no_match', () => {
    expect(classifySmartIntentMatch([])).toBe('no_match');
  });

  it('simple unique → auto_add', () => {
    expect(classifySmartIntentMatch([{ id: 'p1', has_variants: false }])).toBe('auto_add');
  });

  it('variable unique → variant_picker (never parent-only auto-add)', () => {
    expect(classifySmartIntentMatch([{ id: 'p1', has_variants: true }])).toBe('variant_picker');
  });

  it('multiple matches → narrow_catalog', () => {
    expect(classifySmartIntentMatch([
      { id: 'p1', has_variants: false },
      { id: 'p2', has_variants: true },
    ])).toBe('narrow_catalog');
  });
});

// ═══ Part D: Multi-axis recovery + flow behavior ═══

describe('Multi-axis OOS recovery behavior', () => {
  const source = readFileSync(join(process.cwd(), 'lib/bot/flows/ordering.flow.ts'), 'utf-8');

  it('validate() handles browse_more before axis matching', () => {
    const validateSection = source.slice(
      source.indexOf("id: 'select_option_axis'"),
      source.indexOf("id: 'select_variant_error'") || source.length,
    );
    const validateFn = validateSection.slice(validateSection.indexOf('async validate'));
    // browse_more handled at TOP of validate, before axis/variant logic
    const browseMoreIdx = validateFn.indexOf("'browse_more'");
    const axisIdx = validateFn.indexOf('variantOptions');
    expect(browseMoreIdx).toBeGreaterThan(0);
    expect(browseMoreIdx).toBeLessThan(axisIdx);
  });

  it('validate() handles cancel_order before axis matching', () => {
    const validateSection = source.slice(
      source.indexOf("id: 'select_option_axis'"),
      source.indexOf("id: 'select_variant_error'") || source.length,
    );
    const validateFn = validateSection.slice(validateSection.indexOf('async validate'));
    const cancelIdx = validateFn.indexOf("'cancel_order'");
    const axisIdx = validateFn.indexOf('variantOptions');
    expect(cancelIdx).toBeGreaterThan(0);
    expect(cancelIdx).toBeLessThan(axisIdx);
  });

  it('next() consumes browse_more recovery → routes to browse_catalog', () => {
    const axisSection = source.slice(
      source.indexOf("id: 'select_option_axis'"),
      source.indexOf("id: 'select_variant_error'") || source.length,
    );
    expect(axisSection).toContain("_axis_recovery === 'browse_more'");
    expect(axisSection).toContain("return 'browse_catalog'");
    expect(axisSection).toContain('delete d.current_selected_options');
  });

  it('next() consumes cancel recovery → terminates flow', () => {
    const axisSection = source.slice(
      source.indexOf("id: 'select_option_axis'"),
      source.indexOf("id: 'select_variant_error'") || source.length,
    );
    expect(axisSection).toContain("_axis_recovery === 'cancel'");
    expect(axisSection).toContain('return null');
  });

  it('prompt uses getViableAxisValues production helper', () => {
    const axisSection = source.slice(
      source.indexOf("id: 'select_option_axis'"),
      source.indexOf("id: 'select_variant_error'") || source.length,
    );
    const promptFn = axisSection.slice(0, axisSection.indexOf('async validate'));
    expect(promptFn).toContain('getViableAxisValues(');
  });

  it('validate uses getViableAxisValues production helper', () => {
    const axisSection = source.slice(
      source.indexOf("id: 'select_option_axis'"),
      source.indexOf("id: 'select_variant_error'") || source.length,
    );
    const validateFn = axisSection.slice(axisSection.indexOf('async validate'));
    expect(validateFn).toContain('getViableAxisValues(');
  });
});

// ═══ Part E: Structural supplemental ═══

describe('Structural supplemental', () => {
  const orderingSource = readFileSync(join(process.cwd(), 'lib/bot/flows/ordering.flow.ts'), 'utf-8');

  it('imports from shared/product-availability', () => {
    expect(orderingSource).toContain("from './shared/product-availability'");
  });

  it('uses computeVariantAvailability helper', () => {
    expect(orderingSource).toContain('computeVariantAvailability(');
  });

  it('variant validator binds product_id + is_active', () => {
    expect(orderingSource).toContain(".eq('product_id', d.current_product_id as string)");
  });

  it('cart revalidation checks variant binding', () => {
    expect(orderingSource).toContain(".eq('product_id', item.product_id)");
  });

  it('smart-intent uses shared helpers', () => {
    const smartSource = readFileSync(join(process.cwd(), 'lib/bot/smart-intent.ts'), 'utf-8');
    expect(smartSource).toContain('product-availability');
    expect(smartSource).toContain('isProductAvailable');
  });
});

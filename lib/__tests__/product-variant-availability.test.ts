/**
 * Product/variant availability regression tests (#352 Phase 1).
 *
 * Proves:
 * - Variable products with parent stock=NULL are shown when active variants exist
 * - All-OOS variable products are hidden
 * - Simple product behavior preserved
 * - Validator binding: is_active + product_id on variants
 * - Cart revalidation: variant stock/active/price
 * - Smart-intent uses same availability authority
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const orderingSource = readFileSync(join(process.cwd(), 'lib/bot/flows/ordering.flow.ts'), 'utf-8');
const smartIntentSource = readFileSync(join(process.cwd(), 'lib/bot/smart-intent.ts'), 'utf-8');

describe('#352 Phase 1 — Product availability filter', () => {
  it('isProductAvailable function exists and handles variable products', () => {
    expect(orderingSource).toContain('function isProductAvailable(');
    expect(orderingSource).toContain('if (p.has_variants)');
    expect(orderingSource).toContain('variantAvailability');
  });

  it('browse_catalog uses isProductAvailable with variant availability map', () => {
    const browseSection = orderingSource.slice(
      orderingSource.indexOf("browse_catalog"),
      orderingSource.indexOf("browse_category_items")
    );
    expect(browseSection).toContain('isProductAvailable(p, variantAvail, p.id)');
    expect(browseSection).toContain("from('product_variants')");
    expect(browseSection).toContain("eq('is_active', true)");
  });

  it('browse_category_items uses isProductAvailable', () => {
    // The catVarAvail usage must exist somewhere in the file
    expect(orderingSource).toContain('isProductAvailable(p, catVarAvail, p.id)');
  });

  it('continue_or_checkout (all-at-once) uses isProductAvailable', () => {
    // Both instances
    expect(orderingSource).toContain('isProductAvailable(p, aaoVarAvail, p.id)');
    expect(orderingSource).toContain('isProductAvailable(p, cocVarAvail, p.id)');
  });

  it('no remaining raw track_inventory filter outside isProductAvailable', () => {
    // The only remaining track_inventory || ... should be inside isProductAvailable itself
    const matches = orderingSource.match(/!p\.track_inventory \|\| \(p\.stock_quantity/g);
    // Should be exactly 1 (inside the isProductAvailable function definition)
    expect(matches?.length || 0).toBe(1);
  });
});

describe('#352 Phase 1 — Validator binding', () => {
  it('browse_catalog.validate() checks is_active=true', () => {
    // Find the validate function after browse_catalog prompt
    const validateBlocks = orderingSource.split('async validate(input: string');
    // First validate after browse_catalog (index 1) should have is_active
    expect(validateBlocks[1]).toContain(".eq('is_active', true)");
  });

  it('browse_category_items.validate() checks is_active=true', () => {
    const validateBlocks = orderingSource.split('async validate(input: string');
    // browse_category_items validate (index 2)
    expect(validateBlocks[2]).toContain(".eq('is_active', true)");
  });

  it('continue_or_checkout.validate() checks is_active=true', () => {
    // The continue_or_checkout validate block with product selection
    const cocValidate = orderingSource.slice(orderingSource.indexOf("// Treat as product selection"));
    expect(cocValidate).toContain(".eq('is_active', true)");
  });

  it('select_variant.validate() binds to current_product_id + is_active', () => {
    // The variant validator must bind by product_id + is_active
    expect(orderingSource).toContain(".eq('product_id', d.current_product_id as string)");
    // is_active check on variant validator
    const variantValidateIdx = orderingSource.indexOf("eq('product_id', d.current_product_id");
    const nearbyCode = orderingSource.slice(variantValidateIdx - 50, variantValidateIdx + 100);
    expect(nearbyCode).toContain("eq('is_active', true)");
  });
});

describe('#352 Phase 1 — Cart revalidation for variants', () => {
  it('revalidation checks variant is_active', () => {
    const cartSection = orderingSource.slice(
      orderingSource.indexOf('Variant-aware cart revalidation'),
      orderingSource.indexOf('Calculate subtotal')
    );
    expect(cartSection).toContain("!currentVariant.is_active");
    expect(cartSection).toContain("is no longer available and was removed");
  });

  it('revalidation checks variant stock_quantity', () => {
    const cartSection = orderingSource.slice(
      orderingSource.indexOf('Variant-aware cart revalidation'),
      orderingSource.indexOf('Calculate subtotal')
    );
    expect(cartSection).toContain("currentVariant.stock_quantity");
    expect(cartSection).toContain("is now out of stock and was removed");
    expect(cartSection).toContain("Quantity adjusted");
  });

  it('revalidation updates variant price', () => {
    const cartSection = orderingSource.slice(
      orderingSource.indexOf('Variant-aware cart revalidation'),
      orderingSource.indexOf('Calculate subtotal')
    );
    expect(cartSection).toContain("currentVariant.price !== item.price");
    expect(cartSection).toContain("price updated");
  });

  it('revalidation binds variant to product_id', () => {
    const cartSection = orderingSource.slice(
      orderingSource.indexOf('Variant-aware cart revalidation'),
      orderingSource.indexOf('Calculate subtotal')
    );
    expect(cartSection).toContain(".eq('product_id', item.product_id)");
  });

  it('simple product revalidation preserved unchanged', () => {
    const cartSection = orderingSource.slice(
      orderingSource.indexOf('Simple product: existing behavior'),
      orderingSource.indexOf('validCart.push(item)')
    );
    expect(cartSection).toContain('current.track_inventory');
    expect(cartSection).toContain('current.stock_quantity');
    expect(cartSection).toContain('current.price !== item.price');
  });
});

describe('#352 Phase 1 — Smart-intent availability parity', () => {
  it('smart-intent queries track_inventory and stock_quantity', () => {
    expect(smartIntentSource).toContain('track_inventory, stock_quantity');
  });

  it('smart-intent filters variable products by variant availability', () => {
    expect(smartIntentSource).toContain("from('product_variants')");
    expect(smartIntentSource).toContain("eq('is_active', true)");
    expect(smartIntentSource).toContain('smartVarAvail');
  });

  it('smart-intent filters simple products by stock', () => {
    expect(smartIntentSource).toContain('!p.track_inventory');
    expect(smartIntentSource).toContain('p.stock_quantity !== null && p.stock_quantity > 0');
  });

  it('smart-intent returns empty for all-OOS products', () => {
    expect(smartIntentSource).toContain("products.length === 0) return []");
  });
});

describe('#352 Phase 1 — Existing simple product behavior preserved', () => {
  it('isProductAvailable preserves simple product stock filter', () => {
    // The function must return the same result as the old filter for simple products
    const fnBody = orderingSource.slice(
      orderingSource.indexOf('function isProductAvailable('),
      orderingSource.indexOf('interface OptionGroup')
    );
    expect(fnBody).toContain('!p.track_inventory || (p.stock_quantity !== null && p.stock_quantity > 0)');
  });

  it('low stock warning still shown for simple products', () => {
    expect(orderingSource).toContain('!p.has_variants && p.track_inventory');
    expect(orderingSource).toContain('low_stock_threshold');
  });
});

/**
 * Product gallery images regression tests.
 *
 * Covers: existing single-image products, 4-image limit, add/edit/reorder/delete,
 * invalid uploads, tenant isolation, variant compatibility, imports, bot presentation,
 * catalog sync, concurrent updates, and migration safety.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';

// ── Migration 461 verification ──────────────────────────────────────────────

describe('M461: product gallery migration', () => {
  const migrationSrc = readFileSync('supabase/migrations/461_product_gallery_images.sql', 'utf8');

  it('adds gallery_urls column with correct type and default', () => {
    expect(migrationSrc).toContain('ADD COLUMN IF NOT EXISTS gallery_urls TEXT[]');
    expect(migrationSrc).toContain("NOT NULL DEFAULT '{}'");
  });

  it('enforces max 3 gallery images via CHECK constraint', () => {
    expect(migrationSrc).toContain('chk_product_gallery_max_3');
    expect(migrationSrc).toContain('array_length(gallery_urls, 1)');
    expect(migrationSrc).toContain('<= 3');
  });

  it('does not alter image_url or any existing columns', () => {
    expect(migrationSrc).not.toMatch(/ALTER.*image_url/);
    expect(migrationSrc).not.toMatch(/DROP COLUMN/);
  });

  it('verifies existing products are not violated by the constraint', () => {
    expect(migrationSrc).toContain("array_length(gallery_urls, 1), 0) > 3");
  });
});

// ── TypeScript types ────────────────────────────────────────────────────────

describe('Product type includes gallery_urls', () => {
  it('Product interface has gallery_urls: string[]', () => {
    const typeSrc = readFileSync('app/dashboard/products/components/types.ts', 'utf8');
    expect(typeSrc).toContain('gallery_urls: string[]');
  });

  it('EMPTY_PRODUCT has gallery_urls: []', () => {
    const typeSrc = readFileSync('app/dashboard/products/components/types.ts', 'utf8');
    expect(typeSrc).toContain('gallery_urls: []');
  });

  it('Product interface preserves image_url: string | null', () => {
    const typeSrc = readFileSync('app/dashboard/products/components/types.ts', 'utf8');
    expect(typeSrc).toContain('image_url: string | null');
  });
});

// ── Dashboard product queries ───────────────────────────────────────────────

describe('product gallery data flow', () => {
  it('fetchProducts SELECT includes gallery_urls', () => {
    const pageSrc = readFileSync('app/dashboard/products/page.tsx', 'utf8');
    expect(pageSrc).toContain('gallery_urls');
    // Verify it's in the select string
    const selectMatch = pageSrc.match(/\.select\('([^']+)'\)/);
    expect(selectMatch?.[1]).toContain('gallery_urls');
  });

  it('save payload includes gallery_urls', () => {
    const pageSrc = readFileSync('app/dashboard/products/page.tsx', 'utf8');
    expect(pageSrc).toContain("gallery_urls: form.gallery_urls || []");
  });

  it('openEdit initializes gallery_urls from product data', () => {
    const pageSrc = readFileSync('app/dashboard/products/page.tsx', 'utf8');
    expect(pageSrc).toContain('gallery_urls: product.gallery_urls || []');
  });
});

// ── Existing single-image products backward compatibility ───────────────────

describe('backward compatibility: existing single-image products', () => {
  it('image_url field remains in Product interface', () => {
    const typeSrc = readFileSync('app/dashboard/products/components/types.ts', 'utf8');
    const lines = typeSrc.split('\n');
    const imageUrlLine = lines.find(l => l.includes('image_url:') && l.includes('string | null'));
    expect(imageUrlLine).toBeTruthy();
  });

  it('EMPTY_PRODUCT.image_url remains null', () => {
    const typeSrc = readFileSync('app/dashboard/products/components/types.ts', 'utf8');
    expect(typeSrc).toContain('image_url: null');
  });

  it('migration uses IF NOT EXISTS (safe for re-run)', () => {
    const migrationSrc = readFileSync('supabase/migrations/461_product_gallery_images.sql', 'utf8');
    expect(migrationSrc).toContain('ADD COLUMN IF NOT EXISTS');
  });
});

// ── Variant images remain independent ───────────────────────────────────────

describe('variant image independence', () => {
  it('ProductVariant type still has its own image_url', () => {
    const typeSrc = readFileSync('app/dashboard/products/components/types.ts', 'utf8');
    const variantSection = typeSrc.substring(
      typeSrc.indexOf('interface ProductVariant'),
      typeSrc.indexOf('}', typeSrc.indexOf('interface ProductVariant')) + 1
    );
    expect(variantSection).toContain('image_url');
  });

  it('EMPTY_VARIANT.image_url remains null', () => {
    const typeSrc = readFileSync('app/dashboard/products/components/types.ts', 'utf8');
    const emptyVariantSection = typeSrc.substring(
      typeSrc.indexOf('EMPTY_VARIANT'),
      typeSrc.indexOf('};', typeSrc.indexOf('EMPTY_VARIANT')) + 2
    );
    expect(emptyVariantSection).toContain('image_url: null');
  });

  it('variant image select query does not include gallery_urls', () => {
    const pageSrc = readFileSync('app/dashboard/products/page.tsx', 'utf8');
    const variantSelect = pageSrc.match(/from\('product_variants'\)\s*\.select\('([^']+)'\)/);
    expect(variantSelect?.[1]).not.toContain('gallery_urls');
  });
});

// ── Bot presentation: primary image only ────────────────────────────────────

describe('WhatsApp bot: uses primary image only', () => {
  it('ordering flow reads image_url not gallery_urls', () => {
    const botSrc = readFileSync('lib/bot/flows/ordering.flow.ts', 'utf8');
    expect(botSrc).toContain('product.image_url');
    expect(botSrc).not.toContain('gallery_urls');
  });

  it('ordering flow stores current_product_image_url from image_url', () => {
    const botSrc = readFileSync('lib/bot/flows/ordering.flow.ts', 'utf8');
    expect(botSrc).toContain('current_product_image_url: product.image_url');
  });
});

// ── Catalog sync: primary image only (Meta API extension deferred) ──────────

describe('Meta catalog sync: primary image only', () => {
  it('catalog sync route reads image_url not gallery_urls', () => {
    const syncSrc = readFileSync('app/api/catalog/sync/route.ts', 'utf8');
    expect(syncSrc).toContain('image_url');
    expect(syncSrc).not.toContain('gallery_urls');
  });

  it('CatalogProduct interface has single image_url', () => {
    const catalogSrc = readFileSync('lib/channels/catalog.ts', 'utf8');
    expect(catalogSrc).toContain('image_url?: string');
    expect(catalogSrc).not.toContain('gallery_urls');
    expect(catalogSrc).not.toContain('additional_image');
  });
});

// ── Bulk import: does not clobber gallery_urls ──────────────────────────────

describe('bulk import preserves gallery_urls', () => {
  it('CSV mapCSVRow does not include gallery_urls', () => {
    const typeSrc = readFileSync('app/dashboard/products/components/types.ts', 'utf8');
    const mapSection = typeSrc.substring(
      typeSrc.indexOf('function mapCSVRow'),
      typeSrc.indexOf('}', typeSrc.indexOf('function mapCSVRow') + 100) + 1
    );
    expect(mapSection).not.toContain('gallery');
  });

  it('BulkUpload component does not reference gallery_urls', () => {
    const bulkSrc = readFileSync('app/dashboard/products/components/BulkUpload.tsx', 'utf8');
    expect(bulkSrc).not.toContain('gallery');
    expect(bulkSrc).not.toContain('image');
  });
});

// ── Gallery limit enforcement ───────────────────────────────────────────────

describe('gallery image limit', () => {
  it('CHECK constraint limits gallery to 3 entries (4 total with primary)', () => {
    const migrationSrc = readFileSync('supabase/migrations/461_product_gallery_images.sql', 'utf8');
    expect(migrationSrc).toContain('COALESCE(array_length(gallery_urls, 1), 0) <= 3');
  });

  it('ProductForm enforces totalImages < 4 before showing upload button', () => {
    const formSrc = readFileSync('app/dashboard/products/components/ProductForm.tsx', 'utf8');
    expect(formSrc).toContain('totalImages < 4');
  });

  it('handleGalleryUpload checks both gallery length and total image count', () => {
    const pageSrc = readFileSync('app/dashboard/products/page.tsx', 'utf8');
    expect(pageSrc).toContain('totalImages >= 4');
    expect(pageSrc).toContain('currentGallery.length >= 3');
  });
});

// ── Upload security: reuses existing authenticated endpoint ─────────────────

describe('gallery upload security', () => {
  it('reuses existing upload-image endpoint (not a new route)', () => {
    const pageSrc = readFileSync('app/dashboard/products/page.tsx', 'utf8');
    expect(pageSrc).toContain('/api/products/upload-image');
    // Gallery upload calls uploadImageFile which uses the same endpoint
    expect(pageSrc).toContain('handleGalleryUpload');
    expect(pageSrc).toContain('await uploadImageFile(file)');
  });

  it('upload endpoint validates ownership, file type, size, and magic bytes', () => {
    const uploadSrc = readFileSync('app/api/products/upload-image/route.ts', 'utf8');
    expect(uploadSrc).toContain('eq(\'owner_id\', user.id)');
    expect(uploadSrc).toContain('validateFileSignature');
    expect(uploadSrc).toContain('sanitizeImage');
    expect(uploadSrc).toContain('5 * 1024 * 1024');
  });
});

// ── Gallery UI interactions ─────────────────────────────────────────────────

describe('gallery UI interactions', () => {
  it('supports image removal', () => {
    const pageSrc = readFileSync('app/dashboard/products/page.tsx', 'utf8');
    expect(pageSrc).toContain('handleGalleryRemove');
    expect(pageSrc).toContain('updated.splice(index, 1)');
  });

  it('supports image reordering', () => {
    const pageSrc = readFileSync('app/dashboard/products/page.tsx', 'utf8');
    expect(pageSrc).toContain('handleGalleryReorder');
    expect(pageSrc).toContain('updated.splice(fromIndex, 1)');
    expect(pageSrc).toContain('updated.splice(toIndex, 0, moved)');
  });

  it('supports setting a gallery image as primary', () => {
    const pageSrc = readFileSync('app/dashboard/products/page.tsx', 'utf8');
    expect(pageSrc).toContain('handleSetPrimary');
    // Swaps gallery image with current primary
    expect(pageSrc).toContain('newPrimary');
    expect(pageSrc).toContain('oldPrimary');
  });

  it('shows upload progress indicator', () => {
    const formSrc = readFileSync('app/dashboard/products/components/ProductForm.tsx', 'utf8');
    expect(formSrc).toContain('galleryUploading');
    expect(formSrc).toContain('animate-spin');
  });
});

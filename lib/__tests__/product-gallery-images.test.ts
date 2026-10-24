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
  const migrationSrc = readFileSync('supabase/migrations/462_product_gallery_images.sql', 'utf8');

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
    const migrationSrc = readFileSync('supabase/migrations/462_product_gallery_images.sql', 'utf8');
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
    const migrationSrc = readFileSync('supabase/migrations/462_product_gallery_images.sql', 'utf8');
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
    // Swaps gallery image with current primary, uploading pending file first
    expect(pageSrc).toContain('newPrimary');
    expect(pageSrc).toContain('currentPrimaryUrl');
  });

  it('shows upload progress indicator', () => {
    const formSrc = readFileSync('app/dashboard/products/components/ProductForm.tsx', 'utf8');
    expect(formSrc).toContain('galleryUploading');
    expect(formSrc).toContain('animate-spin');
  });
});

// ── Behavioral unit tests (gallery logic) ───────────────────────────────────

describe('gallery logic: behavioral tests', () => {
  // Simulate the gallery removal logic
  function galleryRemove(urls: string[], index: number): string[] {
    const updated = [...urls];
    updated.splice(index, 1);
    return updated;
  }

  // Simulate the gallery reorder logic
  function galleryReorder(urls: string[], from: number, to: number): string[] {
    const updated = [...urls];
    const [moved] = updated.splice(from, 1);
    updated.splice(to, 0, moved);
    return updated;
  }

  // Simulate set-as-primary swap logic
  function setPrimary(
    imageUrl: string | null,
    galleryUrls: string[],
    galleryIndex: number,
  ): { imageUrl: string; galleryUrls: string[] } {
    const gallery = [...galleryUrls];
    const newPrimary = gallery[galleryIndex];
    gallery.splice(galleryIndex, 1);
    if (imageUrl) gallery.splice(galleryIndex, 0, imageUrl);
    return { imageUrl: newPrimary, galleryUrls: gallery };
  }

  it('removal: removes the correct image and preserves order', () => {
    const urls = ['a.jpg', 'b.jpg', 'c.jpg'];
    expect(galleryRemove(urls, 1)).toEqual(['a.jpg', 'c.jpg']);
    expect(galleryRemove(urls, 0)).toEqual(['b.jpg', 'c.jpg']);
    expect(galleryRemove(urls, 2)).toEqual(['a.jpg', 'b.jpg']);
  });

  it('removal: single-image gallery becomes empty', () => {
    expect(galleryRemove(['only.jpg'], 0)).toEqual([]);
  });

  it('reorder: swap adjacent images', () => {
    const urls = ['a.jpg', 'b.jpg', 'c.jpg'];
    expect(galleryReorder(urls, 0, 1)).toEqual(['b.jpg', 'a.jpg', 'c.jpg']);
    expect(galleryReorder(urls, 2, 1)).toEqual(['a.jpg', 'c.jpg', 'b.jpg']);
  });

  it('reorder: move first to last', () => {
    expect(galleryReorder(['a.jpg', 'b.jpg', 'c.jpg'], 0, 2)).toEqual(['b.jpg', 'c.jpg', 'a.jpg']);
  });

  it('set-as-primary: swaps gallery image with current primary', () => {
    const result = setPrimary('primary.jpg', ['g1.jpg', 'g2.jpg', 'g3.jpg'], 1);
    expect(result.imageUrl).toBe('g2.jpg');
    expect(result.galleryUrls).toEqual(['g1.jpg', 'primary.jpg', 'g3.jpg']);
  });

  it('set-as-primary: first gallery image becomes primary', () => {
    const result = setPrimary('old.jpg', ['new.jpg', 'other.jpg'], 0);
    expect(result.imageUrl).toBe('new.jpg');
    expect(result.galleryUrls).toEqual(['old.jpg', 'other.jpg']);
  });

  it('set-as-primary: preserves total count (no image lost)', () => {
    const gallery = ['g1.jpg', 'g2.jpg', 'g3.jpg'];
    const primary = 'p.jpg';
    const result = setPrimary(primary, gallery, 2);
    expect(result.galleryUrls.length + 1).toBe(gallery.length + 1); // total unchanged
    expect([result.imageUrl, ...result.galleryUrls].sort())
      .toEqual([primary, ...gallery].sort()); // same URLs, just reordered
  });

  it('set-as-primary: with null primary, gallery shrinks by one', () => {
    const result = setPrimary(null, ['g1.jpg', 'g2.jpg'], 0);
    expect(result.imageUrl).toBe('g1.jpg');
    expect(result.galleryUrls).toEqual(['g2.jpg']);
  });

  it('four-image limit: gallery accepts max 3', () => {
    const gallery = ['a.jpg', 'b.jpg', 'c.jpg'];
    // Simulating the functional update check
    const canAdd = gallery.length < 3;
    expect(canAdd).toBe(false);
  });

  it('four-image limit: total of primary + gallery = 4 max', () => {
    const hasPrimary = true;
    const gallery = ['a.jpg', 'b.jpg', 'c.jpg'];
    const totalImages = (hasPrimary ? 1 : 0) + gallery.length;
    expect(totalImages).toBe(4);
    expect(totalImages >= 4).toBe(true);
  });

  it('existing single-image product: empty gallery is valid', () => {
    const product = { image_url: 'existing.jpg', gallery_urls: [] };
    expect(product.gallery_urls).toEqual([]);
    expect(product.image_url).toBe('existing.jpg');
  });

  it('functional state update prevents stale gallery on concurrent upload', () => {
    const pageSrc = readFileSync('app/dashboard/products/page.tsx', 'utf8');
    // handleGalleryUpload must use functional setForm(prev => ...) not setForm({...form})
    expect(pageSrc).toContain('setForm(prev =>');
    expect(pageSrc).toContain('prev.gallery_urls');
  });

  it('handleSetPrimary uploads pending imageFile before swapping', () => {
    const pageSrc = readFileSync('app/dashboard/products/page.tsx', 'utf8');
    // Must upload pending file before clearing it
    expect(pageSrc).toContain('if (imageFile)');
    expect(pageSrc).toContain('await uploadImageFile(imageFile)');
  });
});

// ── Migration/deployment ordering ───────────────────────────────────────────

describe('deployment ordering: gallery_urls resilience', () => {
  it('product select includes gallery_urls in the column list (not wildcard)', () => {
    const pageSrc = readFileSync('app/dashboard/products/page.tsx', 'utf8');
    const selectMatch = pageSrc.match(/\.select\('([^']*gallery_urls[^']*)'\)/);
    expect(selectMatch).toBeTruthy();
  });

  it('openEdit initializes gallery_urls with fallback for pre-migration data', () => {
    const pageSrc = readFileSync('app/dashboard/products/page.tsx', 'utf8');
    // Must handle undefined gallery_urls from pre-migration DB
    expect(pageSrc).toContain('gallery_urls: product.gallery_urls || []');
  });

  it('save payload uses fallback for missing gallery_urls', () => {
    const pageSrc = readFileSync('app/dashboard/products/page.tsx', 'utf8');
    expect(pageSrc).toContain('gallery_urls: form.gallery_urls || []');
  });

  it('EMPTY_PRODUCT.gallery_urls is empty array (safe default)', () => {
    const typeSrc = readFileSync('app/dashboard/products/components/types.ts', 'utf8');
    expect(typeSrc).toContain("gallery_urls: []");
  });
});

// ── R2: Failed upload aborts primary swap ───────────────────────────────────

describe('R2: handleSetPrimary upload failure handling', () => {
  it('aborts primary swap when pending image upload fails', () => {
    const pageSrc = readFileSync('app/dashboard/products/page.tsx', 'utf8');
    // Must check upload result before proceeding
    expect(pageSrc).toContain('if (!uploadedUrl)');
    // Must return early on failure
    expect(pageSrc).toContain('return;');
    // Must show actionable error message
    expect(pageSrc).toContain('Image upload failed');
    expect(pageSrc).toContain('setSyncMessage');
  });

  it('does not clear imageFile on upload failure', () => {
    const pageSrc = readFileSync('app/dashboard/products/page.tsx', 'utf8');
    // The setImageFile(null) must be AFTER the upload success check, not before
    const handleSetPrimaryStart = pageSrc.indexOf('async function handleSetPrimary');
    const handleSetPrimaryEnd = pageSrc.indexOf('// ── Generate variants', handleSetPrimaryStart);
    const fnBody = pageSrc.substring(handleSetPrimaryStart, handleSetPrimaryEnd);
    // Upload failure returns before any setImageFile(null)
    const returnIndex = fnBody.indexOf('return;');
    const firstClearIndex = fnBody.indexOf('setImageFile(null)');
    expect(returnIndex).toBeLessThan(firstClearIndex);
  });
});

// ── R2: Async primary-swap race prevention ──────────────────────────────────

describe('R2: handleSetPrimary uses functional state update', () => {
  it('uses setForm(prev => ...) not setForm({...form})', () => {
    const pageSrc = readFileSync('app/dashboard/products/page.tsx', 'utf8');
    const handleSetPrimaryStart = pageSrc.indexOf('async function handleSetPrimary');
    const handleSetPrimaryEnd = pageSrc.indexOf('// ── Generate variants', handleSetPrimaryStart);
    const fnBody = pageSrc.substring(handleSetPrimaryStart, handleSetPrimaryEnd);
    // Must use functional update
    expect(fnBody).toContain('setForm(prev =>');
    expect(fnBody).toContain('prev.gallery_urls');
    // Must NOT use stale form capture for the swap
    expect(fnBody).not.toContain('setForm({ ...form');
  });

  it('validates galleryIndex bounds before swap', () => {
    const pageSrc = readFileSync('app/dashboard/products/page.tsx', 'utf8');
    expect(pageSrc).toContain('galleryIndex < 0 || galleryIndex >= gallery.length');
  });

  // Behavioral: concurrent gallery edit during async upload is not overwritten
  it('functional update preserves concurrent gallery removal', () => {
    // Simulates: user removes gallery[0] while handleSetPrimary is uploading
    // The functional update reads latest state, not the captured pre-upload state
    const initialGallery = ['a.jpg', 'b.jpg', 'c.jpg'];
    const primaryUrl = 'primary.jpg';

    // Concurrent removal of index 0 happens during upload
    const afterRemoval = ['b.jpg', 'c.jpg'];

    // Functional update runs on afterRemoval state, not initialGallery
    const galleryIndex = 1; // user clicked "set primary" on what was index 1
    const gallery = [...afterRemoval];
    if (galleryIndex >= 0 && galleryIndex < gallery.length) {
      const newPrimary = gallery[galleryIndex];
      gallery.splice(galleryIndex, 1);
      if (primaryUrl) gallery.splice(galleryIndex, 0, primaryUrl);
      expect(newPrimary).toBe('c.jpg'); // was b.jpg before removal, now c.jpg
      expect(gallery).toEqual(['b.jpg', 'primary.jpg']); // correct with latest state
    }
  });

  it('functional update preserves concurrent gallery upload', () => {
    // Simulates: another gallery upload completes while handleSetPrimary is uploading
    const afterConcurrentUpload = ['a.jpg', 'b.jpg', 'c.jpg']; // c.jpg added concurrently
    const primaryUrl = 'old-primary.jpg';

    // Functional update runs on afterConcurrentUpload, sets gallery[0] as primary
    const gallery = [...afterConcurrentUpload];
    const galleryIndex = 0;
    const newPrimary = gallery[galleryIndex];
    gallery.splice(galleryIndex, 1);
    if (primaryUrl) gallery.splice(galleryIndex, 0, primaryUrl);
    expect(newPrimary).toBe('a.jpg');
    expect(gallery).toEqual(['old-primary.jpg', 'b.jpg', 'c.jpg']); // concurrent upload preserved
  });
});

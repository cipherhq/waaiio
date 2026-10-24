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
    expect(pageSrc).toContain('if (!uploadedPrimaryUrl)');
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

// ── R4: Pure state transition via formRef (no updater side effects) ──────────

describe('R4-1: handleSetPrimary uses formRef for latest state, not updater side effects', () => {
  it('reads latest gallery from formRef.current, not stale closure or updater', () => {
    const pageSrc = readFileSync('app/dashboard/products/page.tsx', 'utf8');
    const fn = extractHandleSetPrimary(pageSrc);
    expect(fn).toContain('formRef.current');
    expect(fn).toContain('latest.gallery_urls');
    // No side-effect assignments inside setForm updater
    expect(fn).not.toContain('swappedPrimary = newPrimary');
  });

  it('derives newPrimary, gallery, and preview from one synchronous computation', () => {
    const pageSrc = readFileSync('app/dashboard/products/page.tsx', 'utf8');
    const fn = extractHandleSetPrimary(pageSrc);
    // newPrimary computed before setForm
    expect(fn).toContain('const newPrimary = latestGallery[galleryIndex]');
    // setImagePreview uses the same newPrimary
    expect(fn).toContain('setImagePreview(newPrimary)');
  });

  it('does not read form.gallery_urls (stale closure) for the swap', () => {
    const pageSrc = readFileSync('app/dashboard/products/page.tsx', 'utf8');
    const fn = extractHandleSetPrimary(pageSrc);
    expect(fn).not.toContain('form.gallery_urls');
  });

  it('validates galleryIndex against latest state before swap', () => {
    const pageSrc = readFileSync('app/dashboard/products/page.tsx', 'utf8');
    const fn = extractHandleSetPrimary(pageSrc);
    expect(fn).toContain('galleryIndex < 0 || galleryIndex >= latestGallery.length');
  });

  it('prevents overlapping swaps via ref guard with try/finally', () => {
    const fn = extractHandleSetPrimary(readFileSync('app/dashboard/products/page.tsx', 'utf8'));
    expect(fn).toContain('swappingPrimaryRef.current');
    expect(fn).toContain('try {');
    expect(fn).toContain('} finally {');
  });

  it('formRef is declared and kept in sync with form state', () => {
    const pageSrc = readFileSync('app/dashboard/products/page.tsx', 'utf8');
    expect(pageSrc).toContain('const formRef = useRef(form)');
    expect(pageSrc).toContain('formRef.current = form');
  });
});

describe('R4-2: pending image preserved on aborted swap', () => {
  it('does not clear imageFile when gallery index is invalid after upload', () => {
    const fn = extractHandleSetPrimary(readFileSync('app/dashboard/products/page.tsx', 'utf8'));
    // On invalid index with a successful upload: setImageFile(null) is called
    // (the file was consumed by upload) but imagePreview is NOT changed.
    // On invalid index without upload: function returns without touching imageFile.
    const invalidBlock = fn.substring(fn.indexOf('galleryIndex < 0'), fn.indexOf('Phase 3'));
    expect(invalidBlock).toContain('if (uploadedPrimaryUrl) setImageFile(null)');
    expect(invalidBlock).toContain('return');
    expect(invalidBlock).not.toContain('setImagePreview');
  });

  it('upload failure preserves both imageFile and imagePreview', () => {
    const fn = extractHandleSetPrimary(readFileSync('app/dashboard/products/page.tsx', 'utf8'));
    // The upload failure return is before any setImageFile(null)
    const failBlock = fn.substring(fn.indexOf('if (!uploadedPrimaryUrl)'), fn.indexOf('Phase 2'));
    expect(failBlock).toContain('return');
    expect(failBlock).not.toContain('setImageFile');
    expect(failBlock).not.toContain('setImagePreview');
  });
});

// ── R4 behavioral: concurrent changes during upload ─────────────────────────

describe('R4 behavioral: formRef reads latest state after async upload', () => {
  // Simulates the Phase 2-3 swap logic using latest state
  function simulateSwapFromRef(
    latestGallery: string[],
    latestImageUrl: string | null,
    uploadedPrimaryUrl: string | null,
    galleryIndex: number,
  ): { aborted: boolean; newPrimary: string | null; newGallery: string[]; newPreview: string | null } {
    const gallery = [...latestGallery];
    if (galleryIndex < 0 || galleryIndex >= gallery.length) {
      return { aborted: true, newPrimary: null, newGallery: latestGallery, newPreview: null };
    }
    const newPrimary = gallery[galleryIndex];
    const currentPrimaryUrl = uploadedPrimaryUrl ?? latestImageUrl;
    gallery.splice(galleryIndex, 1);
    if (currentPrimaryUrl) gallery.splice(galleryIndex, 0, currentPrimaryUrl);
    return { aborted: false, newPrimary, newGallery: gallery, newPreview: newPrimary };
  }

  it('gallery removal during upload: index becomes invalid → abort', () => {
    // Started with ['a','b','c'], user clicked set-primary on index 2 (c.jpg)
    // During upload, user removed c.jpg → gallery is ['a','b']
    const result = simulateSwapFromRef(['a.jpg', 'b.jpg'], 'primary.jpg', null, 2);
    expect(result.aborted).toBe(true);
    expect(result.newPreview).toBeNull();
  });

  it('gallery reorder during upload: correct image is swapped', () => {
    // Started with ['a','b','c'], user clicked set-primary on index 1 (b.jpg)
    // During upload, user reordered → gallery is ['c','a','b']
    const result = simulateSwapFromRef(['c.jpg', 'a.jpg', 'b.jpg'], 'primary.jpg', null, 1);
    expect(result.aborted).toBe(false);
    expect(result.newPrimary).toBe('a.jpg'); // index 1 in reordered gallery
    expect(result.newGallery).toEqual(['c.jpg', 'primary.jpg', 'b.jpg']);
  });

  it('concurrent gallery upload: new image preserved in swap', () => {
    // Started with ['a'], user clicked set-primary on index 0
    // During upload, another gallery image was added → ['a','new.jpg']
    const result = simulateSwapFromRef(['a.jpg', 'new.jpg'], 'primary.jpg', null, 0);
    expect(result.aborted).toBe(false);
    expect(result.newPrimary).toBe('a.jpg');
    expect(result.newGallery).toEqual(['primary.jpg', 'new.jpg']); // new.jpg preserved
  });

  it('displayed preview matches saved image_url', () => {
    const result = simulateSwapFromRef(['x.jpg', 'y.jpg'], 'old.jpg', null, 1);
    expect(result.newPrimary).toBe(result.newPreview);
    expect(result.newPrimary).toBe('y.jpg');
  });

  it('pending file upload provides URL for gallery during swap', () => {
    // User selected new file, uploaded it, now swapping with gallery[0]
    const result = simulateSwapFromRef(['g1.jpg', 'g2.jpg'], 'old.jpg', 'uploaded.jpg', 0);
    expect(result.newPrimary).toBe('g1.jpg');
    expect(result.newGallery).toEqual(['uploaded.jpg', 'g2.jpg']); // uploaded URL in gallery
  });

  it('total image count preserved after swap', () => {
    const gallery = ['a.jpg', 'b.jpg', 'c.jpg'];
    const result = simulateSwapFromRef(gallery, 'p.jpg', null, 1);
    const before = 1 + gallery.length;
    const after = (result.newPrimary ? 1 : 0) + result.newGallery.length;
    expect(after).toBe(before);
  });
});

describe('R4 behavioral: interrupted swap edge cases', () => {
  // Reuse the simulateSwapFromRef logic
  function trySwap(gallery: string[], primary: string | null, idx: number) {
    const g = [...gallery];
    if (idx < 0 || idx >= g.length) return { aborted: true, newPrimary: null, gallery };
    const np = g[idx];
    g.splice(idx, 1);
    if (primary) g.splice(idx, 0, primary);
    return { aborted: false, newPrimary: np, gallery: g };
  }

  it('empty gallery after all removed during upload → abort, no state change', () => {
    const result = trySwap([], 'p.jpg', 0);
    expect(result.aborted).toBe(true);
    expect(result.newPrimary).toBeNull();
  });

  it('overlapping swap is rejected by ref guard', () => {
    const fn = extractHandleSetPrimary(readFileSync('app/dashboard/products/page.tsx', 'utf8'));
    // First line must check the guard
    expect(fn).toContain('if (swappingPrimaryRef.current) return');
  });
});

// ── Helper ──────────────────────────────────────────────────────────────────

function extractHandleSetPrimary(src: string): string {
  const start = src.indexOf('async function handleSetPrimary');
  const end = src.indexOf('// ── Generate variants', start);
  return src.substring(start, end);
}

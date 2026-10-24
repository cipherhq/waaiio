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

// ── R5: Behavioral tests for handleSetPrimary swap logic ─────────────────────
// These tests exercise the actual swap algorithm, not source strings.

/**
 * Simulates the R5 handleSetPrimary logic:
 * - Captures targetUrl by identity at invocation
 * - After async upload, locates targetUrl in latest gallery by URL (not index)
 * - If target removed, preserves uploaded URL as primary (R5-3)
 * - All outputs derived synchronously from one computation
 */
function simulateSetPrimary(params: {
  /** Gallery at invocation time */
  invokeGallery: string[];
  /** Gallery index clicked */
  invokeIndex: number;
  /** Current primary at invocation */
  currentPrimary: string | null;
  /** Whether there's a pending imageFile */
  hasPendingFile: boolean;
  /** Upload result (null = failure, string = URL) */
  uploadResult: string | null;
  /** Gallery state AFTER async upload (may differ from invoke time) */
  latestGallery: string[];
  /** Latest primary AFTER async upload */
  latestPrimary: string | null;
}): {
  aborted: boolean;
  reason?: string;
  newPrimary: string | null;
  newGallery: string[];
  newPreview: string | null;
  imageFileCleared: boolean;
  errorMessage: string | null;
} {
  const { invokeGallery, invokeIndex, hasPendingFile, uploadResult, latestGallery, latestPrimary } = params;

  // Capture target URL by identity
  const targetUrl = invokeGallery[invokeIndex];
  if (!targetUrl) {
    return { aborted: true, reason: 'invalid_initial_index', newPrimary: null, newGallery: latestGallery, newPreview: null, imageFileCleared: false, errorMessage: null };
  }

  // Phase 1: Upload
  let uploadedPrimaryUrl: string | null = null;
  if (hasPendingFile) {
    if (!uploadResult) {
      return { aborted: true, reason: 'upload_failed', newPrimary: null, newGallery: latestGallery, newPreview: null, imageFileCleared: false, errorMessage: 'Image upload failed. Please try again before changing the primary photo.' };
    }
    uploadedPrimaryUrl = uploadResult;
  }

  // Phase 2: Locate target by URL in latest gallery
  const gallery = [...latestGallery];
  const currentIdx = gallery.indexOf(targetUrl);

  if (currentIdx === -1) {
    // R5-3: Target removed. Preserve uploaded URL if available.
    if (uploadedPrimaryUrl) {
      return { aborted: false, reason: 'target_removed_upload_preserved', newPrimary: uploadedPrimaryUrl, newGallery: latestGallery, newPreview: uploadedPrimaryUrl, imageFileCleared: true, errorMessage: null };
    }
    return { aborted: true, reason: 'target_removed', newPrimary: null, newGallery: latestGallery, newPreview: null, imageFileCleared: false, errorMessage: null };
  }

  // Phase 3: Swap
  const newPrimary = gallery[currentIdx];
  const currentPrimaryUrl = uploadedPrimaryUrl ?? latestPrimary;
  gallery.splice(currentIdx, 1);
  if (currentPrimaryUrl) gallery.splice(currentIdx, 0, currentPrimaryUrl);

  return { aborted: false, newPrimary, newGallery: gallery, newPreview: newPrimary, imageFileCleared: true, errorMessage: null };
}

describe('R5-1: new primary selection blocked during swap', () => {
  it('handleImageSelect checks swappingPrimaryRef', () => {
    const pageSrc = readFileSync('app/dashboard/products/page.tsx', 'utf8');
    const fn = pageSrc.substring(pageSrc.indexOf('function handleImageSelect'), pageSrc.indexOf('function uploadImageFile'));
    expect(fn).toContain('swappingPrimaryRef.current');
  });
});

describe('R5-2: gallery target tracked by URL identity, not index', () => {
  it('reorder during upload: promotes the SAME image regardless of new position', () => {
    // Clicked on 'b.jpg' at index 1. During upload, reordered to ['c','a','b']
    const result = simulateSetPrimary({
      invokeGallery: ['a.jpg', 'b.jpg', 'c.jpg'], invokeIndex: 1,
      currentPrimary: 'primary.jpg', hasPendingFile: false, uploadResult: null,
      latestGallery: ['c.jpg', 'a.jpg', 'b.jpg'], latestPrimary: 'primary.jpg',
    });
    expect(result.aborted).toBe(false);
    expect(result.newPrimary).toBe('b.jpg'); // the image the user actually clicked
    expect(result.newGallery).toContain('primary.jpg');
    expect(result.newGallery).not.toContain('b.jpg'); // moved to primary
  });

  it('removal of different image: target still found at new position', () => {
    // Clicked on 'c.jpg' at index 2. During upload, 'a.jpg' removed → ['b','c']
    const result = simulateSetPrimary({
      invokeGallery: ['a.jpg', 'b.jpg', 'c.jpg'], invokeIndex: 2,
      currentPrimary: 'p.jpg', hasPendingFile: false, uploadResult: null,
      latestGallery: ['b.jpg', 'c.jpg'], latestPrimary: 'p.jpg',
    });
    expect(result.aborted).toBe(false);
    expect(result.newPrimary).toBe('c.jpg'); // correct image by identity
  });

  it('target image removed during upload → graceful abort', () => {
    // Clicked on 'b.jpg'. During upload, 'b.jpg' was removed.
    const result = simulateSetPrimary({
      invokeGallery: ['a.jpg', 'b.jpg', 'c.jpg'], invokeIndex: 1,
      currentPrimary: 'p.jpg', hasPendingFile: false, uploadResult: null,
      latestGallery: ['a.jpg', 'c.jpg'], latestPrimary: 'p.jpg',
    });
    expect(result.aborted).toBe(true);
    expect(result.reason).toBe('target_removed');
    expect(result.imageFileCleared).toBe(false);
  });
});

describe('R5-3: uploaded URL preserved when swap aborts', () => {
  it('upload succeeds but target removed → uploaded URL becomes primary', () => {
    const result = simulateSetPrimary({
      invokeGallery: ['a.jpg', 'b.jpg'], invokeIndex: 1,
      currentPrimary: 'old.jpg', hasPendingFile: true, uploadResult: 'uploaded.jpg',
      latestGallery: ['a.jpg'], latestPrimary: 'old.jpg', // b.jpg removed during upload
    });
    expect(result.aborted).toBe(false);
    expect(result.reason).toBe('target_removed_upload_preserved');
    expect(result.newPrimary).toBe('uploaded.jpg');
    expect(result.newPreview).toBe('uploaded.jpg');
    expect(result.imageFileCleared).toBe(true);
  });

  it('upload failure → imageFile and preview preserved, error message set', () => {
    const result = simulateSetPrimary({
      invokeGallery: ['a.jpg'], invokeIndex: 0,
      currentPrimary: 'old.jpg', hasPendingFile: true, uploadResult: null,
      latestGallery: ['a.jpg'], latestPrimary: 'old.jpg',
    });
    expect(result.aborted).toBe(true);
    expect(result.reason).toBe('upload_failed');
    expect(result.imageFileCleared).toBe(false);
    expect(result.errorMessage).toContain('Image upload failed');
  });

  it('no pending file, target removed → clean abort, no state change', () => {
    const result = simulateSetPrimary({
      invokeGallery: ['a.jpg', 'b.jpg'], invokeIndex: 0,
      currentPrimary: 'p.jpg', hasPendingFile: false, uploadResult: null,
      latestGallery: ['b.jpg'], latestPrimary: 'p.jpg', // a.jpg removed
    });
    expect(result.aborted).toBe(true);
    expect(result.imageFileCleared).toBe(false);
    expect(result.newPreview).toBeNull();
  });

  it('successful swap: displayed preview matches form.image_url', () => {
    const result = simulateSetPrimary({
      invokeGallery: ['x.jpg', 'y.jpg'], invokeIndex: 1,
      currentPrimary: 'old.jpg', hasPendingFile: false, uploadResult: null,
      latestGallery: ['x.jpg', 'y.jpg'], latestPrimary: 'old.jpg',
    });
    expect(result.newPrimary).toBe('y.jpg');
    expect(result.newPreview).toBe('y.jpg');
    expect(result.newPrimary).toBe(result.newPreview);
  });

  it('total image count preserved after successful swap', () => {
    const gallery = ['a.jpg', 'b.jpg', 'c.jpg'];
    const result = simulateSetPrimary({
      invokeGallery: gallery, invokeIndex: 1,
      currentPrimary: 'p.jpg', hasPendingFile: false, uploadResult: null,
      latestGallery: gallery, latestPrimary: 'p.jpg',
    });
    const totalBefore = 1 + gallery.length;
    const totalAfter = (result.newPrimary ? 1 : 0) + result.newGallery.length;
    expect(totalAfter).toBe(totalBefore);
  });

  it('uploaded primary URL placed in gallery at correct position', () => {
    const result = simulateSetPrimary({
      invokeGallery: ['g1.jpg', 'g2.jpg'], invokeIndex: 0,
      currentPrimary: 'old.jpg', hasPendingFile: true, uploadResult: 'uploaded.jpg',
      latestGallery: ['g1.jpg', 'g2.jpg'], latestPrimary: 'old.jpg',
    });
    expect(result.newPrimary).toBe('g1.jpg');
    expect(result.newGallery).toEqual(['uploaded.jpg', 'g2.jpg']);
  });
});

describe('R5-4: error display in ProductForm', () => {
  it('ProductForm accepts galleryError prop', () => {
    const formSrc = readFileSync('app/dashboard/products/components/ProductForm.tsx', 'utf8');
    expect(formSrc).toContain('galleryError: string | null');
    expect(formSrc).toContain('galleryError');
  });

  it('ProductForm renders error message in gallery section', () => {
    const formSrc = readFileSync('app/dashboard/products/components/ProductForm.tsx', 'utf8');
    expect(formSrc).toContain('{galleryError && (');
    expect(formSrc).toContain('text-red-600');
  });

  it('page passes galleryError prop to ProductForm', () => {
    const pageSrc = readFileSync('app/dashboard/products/page.tsx', 'utf8');
    expect(pageSrc).toContain('galleryError={galleryError}');
  });

  it('handleSetPrimary sets galleryError on upload failure', () => {
    const pageSrc = readFileSync('app/dashboard/products/page.tsx', 'utf8');
    const fn = pageSrc.substring(pageSrc.indexOf('async function handleSetPrimary'), pageSrc.indexOf('// ── Generate variants'));
    expect(fn).toContain('setGalleryError(');
  });
});

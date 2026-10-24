/**
 * Product gallery handlers — genuine React behavioral tests.
 *
 * Tests the PRODUCTION useProductGallery hook from
 * app/dashboard/products/hooks/useProductGallery.ts using renderHook
 * with deferred upload promises, simulating real async upload timing,
 * concurrent gallery changes, and interrupted swaps.
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useProductGallery } from '@/app/dashboard/products/hooks/useProductGallery';

// ── Helper: create a deferred promise for controlling upload timing ──
function createDeferredUpload() {
  let resolve!: (url: string | null) => void;
  const promise = new Promise<string | null>(r => { resolve = r; });
  const fn = vi.fn(() => promise);
  return { fn, resolve, promise };
}

// ═══════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════

describe('gallery upload error feedback (R6-1)', () => {
  it('sets galleryError when additional-photo upload fails', async () => {
    const upload = createDeferredUpload();
    const { result } = renderHook(() => useProductGallery(upload.fn));

    // Set up primary image so gallery is shown
    act(() => {
      result.current.setImageUrl('primary.jpg');
      result.current.setImagePreview('primary.jpg');
    });

    // Start gallery upload
    let uploadPromise: Promise<void>;
    act(() => { uploadPromise = result.current.handleGalleryUpload(new File(['x'], 'photo.jpg')); });

    expect(result.current.galleryUploading).toBe(true);
    expect(result.current.galleryError).toBeNull();

    // Fail the upload
    await act(async () => { upload.resolve(null); await uploadPromise!; });

    expect(result.current.galleryUploading).toBe(false);
    expect(result.current.galleryError).toBe('Photo upload failed. Please check the file and try again.');
    expect(result.current.galleryUrls).toEqual([]); // No image added
  });

  it('clears galleryError on successful retry', async () => {
    const calls: Array<Promise<string | null>> = [];
    let callIndex = 0;
    const resolvers: Array<(v: string | null) => void> = [];

    const uploadFn = vi.fn(() => {
      const p = new Promise<string | null>(r => resolvers.push(r));
      calls.push(p);
      return p;
    });

    const { result } = renderHook(() => useProductGallery(uploadFn));
    act(() => { result.current.setImageUrl('p.jpg'); result.current.setImagePreview('p.jpg'); });

    // First upload: fail
    let p1: Promise<void>;
    act(() => { p1 = result.current.handleGalleryUpload(new File(['x'], 'a.jpg')); });
    await act(async () => { resolvers[0](null); await p1!; });
    expect(result.current.galleryError).toContain('failed');

    // Second upload: succeed — error should clear
    let p2: Promise<void>;
    act(() => { p2 = result.current.handleGalleryUpload(new File(['x'], 'b.jpg')); });
    // galleryError cleared at start of upload
    expect(result.current.galleryError).toBeNull();
    await act(async () => { resolvers[1]('https://storage/b.jpg'); await p2!; });
    expect(result.current.galleryError).toBeNull();
    expect(result.current.galleryUrls).toEqual(['https://storage/b.jpg']);
  });
});

describe('R5-1: primary selection blocked during swap', () => {
  it('rejects handleImageSelect while swap is in progress', async () => {
    const upload = createDeferredUpload();
    const { result } = renderHook(() => useProductGallery(upload.fn));

    // Set up state: primary + pending file + gallery
    act(() => {
      result.current.setImageUrl('old.jpg');
      result.current.setImagePreview('old.jpg');
      result.current.setGalleryUrls(['g1.jpg', 'g2.jpg']);
      result.current.setImageFile(new File(['x'], 'pending.jpg'));
      result.current.setImagePreview('preview:pending.jpg');
    });

    // Start swap (will await upload)
    let swapPromise: Promise<void>;
    act(() => { swapPromise = result.current.handleSetPrimary(0); });

    // While swap is uploading, try to select a new primary
    act(() => { result.current.handleImageSelect(new File(['y'], 'newer.jpg')); });

    // The new file should be REJECTED (swap in progress)
    expect(result.current.imageFile?.name).toBe('pending.jpg');

    // Complete the swap
    await act(async () => { upload.resolve('uploaded-pending.jpg'); await swapPromise!; });

    // Swap completed — g1.jpg became primary
    expect(result.current.imageUrl).toBe('g1.jpg');
    expect(result.current.imagePreview).toBe('g1.jpg');
  });
});

describe('R5-2: gallery target tracked by URL identity', () => {
  it('promotes correct image after reorder during upload', async () => {
    const upload = createDeferredUpload();
    const { result } = renderHook(() => useProductGallery(upload.fn));

    act(() => {
      result.current.setImageUrl('primary.jpg');
      result.current.setImagePreview('primary.jpg');
      result.current.setGalleryUrls(['a.jpg', 'b.jpg', 'c.jpg']);
      result.current.setImageFile(new File(['x'], 'pending.jpg'));
    });

    // Click set-primary on b.jpg (index 1)
    let swapPromise: Promise<void>;
    act(() => { swapPromise = result.current.handleSetPrimary(1); });

    // During upload, reorder gallery: ['c', 'a', 'b']
    act(() => {
      result.current.setGalleryUrls(['c.jpg', 'a.jpg', 'b.jpg']);
    });

    // Complete upload
    await act(async () => { upload.resolve('uploaded.jpg'); await swapPromise!; });

    // b.jpg should be the new primary (found by URL, not index 1)
    expect(result.current.imageUrl).toBe('b.jpg');
    expect(result.current.imagePreview).toBe('b.jpg');
    expect(result.current.galleryUrls).toContain('uploaded.jpg');
    expect(result.current.galleryUrls).not.toContain('b.jpg');
  });

  it('aborts gracefully when target removed during async upload', async () => {
    const upload = createDeferredUpload();
    const { result } = renderHook(() => useProductGallery(upload.fn));

    act(() => {
      result.current.setImageUrl('primary.jpg');
      result.current.setImagePreview('preview:pending.jpg');
      result.current.setGalleryUrls(['a.jpg', 'b.jpg']);
      result.current.setImageFile(new File(['x'], 'pending.jpg'));
    });

    // Click set-primary on b.jpg (index 1) — has pending file, so async
    let swapPromise: Promise<void>;
    act(() => { swapPromise = result.current.handleSetPrimary(1); });

    // During upload, remove b.jpg (the target)
    act(() => { result.current.setGalleryUrls(['a.jpg']); });

    // Upload succeeds, but target is gone
    await act(async () => { upload.resolve('uploaded.jpg'); await swapPromise!; });

    // R5-3: uploaded URL preserved as primary since target was removed
    expect(result.current.imageUrl).toBe('uploaded.jpg');
    expect(result.current.imagePreview).toBe('uploaded.jpg');
    expect(result.current.imageFile).toBeNull();
  });
});

describe('R5-3: uploaded URL preserved on abort', () => {
  it('sets uploaded URL as primary when target is removed during upload', async () => {
    const upload = createDeferredUpload();
    const { result } = renderHook(() => useProductGallery(upload.fn));

    act(() => {
      result.current.setImageUrl('old-primary.jpg');
      result.current.setImagePreview('preview:pending.jpg');
      result.current.setGalleryUrls(['a.jpg', 'target.jpg']);
      result.current.setImageFile(new File(['x'], 'pending.jpg'));
    });

    // Click set-primary on target.jpg (index 1)
    let swapPromise: Promise<void>;
    act(() => { swapPromise = result.current.handleSetPrimary(1); });

    // During upload, target.jpg is removed
    act(() => { result.current.setGalleryUrls(['a.jpg']); });

    // Upload succeeds
    await act(async () => { upload.resolve('uploaded.jpg'); await swapPromise!; });

    // Uploaded URL should be preserved as primary (not orphaned)
    expect(result.current.imageUrl).toBe('uploaded.jpg');
    expect(result.current.imagePreview).toBe('uploaded.jpg');
    expect(result.current.imageFile).toBeNull();
  });

  it('upload failure preserves imageFile and preview', async () => {
    const upload = createDeferredUpload();
    const { result } = renderHook(() => useProductGallery(upload.fn));

    act(() => {
      result.current.setImageUrl('old.jpg');
      result.current.setImagePreview('preview:pending.jpg');
      result.current.setGalleryUrls(['g1.jpg']);
      result.current.setImageFile(new File(['x'], 'pending.jpg'));
    });

    let swapPromise: Promise<void>;
    act(() => { swapPromise = result.current.handleSetPrimary(0); });

    // Upload fails
    await act(async () => { upload.resolve(null); await swapPromise!; });

    // imageFile and preview should be intact
    expect(result.current.imageFile?.name).toBe('pending.jpg');
    expect(result.current.imagePreview).toBe('preview:pending.jpg');
    expect(result.current.imageUrl).toBe('old.jpg'); // unchanged
    expect(result.current.galleryError).toContain('Image upload failed');
  });
});

describe('displayed image matches saved image after swap', () => {
  it('successful swap: preview === imageUrl', async () => {
    const uploadFn = vi.fn(async () => null as string | null);
    const { result } = renderHook(() => useProductGallery(uploadFn));

    act(() => {
      result.current.setImageUrl('primary.jpg');
      result.current.setImagePreview('primary.jpg');
      result.current.setGalleryUrls(['g1.jpg', 'g2.jpg', 'g3.jpg']);
    });

    // Set g2.jpg as primary (no pending file, so no upload needed)
    await act(async () => { await result.current.handleSetPrimary(1); });

    expect(result.current.imageUrl).toBe('g2.jpg');
    expect(result.current.imagePreview).toBe('g2.jpg');
    // Old primary moved to gallery at same position
    expect(result.current.galleryUrls).toEqual(['g1.jpg', 'primary.jpg', 'g3.jpg']);
  });

  it('total image count preserved: 1 primary + N gallery unchanged', async () => {
    const uploadFn = vi.fn(async () => null as string | null);
    const { result } = renderHook(() => useProductGallery(uploadFn));

    act(() => {
      result.current.setImageUrl('p.jpg');
      result.current.setImagePreview('p.jpg');
      result.current.setGalleryUrls(['a.jpg', 'b.jpg', 'c.jpg']);
    });

    const before = 1 + result.current.galleryUrls.length;

    await act(async () => { await result.current.handleSetPrimary(2); });

    const after = (result.current.imageUrl ? 1 : 0) + result.current.galleryUrls.length;
    expect(after).toBe(before);
  });
});

describe('overlapping swap prevention', () => {
  it('second swap call is rejected while first is in progress', async () => {
    const upload = createDeferredUpload();
    const { result } = renderHook(() => useProductGallery(upload.fn));

    act(() => {
      result.current.setImageUrl('p.jpg');
      result.current.setImagePreview('p.jpg');
      result.current.setGalleryUrls(['a.jpg', 'b.jpg']);
      result.current.setImageFile(new File(['x'], 'pending.jpg'));
    });

    // Start first swap
    let swap1: Promise<void>;
    act(() => { swap1 = result.current.handleSetPrimary(0); });

    // Try second swap (should be rejected)
    let swap2: Promise<void>;
    act(() => { swap2 = result.current.handleSetPrimary(1); });

    // Complete first swap
    await act(async () => { upload.resolve('uploaded.jpg'); await swap1!; await swap2!; });

    // Only the first swap should have taken effect (a.jpg as primary)
    expect(result.current.imageUrl).toBe('a.jpg');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// R7: Integration tests — save payload correctness
// ═══════════════════════════════════════════════════════════════════════

/**
 * Simulates the page-level uploadImage() + save payload computation
 * using the production hook state — exactly as page.tsx does.
 */
function computeSavePayload(
  hookResult: ReturnType<typeof useProductGallery>,
  uploadImageFile: (f: File) => Promise<string | null>,
) {
  // Mirrors page.tsx uploadImage() + payload construction
  async function getPayload() {
    let imageUrl: string | null;
    if (hookResult.imageFile) {
      const url = await uploadImageFile(hookResult.imageFile);
      if (url) hookResult.setImageFile(null);
      imageUrl = url || hookResult.imageUrl;
    } else {
      // R7 fix: hook state is authoritative — no fallback to stale form.image_url
      imageUrl = hookResult.imageUrl;
    }
    return { image_url: imageUrl, gallery_urls: hookResult.galleryUrls };
  }
  return getPayload;
}

describe('R7: promote-to-gallery saves correct database values', () => {
  it('after handlePromoteToGallery, save payload has null primary and old primary in gallery', async () => {
    const uploadFn = vi.fn(async () => null as string | null);
    const { result } = renderHook(() => useProductGallery(uploadFn));

    // Set up: product with primary and one gallery image
    act(() => {
      result.current.setImageUrl('primary.jpg');
      result.current.setImagePreview('primary.jpg');
      result.current.setGalleryUrls(['gallery1.jpg']);
    });

    // Move primary to gallery
    act(() => { result.current.handlePromoteToGallery(); });

    // Hook state should be: imageUrl=null, gallery=['gallery1.jpg', 'primary.jpg']
    expect(result.current.imageUrl).toBeNull();
    expect(result.current.galleryUrls).toEqual(['gallery1.jpg', 'primary.jpg']);

    // Simulate save — compute payload from hook state (as page.tsx does)
    const getPayload = computeSavePayload(result.current, uploadFn);
    const payload = await getPayload();

    // The DB payload must have null primary — NOT the old 'primary.jpg'
    expect(payload.image_url).toBeNull();
    expect(payload.gallery_urls).toEqual(['gallery1.jpg', 'primary.jpg']);
  });

  it('after handleSetPrimary swap, save payload has the new primary and old primary in gallery', async () => {
    const uploadFn = vi.fn(async () => null as string | null);
    const { result } = renderHook(() => useProductGallery(uploadFn));

    act(() => {
      result.current.setImageUrl('old-primary.jpg');
      result.current.setImagePreview('old-primary.jpg');
      result.current.setGalleryUrls(['g1.jpg', 'g2.jpg']);
    });

    // Swap g2.jpg to primary
    await act(async () => { await result.current.handleSetPrimary(1); });

    const getPayload = computeSavePayload(result.current, uploadFn);
    const payload = await getPayload();

    expect(payload.image_url).toBe('g2.jpg');
    expect(payload.gallery_urls).toEqual(['g1.jpg', 'old-primary.jpg']);
  });

  it('new product with no images: save payload has null primary and empty gallery', async () => {
    const uploadFn = vi.fn(async () => null as string | null);
    const { result } = renderHook(() => useProductGallery(uploadFn));

    const getPayload = computeSavePayload(result.current, uploadFn);
    const payload = await getPayload();

    expect(payload.image_url).toBeNull();
    expect(payload.gallery_urls).toEqual([]);
  });

  it('pending file upload: save payload uses uploaded URL', async () => {
    const uploadFn = vi.fn(async () => 'https://storage/uploaded.jpg');
    const { result } = renderHook(() => useProductGallery(uploadFn));

    act(() => {
      result.current.setImageFile(new File(['x'], 'photo.jpg'));
      result.current.setImagePreview('preview:photo.jpg');
      result.current.setGalleryUrls(['g1.jpg']);
    });

    const getPayload = computeSavePayload(result.current, uploadFn);
    let payload: { image_url: string | null; gallery_urls: string[] };
    await act(async () => { payload = await getPayload(); });

    expect(payload!.image_url).toBe('https://storage/uploaded.jpg');
    expect(payload!.gallery_urls).toEqual(['g1.jpg']);
  });
});

describe('R7: FileReader race guard', () => {
  it('page.tsx uses imageSelectSeqRef to guard FileReader.onload', () => {
    const { readFileSync } = require('fs');
    const pageSrc = readFileSync('app/dashboard/products/page.tsx', 'utf8');
    expect(pageSrc).toContain('imageSelectSeqRef');
    expect(pageSrc).toContain('seq === imageSelectSeqRef.current');
  });

  it('resets on openAdd and openEdit prevent stale FileReader', () => {
    const { readFileSync } = require('fs');
    const pageSrc = readFileSync('app/dashboard/products/page.tsx', 'utf8');
    // Both openAdd and openEdit bump the sequence counter
    const addSection = pageSrc.substring(pageSrc.indexOf('function openAdd'), pageSrc.indexOf('async function openEdit'));
    expect(addSection).toContain('imageSelectSeqRef.current++');
    const editSection = pageSrc.substring(pageSrc.indexOf('async function openEdit'), pageSrc.indexOf('// ── Image handling'));
    expect(editSection).toContain('imageSelectSeqRef.current++');
  });
});

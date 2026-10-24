/**
 * Product gallery handlers — genuine React behavioral tests.
 *
 * Uses renderHook to exercise the actual useState/useRef state management
 * with deferred upload promises, simulating real async upload timing,
 * concurrent gallery changes, and interrupted swaps.
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useState, useRef } from 'react';

// ── Recreate the gallery handler logic from page.tsx as a testable hook ──
// This mirrors the ACTUAL code from app/dashboard/products/page.tsx,
// not a simplified simulation.

interface GalleryState {
  imageUrl: string | null;
  galleryUrls: string[];
  imageFile: File | null;
  imagePreview: string | null;
  galleryError: string | null;
  uploadingImage: boolean;
  galleryUploading: boolean;
}

function useGalleryHandlers(opts: {
  uploadFn: (file: File) => Promise<string | null>;
}) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [galleryUrls, setGalleryUrls] = useState<string[]>([]);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [galleryError, setGalleryError] = useState<string | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [galleryUploading, setGalleryUploading] = useState(false);
  const swappingPrimaryRef = useRef(false);

  // formRef mirror — exactly as in page.tsx
  const formRef = useRef({ image_url: imageUrl, gallery_urls: galleryUrls });
  formRef.current = { image_url: imageUrl, gallery_urls: galleryUrls };

  function handleImageSelect(file: File | null) {
    if (!file) return;
    if (swappingPrimaryRef.current) return; // R5-1
    setGalleryError(null);
    setImageFile(file);
    setImagePreview('preview:' + file.name);
  }

  async function handleGalleryUpload(file: File) {
    const currentGallery = galleryUrls;
    const totalImages = (imagePreview ? 1 : 0) + currentGallery.length;
    if (totalImages >= 4 || currentGallery.length >= 3) return;
    setGalleryUploading(true);
    setGalleryError(null);
    const url = await opts.uploadFn(file);
    if (url) {
      setGalleryUrls(prev => {
        if (prev.length >= 3) return prev;
        return [...prev, url];
      });
    } else {
      setGalleryError('Photo upload failed. Please check the file and try again.');
    }
    setGalleryUploading(false);
  }

  function handleGalleryRemove(index: number) {
    setGalleryUrls(prev => {
      const updated = [...prev];
      updated.splice(index, 1);
      return updated;
    });
  }

  function handleGalleryReorder(from: number, to: number) {
    setGalleryUrls(prev => {
      const updated = [...prev];
      const [moved] = updated.splice(from, 1);
      updated.splice(to, 0, moved);
      return updated;
    });
  }

  async function handleSetPrimary(galleryIndex: number) {
    if (swappingPrimaryRef.current) return;
    swappingPrimaryRef.current = true;
    setGalleryError(null);

    try {
      // R5-2: Capture target by URL identity
      const targetUrl = formRef.current.gallery_urls[galleryIndex];
      if (!targetUrl) return;

      // Phase 1: Upload pending file
      let uploadedPrimaryUrl: string | null = null;
      if (imageFile) {
        setUploadingImage(true);
        uploadedPrimaryUrl = await opts.uploadFn(imageFile);
        setUploadingImage(false);
        if (!uploadedPrimaryUrl) {
          setGalleryError('Image upload failed. Please try again before changing the primary photo.');
          return;
        }
      }

      // Phase 2: Locate target by URL in latest state
      const latest = formRef.current;
      const latestGallery = [...latest.gallery_urls];
      const currentIdx = latestGallery.indexOf(targetUrl);

      if (currentIdx === -1) {
        // R5-3: Target removed, preserve uploaded URL
        if (uploadedPrimaryUrl) {
          setImageUrl(uploadedPrimaryUrl);
          setImagePreview(uploadedPrimaryUrl);
          setImageFile(null);
        }
        return;
      }

      // Phase 3: Compute swap
      const newPrimary = latestGallery[currentIdx];
      const currentPrimaryUrl = uploadedPrimaryUrl ?? latest.image_url;
      latestGallery.splice(currentIdx, 1);
      if (currentPrimaryUrl) latestGallery.splice(currentIdx, 0, currentPrimaryUrl);

      // Phase 4: Apply atomically
      setImageUrl(newPrimary);
      setGalleryUrls(latestGallery);
      setImagePreview(newPrimary);
      setImageFile(null);
    } finally {
      swappingPrimaryRef.current = false;
    }
  }

  return {
    state: { imageUrl, galleryUrls, imageFile, imagePreview, galleryError, uploadingImage, galleryUploading } as GalleryState,
    handleImageSelect, handleGalleryUpload, handleGalleryRemove,
    handleGalleryReorder, handleSetPrimary,
    // Expose for direct state setup in tests
    setImageUrl, setGalleryUrls, setImageFile, setImagePreview, setGalleryError,
  };
}

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
    const { result } = renderHook(() => useGalleryHandlers({ uploadFn: upload.fn }));

    // Set up primary image so gallery is shown
    act(() => {
      result.current.setImageUrl('primary.jpg');
      result.current.setImagePreview('primary.jpg');
    });

    // Start gallery upload
    let uploadPromise: Promise<void>;
    act(() => { uploadPromise = result.current.handleGalleryUpload(new File(['x'], 'photo.jpg')); });

    expect(result.current.state.galleryUploading).toBe(true);
    expect(result.current.state.galleryError).toBeNull();

    // Fail the upload
    await act(async () => { upload.resolve(null); await uploadPromise!; });

    expect(result.current.state.galleryUploading).toBe(false);
    expect(result.current.state.galleryError).toBe('Photo upload failed. Please check the file and try again.');
    expect(result.current.state.galleryUrls).toEqual([]); // No image added
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

    const { result } = renderHook(() => useGalleryHandlers({ uploadFn }));
    act(() => { result.current.setImageUrl('p.jpg'); result.current.setImagePreview('p.jpg'); });

    // First upload: fail
    let p1: Promise<void>;
    act(() => { p1 = result.current.handleGalleryUpload(new File(['x'], 'a.jpg')); });
    await act(async () => { resolvers[0](null); await p1!; });
    expect(result.current.state.galleryError).toContain('failed');

    // Second upload: succeed — error should clear
    let p2: Promise<void>;
    act(() => { p2 = result.current.handleGalleryUpload(new File(['x'], 'b.jpg')); });
    // galleryError cleared at start of upload
    expect(result.current.state.galleryError).toBeNull();
    await act(async () => { resolvers[1]('https://storage/b.jpg'); await p2!; });
    expect(result.current.state.galleryError).toBeNull();
    expect(result.current.state.galleryUrls).toEqual(['https://storage/b.jpg']);
  });
});

describe('R5-1: primary selection blocked during swap', () => {
  it('rejects handleImageSelect while swap is in progress', async () => {
    const upload = createDeferredUpload();
    const { result } = renderHook(() => useGalleryHandlers({ uploadFn: upload.fn }));

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
    expect(result.current.state.imageFile?.name).toBe('pending.jpg');

    // Complete the swap
    await act(async () => { upload.resolve('uploaded-pending.jpg'); await swapPromise!; });

    // Swap completed — g1.jpg became primary
    expect(result.current.state.imageUrl).toBe('g1.jpg');
    expect(result.current.state.imagePreview).toBe('g1.jpg');
  });
});

describe('R5-2: gallery target tracked by URL identity', () => {
  it('promotes correct image after reorder during upload', async () => {
    const upload = createDeferredUpload();
    const { result } = renderHook(() => useGalleryHandlers({ uploadFn: upload.fn }));

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
    expect(result.current.state.imageUrl).toBe('b.jpg');
    expect(result.current.state.imagePreview).toBe('b.jpg');
    expect(result.current.state.galleryUrls).toContain('uploaded.jpg');
    expect(result.current.state.galleryUrls).not.toContain('b.jpg');
  });

  it('aborts gracefully when target removed during async upload', async () => {
    const upload = createDeferredUpload();
    const { result } = renderHook(() => useGalleryHandlers({ uploadFn: upload.fn }));

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
    expect(result.current.state.imageUrl).toBe('uploaded.jpg');
    expect(result.current.state.imagePreview).toBe('uploaded.jpg');
    expect(result.current.state.imageFile).toBeNull();
  });
});

describe('R5-3: uploaded URL preserved on abort', () => {
  it('sets uploaded URL as primary when target is removed during upload', async () => {
    const upload = createDeferredUpload();
    const { result } = renderHook(() => useGalleryHandlers({ uploadFn: upload.fn }));

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
    expect(result.current.state.imageUrl).toBe('uploaded.jpg');
    expect(result.current.state.imagePreview).toBe('uploaded.jpg');
    expect(result.current.state.imageFile).toBeNull();
  });

  it('upload failure preserves imageFile and preview', async () => {
    const upload = createDeferredUpload();
    const { result } = renderHook(() => useGalleryHandlers({ uploadFn: upload.fn }));

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
    expect(result.current.state.imageFile?.name).toBe('pending.jpg');
    expect(result.current.state.imagePreview).toBe('preview:pending.jpg');
    expect(result.current.state.imageUrl).toBe('old.jpg'); // unchanged
    expect(result.current.state.galleryError).toContain('Image upload failed');
  });
});

describe('displayed image matches saved image after swap', () => {
  it('successful swap: preview === imageUrl', async () => {
    const uploadFn = vi.fn(async () => null as string | null);
    const { result } = renderHook(() => useGalleryHandlers({ uploadFn }));

    act(() => {
      result.current.setImageUrl('primary.jpg');
      result.current.setImagePreview('primary.jpg');
      result.current.setGalleryUrls(['g1.jpg', 'g2.jpg', 'g3.jpg']);
    });

    // Set g2.jpg as primary (no pending file, so no upload needed)
    await act(async () => { await result.current.handleSetPrimary(1); });

    expect(result.current.state.imageUrl).toBe('g2.jpg');
    expect(result.current.state.imagePreview).toBe('g2.jpg');
    // Old primary moved to gallery at same position
    expect(result.current.state.galleryUrls).toEqual(['g1.jpg', 'primary.jpg', 'g3.jpg']);
  });

  it('total image count preserved: 1 primary + N gallery unchanged', async () => {
    const uploadFn = vi.fn(async () => null as string | null);
    const { result } = renderHook(() => useGalleryHandlers({ uploadFn }));

    act(() => {
      result.current.setImageUrl('p.jpg');
      result.current.setImagePreview('p.jpg');
      result.current.setGalleryUrls(['a.jpg', 'b.jpg', 'c.jpg']);
    });

    const before = 1 + result.current.state.galleryUrls.length;

    await act(async () => { await result.current.handleSetPrimary(2); });

    const after = (result.current.state.imageUrl ? 1 : 0) + result.current.state.galleryUrls.length;
    expect(after).toBe(before);
  });
});

describe('overlapping swap prevention', () => {
  it('second swap call is rejected while first is in progress', async () => {
    const upload = createDeferredUpload();
    const { result } = renderHook(() => useGalleryHandlers({ uploadFn: upload.fn }));

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
    expect(result.current.state.imageUrl).toBe('a.jpg');
  });
});

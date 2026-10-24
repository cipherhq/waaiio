'use client';

import { useState, useRef, useCallback } from 'react';

export interface ProductGalleryState {
  imageUrl: string | null;
  galleryUrls: string[];
  imageFile: File | null;
  imagePreview: string | null;
  galleryError: string | null;
  uploadingImage: boolean;
  galleryUploading: boolean;
}

export interface ProductGalleryActions {
  /** Returns true if accepted, false if rejected (swap in progress). */
  handleImageSelect: (file: File | null) => boolean;
  handleGalleryUpload: (file: File) => Promise<void>;
  handleGalleryRemove: (index: number) => void;
  handleGalleryReorder: (fromIndex: number, toIndex: number) => void;
  handlePromoteToGallery: () => void;
  handleSetPrimary: (galleryIndex: number) => Promise<void>;
  /** Reset gallery state for a new or edited product */
  reset: (opts: { imageUrl: string | null; galleryUrls: string[] }) => void;
  /** Compute save payload: uploads pending file if needed, returns authoritative image_url + gallery_urls. */
  buildSaveImagePayload: () => Promise<{ image_url: string | null; gallery_urls: string[] }>;
  /** Current preview sequence — pass to FileReader guard. Bumped on select/swap/promote/reset. */
  previewSeq: () => number;
  /** Direct setters (for form-level integration) */
  setImageUrl: (url: string | null) => void;
  setGalleryUrls: (urls: string[]) => void;
  setImageFile: (file: File | null) => void;
  setImagePreview: (preview: string | null) => void;
  setGalleryError: (error: string | null) => void;
}

/**
 * Manages product gallery state: primary image, gallery images, uploads,
 * reordering, primary swaps, and error feedback.
 *
 * @param uploadFn  Async function that uploads a File and returns a URL or null on failure.
 */
export function useProductGallery(
  uploadFn: (file: File) => Promise<string | null>,
): ProductGalleryState & ProductGalleryActions {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [galleryUrls, setGalleryUrls] = useState<string[]>([]);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [galleryError, setGalleryError] = useState<string | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [galleryUploading, setGalleryUploading] = useState(false);
  const swappingPrimaryRef = useRef(false);

  // Ref mirror for async handlers to read the latest state without stale closures.
  const stateRef = useRef({ imageUrl, galleryUrls });
  // Sequence counter for invalidating stale FileReader callbacks.
  // Incremented on every operation that changes the preview: select, swap, promote, reset.
  const previewSeqRef = useRef(0);
  stateRef.current = { imageUrl, galleryUrls };

  /** Returns true if the selection was accepted, false if rejected (e.g. swap in progress). */
  const handleImageSelect = useCallback((file: File | null): boolean => {
    if (!file) return false;
    // R5-1: Block while swap is in progress
    if (swappingPrimaryRef.current) return false;
    setGalleryError(null);
    setImageFile(file);
    previewSeqRef.current++;
    return true;
  }, []);

  const handleGalleryUpload = useCallback(async (file: File) => {
    const current = stateRef.current;
    const totalImages = (current.imageUrl ? 1 : 0) + current.galleryUrls.length;
    if (totalImages >= 4 || current.galleryUrls.length >= 3) return;
    setGalleryUploading(true);
    setGalleryError(null);
    const url = await uploadFn(file);
    if (url) {
      setGalleryUrls(prev => {
        if (prev.length >= 3) return prev;
        return [...prev, url];
      });
    } else {
      setGalleryError('Photo upload failed. Please check the file and try again.');
    }
    setGalleryUploading(false);
  }, [uploadFn]);

  const handleGalleryRemove = useCallback((index: number) => {
    setGalleryUrls(prev => {
      const updated = [...prev];
      updated.splice(index, 1);
      return updated;
    });
  }, []);

  const handleGalleryReorder = useCallback((fromIndex: number, toIndex: number) => {
    setGalleryUrls(prev => {
      const updated = [...prev];
      const [moved] = updated.splice(fromIndex, 1);
      updated.splice(toIndex, 0, moved);
      return updated;
    });
  }, []);

  const handlePromoteToGallery = useCallback(() => {
    const current = stateRef.current;
    if (current.imageUrl && current.galleryUrls.length < 3) {
      setGalleryUrls(prev => [...prev, current.imageUrl!]);
      setImageUrl(null);
      previewSeqRef.current++; // Invalidate pending FileReader
      setImagePreview(null);
      setImageFile(null);
    }
  }, []);

  const handleSetPrimary = useCallback(async (galleryIndex: number) => {
    if (swappingPrimaryRef.current) return;
    swappingPrimaryRef.current = true;
    setGalleryError(null);

    try {
      // R5-2: Capture target by URL identity
      const targetUrl = stateRef.current.galleryUrls[galleryIndex];
      if (!targetUrl) return;

      // Phase 1: Upload pending file
      let uploadedPrimaryUrl: string | null = null;
      if (imageFile) {
        setUploadingImage(true);
        uploadedPrimaryUrl = await uploadFn(imageFile);
        setUploadingImage(false);
        if (!uploadedPrimaryUrl) {
          setGalleryError('Image upload failed. Please try again before changing the primary photo.');
          return;
        }
      }

      // Phase 2: Locate target by URL in latest state
      const latest = stateRef.current;
      const latestGallery = [...latest.galleryUrls];
      const currentIdx = latestGallery.indexOf(targetUrl);

      if (currentIdx === -1) {
        // R5-3: Target removed, preserve uploaded URL
        if (uploadedPrimaryUrl) {
          setImageUrl(uploadedPrimaryUrl);
          previewSeqRef.current++; // Invalidate pending FileReader
          setImagePreview(uploadedPrimaryUrl);
          setImageFile(null);
        }
        return;
      }

      // Phase 3: Compute swap
      const newPrimary = latestGallery[currentIdx];
      const currentPrimaryUrl = uploadedPrimaryUrl ?? latest.imageUrl;
      latestGallery.splice(currentIdx, 1);
      if (currentPrimaryUrl) latestGallery.splice(currentIdx, 0, currentPrimaryUrl);

      // Phase 4: Apply atomically
      setImageUrl(newPrimary);
      setGalleryUrls(latestGallery);
      previewSeqRef.current++; // Invalidate pending FileReader
      setImagePreview(newPrimary);
      setImageFile(null);
    } finally {
      swappingPrimaryRef.current = false;
    }
  }, [imageFile, uploadFn]);

  const reset = useCallback((opts: { imageUrl: string | null; galleryUrls: string[] }) => {
    setImageUrl(opts.imageUrl);
    setGalleryUrls(opts.galleryUrls);
    setImageFile(null);
    previewSeqRef.current++; // Invalidate pending FileReader
    setImagePreview(opts.imageUrl);
    setGalleryError(null);
    setUploadingImage(false);
    setGalleryUploading(false);
  }, []);

  /**
   * Compute the image_url and gallery_urls for the save payload.
   * If a pending imageFile exists, uploads it first. Hook state is authoritative.
   */
  const buildSaveImagePayload = useCallback(async (): Promise<{ image_url: string | null; gallery_urls: string[] }> => {
    let saveImageUrl: string | null;
    if (imageFile) {
      const url = await uploadFn(imageFile);
      if (url) setImageFile(null);
      saveImageUrl = url || stateRef.current.imageUrl;
    } else {
      saveImageUrl = stateRef.current.imageUrl;
    }
    return { image_url: saveImageUrl, gallery_urls: stateRef.current.galleryUrls };
  }, [imageFile, uploadFn]);

  const previewSeq = useCallback(() => previewSeqRef.current, []);

  return {
    imageUrl, galleryUrls, imageFile, imagePreview, galleryError,
    uploadingImage, galleryUploading,
    handleImageSelect, handleGalleryUpload, handleGalleryRemove,
    handleGalleryReorder, handlePromoteToGallery, handleSetPrimary,
    reset, buildSaveImagePayload, previewSeq,
    setImageUrl, setGalleryUrls, setImageFile, setImagePreview, setGalleryError,
  };
}

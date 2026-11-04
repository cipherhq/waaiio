/**
 * Browser-side image preparation for Ace uploads.
 *
 * Phone photos are often 5–15MB, above Vercel's ~4.5MB request body limit.
 * We redraw them on a canvas as a JPEG with the long edge ≤ 1600px before
 * upload. Where the browser can decode HEIC (Safari), this also converts it.
 */

export const CLIENT_IMAGE_MAX_EDGE = 1600;
export const CLIENT_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
export const CLIENT_IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,image/heif';

const SERVER_READABLE = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export class ImagePrepError extends Error {}

async function downscaleToJpeg(file: File): Promise<File> {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') {
    throw new Error('Canvas image decoding is not available');
  }
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, CLIENT_IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No 2D context');
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (!blob) throw new Error('Could not encode image');
    const baseName = file.name.replace(/\.[^.]+$/, '') || 'photo';
    return new File([blob], `${baseName}.jpg`, { type: 'image/jpeg' });
  } finally {
    bitmap.close?.();
  }
}

/**
 * Returns a file the server can accept. Throws ImagePrepError with a
 * user-facing message when the photo cannot be prepared.
 */
export async function prepareImageForUpload(file: File): Promise<File> {
  let prepared: File | null = null;
  try {
    prepared = await downscaleToJpeg(file);
  } catch {
    // Fall back to the original only if the server can read it as-is
    if (SERVER_READABLE.includes(file.type)) prepared = file;
  }
  if (!prepared) {
    throw new ImagePrepError('This photo format could not be read in your browser. Please use a JPEG or PNG photo.');
  }
  if (prepared.size > CLIENT_IMAGE_MAX_BYTES) {
    throw new ImagePrepError('This photo is too large. Please use a photo under 4MB.');
  }
  return prepared;
}

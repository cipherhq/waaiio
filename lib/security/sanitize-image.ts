import sharp from 'sharp';

interface SanitizeResult {
  buffer: Buffer;
  format: 'jpeg' | 'png' | 'webp';
  contentType: string;
  width: number;
  height: number;
}

/**
 * Re-encode an image through Sharp to strip all metadata and embedded payloads.
 *
 * This is the most reliable malware prevention for image uploads:
 * 1. Decodes the image into raw pixels (fails if not a real image)
 * 2. Re-encodes as clean JPEG/PNG/WebP (destroys any embedded payloads)
 * 3. Strips all EXIF/metadata (privacy + security)
 * 4. Limits dimensions to prevent memory bombs
 *
 * Throws if the file is not a valid image.
 */
export async function sanitizeImage(
  input: Buffer | Uint8Array,
  opts?: {
    maxWidth?: number;
    maxHeight?: number;
    quality?: number;
    format?: 'jpeg' | 'png' | 'webp';
  },
): Promise<SanitizeResult> {
  const maxWidth = opts?.maxWidth ?? 4096;
  const maxHeight = opts?.maxHeight ?? 4096;
  const quality = opts?.quality ?? 85;

  // Load image — this fails if the input is not valid image data
  const image = sharp(Buffer.from(input));
  const metadata = await image.metadata();

  if (!metadata.width || !metadata.height) {
    throw new Error('Invalid image: could not read dimensions');
  }

  // Determine output format
  let format: 'jpeg' | 'png' | 'webp' = opts?.format ?? 'jpeg';
  if (!opts?.format) {
    if (metadata.format === 'png') format = 'png';
    else if (metadata.format === 'webp') format = 'webp';
    else format = 'jpeg'; // Default: JPEG (smallest, most compatible)
  }

  // Re-encode: resize if needed, strip metadata, re-compress
  let pipeline = image
    .rotate() // Auto-rotate based on EXIF (before stripping)
    .resize(maxWidth, maxHeight, { fit: 'inside', withoutEnlargement: true });

  let contentType: string;
  if (format === 'png') {
    pipeline = pipeline.png({ quality });
    contentType = 'image/png';
  } else if (format === 'webp') {
    pipeline = pipeline.webp({ quality });
    contentType = 'image/webp';
  } else {
    pipeline = pipeline.jpeg({ quality, mozjpeg: true });
    contentType = 'image/jpeg';
  }

  const buffer = await pipeline.toBuffer();
  const outputMeta = await sharp(buffer).metadata();

  return {
    buffer,
    format,
    contentType,
    width: outputMeta.width || metadata.width,
    height: outputMeta.height || metadata.height,
  };
}

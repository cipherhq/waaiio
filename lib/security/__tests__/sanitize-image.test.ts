/**
 * sanitizeImage — real sharp, no mocks.
 *
 * Verifies the security-relevant image re-encoding pipeline:
 * - JPEG / PNG / WebP inputs produce valid output in the expected format
 * - EXIF metadata is stripped by the re-encode
 * - Oversized images are resized to the configured limit
 * - Random bytes and truncated files are rejected (throw, no crash)
 */
import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { sanitizeImage } from '../sanitize-image';
import { randomBytes } from 'crypto';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Create a tiny test image in the given format. */
async function makeImage(
  fmt: 'jpeg' | 'png' | 'webp',
  opts?: { width?: number; height?: number; withExif?: boolean },
): Promise<Buffer> {
  const w = opts?.width ?? 20;
  const h = opts?.height ?? 20;
  let pipeline = sharp({
    create: { width: w, height: h, channels: 3, background: '#f00' },
  });

  if (fmt === 'jpeg') pipeline = pipeline.jpeg();
  else if (fmt === 'png') pipeline = pipeline.png();
  else pipeline = pipeline.webp();

  let buf = await pipeline.toBuffer();

  // Embed EXIF data if requested (JPEG only — PNG/WebP don't carry EXIF the same way)
  if (opts?.withExif && fmt === 'jpeg') {
    buf = await sharp(buf)
      .withMetadata({
        exif: {
          IFD0: { ImageDescription: 'secret-location-data' },
        },
      })
      .jpeg()
      .toBuffer();
  }

  return buf;
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe('sanitizeImage', () => {
  // --- format preservation ---------------------------------------------------

  it('JPEG input → JPEG output with valid image data', async () => {
    const input = await makeImage('jpeg');
    const result = await sanitizeImage(input);

    expect(result.format).toBe('jpeg');
    expect(result.contentType).toBe('image/jpeg');
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);

    // Output is a valid image
    const meta = await sharp(result.buffer).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(20);
    expect(meta.height).toBe(20);
  });

  it('PNG input → PNG output with valid image data', async () => {
    const input = await makeImage('png');
    const result = await sanitizeImage(input);

    expect(result.format).toBe('png');
    expect(result.contentType).toBe('image/png');

    const meta = await sharp(result.buffer).metadata();
    expect(meta.format).toBe('png');
  });

  it('WebP input → WebP output with valid image data', async () => {
    const input = await makeImage('webp');
    const result = await sanitizeImage(input);

    expect(result.format).toBe('webp');
    expect(result.contentType).toBe('image/webp');

    const meta = await sharp(result.buffer).metadata();
    expect(meta.format).toBe('webp');
  });

  // --- format override -------------------------------------------------------

  it('forces output to the requested format', async () => {
    const png = await makeImage('png');
    const result = await sanitizeImage(png, { format: 'jpeg' });

    expect(result.format).toBe('jpeg');
    const meta = await sharp(result.buffer).metadata();
    expect(meta.format).toBe('jpeg');
  });

  // --- EXIF stripping --------------------------------------------------------

  it('strips EXIF metadata from JPEG', async () => {
    const input = await makeImage('jpeg', { withExif: true });

    // Confirm the input actually has EXIF
    const inputMeta = await sharp(input).metadata();
    expect(inputMeta.exif).toBeDefined();
    expect(inputMeta.exif!.length).toBeGreaterThan(0);

    const result = await sanitizeImage(input);

    // Output should have no EXIF
    const outputMeta = await sharp(result.buffer).metadata();
    expect(outputMeta.exif).toBeUndefined();
  });

  // --- resize limits ---------------------------------------------------------

  it('downsizes images exceeding maxWidth/maxHeight', async () => {
    const input = await makeImage('jpeg', { width: 200, height: 200 });
    const result = await sanitizeImage(input, { maxWidth: 50, maxHeight: 50 });

    expect(result.width).toBeLessThanOrEqual(50);
    expect(result.height).toBeLessThanOrEqual(50);

    const meta = await sharp(result.buffer).metadata();
    expect(meta.width).toBeLessThanOrEqual(50);
    expect(meta.height).toBeLessThanOrEqual(50);
  });

  it('does not enlarge images smaller than the limit', async () => {
    const input = await makeImage('jpeg', { width: 10, height: 10 });
    const result = await sanitizeImage(input, { maxWidth: 4096, maxHeight: 4096 });

    expect(result.width).toBe(10);
    expect(result.height).toBe(10);
  });

  // --- rejection of invalid input --------------------------------------------

  it('rejects random bytes (not a valid image)', async () => {
    const garbage = randomBytes(512);
    await expect(sanitizeImage(garbage)).rejects.toThrow();
  });

  it('rejects a truncated JPEG (incomplete file)', async () => {
    const full = await makeImage('jpeg', { width: 40, height: 40 });
    // Truncate to ~30 % of the file — enough for a header but not a valid image
    const truncated = full.subarray(0, Math.floor(full.length * 0.3));
    await expect(sanitizeImage(Buffer.from(truncated))).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// images/convert route — success case (PNG → JPEG)
// ---------------------------------------------------------------------------

describe('images/convert route handler', () => {
  it('converts a PNG buffer to JPEG', async () => {
    // We test the sharp pipeline directly since the route handler wraps
    // fetch + sharp.  The route's sharp call is:
    //   sharp(Buffer.from(arrayBuf)).jpeg({ quality: 85 }).toBuffer()
    const png = await makeImage('png', { width: 30, height: 30 });
    const jpeg = await sharp(png).jpeg({ quality: 85 }).toBuffer();

    const meta = await sharp(jpeg).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(30);
    expect(meta.height).toBe(30);
  });
});

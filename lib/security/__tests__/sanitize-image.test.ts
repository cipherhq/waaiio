/**
 * sanitizeImage — real sharp, no mocks.
 *
 * Verifies the security-relevant image re-encoding pipeline:
 * - JPEG / PNG / WebP inputs produce valid output in the expected format
 * - EXIF metadata is stripped by the re-encode
 * - Oversized images are resized to the configured limit
 * - Random bytes and truncated files are rejected (throw, no crash)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import sharp from 'sharp';
import { sanitizeImage } from '../sanitize-image';
import { randomBytes } from 'crypto';

// Hoisted mock for the convert route's rate-limit dependency
vi.mock('@/lib/rate-limit', () => ({
  rateLimitResponseAsync: vi.fn().mockResolvedValue(null),
  getRateLimitKey: vi.fn().mockReturnValue('test-key'),
}));

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
// images/convert route handler — real Request / real sharp
// ---------------------------------------------------------------------------

describe('images/convert route handler', () => {
  const SUPABASE_URL = 'https://test.supabase.co';

  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  });

  it('converts a Supabase PNG to JPEG with correct headers and magic bytes', async () => {
    const png = await makeImage('png', { width: 30, height: 30 });

    // Mock global fetch to return the real PNG buffer
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(png, { status: 200 }),
    );

    const { GET } = await import('@/app/api/images/convert/route');
    const req = new Request(
      `http://localhost/api/images/convert?url=${SUPABASE_URL}/storage/v1/object/public/test.webp`,
    );

    // NextRequest wraps Request — the route uses request.nextUrl.searchParams
    const { NextRequest } = await import('next/server');
    const nextReq = new NextRequest(req);
    const res = await GET(nextReq);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');

    const body = await res.arrayBuffer();
    const bytes = new Uint8Array(body);
    // JPEG magic bytes: FF D8 FF
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
    expect(bytes[2]).toBe(0xff);

    // Verify dimensions via sharp
    const meta = await sharp(Buffer.from(body)).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(30);
    expect(meta.height).toBe(30);

    fetchSpy.mockRestore();
  });

  it('returns 400 for missing url parameter', async () => {
    const { GET } = await import('@/app/api/images/convert/route');
    const { NextRequest } = await import('next/server');

    const req = new NextRequest(new Request('http://localhost/api/images/convert'));
    const res = await GET(req);
    expect(res.status).toBe(400);

    const json = await res.json();
    expect(json.error).toBe('Missing url parameter');
  });

  it('returns 400 for non-Supabase URL', async () => {
    const { GET } = await import('@/app/api/images/convert/route');
    const { NextRequest } = await import('next/server');

    const req = new NextRequest(
      new Request('http://localhost/api/images/convert?url=https://evil.com/image.png'),
    );
    const res = await GET(req);
    expect(res.status).toBe(400);

    const json = await res.json();
    expect(json.error).toBe('Invalid URL');
  });

  it('returns 500 for non-image input', async () => {
    const garbage = randomBytes(256);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(garbage, { status: 200 }),
    );

    const { GET } = await import('@/app/api/images/convert/route');
    const { NextRequest } = await import('next/server');
    const req = new NextRequest(
      new Request(`http://localhost/api/images/convert?url=${SUPABASE_URL}/storage/v1/object/public/bad.bin`),
    );
    const res = await GET(req);
    expect(res.status).toBe(500);

    const json = await res.json();
    expect(json.error).toBe('Conversion failed');
  });
});

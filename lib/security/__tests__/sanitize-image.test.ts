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

// Mock logger to avoid console noise in tests and verify diagnostic events
vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  },
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
// images/convert route handler — URL validation and conversion
// ---------------------------------------------------------------------------

describe('images/convert route handler', () => {
  const SUPABASE_URL = 'https://test.supabase.co';
  const VALID_STORAGE_URL = `${SUPABASE_URL}/storage/v1/object/public/images/test.webp`;

  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  });

  async function callRoute(inputUrl: string) {
    const { GET } = await import('@/app/api/images/convert/route');
    const { NextRequest } = await import('next/server');
    const req = new NextRequest(
      new Request(`http://localhost/api/images/convert?url=${encodeURIComponent(inputUrl)}`),
    );
    return GET(req);
  }

  // --- positive case ---------------------------------------------------------

  it('converts a valid Supabase storage PNG to JPEG (200, magic bytes)', async () => {
    const png = await makeImage('png', { width: 30, height: 30 });
    fetchSpy.mockResolvedValue(new Response(png, { status: 200 }));

    const res = await callRoute(VALID_STORAGE_URL);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');

    const body = await res.arrayBuffer();
    const bytes = new Uint8Array(body);
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
    expect(bytes[2]).toBe(0xff);

    const meta = await sharp(Buffer.from(body)).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(30);
    expect(meta.height).toBe(30);
  });

  // --- missing/empty param ---------------------------------------------------

  it('returns 400 for missing url parameter', async () => {
    const { GET } = await import('@/app/api/images/convert/route');
    const { NextRequest } = await import('next/server');
    const req = new NextRequest(new Request('http://localhost/api/images/convert'));
    const res = await GET(req);

    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // --- non-image body --------------------------------------------------------

  it('returns 400 for non-image body from a valid URL', async () => {
    fetchSpy.mockResolvedValue(new Response(randomBytes(256), { status: 200 }));

    const res = await callRoute(VALID_STORAGE_URL);
    expect(res.status).toBe(400);
  });

  // --- redirect rejection ----------------------------------------------------

  it('rejects upstream redirect (302 to another host)', async () => {
    fetchSpy.mockRejectedValue(new TypeError('fetch failed (redirect mode is error)'));

    const res = await callRoute(VALID_STORAGE_URL);
    expect(res.status).toBe(400);
  });

  // --- URL validation: fetch must NOT be called for invalid URLs -------------

  it('rejects a lookalike host sharing the prefix', async () => {
    const res = await callRoute('https://test.supabase.co.evil.com/storage/v1/object/public/img.png');
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a URL with userinfo (credentials in URL)', async () => {
    const res = await callRoute('https://admin:secret@test.supabase.co/storage/v1/object/public/img.png');
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a non-default port', async () => {
    const res = await callRoute('https://test.supabase.co:8443/storage/v1/object/public/img.png');
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects http instead of https', async () => {
    const res = await callRoute('http://test.supabase.co/storage/v1/object/public/img.png');
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a different subdomain of the same parent domain', async () => {
    const res = await callRoute('https://other.supabase.co/storage/v1/object/public/img.png');
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a URL with encoded host characters', async () => {
    const res = await callRoute('https://test.supabase.co%2f@evil.com/storage/v1/object/public/img.png');
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects an unparseable URL', async () => {
    const res = await callRoute('not-a-url-at-all');
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a URL with the right host but wrong path (not storage)', async () => {
    const res = await callRoute('https://test.supabase.co/rest/v1/some-table');
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a non-Supabase URL entirely', async () => {
    const res = await callRoute('https://evil.com/image.png');
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// images/convert — resource hardening (bounded download, timeouts, dimensions)
// ---------------------------------------------------------------------------

describe('images/convert resource hardening', () => {
  const SUPABASE_URL = 'https://test.supabase.co';
  const VALID_STORAGE_URL = `${SUPABASE_URL}/storage/v1/object/public/images/test.webp`;

  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  });

  async function callRoute(inputUrl: string) {
    const { GET } = await import('@/app/api/images/convert/route');
    const { NextRequest } = await import('next/server');
    const req = new NextRequest(
      new Request(`http://localhost/api/images/convert?url=${encodeURIComponent(inputUrl)}`),
    );
    return GET(req);
  }

  /** Create a ReadableStream that emits `totalBytes` in chunks of `chunkSize`. */
  function makeLargeStream(totalBytes: number, chunkSize = 64 * 1024): ReadableStream<Uint8Array> {
    let emitted = 0;
    return new ReadableStream({
      pull(controller) {
        if (emitted >= totalBytes) {
          controller.close();
          return;
        }
        const remaining = totalBytes - emitted;
        const size = Math.min(chunkSize, remaining);
        controller.enqueue(new Uint8Array(size)); // zeros — not valid image data
        emitted += size;
      },
    });
  }

  // --- Normal conversion: WebP input → JPEG output ---------------------------

  it('converts a valid WebP image to JPEG', async () => {
    const webp = await makeImage('webp', { width: 40, height: 40 });
    fetchSpy.mockResolvedValue(new Response(webp, { status: 200 }));

    const res = await callRoute(VALID_STORAGE_URL);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');

    const body = await res.arrayBuffer();
    const meta = await sharp(Buffer.from(body)).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(40);
    expect(meta.height).toBe(40);
  });

  // --- Normal conversion: JPEG input → JPEG output ---------------------------

  it('converts a valid JPEG image (re-encodes to JPEG)', async () => {
    const jpeg = await makeImage('jpeg', { width: 50, height: 50 });
    fetchSpy.mockResolvedValue(new Response(jpeg, { status: 200 }));

    const res = await callRoute(VALID_STORAGE_URL);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');

    const body = await res.arrayBuffer();
    const bytes = new Uint8Array(body);
    // JPEG magic bytes
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);

    const meta = await sharp(Buffer.from(body)).metadata();
    expect(meta.format).toBe('jpeg');
  });

  // --- Normal conversion: PNG input (already tested above, but verify caching) -

  it('returns correct cache-control headers', async () => {
    const png = await makeImage('png', { width: 20, height: 20 });
    fetchSpy.mockResolvedValue(new Response(png, { status: 200 }));

    const res = await callRoute(VALID_STORAGE_URL);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=86400, s-maxage=86400');
  });

  // --- Oversized Content-Length is rejected early ----------------------------

  it('rejects response with Content-Length exceeding 10 MB', async () => {
    const headers = new Headers({ 'Content-Length': String(11 * 1024 * 1024) });
    // Body stream should NOT be fully consumed — the route should abort early
    const stream = makeLargeStream(11 * 1024 * 1024);
    fetchSpy.mockResolvedValue(new Response(stream, { status: 200, headers }));

    const res = await callRoute(VALID_STORAGE_URL);
    expect(res.status).toBe(413);

    const body = await res.json();
    expect(body.error).toBe('Image too large');
  });

  // --- Missing Content-Length does NOT bypass the limit ----------------------

  it('rejects oversized body even when Content-Length header is absent', async () => {
    // No Content-Length header, but body exceeds 10 MB
    const stream = makeLargeStream(11 * 1024 * 1024);
    fetchSpy.mockResolvedValue(new Response(stream, { status: 200 }));

    const res = await callRoute(VALID_STORAGE_URL);
    expect(res.status).toBe(413);

    const body = await res.json();
    expect(body.error).toBe('Image too large');
  });

  // --- Falsified Content-Length does NOT bypass the limit --------------------

  it('rejects body exceeding limit even when Content-Length lies (claims small)', async () => {
    // Content-Length says 1 KB, but stream emits 11 MB
    const headers = new Headers({ 'Content-Length': '1024' });
    const stream = makeLargeStream(11 * 1024 * 1024);
    fetchSpy.mockResolvedValue(new Response(stream, { status: 200, headers }));

    const res = await callRoute(VALID_STORAGE_URL);
    expect(res.status).toBe(413);

    const body = await res.json();
    expect(body.error).toBe('Image too large');
  });

  // --- Streaming stops when byte budget is exceeded -------------------------

  it('stops reading the stream once the byte budget is exceeded', async () => {
    let chunksEmitted = 0;
    const chunkSize = 1024 * 1024; // 1 MB chunks
    const totalChunks = 20; // 20 MB total — well over 10 MB limit

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunksEmitted >= totalChunks) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(chunkSize));
        chunksEmitted++;
      },
    });

    fetchSpy.mockResolvedValue(new Response(stream, { status: 200 }));

    const res = await callRoute(VALID_STORAGE_URL);
    expect(res.status).toBe(413);

    // Should have stopped well before consuming all 20 chunks.
    // Budget is 10 MB = 10 chunks of 1 MB. The check fires after accumulating,
    // so up to 11 chunks may be read before the (11 MB) check triggers abort.
    // Allow one extra for the chunk that triggers the overflow.
    expect(chunksEmitted).toBeLessThanOrEqual(12);
  });

  // --- Timeout terminates the upstream request ------------------------------

  it('returns 504 when upstream fetch times out', async () => {
    // Simulate AbortError (what happens when AbortController.abort() fires)
    const abortError = new DOMException('The operation was aborted', 'AbortError');
    fetchSpy.mockRejectedValue(abortError);

    const res = await callRoute(VALID_STORAGE_URL);
    expect(res.status).toBe(504);

    const body = await res.json();
    expect(body.error).toBe('Upstream timeout');
  });

  // --- Stream resources are released on success -----------------------------

  it('succeeds with a streamed response body (no buffering regression)', async () => {
    const png = await makeImage('png', { width: 25, height: 25 });

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(png));
        controller.close();
      },
    });

    fetchSpy.mockResolvedValue(new Response(stream, { status: 200 }));

    const res = await callRoute(VALID_STORAGE_URL);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
  });

  // --- Stream resources are released on size rejection ----------------------

  it('releases stream resources when size limit is exceeded', async () => {
    let cancelCalled = false;
    let emitted = 0;
    const chunkSize = 2 * 1024 * 1024;

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted > 12 * 1024 * 1024) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(chunkSize));
        emitted += chunkSize;
      },
      cancel() {
        cancelCalled = true;
      },
    });

    fetchSpy.mockResolvedValue(new Response(stream, { status: 200 }));

    const res = await callRoute(VALID_STORAGE_URL);
    expect(res.status).toBe(413);
    // Cancel should have been called to release the stream
    expect(cancelCalled).toBe(true);
  });

  // --- Oversized image dimensions are rejected ------------------------------

  it('rejects image with dimensions exceeding 10 000 px', async () => {
    // Create an image that is 10001 × 1 — tiny in bytes but extreme dimension
    const wideImage = await sharp({
      create: { width: 10001, height: 1, channels: 3, background: '#f00' },
    }).png().toBuffer();

    fetchSpy.mockResolvedValue(new Response(wideImage, { status: 200 }));

    const res = await callRoute(VALID_STORAGE_URL);
    expect(res.status).toBe(413);

    const body = await res.json();
    expect(body.error).toBe('Image dimensions too large');
  });

  it('rejects image with tall dimension exceeding 10 000 px', async () => {
    const tallImage = await sharp({
      create: { width: 1, height: 10001, channels: 3, background: '#0f0' },
    }).png().toBuffer();

    fetchSpy.mockResolvedValue(new Response(tallImage, { status: 200 }));

    const res = await callRoute(VALID_STORAGE_URL);
    expect(res.status).toBe(413);

    const body = await res.json();
    expect(body.error).toBe('Image dimensions too large');
  });

  // --- Invalid image content fails safely -----------------------------------

  it('returns 400 for corrupted image data (random bytes)', async () => {
    fetchSpy.mockResolvedValue(new Response(randomBytes(2048), { status: 200 }));

    const res = await callRoute(VALID_STORAGE_URL);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toBe('Invalid image');
  });

  // --- Upstream non-OK status -----------------------------------------------

  it('returns 502 for upstream 404', async () => {
    fetchSpy.mockResolvedValue(new Response('Not Found', { status: 404 }));

    const res = await callRoute(VALID_STORAGE_URL);
    expect(res.status).toBe(502);
  });

  it('returns 502 for upstream 500', async () => {
    fetchSpy.mockResolvedValue(new Response('Internal Server Error', { status: 500 }));

    const res = await callRoute(VALID_STORAGE_URL);
    expect(res.status).toBe(502);
  });

  // --- Error responses do not leak internals --------------------------------

  it('error responses do not contain URL, credentials, or stack traces', async () => {
    fetchSpy.mockResolvedValue(new Response(randomBytes(256), { status: 200 }));

    const res = await callRoute(VALID_STORAGE_URL);
    expect(res.status).toBe(400);

    const text = await res.clone().text();
    expect(text).not.toContain('supabase');
    expect(text).not.toContain('SUPABASE');
    expect(text).not.toContain('stack');
    expect(text).not.toContain('Error:');
  });

  // --- WhatsApp-compatible: valid image under limits passes through ----------

  it('WhatsApp-compatible: converts a typical product image (800×600 PNG)', async () => {
    const productImage = await makeImage('png', { width: 800, height: 600 });
    fetchSpy.mockResolvedValue(new Response(productImage, { status: 200 }));

    const res = await callRoute(VALID_STORAGE_URL);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');

    const body = await res.arrayBuffer();
    const meta = await sharp(Buffer.from(body)).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(800);
    expect(meta.height).toBe(600);
  });

  it('WhatsApp-compatible: converts a large but valid image (3000×2000 WebP)', async () => {
    const largeImage = await makeImage('webp', { width: 3000, height: 2000 });
    fetchSpy.mockResolvedValue(new Response(largeImage, { status: 200 }));

    const res = await callRoute(VALID_STORAGE_URL);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');

    const body = await res.arrayBuffer();
    const meta = await sharp(Buffer.from(body)).metadata();
    expect(meta.format).toBe('jpeg');
    // Should not have been resized (under 4096 limit)
    expect(meta.width).toBe(3000);
    expect(meta.height).toBe(2000);
  });

  // --- Exactly-at-limit images pass through ---------------------------------

  it('accepts an image at exactly the dimension limit (10 000 × 1)', async () => {
    const edgeImage = await sharp({
      create: { width: 10000, height: 1, channels: 3, background: '#00f' },
    }).png().toBuffer();

    fetchSpy.mockResolvedValue(new Response(edgeImage, { status: 200 }));

    const res = await callRoute(VALID_STORAGE_URL);
    expect(res.status).toBe(200);
  });
});

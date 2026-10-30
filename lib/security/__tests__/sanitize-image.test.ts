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
  let loggerMod: { logger: { warn: ReturnType<typeof vi.fn> } };

  beforeEach(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    loggerMod = await import('@/lib/logger') as typeof loggerMod;
    vi.mocked(loggerMod.logger.warn).mockClear();
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

  // =========================================================================
  // Normal conversion (PNG, WebP, JPEG)
  // =========================================================================

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

  it('converts a valid JPEG image (re-encodes to JPEG)', async () => {
    const jpeg = await makeImage('jpeg', { width: 50, height: 50 });
    fetchSpy.mockResolvedValue(new Response(jpeg, { status: 200 }));

    const res = await callRoute(VALID_STORAGE_URL);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');

    const body = await res.arrayBuffer();
    const bytes = new Uint8Array(body);
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
  });

  it('returns correct cache-control headers', async () => {
    const png = await makeImage('png', { width: 20, height: 20 });
    fetchSpy.mockResolvedValue(new Response(png, { status: 200 }));

    const res = await callRoute(VALID_STORAGE_URL);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=86400, s-maxage=86400');
  });

  // =========================================================================
  // Download byte limits
  // =========================================================================

  it('rejects response with Content-Length exceeding 10 MB', async () => {
    const headers = new Headers({ 'Content-Length': String(11 * 1024 * 1024) });
    const stream = makeLargeStream(11 * 1024 * 1024);
    fetchSpy.mockResolvedValue(new Response(stream, { status: 200, headers }));

    const res = await callRoute(VALID_STORAGE_URL);
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe('Image too large');
  });

  it('rejects oversized body even when Content-Length header is absent', async () => {
    const stream = makeLargeStream(11 * 1024 * 1024);
    fetchSpy.mockResolvedValue(new Response(stream, { status: 200 }));

    const res = await callRoute(VALID_STORAGE_URL);
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe('Image too large');
  });

  it('rejects body exceeding limit even when Content-Length lies (claims small)', async () => {
    const headers = new Headers({ 'Content-Length': '1024' });
    const stream = makeLargeStream(11 * 1024 * 1024);
    fetchSpy.mockResolvedValue(new Response(stream, { status: 200, headers }));

    const res = await callRoute(VALID_STORAGE_URL);
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe('Image too large');
  });

  it('handles non-numeric Content-Length gracefully', async () => {
    const png = await makeImage('png', { width: 10, height: 10 });
    const headers = new Headers({ 'Content-Length': 'not-a-number' });
    fetchSpy.mockResolvedValue(new Response(png, { status: 200, headers }));

    const res = await callRoute(VALID_STORAGE_URL);
    // Non-numeric Content-Length should be ignored (NaN), actual bytes enforced
    expect(res.status).toBe(200);
  });

  it('handles Content-Length of zero gracefully', async () => {
    const headers = new Headers({ 'Content-Length': '0' });
    // Empty body — should fail at Sharp processing
    fetchSpy.mockResolvedValue(new Response(new Uint8Array(0), { status: 200, headers }));

    const res = await callRoute(VALID_STORAGE_URL);
    expect(res.status).toBe(400); // Invalid image (empty)
  });

  it('stops reading the stream once the byte budget is exceeded', async () => {
    let chunksEmitted = 0;
    const chunkSize = 1024 * 1024;
    const totalChunks = 20;

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
    // Budget is 10 MB = 10 chunks of 1 MB. Allow 1-2 extra for the overflow chunk.
    expect(chunksEmitted).toBeLessThanOrEqual(12);
  });

  // =========================================================================
  // Timeout classification (P1 fix)
  // =========================================================================

  it('returns 504 when fetch itself is aborted (connect timeout)', async () => {
    const abortError = new DOMException('The operation was aborted', 'AbortError');
    fetchSpy.mockRejectedValue(abortError);

    const res = await callRoute(VALID_STORAGE_URL);
    expect(res.status).toBe(504);
    expect((await res.json()).error).toBe('Upstream timeout');
  });

  it('returns 504 when body download is aborted mid-stream (stalled body)', async () => {
    // Simulate a stream that delivers some data then stalls, and gets aborted
    // by the AbortController. This exercises the download catch path.
    let readerController: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        readerController = controller;
        // Emit one small chunk to start the download
        controller.enqueue(new Uint8Array(1024));
      },
    });

    // The fetch succeeds with 200 and starts streaming
    fetchSpy.mockImplementation((_url: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;
      // When the signal aborts, make the stream error with AbortError
      if (signal) {
        signal.addEventListener('abort', () => {
          try {
            readerController.error(new DOMException('The operation was aborted', 'AbortError'));
          } catch { /* stream may already be errored */ }
        });
      }
      return Promise.resolve(new Response(stream, { status: 200 }));
    });

    // Abort immediately to simulate timeout during download
    // We need to intercept the AbortController. Since we can't access
    // the route's internal controller, we abort via the signal listener above
    // by triggering it from outside. Use a short setTimeout to abort after
    // the route calls fetch but while reader.read() is pending.
    const originalSetTimeout = globalThis.setTimeout;
    let capturedAbortFn: (() => void) | null = null;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn: TimerHandler, _ms?: number) => {
      capturedAbortFn = fn as () => void;
      // Return a valid timer ID but don't actually schedule it
      return originalSetTimeout(() => {}, 0) as unknown as NodeJS.Timeout;
    });

    // Start the route call, but before it resolves, fire the "timeout"
    const routePromise = callRoute(VALID_STORAGE_URL);

    // Give the event loop a tick to let the route get to reader.read()
    await new Promise((r) => originalSetTimeout(r, 10));

    // Fire the captured timeout callback (the abort)
    if (capturedAbortFn) capturedAbortFn();

    const res = await routePromise;
    expect(res.status).toBe(504);
    expect((await res.json()).error).toBe('Upstream timeout');
  });

  // =========================================================================
  // Stream cleanup
  // =========================================================================

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
    expect(cancelCalled).toBe(true);
  });

  it('succeeds with a streamed response body', async () => {
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

  // =========================================================================
  // Non-OK response cleanup (P2 fix)
  // =========================================================================

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

  it('discards body of non-OK upstream response', async () => {
    let cancelCalled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024));
        // Don't close — simulates a non-OK response with dangling body
      },
      cancel() {
        cancelCalled = true;
      },
    });

    fetchSpy.mockResolvedValue(new Response(stream, { status: 503 }));

    const res = await callRoute(VALID_STORAGE_URL);
    expect(res.status).toBe(502);
    expect(cancelCalled).toBe(true);
  });

  // =========================================================================
  // Dimension limits (8 000 px per axis)
  // =========================================================================

  it('rejects image with width exceeding 8 000 px', async () => {
    const wideImage = await sharp({
      create: { width: 8001, height: 1, channels: 3, background: '#f00' },
    }).png().toBuffer();

    fetchSpy.mockResolvedValue(new Response(wideImage, { status: 200 }));

    const res = await callRoute(VALID_STORAGE_URL);
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe('Image dimensions too large');
  });

  it('rejects image with height exceeding 8 000 px', async () => {
    const tallImage = await sharp({
      create: { width: 1, height: 8001, channels: 3, background: '#0f0' },
    }).png().toBuffer();

    fetchSpy.mockResolvedValue(new Response(tallImage, { status: 200 }));

    const res = await callRoute(VALID_STORAGE_URL);
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe('Image dimensions too large');
  });

  it('accepts an image at exactly the dimension limit (8 000 × 1)', async () => {
    const edgeImage = await sharp({
      create: { width: 8000, height: 1, channels: 3, background: '#00f' },
    }).png().toBuffer();

    fetchSpy.mockResolvedValue(new Response(edgeImage, { status: 200 }));

    const res = await callRoute(VALID_STORAGE_URL);
    expect(res.status).toBe(200);
  });

  // =========================================================================
  // Invalid content
  // =========================================================================

  it('returns 400 for corrupted image data (random bytes)', async () => {
    fetchSpy.mockResolvedValue(new Response(randomBytes(2048), { status: 200 }));

    const res = await callRoute(VALID_STORAGE_URL);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Invalid image');
  });

  // =========================================================================
  // Diagnostic logging: no URLs, paths, or sensitive data (P1/P2 fix)
  // =========================================================================

  it('logger.warn arguments never contain user-supplied URLs or storage paths', async () => {
    // Trigger multiple error paths and verify no URL leaks in any log call.
    const sensitiveUrl = `${SUPABASE_URL}/storage/v1/object/public/secret-bucket/private-photo.webp`;

    // 1. Timeout path
    fetchSpy.mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'));
    await callRoute(sensitiveUrl);

    // 2. Non-OK upstream
    fetchSpy.mockResolvedValue(new Response('fail', { status: 500 }));
    await callRoute(sensitiveUrl);

    // 3. Invalid image
    fetchSpy.mockResolvedValue(new Response(randomBytes(256), { status: 200 }));
    await callRoute(sensitiveUrl);

    // Check all logger.warn calls — none should contain any part of the URL
    const warnCalls = vi.mocked(loggerMod.logger.warn).mock.calls;
    expect(warnCalls.length).toBeGreaterThanOrEqual(3);

    for (const call of warnCalls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain('supabase.co');
      expect(serialized).not.toContain('secret-bucket');
      expect(serialized).not.toContain('private-photo');
      expect(serialized).not.toContain('/storage/v1');
      expect(serialized).not.toContain('url');
    }
  });

  it('error responses do not contain URLs, credentials, or stack traces', async () => {
    fetchSpy.mockResolvedValue(new Response(randomBytes(256), { status: 200 }));

    const res = await callRoute(VALID_STORAGE_URL);
    expect(res.status).toBe(400);

    const text = await res.clone().text();
    expect(text).not.toContain('supabase');
    expect(text).not.toContain('SUPABASE');
    expect(text).not.toContain('stack');
    expect(text).not.toContain('Error:');
  });

  // =========================================================================
  // WhatsApp output size enforcement (P2 fix)
  // =========================================================================

  it('JPEG output is within WhatsApp 5 MB limit for normal images', async () => {
    const productImage = await makeImage('png', { width: 800, height: 600 });
    fetchSpy.mockResolvedValue(new Response(productImage, { status: 200 }));

    const res = await callRoute(VALID_STORAGE_URL);
    expect(res.status).toBe(200);

    const body = await res.arrayBuffer();
    // Must be under 4.5 MB (our safe margin)
    expect(body.byteLength).toBeLessThan(4_608_000);
  });

  it('large valid image (1200×800 WebP) converts within size limits', async () => {
    const largeImage = await makeImage('webp', { width: 1200, height: 800 });
    fetchSpy.mockResolvedValue(new Response(largeImage, { status: 200 }));

    const res = await callRoute(VALID_STORAGE_URL);
    expect(res.status).toBe(200);

    const body = await res.arrayBuffer();
    const meta = await sharp(Buffer.from(body)).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(1200);
    expect(meta.height).toBe(800);
    expect(body.byteLength).toBeLessThan(4_608_000);
  });

  it('high-entropy image output stays within WhatsApp limit or is rejected', async () => {
    // Create a 1500×1500 image with random noise (high entropy = hard to compress).
    // Encode as JPEG at near-lossless quality to keep input under 10 MB download.
    const noiseBuffer = randomBytes(1500 * 1500 * 3);
    const noisyImage = await sharp(noiseBuffer, {
      raw: { width: 1500, height: 1500, channels: 3 },
    }).jpeg({ quality: 98 }).toBuffer();

    fetchSpy.mockResolvedValue(new Response(noisyImage, { status: 200 }));

    const res = await callRoute(VALID_STORAGE_URL);

    // Either succeeds with output under 4.5 MB, or is rejected at 413
    if (res.status === 413) {
      const body = await res.json();
      // Could be download-size or output-size rejection
      expect(['Image too large', 'Converted image too large for delivery']).toContain(body.error);
    } else {
      expect(res.status).toBe(200);
      const body = await res.arrayBuffer();
      expect(body.byteLength).toBeLessThan(4_608_000);
    }
  }, 15_000);

  it('output size enforcement: JPEG output under 4.5 MB for 4096×4096 solid color', async () => {
    // Solid color compresses extremely well in JPEG — should always be under limit.
    // This verifies the output path works for large-dimension images.
    const solidImage = await sharp({
      create: { width: 4096, height: 4096, channels: 3, background: '#336699' },
    }).png().toBuffer();

    fetchSpy.mockResolvedValue(new Response(solidImage, { status: 200 }));

    const res = await callRoute(VALID_STORAGE_URL);
    expect(res.status).toBe(200);

    const body = await res.arrayBuffer();
    expect(body.byteLength).toBeLessThan(4_608_000);
    expect(body.byteLength).toBeGreaterThan(0);
  }, 15_000);

  // =========================================================================
  // WhatsApp-compatible product/event images
  // =========================================================================

  it('WhatsApp-compatible: typical product image (800×600 PNG)', async () => {
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
});

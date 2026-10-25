import { NextRequest, NextResponse } from 'next/server';
import sharp from 'sharp';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

// ---------------------------------------------------------------------------
// Resource ceilings
// ---------------------------------------------------------------------------
// Download: 10 MB — generous for any product/event image stored in Supabase.
// WhatsApp image API limit is 5 MB; Supabase free-tier max upload is 50 MB.
// 10 MB gives headroom while preventing multi-GB downloads.
const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;

// Fetch timeout: 15 s — Supabase CDN typically responds in <2 s.
// Vercel serverless default is 60 s; 15 s is a safe interior bound.
const FETCH_TIMEOUT_MS = 15_000;

// Sharp pixel limit: 100 megapixels (e.g. 10 000 × 10 000).
// Default Sharp limit is 268 MP; tightening prevents decompression bombs.
const MAX_INPUT_PIXELS = 100_000_000;

// Max input dimension on either axis.
const MAX_INPUT_DIMENSION = 10_000;

// JPEG output quality — matches existing behavior.
const JPEG_QUALITY = 85;

// Output dimension ceiling — resize oversized images to fit within this.
const MAX_OUTPUT_DIMENSION = 4096;

// ---------------------------------------------------------------------------
// URL allowlist (preserved from PR #649)
// ---------------------------------------------------------------------------
const STORAGE_PATH_PREFIX = '/storage/v1/object/public/';

function isAllowedStorageUrl(input: string): boolean {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) return false;

  let parsed: URL;
  let allowed: URL;
  try {
    parsed = new URL(input);
    allowed = new URL(supabaseUrl);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'https:') return false;
  if (parsed.origin !== allowed.origin) return false;
  if (parsed.username || parsed.password) return false;
  if (parsed.port && parsed.port !== '443') return false;
  if (!parsed.pathname.startsWith(STORAGE_PATH_PREFIX)) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Bounded streaming download
// ---------------------------------------------------------------------------

/**
 * Download up to `maxBytes` from the response body, aborting if exceeded.
 * Does NOT trust Content-Length — enforces the limit on actual received bytes.
 * Returns the concatenated buffer, or throws on size/timeout/stream errors.
 */
async function downloadBounded(
  response: Response,
  maxBytes: number,
  abortController: AbortController,
): Promise<Buffer> {
  // Early rejection via Content-Length (advisory only — actual bytes still enforced)
  const declaredLength = response.headers.get('content-length');
  if (declaredLength) {
    const declared = parseInt(declaredLength, 10);
    if (!Number.isNaN(declared) && declared > maxBytes) {
      abortController.abort();
      throw new SizeExceededError(declared);
    }
  }

  const body = response.body;
  if (!body) {
    throw new Error('Empty response body');
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      received += value.byteLength;
      if (received > maxBytes) {
        abortController.abort();
        throw new SizeExceededError(received);
      }
      chunks.push(value);
    }
  } finally {
    // Always release the reader lock — enables garbage collection of the
    // underlying connection even if an error was thrown above.
    try { reader.releaseLock(); } catch { /* already released */ }
    // Cancel any remaining body to free the socket.
    try { body.cancel().catch(() => {}); } catch { /* no-op */ }
  }

  return Buffer.concat(chunks, received);
}

class SizeExceededError extends Error {
  constructor(public readonly receivedBytes: number) {
    super(`Image exceeds maximum allowed size (received ${receivedBytes} bytes)`);
    this.name = 'SizeExceededError';
  }
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * GET /api/images/convert?url=<supabase-storage-url>
 * Fetches a PNG/WebP/JPEG image from Supabase storage and returns it as JPEG.
 * Used by the WhatsApp bot since Meta doesn't support WebP in image messages.
 */
export async function GET(request: NextRequest) {
  const rateLimit = await rateLimitResponseAsync(getRateLimitKey(request, 'images-convert'), 30, 60_000);
  if (rateLimit) return rateLimit;

  const url = request.nextUrl.searchParams.get('url');
  if (!url) {
    return NextResponse.json({ error: 'Missing url parameter' }, { status: 400 });
  }

  if (!isAllowedStorageUrl(url)) {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });
  }

  // --- Fetch with timeout and abort ---
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      redirect: 'error',
      signal: abortController.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof DOMException && err.name === 'AbortError') {
      logger.warn('image-convert: upstream fetch timed out', { url: url.substring(0, 120) });
      return NextResponse.json({ error: 'Upstream timeout' }, { status: 504 });
    }
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });
  }

  if (!response.ok) {
    clearTimeout(timeout);
    logger.warn('image-convert: upstream returned non-OK status', { status: response.status });
    return NextResponse.json({ error: 'Failed to fetch image' }, { status: 502 });
  }

  // --- Bounded streaming download ---
  let imageBuffer: Buffer;
  try {
    imageBuffer = await downloadBounded(response, MAX_DOWNLOAD_BYTES, abortController);
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof SizeExceededError) {
      logger.warn('image-convert: rejected oversized image', { receivedBytes: err.receivedBytes });
      return NextResponse.json({ error: 'Image too large' }, { status: 413 });
    }
    logger.warn('image-convert: download stream error');
    return NextResponse.json({ error: 'Failed to download image' }, { status: 502 });
  }
  clearTimeout(timeout);

  // --- Sharp conversion with resource limits ---
  try {
    const image = sharp(imageBuffer, {
      limitInputPixels: MAX_INPUT_PIXELS,
    });

    const metadata = await image.metadata();

    // Reject images with extreme dimensions even if under pixel limit
    if (
      metadata.width && metadata.width > MAX_INPUT_DIMENSION ||
      metadata.height && metadata.height > MAX_INPUT_DIMENSION
    ) {
      logger.warn('image-convert: rejected oversized dimensions', {
        width: metadata.width ?? 0,
        height: metadata.height ?? 0,
      });
      return NextResponse.json({ error: 'Image dimensions too large' }, { status: 413 });
    }

    const jpeg = await image
      .resize(MAX_OUTPUT_DIMENSION, MAX_OUTPUT_DIMENSION, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toBuffer();

    return new NextResponse(new Uint8Array(jpeg), {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=86400, s-maxage=86400',
      },
    });
  } catch (err) {
    // Sharp throws for corrupt/unsupported input — return safe error
    logger.warn('image-convert: sharp processing failed');
    return NextResponse.json({ error: 'Invalid image' }, { status: 400 });
  }
}

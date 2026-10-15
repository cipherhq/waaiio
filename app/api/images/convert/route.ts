import { NextRequest, NextResponse } from 'next/server';
import sharp from 'sharp';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';

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

/**
 * GET /api/images/convert?url=<supabase-storage-url>
 * Fetches a WebP image and returns it as JPEG.
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

  let response: Response;
  try {
    response = await fetch(url, { redirect: 'error' });
  } catch {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });
  }

  if (!response.ok) {
    return NextResponse.json({ error: 'Failed to fetch image' }, { status: 502 });
  }

  try {
    const arrayBuf = await response.arrayBuffer();
    const jpeg = await sharp(Buffer.from(arrayBuf)).jpeg({ quality: 85 }).toBuffer();

    return new NextResponse(new Uint8Array(jpeg), {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=86400, s-maxage=86400',
      },
    });
  } catch {
    return NextResponse.json({ error: 'Invalid image' }, { status: 400 });
  }
}

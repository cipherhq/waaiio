import { NextRequest, NextResponse } from 'next/server';
import sharp from 'sharp';

/**
 * GET /api/images/convert?url=<supabase-storage-url>
 * Fetches a WebP image and returns it as JPEG.
 * Used by the WhatsApp bot since Meta doesn't support WebP in image messages.
 */
export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get('url');
  if (!url) {
    return NextResponse.json({ error: 'Missing url parameter' }, { status: 400 });
  }

  // Only allow Supabase storage URLs
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl || !url.startsWith(supabaseUrl)) {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });
  }

  try {
    const response = await fetch(url);
    if (!response.ok) {
      return NextResponse.json({ error: 'Failed to fetch image' }, { status: 502 });
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const jpeg = await sharp(buffer).jpeg({ quality: 85 }).toBuffer();

    return new NextResponse(jpeg, {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=86400, s-maxage=86400',
      },
    });
  } catch {
    return NextResponse.json({ error: 'Conversion failed' }, { status: 500 });
  }
}

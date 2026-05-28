import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import QRCode from 'qrcode';

/**
 * GET /api/tickets/image?code=TK-ABC123
 * Returns the event flyer if available, otherwise generates a QR code image.
 * Used by WhatsApp bot to send visual tickets after purchase.
 */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  if (!code) {
    return NextResponse.json({ error: 'Missing code parameter' }, { status: 400 });
  }

  const supabase = createServiceClient();

  const { data: ticket } = await supabase
    .from('event_tickets')
    .select('ticket_code, event_id')
    .eq('ticket_code', code)
    .maybeSingle();

  if (!ticket) {
    return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
  }

  // Check if event has a flyer image
  if (ticket.event_id) {
    const { data: event } = await supabase
      .from('events')
      .select('image_url')
      .eq('id', ticket.event_id)
      .single();

    if (event?.image_url) {
      try {
        // Fetch the flyer and return it (converting WebP to PNG if needed)
        const res = await fetch(event.image_url);
        if (res.ok) {
          const buffer = await res.arrayBuffer();
          const contentType = res.headers.get('content-type') || 'image/jpeg';

          // If WebP, we need to convert — use sharp
          if (contentType.includes('webp') || event.image_url.toLowerCase().endsWith('.webp')) {
            try {
              const sharp = (await import('sharp')).default;
              const jpeg = await sharp(Buffer.from(buffer)).jpeg({ quality: 85 }).toBuffer();
              return new NextResponse(new Uint8Array(jpeg), {
                headers: {
                  'Content-Type': 'image/jpeg',
                  'Cache-Control': 'public, max-age=3600, s-maxage=3600',
                },
              });
            } catch {
              // Sharp failed — fall through to QR
            }
          } else {
            // Return flyer as-is (JPEG/PNG)
            return new NextResponse(new Uint8Array(buffer), {
              headers: {
                'Content-Type': contentType,
                'Cache-Control': 'public, max-age=3600, s-maxage=3600',
              },
            });
          }
        }
      } catch {
        // Flyer fetch failed — fall through to QR
      }
    }
  }

  // Fallback: generate a QR code image
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://waaiio.com';
  const verifyUrl = `${appUrl}/tickets/${code}`;

  const qrPng = await QRCode.toBuffer(verifyUrl, {
    type: 'png',
    width: 400,
    margin: 2,
    color: { dark: '#000000', light: '#FFFFFF' },
  });

  return new NextResponse(new Uint8Array(qrPng), {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=3600, s-maxage=3600',
    },
  });
}

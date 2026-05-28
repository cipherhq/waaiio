import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import QRCode from 'qrcode';

/**
 * GET /api/tickets/image?code=TK-ABC123
 * Returns the event flyer if available, otherwise redirects to an external QR code.
 * Used by WhatsApp bot to send visual tickets after purchase.
 */
export async function GET(request: NextRequest) {
  try {
    const code = request.nextUrl.searchParams.get('code');
    if (!code) {
      return NextResponse.json({ error: 'Missing code parameter' }, { status: 400 });
    }

    const supabase = createServiceClient();

    const { data: ticket, error: ticketErr } = await supabase
      .from('event_tickets')
      .select('ticket_code, event_id')
      .eq('ticket_code', code)
      .maybeSingle();

    if (ticketErr || !ticket) {
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
          const imgUrl = event.image_url;
          const isWebP = imgUrl.toLowerCase().endsWith('.webp');

          if (isWebP) {
            // Convert WebP via our own convert endpoint
            const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://waaiio.com';
            const convertUrl = `${appUrl}/api/images/convert?url=${encodeURIComponent(imgUrl)}`;
            const res = await fetch(convertUrl);
            if (res.ok) {
              const buffer = await res.arrayBuffer();
              return new NextResponse(new Uint8Array(buffer), {
                headers: {
                  'Content-Type': 'image/jpeg',
                  'Cache-Control': 'public, max-age=3600, s-maxage=3600',
                },
              });
            }
          } else {
            // Fetch and return flyer as-is
            const res = await fetch(imgUrl);
            if (res.ok) {
              const buffer = await res.arrayBuffer();
              return new NextResponse(new Uint8Array(buffer), {
                headers: {
                  'Content-Type': res.headers.get('content-type') || 'image/jpeg',
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

    // Fallback: generate QR code as SVG → convert to data URL → return as redirect
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://waaiio.com';
    const verifyUrl = `${appUrl}/tickets/${code}`;

    // Use SVG output (no native dependencies needed)
    const qrSvg = await QRCode.toString(verifyUrl, {
      type: 'svg',
      width: 400,
      margin: 2,
      color: { dark: '#000000', light: '#FFFFFF' },
    });

    return new NextResponse(qrSvg, {
      headers: {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'public, max-age=3600, s-maxage=3600',
      },
    });
  } catch (err) {
    console.error('[TICKET-IMAGE] Error:', err);
    return NextResponse.json({ error: 'Failed to generate ticket image' }, { status: 500 });
  }
}

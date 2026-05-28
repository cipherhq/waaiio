import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import QRCode from 'qrcode';
import sharp from 'sharp';

/**
 * GET /api/tickets/image?code=TK-ABC123
 * Generates a rich ticket image with event flyer + QR code overlay.
 * If no flyer exists, generates a branded default ticket.
 */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  if (!code) {
    return NextResponse.json({ error: 'Missing code parameter' }, { status: 400 });
  }

  const supabase = createServiceClient();

  const { data: ticket } = await supabase
    .from('event_tickets')
    .select(`
      ticket_code, ticket_number, guest_name, status,
      event:events!event_id(name, date, time, venue, image_url),
      booking:bookings!booking_id(reference_code, business_id)
    `)
    .eq('ticket_code', code)
    .maybeSingle();

  if (!ticket) {
    return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
  }

  const eventRaw = ticket.event as unknown;
  const event = (Array.isArray(eventRaw) ? eventRaw[0] : eventRaw) as { name: string; date: string; time: string; venue: string; image_url: string | null } | null;
  const bookingRaw = ticket.booking as unknown;
  const booking = (Array.isArray(bookingRaw) ? bookingRaw[0] : bookingRaw) as { reference_code: string; business_id: string } | null;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://waaiio.com';
  const verifyUrl = `${appUrl}/tickets/${code}`;

  const eventName = event?.name || 'Event';
  const eventDate = event?.date
    ? new Date(event.date + 'T00:00').toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
    : '';
  const eventTime = event?.time || '';
  const venue = event?.venue || '';
  const ref = booking?.reference_code || '';

  // Generate QR code
  const qrBuffer = await QRCode.toBuffer(verifyUrl, {
    width: 200, margin: 1,
    color: { dark: '#000000', light: '#FFFFFF' },
  });

  const width = 800;
  const height = 1000;

  // Try to fetch event flyer
  let flyerBuffer: Buffer | null = null;
  if (event?.image_url) {
    try {
      const res = await fetch(event.image_url);
      if (res.ok) {
        const raw = Buffer.from(await res.arrayBuffer());
        // Resize flyer to fill top portion (800 x 560)
        flyerBuffer = await sharp(raw)
          .resize(width, 560, { fit: 'cover', position: 'center' })
          .toBuffer();
      }
    } catch {
      // Flyer fetch failed — use default
    }
  }

  // Bottom ticket strip: white card with details + QR
  const stripHeight = 440;
  const stripSvg = `
    <svg width="${width}" height="${stripHeight}">
      <rect width="100%" height="100%" fill="white"/>
      <line x1="0" y1="0" x2="${width}" y2="0" stroke="#6C2BD9" stroke-width="4"/>
      <circle cx="0" cy="0" r="20" fill="#f3f4f6"/>
      <circle cx="${width}" cy="0" r="20" fill="#f3f4f6"/>
      <text x="40" y="50" font-family="Arial,sans-serif" font-size="26" font-weight="bold" fill="#1a1a1a">${esc(eventName)}</text>
      <text x="40" y="90" font-family="Arial,sans-serif" font-size="18" fill="#555">${esc(eventDate)}${eventTime ? '  ·  ' + esc(eventTime) : ''}</text>
      <text x="40" y="120" font-family="Arial,sans-serif" font-size="16" fill="#777">${venue ? esc(venue) : ''}</text>
      <text x="40" y="175" font-family="Arial,sans-serif" font-size="22" font-weight="bold" fill="#6C2BD9">${esc(code)}</text>
      <text x="40" y="205" font-family="Arial,sans-serif" font-size="14" fill="#999">Ref: ${esc(ref)}</text>
      <text x="40" y="245" font-family="Arial,sans-serif" font-size="16" fill="#333">${esc(ticket.guest_name || 'Guest')}</text>
      <text x="40" y="390" font-family="Arial,sans-serif" font-size="12" fill="#aaa">Scan QR to verify · waaiio.com</text>
      <text x="40" y="415" font-family="Arial,sans-serif" font-size="11" fill="#ccc">${esc(verifyUrl)}</text>
    </svg>
  `;

  const composites: Array<{ input: Buffer; top: number; left: number }> = [];

  if (flyerBuffer) {
    // Flyer ticket: flyer on top, details strip on bottom
    composites.push({ input: flyerBuffer, top: 0, left: 0 });
    composites.push({ input: Buffer.from(stripSvg), top: 560, left: 0 });
    composites.push({ input: qrBuffer, top: 600, left: 560 });
  } else {
    // Default ticket: purple header, white body
    const defaultSvg = `
      <svg width="${width}" height="${height}">
        <rect width="100%" height="100%" fill="white" rx="16"/>
        <rect width="100%" height="200" fill="#6C2BD9" rx="16"/>
        <rect y="184" width="100%" height="16" fill="#6C2BD9"/>
        <text x="40" y="80" font-family="Arial,sans-serif" font-size="18" fill="rgba(255,255,255,0.7)">YOUR TICKET</text>
        <text x="40" y="130" font-family="Arial,sans-serif" font-size="36" font-weight="bold" fill="white">${esc(eventName)}</text>
        <text x="40" y="170" font-family="Arial,sans-serif" font-size="18" fill="rgba(255,255,255,0.9)">${esc(eventDate)}${eventTime ? '  ·  ' + esc(eventTime) : ''}</text>
        <text x="40" y="260" font-family="Arial,sans-serif" font-size="18" fill="#555">${venue ? esc(venue) : ''}</text>
        <text x="40" y="330" font-family="Arial,sans-serif" font-size="28" font-weight="bold" fill="#6C2BD9">${esc(code)}</text>
        <text x="40" y="365" font-family="Arial,sans-serif" font-size="16" fill="#999">Ref: ${esc(ref)}</text>
        <text x="40" y="420" font-family="Arial,sans-serif" font-size="18" fill="#333">${esc(ticket.guest_name || 'Guest')}</text>
        <text x="40" y="940" font-family="Arial,sans-serif" font-size="12" fill="#aaa">Scan QR to verify · waaiio.com</text>
        <text x="40" y="965" font-family="Arial,sans-serif" font-size="11" fill="#ccc">${esc(verifyUrl)}</text>
      </svg>
    `;
    composites.push({ input: Buffer.from(defaultSvg), top: 0, left: 0 });
    composites.push({ input: qrBuffer, top: 500, left: 560 });
  }

  const image = await sharp({
    create: { width, height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  })
    .composite(composites)
    .jpeg({ quality: 90 })
    .toBuffer();

  return new NextResponse(new Uint8Array(image), {
    headers: {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'public, max-age=3600, s-maxage=3600',
    },
  });
}

function esc(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

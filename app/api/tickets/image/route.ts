import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import QRCode from 'qrcode';
import sharp from 'sharp';

/**
 * GET /api/tickets/image?code=TK-ABC123
 * Generates a rich ticket image with event details + QR code.
 * Used by WhatsApp bot to send visual tickets after purchase.
 */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  if (!code) {
    return NextResponse.json({ error: 'Missing code parameter' }, { status: 400 });
  }

  const supabase = createServiceClient();

  // Fetch ticket + event details
  const { data: ticket } = await supabase
    .from('event_tickets')
    .select(`
      ticket_code, ticket_number, guest_name, status,
      event:events!event_id(name, date, time, venue),
      booking:bookings!booking_id(reference_code, business_id)
    `)
    .eq('ticket_code', code)
    .maybeSingle();

  if (!ticket) {
    return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
  }

  const event = ticket.event as { name: string; date: string; time: string; venue: string } | null;
  const booking = ticket.booking as { reference_code: string; business_id: string } | null;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://waaiio.com';
  const verifyUrl = `${appUrl}/tickets/${code}`;

  // Generate QR code as PNG buffer
  const qrBuffer = await QRCode.toBuffer(verifyUrl, {
    width: 300,
    margin: 2,
    color: { dark: '#000000', light: '#FFFFFF' },
  });

  // Build ticket image with Sharp: white card with text overlay + QR
  const width = 800;
  const height = 500;
  const eventName = event?.name || 'Event';
  const eventDate = event?.date
    ? new Date(event.date + 'T00:00').toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    : '';
  const eventTime = event?.time || '';
  const venue = event?.venue || '';
  const ref = booking?.reference_code || '';

  // Create SVG text overlay
  const svg = `
    <svg width="${width}" height="${height}">
      <rect width="100%" height="100%" fill="white" rx="16"/>
      <rect width="100%" height="80" fill="#6C2BD9" rx="16"/>
      <rect y="64" width="100%" height="16" fill="#6C2BD9"/>
      <text x="40" y="52" font-family="Arial,sans-serif" font-size="28" font-weight="bold" fill="white">🎟️ ${escapeXml(eventName)}</text>
      <text x="40" y="130" font-family="Arial,sans-serif" font-size="20" fill="#333">📅 ${escapeXml(eventDate)}${eventTime ? '  🕐 ' + escapeXml(eventTime) : ''}</text>
      <text x="40" y="165" font-family="Arial,sans-serif" font-size="18" fill="#666">${venue ? '📍 ' + escapeXml(venue) : ''}</text>
      <text x="40" y="210" font-family="Arial,sans-serif" font-size="20" font-weight="bold" fill="#6C2BD9">${escapeXml(code)}</text>
      <text x="40" y="240" font-family="Arial,sans-serif" font-size="16" fill="#999">Ref: ${escapeXml(ref)}</text>
      <text x="40" y="280" font-family="Arial,sans-serif" font-size="16" fill="#333">👤 ${escapeXml(ticket.guest_name || 'Guest')}</text>
      <text x="40" y="460" font-family="Arial,sans-serif" font-size="12" fill="#999">Scan QR or visit ${escapeXml(verifyUrl)}</text>
    </svg>
  `;

  const image = await sharp({
    create: { width, height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  })
    .composite([
      { input: Buffer.from(svg), top: 0, left: 0 },
      { input: qrBuffer, top: 140, left: 480 },
    ])
    .jpeg({ quality: 90 })
    .toBuffer();

  return new NextResponse(new Uint8Array(image), {
    headers: {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'public, max-age=3600, s-maxage=3600',
    },
  });
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

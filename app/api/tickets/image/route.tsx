import { ImageResponse } from 'next/og';
import { type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';

export const runtime = 'edge';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');

  if (!code) {
    return new Response('Missing code', { status: 400 });
  }

  // Fetch ticket + event + business data
  const supabase = createServiceClient();
  const { data: ticket } = await supabase
    .from('event_tickets')
    .select('ticket_code, guest_name, status, events:event_id(name, date, time, venue, image_url), businesses:business_id(name, logo_url)')
    .eq('ticket_code', code)
    .single();

  if (!ticket) {
    return new Response('Ticket not found', { status: 404 });
  }

  const event = ticket.events as unknown as { name: string; date: string; time?: string; venue?: string; image_url?: string } | null;
  const business = ticket.businesses as unknown as { name: string; logo_url?: string } | null;

  const eventName = event?.name || 'Event';
  const eventDate = event?.date
    ? new Date(event.date + 'T00:00').toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    : '';
  const eventTime = event?.time || '';
  const venue = event?.venue || '';
  const guestName = ticket.guest_name || 'Guest';
  const ticketCode = ticket.ticket_code;
  const businessName = business?.name || '';

  // QR code URL
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&format=png&color=1a1a1a&bgcolor=ffffff&data=${encodeURIComponent(`https://waaiio.com/tickets/${ticketCode}`)}`;

  const flyerUrl = event?.image_url || null;

  return new ImageResponse(
    (
      <div
        style={{
          width: '800',
          height: '400',
          display: 'flex',
          background: flyerUrl ? '#000' : 'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)',
          color: 'white',
          fontFamily: 'sans-serif',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {/* Event flyer as background (if available) */}
        {flyerUrl && (
          <img
            src={flyerUrl}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              opacity: 0.35,
            }}
          />
        )}

        {/* Dark overlay for readability */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            background: flyerUrl
              ? 'linear-gradient(135deg, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0.5) 50%, rgba(0,0,0,0.7) 100%)'
              : 'transparent',
            display: 'flex',
          }}
        />

        {/* Left side — Event details */}
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            padding: '40px',
            zIndex: 1,
          }}
        >
          {/* Business name */}
          <div style={{ fontSize: 14, color: '#a0a0c0', letterSpacing: '2px', textTransform: 'uppercase', marginBottom: '8px', display: 'flex' }}>
            {businessName}
          </div>

          {/* Event name */}
          <div style={{ fontSize: 28, fontWeight: 'bold', lineHeight: 1.2, marginBottom: '16px', display: 'flex' }}>
            {eventName}
          </div>

          {/* Date + Time */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '16px' }}>
            <div style={{ fontSize: 16, color: '#e0e0ff', display: 'flex' }}>
              {eventDate}{eventTime ? ` at ${eventTime}` : ''}
            </div>
            {venue && (
              <div style={{ fontSize: 14, color: '#a0a0c0', display: 'flex' }}>
                {venue}
              </div>
            )}
          </div>

          {/* Guest name */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', marginBottom: '12px' }}>
            <div style={{ fontSize: 11, color: '#808090', textTransform: 'uppercase', letterSpacing: '1px', display: 'flex' }}>Ticket Holder</div>
            <div style={{ fontSize: 18, fontWeight: 'bold', display: 'flex' }}>{guestName}</div>
          </div>

          {/* Ticket code */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ fontSize: 14, fontWeight: 'bold', color: '#6C2BD9', background: 'rgba(108, 43, 217, 0.15)', padding: '4px 12px', borderRadius: '6px', display: 'flex' }}>
              {ticketCode}
            </div>
          </div>
        </div>

        {/* Right side — QR code */}
        <div
          style={{
            width: '240px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '30px',
            borderLeft: '2px dashed rgba(255,255,255,0.15)',
            zIndex: 1,
          }}
        >
          {/* QR Code */}
          <div style={{ background: 'white', borderRadius: '12px', padding: '12px', display: 'flex' }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qrUrl} width={160} height={160} alt="QR" />
          </div>

          <div style={{ fontSize: 11, color: '#a0a0c0', marginTop: '12px', textAlign: 'center', display: 'flex' }}>
            Scan to verify
          </div>

          {/* Waaiio branding */}
          <div style={{ fontSize: 10, color: '#505060', marginTop: '8px', display: 'flex' }}>
            Powered by Waaiio
          </div>
        </div>
      </div>
    ),
    {
      width: 800,
      height: 400,
    },
  );
}

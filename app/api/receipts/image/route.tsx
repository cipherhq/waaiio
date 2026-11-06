import { ImageResponse } from 'next/og';
import { type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';

export const runtime = 'edge';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const ref = searchParams.get('ref');

  if (!ref) {
    return new Response('Missing ref', { status: 400 });
  }

  const supabase = createServiceClient();

  // Anyone holding the reference code can open this image, so it shows only
  // non-personal details: status, date, business and service. The customer's
  // name and the amount are left out (Owner decision 2026-11-06).
  // Try bookings first, then orders.
  let receiptData: {
    type: string;
    businessName: string;
    logoUrl?: string;
    serviceName: string;
    date: string;
    referenceCode: string;
    status: string;
    quantity?: number;
    subscriptionTier?: string;
  } | null = null;

  // Check bookings
  const { data: booking } = await supabase
    .from('bookings')
    .select('reference_code, date, status, quantity, services(name), businesses(name, logo_url, subscription_tier)')
    .eq('reference_code', ref)
    .maybeSingle();

  if (booking) {
    const biz = booking.businesses as unknown as { name: string; logo_url?: string; subscription_tier?: string } | null;
    const svc = booking.services as unknown as { name: string } | null;
    receiptData = {
      type: 'Booking Receipt',
      businessName: biz?.name || 'Business',
      logoUrl: biz?.logo_url || undefined,
      serviceName: svc?.name || 'Service',
      date: new Date(booking.date + 'T00:00').toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
      referenceCode: booking.reference_code,
      status: booking.status,
      quantity: booking.quantity || 1,
      subscriptionTier: biz?.subscription_tier || 'free',
    };
  }

  // Check orders if no booking
  if (!receiptData) {
    const { data: order } = await supabase
      .from('orders')
      .select('reference_code, status, created_at, businesses:business_id(name, logo_url, subscription_tier)')
      .eq('reference_code', ref)
      .maybeSingle();

    if (order) {
      const biz = order.businesses as unknown as { name: string; logo_url?: string; subscription_tier?: string } | null;
      receiptData = {
        type: 'Order Receipt',
        businessName: biz?.name || 'Business',
        logoUrl: biz?.logo_url || undefined,
        serviceName: 'Order',
        date: new Date(order.created_at).toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
        referenceCode: order.reference_code,
        status: order.status,
        subscriptionTier: biz?.subscription_tier || 'free',
      };
    }
  }

  if (!receiptData) {
    return new Response('Receipt not found', { status: 404 });
  }

  const r = receiptData;
  const statusColor = r.status === 'confirmed' || r.status === 'completed' || r.status === 'delivered'
    ? '#22c55e' : r.status === 'pending' ? '#f59e0b' : r.status === 'cancelled' ? '#ef4444' : '#6C2BD9';
  const statusLabel = r.status.charAt(0).toUpperCase() + r.status.slice(1);

  return new ImageResponse(
    (
      <div
        style={{
          width: '800',
          height: '420',
          display: 'flex',
          flexDirection: 'column',
          background: 'white',
          fontFamily: 'sans-serif',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {/* Top accent bar */}
        <div style={{ height: '6px', background: 'linear-gradient(90deg, #6C2BD9 0%, #9F67FF 100%)', display: 'flex' }} />

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '24px 40px 16px' }}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ fontSize: 22, fontWeight: 'bold', color: '#1a1a1a', display: 'flex' }}>{r.type}</div>
            <div style={{ fontSize: 13, color: '#888', marginTop: '2px', display: 'flex' }}>{r.businessName}</div>
          </div>
          <div
            style={{
              fontSize: 13,
              fontWeight: 'bold',
              color: statusColor,
              background: `${statusColor}18`,
              padding: '6px 16px',
              borderRadius: '20px',
              display: 'flex',
            }}
          >
            {statusLabel}
          </div>
        </div>

        {/* Divider */}
        <div style={{ height: '1px', background: '#eee', margin: '0 40px', display: 'flex' }} />

        {/* Body */}
        <div style={{ display: 'flex', flex: 1, padding: '20px 40px' }}>
          {/* Left — details */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ fontSize: 11, color: '#999', textTransform: 'uppercase', letterSpacing: '1px', display: 'flex' }}>Service</div>
              <div style={{ fontSize: 15, color: '#333', display: 'flex' }}>{r.serviceName}{r.quantity && r.quantity > 1 ? ` x${r.quantity}` : ''}</div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ fontSize: 11, color: '#999', textTransform: 'uppercase', letterSpacing: '1px', display: 'flex' }}>Date</div>
              <div style={{ fontSize: 15, color: '#333', display: 'flex' }}>{r.date}</div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ fontSize: 11, color: '#999', textTransform: 'uppercase', letterSpacing: '1px', display: 'flex' }}>Reference</div>
              <div style={{ fontSize: 14, color: '#6C2BD9', fontWeight: 'bold', display: 'flex' }}>{r.referenceCode}</div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 40px', background: '#fafafa', borderTop: '1px solid #eee' }}>
          {r.subscriptionTier !== 'business' && (
            <div style={{ fontSize: 11, color: '#aaa', display: 'flex' }}>Powered by Waaiio</div>
          )}
          {r.subscriptionTier !== 'business' && (
            <div style={{ fontSize: 11, color: '#aaa', display: 'flex' }}>waaiio.com</div>
          )}
        </div>
      </div>
    ),
    {
      width: 800,
      height: 420,
    },
  );
}

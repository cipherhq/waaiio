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

  // Try bookings first, then orders, then donations
  let receiptData: {
    type: string;
    businessName: string;
    logoUrl?: string;
    serviceName: string;
    date: string;
    amount: number;
    currency: string;
    referenceCode: string;
    status: string;
    guestName: string;
    quantity?: number;
  } | null = null;

  // Check bookings
  const { data: booking } = await supabase
    .from('bookings')
    .select('reference_code, date, total_amount, status, guest_name, quantity, services(name), businesses(name, logo_url, country_code)')
    .eq('reference_code', ref)
    .maybeSingle();

  if (booking) {
    const biz = booking.businesses as unknown as { name: string; logo_url?: string; country_code?: string } | null;
    const svc = booking.services as unknown as { name: string } | null;
    const cc = biz?.country_code || 'NG';
    receiptData = {
      type: 'Booking Receipt',
      businessName: biz?.name || 'Business',
      logoUrl: biz?.logo_url || undefined,
      serviceName: svc?.name || 'Service',
      date: new Date(booking.date + 'T00:00').toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
      amount: booking.total_amount || 0,
      currency: cc === 'US' ? '$' : cc === 'GB' ? '\u00A3' : cc === 'CA' ? 'CA$' : cc === 'GH' ? 'GH\u20B5' : '\u20A6',
      referenceCode: booking.reference_code,
      status: booking.status,
      guestName: booking.guest_name || 'Customer',
      quantity: booking.quantity || 1,
    };
  }

  // Check orders if no booking
  if (!receiptData) {
    const { data: order } = await supabase
      .from('orders')
      .select('reference_code, total_amount, status, created_at, businesses:business_id(name, logo_url, country_code), user:profiles!orders_user_id_fkey(first_name, last_name)')
      .eq('reference_code', ref)
      .maybeSingle();

    if (order) {
      const biz = order.businesses as unknown as { name: string; logo_url?: string; country_code?: string } | null;
      const user = order.user as unknown as { first_name?: string; last_name?: string } | null;
      const cc = biz?.country_code || 'NG';
      receiptData = {
        type: 'Order Receipt',
        businessName: biz?.name || 'Business',
        logoUrl: biz?.logo_url || undefined,
        serviceName: 'Order',
        date: new Date(order.created_at).toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
        amount: order.total_amount || 0,
        currency: cc === 'US' ? '$' : cc === 'GB' ? '\u00A3' : cc === 'CA' ? 'CA$' : cc === 'GH' ? 'GH\u20B5' : '\u20A6',
        referenceCode: order.reference_code,
        status: order.status,
        guestName: `${user?.first_name || ''} ${user?.last_name || ''}`.trim() || 'Customer',
      };
    }
  }

  if (!receiptData) {
    return new Response('Receipt not found', { status: 404 });
  }

  const r = receiptData;
  const formattedAmount = `${r.currency}${r.amount.toLocaleString()}`;
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
              <div style={{ fontSize: 11, color: '#999', textTransform: 'uppercase', letterSpacing: '1px', display: 'flex' }}>Customer</div>
              <div style={{ fontSize: 16, fontWeight: 'bold', color: '#1a1a1a', display: 'flex' }}>{r.guestName}</div>
            </div>

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

          {/* Right — amount */}
          <div style={{ width: '220px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', borderLeft: '1px solid #eee', paddingLeft: '30px' }}>
            <div style={{ fontSize: 11, color: '#999', textTransform: 'uppercase', letterSpacing: '1px', display: 'flex' }}>Amount Paid</div>
            <div style={{ fontSize: 36, fontWeight: 'bold', color: '#1a1a1a', marginTop: '8px', display: 'flex' }}>{formattedAmount}</div>
          </div>
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 40px', background: '#fafafa', borderTop: '1px solid #eee' }}>
          <div style={{ fontSize: 11, color: '#aaa', display: 'flex' }}>Powered by Waaiio</div>
          <div style={{ fontSize: 11, color: '#aaa', display: 'flex' }}>waaiio.com</div>
        </div>
      </div>
    ),
    {
      width: 800,
      height: 420,
    },
  );
}

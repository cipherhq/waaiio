import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { initializePayment } from '@/lib/bot/flows/shared/payment';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    const rateLimit = await rateLimitResponseAsync(getRateLimitKey(request, 'request-balance'), 10, 60_000);
    if (rateLimit) return rateLimit;

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { bookingId, businessId, table } = await request.json();
    if (!bookingId || !businessId) {
      return NextResponse.json({ error: 'bookingId and businessId required' }, { status: 400 });
    }

    // Verify ownership
    const { data: biz } = await supabase
      .from('businesses')
      .select('id, name, country_code, payment_gateway')
      .eq('id', businessId)
      .eq('owner_id', user.id)
      .single();

    if (!biz) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const serviceClient = createServiceClient();
    const dbTable = table === 'reservations' ? 'reservations' : 'bookings';

    // Get booking
    const { data: booking } = await serviceClient
      .from(dbTable)
      .select('id, reference_code, total_amount, deposit_amount, deposit_status, guest_name, guest_phone, guest_email, user_id')
      .eq('id', bookingId)
      .eq('business_id', businessId)
      .single();

    if (!booking) return NextResponse.json({ error: 'Booking not found' }, { status: 404 });

    const totalAmount = Number(booking.total_amount || 0);
    const depositPaid = booking.deposit_status === 'paid' ? Number(booking.deposit_amount || 0) : 0;
    const balance = totalAmount - depositPaid;

    if (balance <= 0) {
      return NextResponse.json({ error: 'No balance remaining' }, { status: 400 });
    }

    const cc = (biz.country_code || 'NG') as CountryCode;
    const phone = booking.guest_phone || '';
    if (!phone) return NextResponse.json({ error: 'No phone number on this booking' }, { status: 400 });

    // Initialize payment for the balance
    const result = await initializePayment(serviceClient, {
      bookingId: booking.id,
      userId: booking.user_id || '00000000-0000-0000-0000-000000000000',
      amount: balance,
      referenceCode: `${booking.reference_code}-BAL`,
      businessName: biz.name,
      phone,
      userEmail: booking.guest_email || undefined,
      countryCode: cc,
      businessId: biz.id,
    });

    if (!result) {
      return NextResponse.json({ error: 'Failed to create payment link' }, { status: 500 });
    }

    // Get direct gateway URL
    const { data: payment } = await serviceClient
      .from('payments')
      .select('gateway, gateway_reference, metadata')
      .eq('gateway_reference', result.reference)
      .eq('status', 'pending')
      .maybeSingle();

    let paymentUrl = result.url;
    if (payment?.gateway === 'paystack' && payment.gateway_reference) {
      paymentUrl = `https://checkout.paystack.com/${payment.gateway_reference}`;
    } else if (payment?.gateway === 'stripe') {
      const meta = (payment.metadata || {}) as Record<string, unknown>;
      const sessionId = meta.stripe_session_id as string;
      if (sessionId) {
        try {
          const key = process.env.STRIPE_SECRET_KEY || '';
          const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
            headers: { Authorization: `Bearer ${key}` },
          });
          const session = await res.json();
          if (session.url) paymentUrl = session.url;
        } catch { /* use shortened URL */ }
      }
    }

    // Send via WhatsApp
    const resolver = new ChannelResolver(serviceClient);
    const resolved = await resolver.resolveByBusinessId(businessId);

    if (resolved) {
      const toPhone = phone.startsWith('+') ? phone.slice(1) : phone;
      await resolved.sender.sendText({
        to: toPhone,
        text: [
          `💰 *Balance Payment Due*`,
          '',
          `from *${biz.name}*`,
          `🔑 Ref: *${booking.reference_code}*`,
          `💵 Balance: *${formatCurrency(balance, cc)}*`,
          '',
          `Pay here 👇`,
          paymentUrl,
        ].join('\n'),
      });
    }

    return NextResponse.json({ success: true, balance, paymentUrl });
  } catch (error) {
    logger.error('[BALANCE] Request balance error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

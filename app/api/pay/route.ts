import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';

/**
 * GET /api/pay?ref=XXXX
 *
 * Short payment URL redirect. Looks up the payment by reference code,
 * finds the gateway checkout URL, and redirects the customer.
 * Used to shorten long Stripe/Paystack checkout URLs in WhatsApp messages.
 */
export async function GET(request: NextRequest) {
  const ref = request.nextUrl.searchParams.get('ref');
  if (!ref) {
    return NextResponse.redirect(new URL('/', request.url));
  }

  const supabase = createServiceClient();

  // Look up payment by gateway_reference or booking reference_code
  const { data: payment } = await supabase
    .from('payments')
    .select('gateway, gateway_reference, metadata')
    .eq('gateway_reference', ref)
    .eq('status', 'pending')
    .maybeSingle();

  if (payment) {
    const meta = (payment.metadata || {}) as Record<string, unknown>;
    const stripeSessionId = meta.stripe_session_id as string;

    if (payment.gateway === 'stripe' && stripeSessionId) {
      // Retrieve Stripe checkout session URL
      const key = process.env.STRIPE_SECRET_KEY || '';
      if (key) {
        const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${stripeSessionId}`, {
          headers: { Authorization: `Bearer ${key}` },
        });
        const session = await res.json();
        if (session.url) {
          return NextResponse.redirect(session.url);
        }
      }
    }

    if (payment.gateway === 'paystack') {
      // Paystack checkout URLs follow a predictable pattern
      return NextResponse.redirect(`https://checkout.paystack.com/${ref}`);
    }
  }

  // Fallback: try looking up by booking reference
  const { data: booking } = await supabase
    .from('bookings')
    .select('id, reference_code')
    .eq('reference_code', ref)
    .maybeSingle();

  if (booking) {
    const { data: bookingPayment } = await supabase
      .from('payments')
      .select('gateway, gateway_reference, metadata')
      .eq('booking_id', booking.id)
      .eq('status', 'pending')
      .maybeSingle();

    if (bookingPayment?.gateway === 'stripe') {
      const meta = (bookingPayment.metadata || {}) as Record<string, unknown>;
      const sid = meta.stripe_session_id as string;
      if (sid) {
        const key = process.env.STRIPE_SECRET_KEY || '';
        const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sid}`, {
          headers: { Authorization: `Bearer ${key}` },
        });
        const session = await res.json();
        if (session.url) return NextResponse.redirect(session.url);
      }
    }
  }

  return NextResponse.redirect(new URL('/payment-success', request.url));
}

import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';

/**
 * GET /api/pay?ref=XXXX
 *
 * Short payment URL redirect. Looks up the payment by reference code,
 * finds the gateway checkout URL, and redirects the customer.
 * Used to shorten long Stripe/Paystack checkout URLs in WhatsApp messages.
 *
 * All redirects use explicit HTTP 302 (Found) for maximum browser/webview
 * compatibility, especially WhatsApp in-app browser and Nigerian mobile networks.
 */
export async function GET(request: NextRequest) {
  const ref = request.nextUrl.searchParams.get('ref');
  if (!ref || ref.length < 6) {
    return NextResponse.redirect(new URL('/', request.url), 302);
  }

  const supabase = createServiceClient();

  // Look up payment by gateway_reference (full or partial match)
  const safeRef = ref.replace(/[%_\\]/g, '\\$&');
  const { data: payment } = await supabase
    .from('payments')
    .select('gateway, gateway_reference, metadata')
    .like('gateway_reference', `%${safeRef}`)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (payment) {
    const meta = (payment.metadata || {}) as Record<string, unknown>;

    // Use stored checkout URL if available (works for all gateways)
    const storedUrl = meta.checkout_url as string;
    if (storedUrl) {
      const ALLOWED_DOMAINS = ['paystack.com', 'checkout.paystack.com', 'stripe.com', 'checkout.stripe.com', 'js.stripe.com', 'checkout.flutterwave.com', 'squareup.com', 'sandbox.paypal.com', 'paypal.com', 'waaiio.com', 'www.waaiio.com'];
      try {
        const urlObj = new URL(storedUrl);
        if (!ALLOWED_DOMAINS.some(d => urlObj.hostname === d || urlObj.hostname.endsWith('.' + d))) {
          return NextResponse.json({ error: 'Invalid redirect' }, { status: 400 });
        }
      } catch {
        return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });
      }
      return NextResponse.redirect(storedUrl, 302);
    }

    // Fallback: reconstruct gateway URL
    if (payment.gateway === 'stripe') {
      const stripeSessionId = meta.stripe_session_id as string;
      if (stripeSessionId) {
        const key = process.env.STRIPE_SECRET_KEY || '';
        if (key) {
          const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${stripeSessionId}`, {
            headers: { Authorization: `Bearer ${key}` },
          });
          const session = await res.json();
          if (session.url) {
            return NextResponse.redirect(session.url, 302);
          }
        }
      }
    }

    // Paystack fallback: use stored access_code (the correct checkout identifier).
    // Never fabricate checkout.paystack.com/<gateway_reference> — gateway_reference
    // is the transaction reference, not the access code.
    if (payment.gateway === 'paystack') {
      const accessCode = meta.access_code as string;
      if (accessCode) {
        return NextResponse.redirect(`https://checkout.paystack.com/${accessCode}`, 302);
      }
      // No stored checkout URL and no access code — cannot safely redirect to provider
      return NextResponse.redirect(new URL('/payment-success?error=link-expired', request.url), 302);
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
        if (session.url) return NextResponse.redirect(session.url, 302);
      }
    }
  }

  return NextResponse.redirect(new URL('/payment-success', request.url), 302);
}

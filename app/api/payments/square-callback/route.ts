import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';

/**
 * GET /api/payments/square-callback?ref=xxx
 *
 * Square redirects customers here after completing payment on the hosted checkout page.
 * We look up the payment, verify it via webhook (async), and redirect the customer
 * back to WhatsApp or a thank-you page.
 */
export async function GET(request: NextRequest) {
  const ref = request.nextUrl.searchParams.get('ref');

  if (!ref) {
    return NextResponse.redirect(new URL('/', request.url));
  }

  try {
    const supabase = createServiceClient();

    // Look up the payment by the idempotency key (stored as gateway_reference or in metadata)
    const { data: payment } = await supabase
      .from('payments')
      .select('id, booking_id, invoice_id, status, metadata')
      .or(`gateway_reference.eq.${ref},metadata->>square_payment_link_id.eq.${ref}`)
      .maybeSingle();

    if (!payment) {
      // Payment not found — redirect to homepage
      return NextResponse.redirect(new URL('/?payment=not_found', request.url));
    }

    // Find the business for this payment to get the WhatsApp link
    let businessId: string | null = null;
    let botCode: string | null = null;

    if (payment.booking_id) {
      const { data: booking } = await supabase
        .from('bookings')
        .select('business_id')
        .eq('id', payment.booking_id)
        .single();
      businessId = booking?.business_id || null;
    }

    if (payment.invoice_id && !businessId) {
      const { data: invoice } = await supabase
        .from('invoices')
        .select('business_id')
        .eq('id', payment.invoice_id)
        .single();
      businessId = invoice?.business_id || null;
    }

    if (businessId) {
      const { data: business } = await supabase
        .from('businesses')
        .select('bot_code')
        .eq('id', businessId)
        .single();
      botCode = business?.bot_code || null;
    }

    // Determine the WhatsApp number to redirect back to
    const waNumber = process.env.NEXT_PUBLIC_WHATSAPP_NUMBER_US || process.env.NEXT_PUBLIC_WHATSAPP_NUMBER_NG || '';

    if (waNumber && botCode) {
      // Redirect back to WhatsApp conversation with the business
      const waUrl = `https://wa.me/${waNumber}?text=${encodeURIComponent('paid')}`;
      return NextResponse.redirect(waUrl);
    }

    // Fallback: redirect to a simple thank-you
    return NextResponse.redirect(new URL('/?payment=success', request.url));
  } catch {
    return NextResponse.redirect(new URL('/?payment=error', request.url));
  }
}

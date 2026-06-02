import { NextResponse, type NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createServiceClient } from '@/lib/supabase/service';
import { initializePayment } from '@/lib/bot/flows/shared/payment';
import { rateLimitResponse, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

/** Fetch the direct gateway checkout URL from the payments table */
async function getDirectGatewayUrl(supabase: SupabaseClient, reference: string): Promise<string | null> {
  const { data: payment } = await supabase
    .from('payments')
    .select('gateway, gateway_reference, metadata')
    .eq('gateway_reference', reference)
    .eq('status', 'pending')
    .maybeSingle();

  if (!payment) return null;

  if (payment.gateway === 'paystack' && payment.gateway_reference) {
    return `https://checkout.paystack.com/${payment.gateway_reference}`;
  }

  if (payment.gateway === 'stripe') {
    const meta = (payment.metadata || {}) as Record<string, unknown>;
    const sessionId = meta.stripe_session_id as string;
    if (sessionId) {
      try {
        const key = process.env.STRIPE_SECRET_KEY || '';
        const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
          headers: { Authorization: `Bearer ${key}` },
        });
        const session = await res.json();
        if (session.url) return session.url;
      } catch { /* fall through */ }
    }
  }

  return null;
}

export async function POST(request: NextRequest) {
  const rateLimit = rateLimitResponse(getRateLimitKey(request, 'invoice-pay'), 10, 60_000);
  if (rateLimit) return rateLimit;

  try {
    const body = await request.json();
    const { token } = body;

    if (!token) {
      return NextResponse.json({ error: 'Token is required' }, { status: 400 });
    }

    const supabase = createServiceClient();

    const { data: invoice } = await supabase
      .from('invoices')
      .select('id, business_id, reference_code, total_amount, amount_paid, currency, status, token_expires_at, customer_phone, customer_email, customer_name')
      .eq('token', token)
      .single();

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
    }

    // Validate
    if (invoice.status === 'paid') {
      return NextResponse.json({ error: 'Invoice already paid' }, { status: 400 });
    }
    if (invoice.status === 'cancelled') {
      return NextResponse.json({ error: 'Invoice has been cancelled' }, { status: 400 });
    }
    if (invoice.token_expires_at && new Date(invoice.token_expires_at) < new Date()) {
      return NextResponse.json({ error: 'Payment link has expired' }, { status: 400 });
    }

    // Check for existing pending payment to prevent duplicates
    const { data: existingPayment } = await supabase
      .from('payments')
      .select('id, gateway_reference, status')
      .eq('invoice_id', invoice.id)
      .eq('status', 'pending')
      .maybeSingle();

    if (existingPayment) {
      // Re-use existing pending payment — fetch gateway URL from metadata
      // For now, create a new one (old pending one will be superseded by webhook)
    }

    // Fetch business info for payment
    const { data: biz } = await supabase
      .from('businesses')
      .select('id, name, country_code, payment_gateway')
      .eq('id', invoice.business_id)
      .single();

    if (!biz) {
      return NextResponse.json({ error: 'Business not found' }, { status: 500 });
    }

    const { getCountry } = await import('@/lib/countries');
    const countryCode = biz.country_code || 'NG';

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';

    // Calculate balance (partial payments supported)
    const balance = invoice.total_amount - (invoice.amount_paid || 0);
    if (balance <= 0) {
      return NextResponse.json({ error: 'Invoice already paid' }, { status: 400 });
    }

    const result = await initializePayment(supabase, {
      invoiceId: invoice.id,
      userId: '00000000-0000-0000-0000-000000000000', // public, no auth user
      amount: balance,
      referenceCode: invoice.reference_code,
      businessName: biz.name,
      phone: invoice.customer_phone || '',
      userEmail: invoice.customer_email || undefined,
      countryCode: countryCode as 'NG' | 'US' | 'GB' | 'GH' | 'KE' | 'ZA',
      gatewayOverride: biz.payment_gateway,
      businessId: biz.id,
    });

    if (!result) {
      return NextResponse.json({ error: 'Failed to initialize payment. Please contact the business.' }, { status: 500 });
    }

    // Get the direct gateway URL (not the shortened WhatsApp URL)
    // The shortened URL (/api/pay?ref=XX) doesn't reliably resolve for all gateways
    const gatewayUrl = await getDirectGatewayUrl(supabase, result.reference);

    return NextResponse.json({ url: gatewayUrl || result.url, reference: result.reference });
  } catch (err) {
    logger.error('invoices/pay error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

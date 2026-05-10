import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { initializePayment } from '@/lib/bot/flows/shared/payment';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { rateLimitResponse, getRateLimitKey } from '@/lib/rate-limit';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    const rateLimit = rateLimitResponse(getRateLimitKey(request, 'payment-request'), 20, 60_000);
    if (rateLimit) return rateLimit;

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { businessId, customerPhone, customerName, amount, description } = await request.json();

    if (!businessId || !customerPhone || !amount) {
      return NextResponse.json({ error: 'businessId, customerPhone, and amount are required' }, { status: 400 });
    }

    if (typeof amount !== 'number' || amount <= 0) {
      return NextResponse.json({ error: 'Amount must be a positive number' }, { status: 400 });
    }

    // Verify ownership
    const { data: biz } = await supabase
      .from('businesses')
      .select('id, name, country_code, payment_gateway')
      .eq('id', businessId)
      .eq('owner_id', user.id)
      .single();

    if (!biz) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const cc = (biz.country_code || 'NG') as CountryCode;
    const phone = customerPhone.replace(/\D/g, '');
    if (!phone || phone.length < 7) {
      return NextResponse.json({ error: 'Invalid phone number' }, { status: 400 });
    }

    // Generate reference code
    const refCode = `PAY-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

    const serviceClient = createServiceClient();

    // Create booking record for payment tracking
    const { data: booking, error: bookingError } = await serviceClient
      .from('bookings')
      .insert({
        business_id: businessId,
        user_id: user.id,
        guest_name: customerName || 'Customer',
        guest_phone: phone,
        reference_code: refCode,
        total_amount: amount,
        status: 'confirmed',
        flow_type: 'payment',
        notes: description || null,
      })
      .select('id, reference_code')
      .single();

    if (bookingError || !booking) {
      logger.error('[PAYMENT-REQUEST] Failed to create booking:', bookingError);
      return NextResponse.json({ error: 'Failed to create payment record' }, { status: 500 });
    }

    // Initialize payment
    const result = await initializePayment(serviceClient, {
      bookingId: booking.id,
      userId: user.id,
      amount,
      referenceCode: refCode,
      businessName: biz.name,
      phone,
      countryCode: cc,
      gatewayOverride: biz.payment_gateway,
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

    // Send WhatsApp message
    const resolver = new ChannelResolver(serviceClient);
    const resolved = await resolver.resolveByBusinessId(businessId);

    if (resolved) {
      const toPhone = phone.startsWith('+') ? phone.slice(1) : phone;
      const message = [
        `💳 *Payment Request*`,
        '',
        `from *${biz.name}*`,
        `💰 Amount: *${formatCurrency(amount, cc)}*`,
        description ? `📝 ${description}` : '',
        '',
        `Pay here 👇`,
        paymentUrl,
      ].filter(Boolean).join('\n');

      try {
        await resolved.sender.sendText({ to: toPhone, text: message });
      } catch (sendErr) {
        logger.error('[PAYMENT-REQUEST] WhatsApp send failed:', sendErr);
      }
    }

    return NextResponse.json({
      success: true,
      paymentUrl,
      reference: refCode,
    });
  } catch (error) {
    logger.error('[PAYMENT-REQUEST] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

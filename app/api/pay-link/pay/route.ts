import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

/** Gateways that require a valid E.164 phone to initialize payment. */
const PHONE_REQUIRED_GATEWAYS = new Set(['paystack', 'flutterwave']);

const E164_REGEX = /^\+[1-9]\d{7,14}$/;

/** Normalize a raw phone string to +E.164 or return null if invalid. */
function normalizePhone(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const trimmed = raw.trim().replace(/[\s\-()]/g, '');
  const withPlus = trimmed.startsWith('+') ? trimmed : `+${trimmed}`;
  return E164_REGEX.test(withPlus) ? withPlus : null;
}

/**
 * POST /api/pay-link/pay — Public endpoint (CSRF-exempt).
 * Initializes payment for a scan-to-pay link.
 *
 * #736 fix: validate payer phone before creating any payment record so
 * Paystack-routed businesses never leave orphaned pending rows.
 */
export async function POST(request: NextRequest) {
  // Rate limit: 20 requests per minute per IP
  const rl = await rateLimitResponseAsync(getRateLimitKey(request, 'pay-link'), 20, 60_000);
  if (rl) return rl;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { token, amount, customer_name, customer_email, customer_phone } = body as {
    token?: string;
    amount?: number;
    customer_name?: string;
    customer_email?: string;
    customer_phone?: string;
  };

  if (!token || typeof token !== 'string') {
    return NextResponse.json({ error: 'Token is required' }, { status: 400 });
  }

  if (!amount || typeof amount !== 'number' || amount <= 0 || amount > 10_000_000) {
    return NextResponse.json({ error: 'Invalid amount' }, { status: 400 });
  }

  const supabase = createServiceClient();

  // Fetch payment link with business info
  const { data: link } = await supabase
    .from('payment_links')
    .select(
      'id, title, amount, currency, uses_count, expires_at, max_uses, business_id, is_active, businesses!inner(name, country_code, payment_gateway, status)',
    )
    .eq('token', token)
    .eq('is_active', true)
    .single();

  if (!link) {
    return NextResponse.json(
      { error: 'Payment link not found or inactive' },
      { status: 404 },
    );
  }

  // Check expiry
  if (link.expires_at && new Date(link.expires_at) < new Date()) {
    return NextResponse.json({ error: 'This payment link has expired' }, { status: 410 });
  }

  // Check max uses
  if (link.max_uses && (link.uses_count ?? 0) >= link.max_uses) {
    return NextResponse.json({ error: 'This payment link has reached its usage limit' }, { status: 410 });
  }

  // If fixed amount, verify it matches (allow 1 unit tolerance for rounding)
  if (link.amount && Math.abs(link.amount - amount) > 1) {
    return NextResponse.json({ error: 'Amount mismatch' }, { status: 400 });
  }

  const biz = link.businesses as unknown as {
    name: string;
    country_code: string;
    payment_gateway: string;
    status: string;
  };

  // Business must be active to accept payments (#493 B3)
  if (biz.status !== 'active') {
    return NextResponse.json(
      { error: 'This business is not yet set up to accept payments. Please contact the business owner.' },
      { status: 503 },
    );
  }

  // Resolve canonical gateway — no silent fallback to any provider (#493)
  const { resolveBusinessGateway } = await import('@/lib/payments/gateway-resolver');
  const gatewayResult = await resolveBusinessGateway(supabase, link.business_id);
  if (!gatewayResult.gateway) {
    logger.error('[PAY-LINK] No canonical gateway for business:', {
      business_id: link.business_id,
      country_code: biz.country_code,
      reason: gatewayResult.reason,
    });
    return NextResponse.json(
      { error: 'Payment is not available for this business. Please contact the business owner.' },
      { status: 503 },
    );
  }

  const currency = link.currency || gatewayResult.currency;
  const gatewayName = gatewayResult.gateway;

  // #736: Validate payer phone BEFORE creating any payment record.
  // Paystack/Flutterwave require a valid E.164 phone for initialization;
  // passing an empty string causes canonicalSavedCardPhone to return null,
  // which makes the gateway return null and leaves an orphaned pending row.
  const normalizedPhone = normalizePhone(customer_phone);
  if (PHONE_REQUIRED_GATEWAYS.has(gatewayName) && !normalizedPhone) {
    return NextResponse.json(
      {
        error: 'A valid phone number is required to pay. Please enter your phone number in international format (e.g. +234XXXXXXXXXX).',
        code: 'PHONE_REQUIRED',
      },
      { status: 422 },
    );
  }

  const refCode = `PL-${Date.now().toString(36).toUpperCase()}`;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';

  // One canonical row owns the anonymous checkout and scan-to-pay metadata.
  let payment: { id: string } | null = null;
  try {
    const { data, error: paymentError } = await supabase
      .from('payments')
      .insert({
        business_id: link.business_id,
        user_id: null,
        amount,
        currency,
        gateway: gatewayName,
        gateway_reference: refCode,
        status: 'pending',
        metadata: {
          payment_link_id: link.id,
          customer_name: customer_name || null,
          customer_phone: normalizedPhone,
          source: 'scan_to_pay',
        },
      })
      .select('id')
      .single();

    if (paymentError || !data?.id) throw new Error('Canonical payment unavailable');
    payment = data;
  } catch {
    logger.error('[PAY-LINK] Canonical payment creation failed');
    return NextResponse.json({ error: 'Failed to create payment' }, { status: 500 });
  }
  if (!payment?.id) {
    logger.error('[PAY-LINK] Canonical payment creation failed');
    return NextResponse.json({ error: 'Failed to create payment' }, { status: 500 });
  }

  const paymentId = payment.id;
  const paymentBusinessId = link.business_id;

  // This records local failure only; it does not cancel a provider session.
  async function failInitialization(message: string) {
    let cleanupConfirmed = false;
    try {
      const { data: changed, error } = await supabase
        .from('payments')
        .update({ status: 'failed' })
        .eq('id', paymentId)
        .eq('business_id', paymentBusinessId)
        .eq('status', 'pending')
        .select('id')
        .maybeSingle();
      if (!error) {
        if (changed?.id) {
          cleanupConfirmed = true;
        } else {
          // A webhook may have completed the row. Never demote terminal state.
          const { data: current, error: readError } = await supabase
            .from('payments')
            .select('status')
            .eq('id', paymentId)
            .eq('business_id', paymentBusinessId)
            .maybeSingle();
          cleanupConfirmed = !readError && !!current && current.status !== 'pending';
        }
      }
    } catch {
      // Keep checkout failure visible even when local cleanup cannot be confirmed.
    }
    if (!cleanupConfirmed) {
      logger.error('[PAY-LINK] Payment failure status could not be confirmed', { payment_id: paymentId });
    }
    return NextResponse.json({
      error: message,
      ...(!cleanupConfirmed && { code: 'PAYMENT_STATUS_UNCONFIRMED' }),
    }, { status: 500 });
  }

  try {
    const { getPaymentGatewayByName } = await import('@/lib/payments/factory');
    const gateway = getPaymentGatewayByName(gatewayName);
    const email = customer_email || `${refCode.toLowerCase()}@pay.waaiio.com`;

    const result = await gateway.initializePayment({
      supabase,
      amount,
      currency,
      referenceCode: refCode,
      businessName: biz.name,
      phone: normalizedPhone || '',
      userEmail: email,
      userId: null,
      existingPaymentId: paymentId,
      callbackUrl: `${appUrl}/payment-success?ref=${refCode}`,
      businessId: link.business_id,
    });

    if (typeof result?.url !== 'string' || !result.url.trim()
      || typeof result.reference !== 'string' || !result.reference.trim()) {
      return failInitialization('Failed to initialize payment. Please check your details and try again.');
    }

    const { data: persisted, error: referenceError } = await supabase
      .from('payments')
      .update({ gateway_reference: result.reference })
      .eq('id', paymentId)
      .eq('business_id', link.business_id)
      .select('id, gateway_reference')
      .single();
    if (referenceError || persisted?.id !== paymentId || persisted.gateway_reference !== result.reference) {
      return failInitialization('Failed to confirm payment checkout. Please try again.');
    }

    // Only a checkout with a confirmed canonical reference consumes a use.
    await supabase.rpc('increment_payment_link_uses', {
      link_id: link.id,
    }).then(({ error: rpcErr }) => {
      // Preserve the existing compatibility fallback for this counter.
      if (rpcErr) {
        supabase
          .from('payment_links')
          .update({ uses_count: (link.uses_count ?? 0) + 1 })
          .eq('id', link.id)
          .then(() => {});
      }
    });
    return NextResponse.json({ url: result.url });
  } catch {
    logger.error('[PAY-LINK] Payment initialization failed');
    return failInitialization('Payment service unavailable');
  }
}

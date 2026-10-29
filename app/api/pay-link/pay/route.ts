import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

/** Gateways that require a valid E.164 phone to initialize payment. */
const PHONE_REQUIRED_GATEWAYS = new Set(['paystack', 'flutterwave']);

const E164_REGEX = /^\+[1-9]\d{7,14}$/;

/** Normalize a raw phone string to +E.164 or return null if invalid. */
function normalizePhone(raw: string | undefined | null): string | null {
  if (!raw || !raw.trim()) return null;
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

  // Initialize gateway payment BEFORE creating a local payment record.
  // The gateway adapter (paystack.ts, stripe.ts) creates its own payment row
  // on success; pre-creating one here caused duplicate/orphaned rows (#736).
  try {
    const { getPaymentGatewayByName } = await import('@/lib/payments/factory');
    const gateway = getPaymentGatewayByName(gatewayName);

    const email =
      customer_email ||
      `${refCode.toLowerCase()}@pay.waaiio.com`;

    const result = await gateway.initializePayment({
      supabase,
      amount,
      currency,
      referenceCode: refCode,
      businessName: biz.name,
      phone: normalizedPhone || '',
      userEmail: email,
      userId: '00000000-0000-0000-0000-000000000000', // anonymous payer
      callbackUrl: `${appUrl}/payment-success?ref=${refCode}`,
      businessId: link.business_id,
    });

    if (result?.url) {
      // Increment uses count atomically
      await supabase.rpc('increment_payment_link_uses', {
        link_id: link.id,
      }).then(({ error: rpcErr }) => {
        // Fallback to simple update if RPC doesn't exist yet
        if (rpcErr) {
          supabase
            .from('payment_links')
            .update({ uses_count: (link.uses_count ?? 0) + 1 })
            .eq('id', link.id)
            .then(() => {});
        }
      });

      return NextResponse.json({ url: result.url });
    }

    return NextResponse.json(
      { error: 'Failed to initialize payment. Please check your details and try again.' },
      { status: 500 },
    );
  } catch (err) {
    logger.error('[PAY-LINK] Payment init error:', err);
    return NextResponse.json(
      { error: 'Payment service unavailable' },
      { status: 500 },
    );
  }
}

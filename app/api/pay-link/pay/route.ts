import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import type { CountryCode } from '@/lib/constants';

/**
 * POST /api/pay-link/pay — Public endpoint (CSRF-exempt).
 * Initializes payment for a scan-to-pay link.
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
      'id, title, amount, currency, uses_count, expires_at, max_uses, business_id, is_active, businesses!inner(name, country_code, payment_gateway)',
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
  };

  const refCode = `PL-${Date.now().toString(36).toUpperCase()}`;
  const email = customer_email || `${refCode.toLowerCase()}@pay.waaiio.com`;

  // Route through the shared payment initializer (resolver determines gateway)
  try {
    const { initializePayment } = await import('@/lib/bot/flows/shared/payment');

    const result = await initializePayment(supabase, {
      amount,
      referenceCode: refCode,
      businessName: biz.name,
      phone: customer_phone || '',
      userEmail: email,
      userId: '00000000-0000-0000-0000-000000000000', // anonymous payer
      countryCode: (biz.country_code || 'NG') as CountryCode,
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
      { error: 'Failed to initialize payment' },
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

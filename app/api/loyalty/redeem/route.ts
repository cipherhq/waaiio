import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { authenticateRequest } from '@/lib/api-auth';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    const rateLimit = await rateLimitResponseAsync(getRateLimitKey(request, 'loyalty-redeem'), 20, 60_000);
    if (rateLimit) return rateLimit;

    const body = await request.json();
    const auth = await authenticateRequest(request, { requireBusinessOwnership: true, body });
    if (auth instanceof NextResponse) return auth;

    const { businessId, customerPhone, points } = body;
    // A stable client-generated key is mandatory: replay must not debit twice.
    const requestId = request.headers.get('Idempotency-Key') || body.redemptionId;
    if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
      return NextResponse.json({ error: 'Stable Idempotency-Key UUID required' }, { status: 428 });
    }
    if (!businessId || !customerPhone || !points) {
      return NextResponse.json({ error: 'businessId, customerPhone, and points required' }, { status: 400 });
    }

    if (!Number.isSafeInteger(points)) {
      return NextResponse.json({ error: 'Points must be a positive integer' }, { status: 400 });
    }

    if (points <= 0) {
      return NextResponse.json({ error: 'Points must be positive' }, { status: 400 });
    }

    const supabase = createServiceClient();

    // Get loyalty account
    const { data: loyalty } = await supabase
      .from('loyalty_points')
      .select('id, points_balance')
      .eq('business_id', businessId)
      .eq('customer_phone', customerPhone)
      .single();

    if (!loyalty) {
      return NextResponse.json({ error: 'Customer not found in loyalty program' }, { status: 404 });
    }

    // M434 atomically creates receipt and debits points; no separate INSERT.
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const codeBytes = crypto.getRandomValues(new Uint8Array(6));
    const proposedCode = 'RW-' + Array.from(codeBytes, b => chars[b % chars.length]).join('');
    const { data: receipt, error: redeemError } = await supabase.rpc('redeem_loyalty_reward_once', {
      p_loyalty_id: loyalty.id,
      p_business_id: businessId,
      p_customer_phone: customerPhone,
      p_points: points,
      p_redemption_key: `api:${requestId}`,
      p_redemption_code: proposedCode,
    });

    if (redeemError) {
      logger.error('[LOYALTY] Atomic redemption failed:', redeemError);
      return NextResponse.json({ error: 'Loyalty redemption unavailable' }, { status: 503 });
    }
    if (receipt?.success !== true) {
      return NextResponse.json({ error: 'Insufficient points or invalid redemption' }, { status: 400 });
    }
    // Do not acknowledge a debit as fulfilled unless the transaction returned
    // a valid, durable receipt. Retries with the SAME idempotency key are safe.
    if (typeof receipt.code !== 'string' || !/^RW-[A-Z2-9]{6}$/.test(receipt.code)
      || !Number.isSafeInteger(receipt.points_balance) || receipt.points_balance < 0) {
      logger.error('[LOYALTY] Atomic redemption returned malformed receipt');
      return NextResponse.json({ error: 'Loyalty redemption receipt unavailable; retry with the same Idempotency-Key' }, { status: 503 });
    }
    return NextResponse.json({
      success: true,
      new_balance: receipt.points_balance,
      redemption_code: receipt.code,
      replayed: receipt.replayed === true,
    });
  } catch (error) {
    logger.error('[LOYALTY] Redeem error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

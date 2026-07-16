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

    const { businessId, customerPhone, points, reason } = body;
    if (!businessId || !customerPhone || !points) {
      return NextResponse.json({ error: 'businessId, customerPhone, and points required' }, { status: 400 });
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

    // Atomic deduction with row-level locking (prevents double-redeem)
    const { data: success } = await supabase.rpc('redeem_loyalty_points', {
      p_loyalty_id: loyalty.id,
      p_points: points,
    });

    if (!success) {
      return NextResponse.json({ error: 'Insufficient points balance' }, { status: 400 });
    }

    // Record transaction
    await supabase.from('loyalty_transactions').insert({
      business_id: businessId,
      customer_phone: customerPhone,
      points_change: -points,
      reason: reason || 'redemption',
    });

    return NextResponse.json({
      success: true,
      new_balance: loyalty.points_balance - points,
    });
  } catch (error) {
    logger.error('[LOYALTY] Redeem error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

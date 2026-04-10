import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { authenticateRequest } from '@/lib/api-auth';
import { rateLimitResponse, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    const rateLimit = rateLimitResponse(getRateLimitKey(request, 'chat-reopen'), 30, 60_000);
    if (rateLimit) return rateLimit;

    const body = await request.json();
    const auth = await authenticateRequest(request, { requireBusinessOwnership: true, body });
    if (auth instanceof NextResponse) return auth;

    const { businessId, customerPhone } = body;
    if (!businessId || !customerPhone) {
      return NextResponse.json({ error: 'businessId and customerPhone required' }, { status: 400 });
    }

    const supabase = createServiceClient();

    await supabase.from('chat_conversations').update({
      status: 'open',
      resolved_at: null,
      resolved_by: null,
    })
      .eq('business_id', businessId)
      .eq('customer_phone', customerPhone);

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('[CHAT] Reopen error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

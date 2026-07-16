import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { resolveConversation } from '@/lib/bot/handoff.service';
import { authenticateRequest } from '@/lib/api-auth';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    const rateLimit = await rateLimitResponseAsync(getRateLimitKey(request, 'chat-resolve'), 30, 60_000);
    if (rateLimit) return rateLimit;

    const body = await request.json();
    const auth = await authenticateRequest(request, { requireBusinessOwnership: true, body });
    if (auth instanceof NextResponse) return auth;

    const { businessId, customerPhone } = body;
    if (!businessId || !customerPhone) {
      return NextResponse.json({ error: 'businessId and customerPhone required' }, { status: 400 });
    }

    const supabase = createServiceClient();

    const resolver = new ChannelResolver(supabase);
    const resolved = await resolver.resolveByBusinessId(businessId);
    if (!resolved?.sender) {
      return NextResponse.json({ error: 'No messaging channel configured' }, { status: 400 });
    }

    await resolveConversation({
      supabase,
      sender: resolved.sender,
      businessId,
      customerPhone,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('[CHAT] Resolve error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { resolveConversation } from '@/lib/bot/handoff.service';

export async function POST(request: NextRequest) {
  try {
    const { businessId, customerPhone } = await request.json();
    if (!businessId || !customerPhone) {
      return NextResponse.json({ error: 'businessId and customerPhone required' }, { status: 400 });
    }

    const supabase = createServiceClient();

    const resolver = new ChannelResolver(supabase);
    const resolved = await resolver.resolveByBusinessId(businessId);

    if (!resolved) {
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
    console.error('[CHAT] Resolve error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

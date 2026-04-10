import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { authenticateRequest } from '@/lib/api-auth';
import { rateLimitResponse, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    const rateLimit = rateLimitResponse(getRateLimitKey(request, 'waitlist-notify'), 20, 60_000);
    if (rateLimit) return rateLimit;

    const body = await request.json();
    const auth = await authenticateRequest(request, { requireBusinessOwnership: true, body });
    if (auth instanceof NextResponse) return auth;

    const { businessId, entryId, count } = body;
    if (!businessId) {
      return NextResponse.json({ error: 'businessId required' }, { status: 400 });
    }

    const supabase = createServiceClient();

    // Get business name
    const { data: biz } = await supabase
      .from('businesses')
      .select('name')
      .eq('id', businessId)
      .single();

    const bizName = biz?.name || 'Business';

    // Get channel resolver for sending messages
    const resolver = new ChannelResolver(supabase);
    const resolved = await resolver.resolveByBusinessId(businessId);

    if (!resolved) {
      return NextResponse.json({ error: 'No messaging channel configured' }, { status: 400 });
    }

    let entries;

    if (entryId) {
      // Notify a specific entry
      const { data } = await supabase
        .from('waitlist_entries')
        .select('id, customer_phone, customer_name')
        .eq('id', entryId)
        .eq('business_id', businessId)
        .eq('status', 'waiting')
        .limit(1);
      entries = data;
    } else {
      // Notify first N waiting entries
      const limit = count || 5;
      const { data } = await supabase
        .from('waitlist_entries')
        .select('id, customer_phone, customer_name')
        .eq('business_id', businessId)
        .eq('status', 'waiting')
        .order('created_at', { ascending: true })
        .limit(limit);
      entries = data;
    }

    if (!entries || entries.length === 0) {
      return NextResponse.json({ message: 'No waiting entries to notify' });
    }

    const notified: string[] = [];

    for (const entry of entries) {
      try {
        const phone = entry.customer_phone.startsWith('+')
          ? entry.customer_phone.slice(1)
          : entry.customer_phone;

        const name = entry.customer_name || 'there';
        await resolved.sender.sendText({
          to: phone,
          text: `Hi ${name}! Great news — a spot has opened up at ${bizName}. Would you like to book? Reply *yes* to confirm or *no* to pass.`,
        });

        await supabase
          .from('waitlist_entries')
          .update({ status: 'notified', notified_at: new Date().toISOString() })
          .eq('id', entry.id);

        notified.push(entry.id);
      } catch (err) {
        logger.error('[WAITLIST] Notify error for entry:', entry.id, err);
      }
    }

    return NextResponse.json({ success: true, notified_count: notified.length });
  } catch (error) {
    logger.error('[WAITLIST] Notify error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { authenticateRequest } from '@/lib/api-auth';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

const STATUS_MESSAGES: Record<string, string> = {
  processing: 'Your order *{ref}* from *{biz}* is now being prepared.',
  shipped: 'Your order *{ref}* from *{biz}* has been shipped! It\'s on its way.',
  ready: 'Your order *{ref}* from *{biz}* is ready for pickup!',
  delivered: 'Your order *{ref}* from *{biz}* has been delivered. Thank you for your purchase!',
  cancelled: 'Your order *{ref}* from *{biz}* has been cancelled. If you have questions, please reach out.',
};

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    const rateLimit = await rateLimitResponseAsync(getRateLimitKey(request, 'order-bulk-status'), 10, 60_000);
    if (rateLimit) return rateLimit;

    const body = await request.json();
    const auth = await authenticateRequest(request, { requireBusinessOwnership: true, body });
    if (auth instanceof NextResponse) return auth;

    const { orderIds, businessId, status } = body;

    if (!Array.isArray(orderIds) || orderIds.length === 0 || orderIds.length > 50) {
      return NextResponse.json({ error: 'orderIds must be an array of 1-50 IDs' }, { status: 400 });
    }
    if (!businessId || !status) {
      return NextResponse.json({ error: 'businessId and status required' }, { status: 400 });
    }

    const validStatuses = ['pending', 'confirmed', 'processing', 'ready', 'shipped', 'delivered', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return NextResponse.json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` }, { status: 400 });
    }

    const supabase = createServiceClient();

    // Fetch all orders in one query — validate they belong to this business
    const { data: orders, error: fetchError } = await supabase
      .from('orders')
      .select('id, reference_code, delivery_phone, status')
      .in('id', orderIds)
      .eq('business_id', businessId);

    if (fetchError || !orders) {
      return NextResponse.json({ error: 'Failed to fetch orders' }, { status: 500 });
    }

    // Filter out orders already in target status
    const toUpdate = orders.filter(o => o.status !== status);
    if (toUpdate.length === 0) {
      return NextResponse.json({ success: true, updated: 0, notified: 0 });
    }

    // Bulk update all orders in one query (business_id filter for defense-in-depth)
    const updateIds = toUpdate.map(o => o.id);
    const { error: updateError } = await supabase.from('orders').update({ status }).in('id', updateIds).eq('business_id', businessId);
    if (updateError) {
      logger.error('[ORDER-BULK-STATUS] Update failed:', updateError);
      return NextResponse.json({ error: 'Failed to update orders' }, { status: 500 });
    }

    // Send notifications in parallel (best-effort)
    const { data: biz } = await supabase
      .from('businesses').select('name').eq('id', businessId).single();
    const bizName = biz?.name || 'your store';
    const messageTemplate = STATUS_MESSAGES[status];

    let notified = 0;
    if (messageTemplate) {
      const resolver = new ChannelResolver(supabase);
      const resolved = await resolver.resolveByBusinessId(businessId);
      if (!resolved?.sender) {
        logger.warn('[ORDER-BULK-STATUS] No messaging channel configured for business', businessId);
        return NextResponse.json({ success: true, updated: toUpdate.length, notified: 0 });
      }
      const sender = resolved.sender;

      const notifications = toUpdate
        .filter(o => o.delivery_phone)
        .map(async (order) => {
          const phone = order.delivery_phone!.startsWith('+')
            ? order.delivery_phone!.slice(1)
            : order.delivery_phone!;
          const message = messageTemplate.replace('{ref}', order.reference_code).replace('{biz}', bizName);
          await sender.sendText({ to: phone, text: message });
        });

      const results = await Promise.allSettled(notifications);
      notified = results.filter(r => r.status === 'fulfilled').length;
    }

    return NextResponse.json({ success: true, updated: toUpdate.length, notified });
  } catch (error) {
    logger.error('[ORDER-BULK-STATUS] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

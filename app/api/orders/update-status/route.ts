import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { GupshupService } from '@/lib/channels/gupshup';
import type { MessageSender } from '@/lib/channels/message-sender';
import { authenticateRequest } from '@/lib/api-auth';
import { rateLimitResponse, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

const STATUS_MESSAGES: Record<string, string> = {
  processing: 'Your order *{ref}* from *{biz}* is now being prepared.',
  shipped: 'Your order *{ref}* from *{biz}* has been shipped! It\'s on its way.',
  ready: 'Your order *{ref}* from *{biz}* is ready for pickup!',
  delivered: 'Your order *{ref}* from *{biz}* has been delivered. Thank you for your purchase!',
  cancelled: 'Your order *{ref}* from *{biz}* has been cancelled. If you have questions, please reach out.',
};

let defaultGupshup: GupshupService;
function getDefaultGupshup() {
  if (!defaultGupshup) defaultGupshup = new GupshupService();
  return defaultGupshup;
}

export async function POST(request: NextRequest) {
  try {
    const rateLimit = rateLimitResponse(getRateLimitKey(request, 'order-status'), 30, 60_000);
    if (rateLimit) return rateLimit;

    const body = await request.json();
    const auth = await authenticateRequest(request, { requireBusinessOwnership: true, body });
    if (auth instanceof NextResponse) return auth;

    const { orderId, businessId, status } = body;

    if (!orderId || !businessId || !status) {
      return NextResponse.json({ error: 'orderId, businessId, and status required' }, { status: 400 });
    }

    const validStatuses = ['pending', 'confirmed', 'processing', 'ready', 'shipped', 'delivered', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return NextResponse.json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` }, { status: 400 });
    }

    const supabase = createServiceClient();

    // Validate order belongs to business
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('id, reference_code, delivery_phone, business_id, status')
      .eq('id', orderId)
      .eq('business_id', businessId)
      .single();

    if (orderError || !order) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    // Don't update if same status
    if (order.status === status) {
      return NextResponse.json({ success: true, notified: false });
    }

    // Update order status
    await supabase
      .from('orders')
      .update({ status })
      .eq('id', orderId);

    // Fetch business name for notification
    const { data: biz } = await supabase
      .from('businesses')
      .select('name')
      .eq('id', businessId)
      .single();
    const bizName = biz?.name || 'your store';

    // Send WhatsApp notification to customer
    let notified = false;
    const messageTemplate = STATUS_MESSAGES[status];
    if (order.delivery_phone && messageTemplate) {
      try {
        const resolver = new ChannelResolver(supabase);
        const resolved = await resolver.resolveByBusinessId(businessId);
        const sender: MessageSender = resolved?.sender || getDefaultGupshup();

        const phone = order.delivery_phone.startsWith('+')
          ? order.delivery_phone.slice(1)
          : order.delivery_phone;

        const message = messageTemplate.replace('{ref}', order.reference_code).replace('{biz}', bizName);
        // Try template first (works outside 24h)
        let sent = false;
        if (sender.sendTemplate) {
          try {
            const tmplResult = await sender.sendTemplate({ to: phone, templateName: 'order_status_update', templateParams: [order.reference_code, status] });
            sent = tmplResult.success !== false;
          } catch { /* template failed, try text */ }
        }
        if (!sent) await sender.sendText({ to: phone, text: message });
        notified = true;
      } catch (err) {
        logger.error('[ORDER-STATUS] WhatsApp notification error:', err);
      }
    }

    return NextResponse.json({ success: true, notified });
  } catch (error) {
    logger.error('[ORDER-STATUS] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

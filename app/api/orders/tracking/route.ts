import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { GupshupService } from '@/lib/channels/gupshup';
import type { MessageSender } from '@/lib/channels/message-sender';
import { authenticateRequest } from '@/lib/api-auth';
import { rateLimitResponse, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

let defaultGupshup: GupshupService;
function getDefaultGupshup() {
  if (!defaultGupshup) defaultGupshup = new GupshupService();
  return defaultGupshup;
}

export async function POST(request: NextRequest) {
  try {
    const rateLimit = rateLimitResponse(getRateLimitKey(request, 'order-tracking'), 30, 60_000);
    if (rateLimit) return rateLimit;

    const body = await request.json();
    const auth = await authenticateRequest(request, { requireBusinessOwnership: true, body });
    if (auth instanceof NextResponse) return auth;

    const { orderId, businessId, shippingCarrier, trackingNumber } = body;

    if (!orderId || !businessId) {
      return NextResponse.json({ error: 'orderId and businessId required' }, { status: 400 });
    }

    const supabase = createServiceClient();

    // Validate order belongs to business
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('id, reference_code, delivery_phone, business_id')
      .eq('id', orderId)
      .eq('business_id', businessId)
      .single();

    if (orderError || !order) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    // Update order with tracking info and set status to shipped
    await supabase
      .from('orders')
      .update({
        shipping_carrier: shippingCarrier || null,
        tracking_number: trackingNumber || null,
        status: 'shipped',
        shipped_at: new Date().toISOString(),
      })
      .eq('id', orderId);

    // Send WhatsApp notification to customer
    if (order.delivery_phone) {
      try {
        const resolver = new ChannelResolver(supabase);
        const resolved = await resolver.resolveByBusinessId(businessId);
        const sender: MessageSender = resolved?.sender || getDefaultGupshup();

        const phone = order.delivery_phone.startsWith('+')
          ? order.delivery_phone.slice(1)
          : order.delivery_phone;

        let message = `Your order *${order.reference_code}* has been shipped!`;
        if (shippingCarrier) {
          message += `\n\nCarrier: ${shippingCarrier}`;
        }
        if (trackingNumber) {
          message += `\nTracking: ${trackingNumber}`;
        }

        // Try template first (works outside 24h)
        let sent = false;
        if (sender.sendTemplate) {
          try {
            const tmplResult = await sender.sendTemplate({ to: phone, templateName: 'order_status_update', templateParams: [order.reference_code, 'shipped'] });
            sent = tmplResult.success !== false;
          } catch { /* template failed */ }
        }
        if (!sent) await sender.sendText({ to: phone, text: message });
      } catch (err) {
        logger.error('[TRACKING] WhatsApp notification error:', err);
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('[TRACKING] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

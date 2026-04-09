import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { GupshupService } from '@/lib/channels/gupshup';
import type { MessageSender } from '@/lib/channels/message-sender';

let defaultGupshup: GupshupService;
function getDefaultGupshup() {
  if (!defaultGupshup) defaultGupshup = new GupshupService();
  return defaultGupshup;
}

export async function POST(request: NextRequest) {
  try {
    const { orderId, businessId, shippingCarrier, trackingNumber } = await request.json();

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

        await sender.sendText({ to: phone, text: message });
      } catch (err) {
        console.error('[TRACKING] WhatsApp notification error:', err);
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[TRACKING] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

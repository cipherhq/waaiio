import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';

export async function POST(request: NextRequest) {
  try {
    const { businessId, customerPhone, messageText } = await request.json();
    if (!businessId || !customerPhone || !messageText) {
      return NextResponse.json({ error: 'businessId, customerPhone, and messageText required' }, { status: 400 });
    }

    const supabase = createServiceClient();

    // Send WhatsApp message via channel resolver
    const resolver = new ChannelResolver(supabase);
    const resolved = await resolver.resolveByBusinessId(businessId);

    if (!resolved) {
      return NextResponse.json({ error: 'No messaging channel configured' }, { status: 400 });
    }

    const phone = customerPhone.startsWith('+')
      ? customerPhone.slice(1)
      : customerPhone;

    await resolved.sender.sendText({
      to: phone,
      text: messageText,
    });

    // Insert outbound chat message
    await supabase.from('chat_messages').insert({
      business_id: businessId,
      customer_phone: customerPhone,
      direction: 'outbound',
      message_text: messageText,
      is_read: true,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[CHAT] Send error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

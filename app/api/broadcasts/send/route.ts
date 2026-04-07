import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { GupshupService } from '@/lib/channels/gupshup';

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { business_id, message, phones } = body;

    if (!business_id || !message || !phones?.length) {
      return NextResponse.json(
        { message: 'Missing required fields: business_id, message, phones' },
        { status: 400 },
      );
    }

    // Verify ownership
    const service = createServiceClient();
    const { data: business } = await service
      .from('businesses')
      .select('id, owner_id, name')
      .eq('id', business_id)
      .eq('owner_id', user.id)
      .single();

    if (!business) {
      return NextResponse.json({ message: 'Business not found' }, { status: 404 });
    }

    // Resolve the sender for this business
    const resolver = new ChannelResolver(service);
    const resolved = await resolver.resolveByBusinessId(business_id);
    const sender = resolved?.sender || new GupshupService();

    let sentCount = 0;

    for (const phone of phones as string[]) {
      try {
        await sender.sendText({ to: phone, text: message });

        // Record notification
        await service.from('notifications').insert({
          business_id,
          recipient_phone: phone,
          type: 'system',
          channel: 'whatsapp',
          status: 'sent',
          body: message,
          sent_at: new Date().toISOString(),
        });

        sentCount++;
      } catch (err) {
        console.error(`[BROADCAST] Failed to send to ${phone}:`, err);
        await service.from('notifications').insert({
          business_id,
          recipient_phone: phone,
          type: 'system',
          channel: 'whatsapp',
          status: 'failed',
          body: message,
          failed_reason: (err as Error).message,
        });
      }
    }

    return NextResponse.json({ sent: sentCount, total: phones.length });
  } catch (error) {
    return NextResponse.json(
      { message: 'Internal server error', error: (error as Error).message },
      { status: 500 },
    );
  }
}

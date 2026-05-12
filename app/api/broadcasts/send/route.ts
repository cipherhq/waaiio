import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { GupshupService } from '@/lib/channels/gupshup';
import { rateLimitResponse } from '@/lib/rate-limit';
import { type SubscriptionTier } from '@/lib/constants';
import { loadPlatformSettings } from '@/lib/platformSettings';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    // Rate limit: max 10 broadcasts per IP per hour
    const broadcastLimit = rateLimitResponse('broadcast:' + (request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'), 10, 3600_000);
    if (broadcastLimit) return broadcastLimit;

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { business_id, message, phones, template_name } = body as {
      business_id: string;
      message: string;
      phones: string[];
      template_name?: string;
    };

    if (!business_id || !message || !phones?.length) {
      return NextResponse.json(
        { message: 'Missing required fields: business_id, message, phones' },
        { status: 400 },
      );
    }

    // Rate limit: max 3 sends per minute per business
    const rateLimited = rateLimitResponse(`broadcast:${business_id}`, 3, 60_000);
    if (rateLimited) return rateLimited;

    // Fetch business with subscription tier
    const service = createServiceClient();
    const { data: business } = await service
      .from('businesses')
      .select('id, owner_id, name, subscription_tier, country_code')
      .eq('id', business_id)
      .eq('owner_id', user.id)
      .single();

    if (!business) {
      return NextResponse.json({ message: 'Business not found' }, { status: 404 });
    }

    const tier = (business.subscription_tier || 'free') as SubscriptionTier;
    const settings = await loadPlatformSettings({ useServiceClient: true });
    const limits = settings.broadcast_limits[tier];

    // Check conversation limit
    const { checkConversationLimit } = await import('@/lib/bot/conversation-guard');
    const convLimit = await checkConversationLimit(service, business.id);
    if (!convLimit.allowed) {
      return NextResponse.json(
        { message: `Monthly conversation limit reached (${convLimit.used}/${convLimit.limit}). Upgrade your plan for more conversations.` },
        { status: 403 },
      );
    }

    // Tier gate: free tier cannot broadcast
    if (tier === 'free') {
      return NextResponse.json(
        { message: 'Broadcast messages are available on Growth and Business plans. Please upgrade to send broadcasts.' },
        { status: 403 },
      );
    }

    // Usage check for current month
    const monthKey = new Date().toISOString().slice(0, 7); // 'YYYY-MM'
    const { data: usage } = await service
      .from('broadcast_usage')
      .select('broadcast_count, recipient_count')
      .eq('business_id', business_id)
      .eq('month_key', monthKey)
      .maybeSingle();

    const currentBroadcasts = usage?.broadcast_count ?? 0;
    const currentRecipients = usage?.recipient_count ?? 0;

    if (limits.maxBroadcasts !== Infinity && currentBroadcasts >= limits.maxBroadcasts) {
      return NextResponse.json(
        { message: `Monthly broadcast limit reached (${limits.maxBroadcasts} broadcasts). Upgrade your plan for more.` },
        { status: 429 },
      );
    }

    if (limits.maxRecipients !== Infinity && currentRecipients + phones.length > limits.maxRecipients) {
      const remaining = limits.maxRecipients - currentRecipients;
      return NextResponse.json(
        { message: `Recipient limit would be exceeded. You can send to ${remaining} more recipients this month (${limits.maxRecipients} total).` },
        { status: 429 },
      );
    }

    // Resolve the sender for this business
    const resolver = new ChannelResolver(service);
    const resolved = await resolver.resolveByBusinessId(business_id);
    const sender = resolved?.sender || new GupshupService();

    let sentCount = 0;
    const usedTemplate = !!(template_name && sender.sendTemplate);

    for (const phone of phones) {
      try {
        if (template_name && sender.sendTemplate) {
          await sender.sendTemplate({
            to: phone,
            templateName: template_name,
            templateParams: [business.name, message],
          });
        } else {
          await sender.sendText({ to: phone, text: message });
        }

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
        logger.error(`[BROADCAST] Failed to send to ${phone}:`, err);
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

    // Increment usage via RPC
    await service.rpc('increment_broadcast_usage', {
      p_business_id: business_id,
      p_recipient_count: phones.length,
    });

    return NextResponse.json({
      sent: sentCount,
      total: phones.length,
      used_template: usedTemplate,
      usage: {
        broadcasts_used: currentBroadcasts + 1,
        recipients_used: currentRecipients + phones.length,
        broadcasts_limit: limits.maxBroadcasts,
        recipients_limit: limits.maxRecipients,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { message: 'Internal server error', error: (error as Error).message },
      { status: 500 },
    );
  }
}

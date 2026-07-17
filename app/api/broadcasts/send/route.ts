import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { rateLimitResponseAsync } from '@/lib/rate-limit';
import { type SubscriptionTier } from '@/lib/constants';
import { loadPlatformSettings } from '@/lib/platformSettings';
import { logger } from '@/lib/logger';
import { sendOrEmail, findCustomerEmail } from '@/lib/channels/send-or-email';
import { businessNotificationEmail } from '@/lib/email/templates';
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    // Rate limit: max 10 broadcasts per IP per hour
    const broadcastLimit = await rateLimitResponseAsync('broadcast:' + (request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'), 10, 3600_000);
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

    // Cap per-request recipients to prevent abuse
    const MAX_PER_REQUEST = 500;
    if (phones.length > MAX_PER_REQUEST) {
      return NextResponse.json(
        { message: `Too many recipients. Maximum ${MAX_PER_REQUEST} per request.` },
        { status: 400 },
      );
    }

    // Rate limit: max 3 sends per minute per business
    const rateLimited = await rateLimitResponseAsync(`broadcast:${business_id}`, 3, 60_000);
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

    // ── Capability check: broadcast ──
    const { data: broadcastCap } = await service
      .from('business_capabilities')
      .select('id')
      .eq('business_id', business_id)
      .eq('capability', 'broadcast')
      .eq('is_enabled', true)
      .maybeSingle();
    if (!broadcastCap) {
      return NextResponse.json({ message: 'Broadcast feature not enabled' }, { status: 403 });
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
        { message: 'Broadcast messages are available on Pro and Premium plans. Please upgrade to send broadcasts.' },
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

    if (!resolved) {
      return NextResponse.json(
        { message: 'WhatsApp channel not set up for this business. Go to WhatsApp Setup to connect your number.' },
        { status: 400 },
      );
    }

    const sender = resolved.sender;

    let sentCount = 0;
    const usedTemplate = !!(template_name && sender.sendTemplate);

    // Build the formatted fallback text (used when template isn't available)
    const TEMPLATE_WRAPPERS: Record<string, (biz: string, msg: string) => string> = {
      business_update: (biz, msg) => `Hello! Here is an update from *${biz}*:\n\n${msg}\n\nReply to this message if you have any questions.`,
      business_reminder: (biz, msg) => `Hello! Here is a reminder from *${biz}*:\n\n${msg}\n\nWe look forward to seeing you. Reply if you need any help.`,
      business_event: (biz, msg) => `Hello! Here is an upcoming event from *${biz}*:\n\n${msg}\n\nWe hope to see you there. Reply for more details or to RSVP.`,
      business_promotion: (biz, msg) => `Hi there! *${biz}* has a special message for you:\n\n${msg}\n\nDon't miss out — reply to learn more or take action today!`,
    };
    const wrapper = template_name ? TEMPLATE_WRAPPERS[template_name] : null;
    const formattedText = wrapper ? wrapper(business.name, message) : message;

    for (const phone of phones) {
      try {
        // Check opt-out before sending promotional message
        const { data: optedOut } = await service
          .from('messaging_opt_outs')
          .select('id')
          .eq('phone', phone)
          .is('resubscribed_at', null)
          .maybeSingle();

        if (optedOut) {
          // Skip — customer opted out
          continue;
        }

        let sent = false;

        // Try template first (works outside 24h window)
        if (template_name && sender.sendTemplate) {
          try {
            await sender.sendTemplate({
              to: phone,
              templateName: template_name,
              templateParams: [business.name, message],
            });
            sent = true;
          } catch (templateErr) {
            // Template failed (not approved, not provisioned, etc.) — fall back to text
            logger.warn(`[BROADCAST] Template "${template_name}" failed for ...${phone.slice(-4)}, falling back to text:`, (templateErr as Error).message);
          }
        }

        // Fallback: send via sendOrEmail (WhatsApp + email fallback/dual delivery)
        if (!sent) {
          const customerEmail = await findCustomerEmail(service, phone, business_id);
          let emailOpt: { address: string; subject: string; html: string } | null = null;
          if (customerEmail) {
            const tmpl = businessNotificationEmail({
              businessName: business.name,
              title: 'Broadcast Message',
              message: formattedText,
            });
            emailOpt = { address: customerEmail, subject: tmpl.subject, html: tmpl.html };
          }

          await sendOrEmail({
            supabase: service,
            sender,
            to: phone,
            text: formattedText,
            email: emailOpt,
            businessName: business.name,
            alwaysEmail: true,
          });
        }

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
        logger.error(`[BROADCAST] Failed to send to ...${phone.slice(-4)}:`, err);
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
    logger.error('Broadcast send error:', error);
    return NextResponse.json(
      { message: 'Something went wrong' },
      { status: 500 },
    );
  }
}

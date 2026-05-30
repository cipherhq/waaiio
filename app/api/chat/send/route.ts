import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { authenticateRequest } from '@/lib/api-auth';
import { rateLimitResponse, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    const rateLimit = rateLimitResponse(getRateLimitKey(request, 'chat-send'), 20, 60_000);
    if (rateLimit) return rateLimit;

    const body = await request.json();
    const { businessId, customerPhone, messageText, audioUrl } = body;
    if (!businessId || !customerPhone || (!messageText && !audioUrl)) {
      return NextResponse.json({ error: 'businessId, customerPhone, and messageText (or audioUrl) required' }, { status: 400 });
    }

    // Auth: allow owner OR active team member
    const auth = await authenticateRequest(request, { requireBusinessOwnership: false, body });
    if (auth instanceof NextResponse) return auth;

    const supabase = createServiceClient();

    const { data: biz } = await supabase
      .from('businesses')
      .select('owner_id')
      .eq('id', businessId)
      .single();

    if (!biz) {
      return NextResponse.json({ error: 'Business not found' }, { status: 404 });
    }

    const isOwner = biz.owner_id === auth.user.id;
    let staffMemberId: string | null = null;

    if (!isOwner) {
      const { data: membership } = await supabase
        .from('business_members')
        .select('id, role')
        .eq('business_id', businessId)
        .eq('user_id', auth.user.id)
        .eq('status', 'active')
        .maybeSingle();

      if (!membership) {
        return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
      }
      staffMemberId = membership.id;
    } else {
      // Owner might also have a business_members record
      const { data: ownerMembership } = await supabase
        .from('business_members')
        .select('id')
        .eq('business_id', businessId)
        .eq('user_id', auth.user.id)
        .eq('status', 'active')
        .maybeSingle();
      staffMemberId = ownerMembership?.id || null;
    }

    // Send WhatsApp message via channel resolver (dedicated first, fallback to shared)
    const resolver = new ChannelResolver(supabase);
    const resolved = await resolver.resolveByBusinessId(businessId);
    if (!resolved?.sender) {
      return NextResponse.json({ error: 'No messaging channel configured' }, { status: 400 });
    }
    const sender = resolved.sender;

    const phone = customerPhone.startsWith('+')
      ? customerPhone.slice(1)
      : customerPhone;

    if (audioUrl) {
      await sender.sendAudio({ to: phone, audioUrl });
    } else {
      await sender.sendText({ to: phone, text: messageText });
    }

    // Upsert conversation and get conversation_id
    await supabase.from('chat_conversations').upsert({
      business_id: businessId,
      customer_phone: customerPhone,
      status: 'open',
      last_message_at: new Date().toISOString(),
    }, { onConflict: 'business_id,customer_phone' });

    const { data: conv } = await supabase
      .from('chat_conversations')
      .select('id')
      .eq('business_id', businessId)
      .eq('customer_phone', customerPhone)
      .maybeSingle();

    // Auto-assign conversation to this sender if unassigned
    if (conv?.id && staffMemberId) {
      const { data: existingConv } = await supabase
        .from('chat_conversations')
        .select('assigned_to')
        .eq('id', conv.id)
        .single();

      if (existingConv && !existingConv.assigned_to) {
        await supabase
          .from('chat_conversations')
          .update({
            assigned_to: staffMemberId,
            assigned_at: new Date().toISOString(),
          })
          .eq('id', conv.id);
      }
    }

    // Insert outbound chat message linked to conversation
    const { data: inserted } = await supabase.from('chat_messages').insert({
      business_id: businessId,
      customer_phone: customerPhone,
      direction: 'outbound',
      message_text: audioUrl ? '[Voice message]' : messageText,
      is_read: true,
      staff_id: staffMemberId,
      conversation_id: conv?.id || null,
      media_url: audioUrl || null,
      media_type: audioUrl ? 'audio' : null,
    }).select().single();

    return NextResponse.json({ success: true, message: inserted });
  } catch (error) {
    logger.error('[CHAT] Send error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { handlePostCompletion } from '@/lib/bot/flows/shared/post-completion';

export async function POST(request: NextRequest) {
  try {
    const { entryId, status, businessId, priority_level } = await request.json();
    if (!entryId || !businessId) {
      return NextResponse.json({ error: 'entryId and businessId required' }, { status: 400 });
    }

    // Must provide at least status or priority_level
    if (!status && !priority_level) {
      return NextResponse.json({ error: 'status or priority_level required' }, { status: 400 });
    }

    const supabase = createServiceClient();
    const updateData: Record<string, unknown> = {};

    if (status) {
      const validStatuses = ['waiting', 'serving', 'completed', 'no_show'];
      if (!validStatuses.includes(status)) {
        return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
      }
      updateData.status = status;
      if (status === 'serving') updateData.called_at = new Date().toISOString();
      if (status === 'completed') updateData.completed_at = new Date().toISOString();
    }

    if (priority_level) {
      const validPriorities = ['normal', 'vip', 'urgent'];
      if (!validPriorities.includes(priority_level)) {
        return NextResponse.json({ error: 'Invalid priority_level' }, { status: 400 });
      }
      updateData.priority_level = priority_level;
    }

    const { error } = await supabase
      .from('queue_entries')
      .update(updateData)
      .eq('id', entryId)
      .eq('business_id', businessId);

    if (error) {
      console.error('[QUEUE] Update error:', error);
      return NextResponse.json({ error: 'Failed to update' }, { status: 500 });
    }

    // If marking as completed, trigger post-completion hook
    if (status === 'completed') {
      try {
        const { data: entry } = await supabase
          .from('queue_entries')
          .select('customer_phone, customer_name')
          .eq('id', entryId)
          .single();

        if (entry) {
          const resolver = new ChannelResolver(supabase);
          const resolved = await resolver.resolveByBusinessId(businessId);
          if (resolved) {
            await handlePostCompletion({
              supabase,
              businessId,
              customerPhone: entry.customer_phone,
              customerName: entry.customer_name,
              serviceType: 'queue',
              referenceId: entryId,
              sender: resolved.sender,
            });
          }
        }
      } catch (err) {
        console.error('[QUEUE] Post-completion hook error:', err);
      }
    }

    // If marking as serving, send WhatsApp notification
    if (status === 'serving') {
      try {
        const { data: entry } = await supabase
          .from('queue_entries')
          .select('customer_phone, customer_name')
          .eq('id', entryId)
          .single();

        if (entry) {
          const resolver = new ChannelResolver(supabase);
          const resolved = await resolver.resolveByBusinessId(businessId);

          if (resolved) {
            const phone = entry.customer_phone.startsWith('+')
              ? entry.customer_phone.slice(1)
              : entry.customer_phone;

            const name = entry.customer_name || 'there';
            await resolved.sender.sendText({
              to: phone,
              text: `Hi ${name}, it's your turn! Please proceed to the counter.`,
            });
          }
        }
      } catch (err) {
        console.error('[QUEUE] WhatsApp notification error:', err);
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[QUEUE] Update error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

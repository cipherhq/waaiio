import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { handlePostCompletion } from '@/lib/bot/flows/shared/post-completion';
import { authenticateRequest } from '@/lib/api-auth';
import { rateLimitResponse, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    const rateLimit = rateLimitResponse(getRateLimitKey(request, 'queue-update'), 30, 60_000);
    if (rateLimit) return rateLimit;

    const body = await request.json();
    const auth = await authenticateRequest(request, { requireBusinessOwnership: true, body });
    if (auth instanceof NextResponse) return auth;

    const { entryId, status, businessId, priority_level } = body;
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

      // Validate status transitions
      const { data: current } = await supabase
        .from('queue_entries')
        .select('status')
        .eq('id', entryId)
        .single();

      const validTransitions: Record<string, string[]> = {
        waiting: ['serving', 'no_show'],
        serving: ['completed', 'no_show'],
        completed: [],
        no_show: [],
      };

      if (current && !validTransitions[current.status]?.includes(status)) {
        return NextResponse.json({ error: `Cannot change from ${current.status} to ${status}` }, { status: 400 });
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
      logger.error('[QUEUE] Update error:', error);
      return NextResponse.json({ error: 'Failed to update' }, { status: 500 });
    }

    // Recalculate estimated wait for remaining waiting customers
    if (status === 'serving' || status === 'completed' || status === 'no_show') {
      try {
        // Get average service time from today's completed entries
        const { data: completed } = await supabase
          .from('queue_entries')
          .select('called_at, completed_at')
          .eq('business_id', businessId)
          .eq('queue_date', new Date().toISOString().split('T')[0])
          .eq('status', 'completed')
          .not('called_at', 'is', null)
          .not('completed_at', 'is', null);

        let avgMinutes = 10; // default
        if (completed && completed.length > 0) {
          const totalMin = completed.reduce((s, e) => {
            const diff = (new Date(e.completed_at!).getTime() - new Date(e.called_at!).getTime()) / 60000;
            return s + Math.max(1, diff);
          }, 0);
          avgMinutes = Math.round(totalMin / completed.length);
        }

        // Update each waiting entry's estimated_wait
        const { data: waiting } = await supabase
          .from('queue_entries')
          .select('id, queue_number')
          .eq('business_id', businessId)
          .eq('queue_date', new Date().toISOString().split('T')[0])
          .eq('status', 'waiting')
          .order('queue_number');

        if (waiting) {
          for (let i = 0; i < waiting.length; i++) {
            await supabase
              .from('queue_entries')
              .update({ estimated_wait_minutes: (i + 1) * avgMinutes })
              .eq('id', waiting[i].id);
          }
        }
      } catch (waitErr) {
        // Non-critical — don't fail the request
        logger.warn('[QUEUE] Wait time recalc error:', waitErr);
      }
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
        logger.error('[QUEUE] Post-completion hook error:', err);
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
        logger.error('[QUEUE] WhatsApp notification error:', err);
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('[QUEUE] Update error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

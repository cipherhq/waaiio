import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { handlePostCompletion } from '@/lib/bot/flows/shared/post-completion';
import { authenticateRequest } from '@/lib/api-auth';
import { rateLimitResponse, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    const rateLimit = rateLimitResponse(getRateLimitKey(request, 'queue-call-next'), 30, 60_000);
    if (rateLimit) return rateLimit;

    const body = await request.json();
    const auth = await authenticateRequest(request, { requireBusinessOwnership: true, body });
    if (auth instanceof NextResponse) return auth;

    const { businessId } = body;
    if (!businessId) {
      return NextResponse.json({ error: 'businessId required' }, { status: 400 });
    }

    const supabase = createServiceClient();

    // Check if queue is paused
    const { data: biz } = await supabase
      .from('businesses')
      .select('metadata')
      .eq('id', businessId)
      .single();

    const meta = (biz?.metadata || {}) as Record<string, unknown>;
    if (meta.queue_paused) {
      return NextResponse.json({ error: 'Queue is paused' }, { status: 400 });
    }

    const today = new Date().toISOString().split('T')[0];

    // Mark current serving entry as completed
    const { data: currentServing } = await supabase
      .from('queue_entries')
      .select('id')
      .eq('business_id', businessId)
      .eq('queue_date', today)
      .eq('status', 'serving')
      .limit(1)
      .maybeSingle();

    if (currentServing) {
      // Get entry details for post-completion hook
      const { data: completedEntry } = await supabase
        .from('queue_entries')
        .select('customer_phone, customer_name')
        .eq('id', currentServing.id)
        .single();

      await supabase
        .from('queue_entries')
        .update({ status: 'completed', completed_at: new Date().toISOString() })
        .eq('id', currentServing.id);

      // Trigger post-completion hook for the completed entry
      if (completedEntry) {
        try {
          const resolver = new ChannelResolver(supabase);
          const resolved = await resolver.resolveByBusinessId(businessId);
          if (resolved) {
            await handlePostCompletion({
              supabase,
              businessId,
              customerPhone: completedEntry.customer_phone,
              customerName: completedEntry.customer_name,
              serviceType: 'queue',
              referenceId: currentServing.id,
              sender: resolved.sender,
            });
          }
        } catch (err) {
          logger.error('[QUEUE] Post-completion hook error:', err);
        }
      }
    }

    // Find next waiting entry — priority ordering: urgent > vip > normal, then by queue_number
    const { data: candidates } = await supabase
      .from('queue_entries')
      .select('id, customer_phone, customer_name, queue_number, priority_level')
      .eq('business_id', businessId)
      .eq('queue_date', today)
      .eq('status', 'waiting')
      .order('queue_number', { ascending: true });

    if (!candidates || candidates.length === 0) {
      return NextResponse.json({ message: 'No one waiting in queue' });
    }

    // Sort by priority then queue_number
    const priorityOrder: Record<string, number> = { urgent: 0, vip: 1, normal: 2 };
    candidates.sort((a, b) => {
      const pa = priorityOrder[a.priority_level || 'normal'] ?? 2;
      const pb = priorityOrder[b.priority_level || 'normal'] ?? 2;
      if (pa !== pb) return pa - pb;
      return a.queue_number - b.queue_number;
    });

    const nextEntry = candidates[0];

    // Mark as serving
    await supabase
      .from('queue_entries')
      .update({ status: 'serving', called_at: new Date().toISOString() })
      .eq('id', nextEntry.id);

    // Send WhatsApp notification
    try {
      const resolver = new ChannelResolver(supabase);
      const resolved = await resolver.resolveByBusinessId(businessId);

      if (resolved) {
        const phone = nextEntry.customer_phone.startsWith('+')
          ? nextEntry.customer_phone.slice(1)
          : nextEntry.customer_phone;

        const name = nextEntry.customer_name || 'there';
        await resolved.sender.sendText({
          to: phone,
          text: `Hi ${name}, it's your turn! Please proceed to the counter.`,
        });
      }
    } catch (err) {
      logger.error('[QUEUE] WhatsApp notification error:', err);
      // Don't fail the whole operation if notification fails
    }

    return NextResponse.json({
      called: {
        id: nextEntry.id,
        queue_number: nextEntry.queue_number,
        customer_name: nextEntry.customer_name,
      },
    });
  } catch (error) {
    logger.error('[QUEUE] Call next error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

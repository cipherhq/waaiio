import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { authenticateRequest } from '@/lib/api-auth';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    const rateLimit = await rateLimitResponseAsync(getRateLimitKey(request, 'queue-toggle-pause'), 10, 60_000);
    if (rateLimit) return rateLimit;

    const body = await request.json();
    const auth = await authenticateRequest(request, { requireBusinessOwnership: true, body });
    if (auth instanceof NextResponse) return auth;

    const { businessId } = body;
    if (!businessId) {
      return NextResponse.json({ error: 'businessId required' }, { status: 400 });
    }

    const supabase = createServiceClient();

    // Get current metadata
    const { data: biz, error: bizError } = await supabase
      .from('businesses')
      .select('metadata, name')
      .eq('id', businessId)
      .single();

    if (bizError || !biz) {
      return NextResponse.json({ error: 'Business not found' }, { status: 404 });
    }

    const meta = (biz.metadata || {}) as Record<string, unknown>;
    const wasPaused = Boolean(meta.queue_paused);
    const newPaused = !wasPaused;

    // Toggle the pause state
    const { error: updateError } = await supabase
      .from('businesses')
      .update({ metadata: { ...meta, queue_paused: newPaused } })
      .eq('id', businessId);

    if (updateError) {
      logger.error('[QUEUE] Toggle pause error:', updateError);
      return NextResponse.json({ error: 'Failed to update' }, { status: 500 });
    }

    // If we just UNPAUSED (resumed), notify all queue reopen subscribers
    let notifiedCount = 0;
    if (wasPaused && !newPaused) {
      try {
        const { data: subs } = await supabase
          .from('queue_reopen_subscriptions')
          .select('id, customer_phone')
          .eq('business_id', businessId)
          .eq('status', 'waiting');

        if (subs && subs.length > 0) {
          const resolver = new ChannelResolver(supabase);
          const resolved = await resolver.resolveByBusinessId(businessId);

          if (resolved) {
            const bizName = biz.name || 'the business';

            for (const sub of subs) {
              try {
                const phone = sub.customer_phone.startsWith('+')
                  ? sub.customer_phone.slice(1)
                  : sub.customer_phone;

                await resolved.sender.sendText({
                  to: phone,
                  text: `The queue at *${bizName}* is now open! Send *Hi* to join the queue.`,
                });

                // Mark as notified — only count if exactly one row transitioned
                const { data: updated, error: markError } = await supabase
                  .from('queue_reopen_subscriptions')
                  .update({ status: 'notified', notified_at: new Date().toISOString() })
                  .eq('id', sub.id)
                  .eq('status', 'waiting')
                  .select('id');

                if (markError) {
                  logger.withContext({ op: 'queue.reopen-mark-notified', subId: sub.id }).error('[QUEUE] Failed to mark subscription as notified');
                  // Leave subscription in waiting state for retry — do NOT increment
                } else if (updated && updated.length === 1) {
                  notifiedCount++;
                } else {
                  // Zero rows matched — subscription was not in expected state
                  logger.withContext({ op: 'queue.reopen-mark-notified', subId: sub.id, rowsUpdated: updated?.length ?? 0 }).error('[QUEUE] Mark-notified matched zero rows');
                }
              } catch (err) {
                // sendText threw — subscription stays waiting (retryable)
                logger.error('[QUEUE] Reopen notification error for', sub.customer_phone, err);
              }
            }
          } else {
            logger.warn('[QUEUE] No WhatsApp channel resolved — reopen subscribers not notified');
          }
        }
      } catch (err) {
        logger.error('[QUEUE] Reopen notification dispatch error:', err);
      }
    }

    return NextResponse.json({
      success: true,
      paused: newPaused,
      notifiedCount,
    });
  } catch (error) {
    logger.error('[QUEUE] Toggle pause error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

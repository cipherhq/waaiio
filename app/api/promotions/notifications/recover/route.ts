/**
 * ACC-204 R4: Recovery endpoint for stuck fulfillment notification intents.
 *
 * Finds intents that are reclaimable (pending, no provider_attempted_at,
 * no active lease) and re-dispatches them through the normal claim flow.
 *
 * Service-role only (admin/cron). Not exposed to end users.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { dispatchFulfillmentNotification } from '@/lib/promotions/fulfillment-notification';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  // Service-role guard: require internal secret header
  const authHeader = request.headers.get('x-service-secret');
  if (authHeader !== process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const service = createServiceClient();
  const body = await request.json().catch(() => ({}));
  const limit = Math.min(Math.max(body.limit || 10, 1), 50);

  // Find recoverable intents via RPC
  const { data: intents, error: findError } = await service.rpc(
    'find_recoverable_notification_intents',
    { p_limit: limit },
  );

  if (findError) {
    logger.error('[RECOVER-NOTIF] RPC error:', findError);
    return NextResponse.json({ error: 'Failed to find recoverable intents' }, { status: 500 });
  }

  if (!intents || intents.length === 0) {
    return NextResponse.json({ recovered: 0, message: 'No recoverable intents found' });
  }

  const results: Array<{ intent_id: string; status: string }> = [];

  for (const intent of intents) {
    try {
      await dispatchFulfillmentNotification(service, {
        id: intent.id,
        redemption_id: intent.redemption_id,
        to_status: intent.to_status,
        campaign_id: intent.campaign_id,
      }, intent.business_id);
      results.push({ intent_id: intent.id, status: 'dispatched' });
    } catch (err) {
      logger.error('[RECOVER-NOTIF] Dispatch error for intent', intent.id, err);
      results.push({ intent_id: intent.id, status: 'error' });
    }
  }

  return NextResponse.json({
    recovered: results.filter(r => r.status === 'dispatched').length,
    total: results.length,
    results,
  });
}

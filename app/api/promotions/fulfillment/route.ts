import { logger } from '@/lib/logger';
import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requireCapabilityWithRole } from '@/lib/capabilities/api-guard';
import type { PromoFulfillmentStatus } from '@/lib/promotions/types';
import { dispatchFulfillmentNotification } from '@/lib/promotions/fulfillment-notification';

const ALL_FULFILLMENT_STATUSES: PromoFulfillmentStatus[] = [
  'pending',
  'processing',
  'fulfilled',
  'rejected',
  'cancelled',
];

/**
 * PUT /api/promotions/fulfillment
 *
 * Delegates to transition_promo_fulfillment RPC for atomic, race-safe
 * fulfillment transitions with verification gating and fulfilled_by tracking.
 */
export async function PUT(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const service = createServiceClient();
  const businessId = body.businessId as string | undefined;

  if (!businessId) {
    return NextResponse.json({ error: 'businessId is required' }, { status: 400 });
  }

  const guard = await requireCapabilityWithRole(service, {
    businessId,
    userId: user.id,
    capability: 'promo_verification',
    action: 'manage_existing',
    allowedRoles: ['owner', 'admin'],
  });
  if (!guard.allowed) return NextResponse.json(guard.denial, { status: guard.status });

  const { redemptionId, fulfillmentStatus, fulfillmentReference, fulfillmentNotes } = body as {
    redemptionId?: string;
    fulfillmentStatus?: string;
    fulfillmentReference?: string;
    fulfillmentNotes?: string;
  };

  if (!redemptionId || typeof redemptionId !== 'string') {
    return NextResponse.json({ error: 'redemptionId is required' }, { status: 400 });
  }
  if (!fulfillmentStatus || !ALL_FULFILLMENT_STATUSES.includes(fulfillmentStatus as PromoFulfillmentStatus)) {
    return NextResponse.json(
      { error: `fulfillmentStatus must be one of: ${ALL_FULFILLMENT_STATUSES.join(', ')}` },
      { status: 400 },
    );
  }

  // Delegate to atomic DB RPC — handles locking, transition validation,
  // verification gating, and fulfilled_by tracking
  const { data: result, error: rpcError } = await service.rpc('transition_promo_fulfillment', {
    p_business_id: businessId,
    p_redemption_id: redemptionId,
    p_next_status: fulfillmentStatus,
    p_actor_user_id: user.id,
    p_fulfillment_reference: fulfillmentReference?.trim() || null,
    p_fulfillment_notes: fulfillmentNotes?.trim() || null,
  });

  if (rpcError) {
    logger.error('[PROMOTIONS] fulfillment RPC error:', rpcError);
    return NextResponse.json({ error: 'Failed to update fulfillment status' }, { status: 500 });
  }

  if (!result?.success) {
    const reason = result?.reason || 'unknown';
    if (reason === 'not_found') {
      return NextResponse.json({ error: 'Redemption not found' }, { status: 404 });
    }
    if (reason === 'secure_pickup_verification_required') {
      return NextResponse.json({ error: 'Secure pickup verification is required before fulfillment', reason }, { status: 422 });
    }
    return NextResponse.json({ error: `Fulfillment transition failed: ${reason}`, ...result }, { status: 422 });
  }

  // ACC-204: Non-blocking fulfillment notification dispatch
  // Check for pending notification intent created atomically by the RPC
  const { data: intent } = await service
    .from('promo_fulfillment_notification_intents')
    .select('id, redemption_id, to_status, campaign_id')
    .eq('redemption_id', redemptionId)
    .eq('to_status', fulfillmentStatus)
    .eq('delivery_status', 'pending')
    .maybeSingle();

  if (intent) {
    // Non-blocking: notification failure must NEVER roll back fulfillment
    dispatchFulfillmentNotification(service, intent, businessId).catch(err => {
      logger.error('[FULFILLMENT] Notification dispatch failed (non-blocking):', err);
    });
  }

  // Fetch updated redemption for response — explicit allowlist, no phone_e164
  const { data: updated } = await service
    .from('promo_redemptions')
    .select('id, campaign_id, claim_reference, fulfillment_status, fulfillment_reference, fulfillment_notes, fulfilled_at, fulfilled_by, verification_mode, verification_status')
    .eq('id', redemptionId)
    .single();

  try {
    if (fulfillmentStatus === 'fulfilled') {
      const { emitServerEvent } = await import('@/lib/observability/server-events');
      emitServerEvent(request, 'promo.winner_fulfilled', user.id, { business_id: businessId, entity_id: redemptionId, status: 'fulfilled' });
    }
  } catch { /* instrumentation must never fail fulfillment */ }

  return NextResponse.json({ redemption: updated });
}

import { logger } from '@/lib/logger';
import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requireCapability } from '@/lib/capabilities/api-guard';
import type { PromoFulfillmentStatus } from '@/lib/promotions/types';

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

  const guard = await requireCapability(supabase, service, {
    businessId,
    userId: user.id,
    capability: 'promo_verification',
    action: 'manage_existing',
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

  // Fetch updated redemption for response
  const { data: updated } = await service
    .from('promo_redemptions')
    .select('*')
    .eq('id', redemptionId)
    .single();

  try {
    const { emitServerEvent } = await import('@/lib/observability/server-events');
    const event = fulfillmentStatus === 'fulfilled' ? 'fulfillment.completed' as const : 'fulfillment.completed' as const;
    emitServerEvent(request, event, user.id, { business_id: businessId, entity_id: redemptionId, status: fulfillmentStatus });
  } catch { /* instrumentation must never fail fulfillment */ }

  return NextResponse.json({ redemption: updated });
}

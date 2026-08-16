import { logger } from '@/lib/logger';
import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requireCapability } from '@/lib/capabilities/api-guard';
import type { PromoFulfillmentStatus } from '@/lib/promotions/types';

/** Valid forward-only fulfillment transitions. */
const VALID_FULFILLMENT_TRANSITIONS: Record<PromoFulfillmentStatus, PromoFulfillmentStatus[]> = {
  pending: ['processing', 'fulfilled', 'rejected', 'cancelled'],
  processing: ['fulfilled', 'rejected', 'cancelled'],
  fulfilled: [],
  rejected: [],
  cancelled: [],
};

const ALL_FULFILLMENT_STATUSES: PromoFulfillmentStatus[] = [
  'pending',
  'processing',
  'fulfilled',
  'rejected',
  'cancelled',
];

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

  // Fetch redemption and verify it belongs to this business
  const { data: redemption, error: fetchError } = await service
    .from('promo_redemptions')
    .select('id, business_id, fulfillment_status, outcome')
    .eq('id', redemptionId)
    .eq('business_id', businessId)
    .maybeSingle();

  if (fetchError || !redemption) {
    return NextResponse.json({ error: 'Redemption not found' }, { status: 404 });
  }

  const currentStatus = redemption.fulfillment_status as PromoFulfillmentStatus;
  const nextStatus = fulfillmentStatus as PromoFulfillmentStatus;

  // Validate transition — fulfillment is forward-only
  const allowed = VALID_FULFILLMENT_TRANSITIONS[currentStatus] || [];
  if (!allowed.includes(nextStatus)) {
    return NextResponse.json(
      {
        error: `Invalid fulfillment transition from '${currentStatus}' to '${nextStatus}'. ${
          allowed.length > 0
            ? `Allowed transitions: ${allowed.join(', ')}`
            : `'${currentStatus}' is a terminal state and cannot be changed.`
        }`,
      },
      { status: 422 },
    );
  }

  const now = new Date().toISOString();
  const updates: Record<string, unknown> = {
    fulfillment_status: nextStatus,
  };

  if (fulfillmentReference !== undefined) {
    updates.fulfillment_reference = fulfillmentReference?.trim() || null;
  }
  if (fulfillmentNotes !== undefined) {
    updates.fulfillment_notes = fulfillmentNotes?.trim() || null;
  }
  if (nextStatus === 'fulfilled') {
    updates.fulfilled_at = now;
  }

  const { data: updated, error: updateError } = await service
    .from('promo_redemptions')
    .update(updates)
    .eq('id', redemptionId)
    .select()
    .single();

  if (updateError) {
    logger.error('[PROMOTIONS] fulfillment update error:', updateError);
    return NextResponse.json({ error: 'Failed to update fulfillment status' }, { status: 500 });
  }

  return NextResponse.json({ redemption: updated });
}

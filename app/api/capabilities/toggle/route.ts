import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { canModifyCapability } from '@/lib/capabilities/policy';

/**
 * POST /api/capabilities/toggle
 *
 * Server-controlled capability write endpoint.
 * Supports: toggle is_enabled, update sort_order, update custom_label.
 *
 * Body: { businessId: string, capability: string, enabled?: boolean, sort_order?: number, custom_label?: string | null }
 * Returns: { success: boolean, reason?: string }
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();

  // Auth
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ success: false, reason: 'unauthorized' }, { status: 401 });
  }

  // Parse body
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, reason: 'invalid_body' }, { status: 400 });
  }

  const { businessId, capability } = body as { businessId?: string; capability?: string };
  const enabled = body.enabled as boolean | undefined;
  const sortOrder = body.sort_order as number | undefined;
  const customLabel = body.custom_label as string | null | undefined;

  if (!businessId || !capability) {
    return NextResponse.json({ success: false, reason: 'missing_fields' }, { status: 400 });
  }

  // Must have at least one operation
  if (enabled === undefined && sortOrder === undefined && customLabel === undefined) {
    return NextResponse.json({ success: false, reason: 'no_operation' }, { status: 400 });
  }

  // Verify business ownership and status
  const { data: business, error: bizError } = await supabase
    .from('businesses')
    .select('id, owner_id, subscription_tier, trial_ends_at, status')
    .eq('id', businessId)
    .eq('owner_id', user.id)
    .maybeSingle();

  if (bizError || !business) {
    return NextResponse.json({ success: false, reason: 'business_not_found' }, { status: 404 });
  }

  // Business must be active or pending (not suspended)
  if (business.status === 'suspended') {
    return NextResponse.json({ success: false, reason: 'business_suspended' }, { status: 403 });
  }

  // Load admin overrides — fail closed on error
  const { data: overrideRows, error: overrideError } = await supabase
    .from('capability_overrides')
    .select('capability')
    .eq('business_id', businessId);

  if (overrideError) {
    return NextResponse.json({ success: false, reason: 'override_read_failed' }, { status: 500 });
  }

  const overrides = (overrideRows || []).map(r => r.capability as string);

  // Policy check for enable operations
  if (enabled !== undefined) {
    const check = canModifyCapability({
      capabilityId: capability,
      requestedState: enabled,
      tier: business.subscription_tier,
      trialEndsAt: business.trial_ends_at,
      overrides,
    });

    if (!check.allowed) {
      return NextResponse.json(
        { success: false, reason: check.reason },
        { status: 403 },
      );
    }
  }

  // Build update payload
  const updatePayload: Record<string, unknown> = {};
  if (enabled !== undefined) updatePayload.is_enabled = enabled;
  if (sortOrder !== undefined) updatePayload.sort_order = sortOrder;
  if (customLabel !== undefined) updatePayload.custom_label = customLabel;

  // Atomic write via service client
  const service = createServiceClient();
  const { error: writeError } = await service
    .from('business_capabilities')
    .upsert(
      { business_id: businessId, capability, ...updatePayload },
      { onConflict: 'business_id,capability' },
    );

  if (writeError) {
    console.warn('[CAP_TOGGLE] Write error:', writeError.message);
    return NextResponse.json(
      { success: false, reason: 'write_failed' },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true });
}

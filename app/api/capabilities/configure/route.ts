import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { canModifyCapability } from '@/lib/capabilities/policy';
import { CAPABILITIES } from '@/lib/capabilities/types';
import { getMissingDependencies } from '@/lib/capabilities/dependencies';
import type { CapabilityId } from '@/lib/capabilities/types';

const VALID_CAP_IDS = new Set<string>(CAPABILITIES.map(c => c.id));

/**
 * POST /api/capabilities/configure
 *
 * Atomic bulk capability configuration via PostgreSQL RPC.
 * Validates the entire request, then applies atomically — all succeed or all roll back.
 *
 * Body: { businessId: string, capabilities: string[], order?: string[] }
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ success: false, reason: 'unauthorized' }, { status: 401 });
  }

  let body: { businessId?: string; capabilities?: string[]; order?: string[] };
  try { body = await request.json(); } catch {
    return NextResponse.json({ success: false, reason: 'invalid_body' }, { status: 400 });
  }

  const { businessId, capabilities: requestedCaps } = body;
  if (!businessId || !Array.isArray(requestedCaps)) {
    return NextResponse.json({ success: false, reason: 'missing_fields' }, { status: 400 });
  }

  // Validate capability IDs
  const invalidCaps = requestedCaps.filter(c => !VALID_CAP_IDS.has(c));
  if (invalidCaps.length > 0) {
    return NextResponse.json({ success: false, reason: 'invalid_capabilities', invalid: invalidCaps }, { status: 400 });
  }
  if (requestedCaps.length === 0) {
    return NextResponse.json({ success: false, reason: 'must_have_at_least_one' }, { status: 400 });
  }

  // Reject duplicates
  if (new Set(requestedCaps).size !== requestedCaps.length) {
    return NextResponse.json({ success: false, reason: 'duplicate_capabilities' }, { status: 400 });
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
  if (business.status === 'suspended') {
    return NextResponse.json({ success: false, reason: 'business_suspended' }, { status: 403 });
  }

  // Load overrides — fail closed
  const { data: overrideRows, error: overrideError } = await supabase
    .from('capability_overrides')
    .select('capability')
    .eq('business_id', businessId);

  if (overrideError) {
    return NextResponse.json({ success: false, reason: 'override_read_failed' }, { status: 500 });
  }

  const overrides = (overrideRows || []).map(r => r.capability as string);

  // Service client for server-controlled operations
  const service = createServiceClient();

  // Load current selected capabilities to distinguish newly enabled from unchanged
  const { data: currentRows, error: currentError } = await service
    .from('business_capabilities')
    .select('capability, is_enabled')
    .eq('business_id', businessId);

  if (currentError) {
    return NextResponse.json({ success: false, reason: 'capability_read_failed' }, { status: 500 });
  }

  const currentSelected = new Set(
    (currentRows || []).filter(r => r.is_enabled).map(r => r.capability as string),
  );

  // Only validate tier/trial/override for NEWLY ENABLED capabilities
  // Existing paused-but-selected capabilities are allowed to remain selected
  const newlyEnabled = requestedCaps.filter(cap => !currentSelected.has(cap));

  const denied: Array<{ capability: string; reason: string }> = [];
  for (const cap of newlyEnabled) {
    const check = canModifyCapability({
      capabilityId: cap,
      requestedState: true,
      tier: business.subscription_tier,
      trialEndsAt: business.trial_ends_at,
      overrides,
    });
    if (!check.allowed) {
      denied.push({ capability: cap, reason: check.reason || 'tier_required' });
    }
  }

  if (denied.length > 0) {
    return NextResponse.json({ success: false, reason: 'capabilities_denied', denied }, { status: 403 });
  }

  // Validate dependencies
  for (const cap of requestedCaps) {
    const missing = getMissingDependencies(cap as CapabilityId, requestedCaps as CapabilityId[]);
    if (missing.length > 0) {
      return NextResponse.json(
        { success: false, reason: 'dependency_missing', capability: cap, missing_dependencies: missing },
        { status: 400 },
      );
    }
  }

  // Validate and build sort orders
  const order = body.order || requestedCaps;
  if (!Array.isArray(order)) {
    return NextResponse.json({ success: false, reason: 'invalid_order' }, { status: 400 });
  }
  // Order must contain exactly the same IDs as requestedCaps
  const orderSet = new Set(order);
  const capsSet = new Set(requestedCaps);
  if (orderSet.size !== order.length) {
    return NextResponse.json({ success: false, reason: 'invalid_order', detail: 'duplicate entries' }, { status: 400 });
  }
  if (orderSet.size !== capsSet.size || ![...orderSet].every(id => capsSet.has(id))) {
    return NextResponse.json({ success: false, reason: 'invalid_order', detail: 'must contain exactly the requested capabilities' }, { status: 400 });
  }
  // Validate all order entries are valid capability IDs
  const invalidOrderIds = order.filter(id => !VALID_CAP_IDS.has(id));
  if (invalidOrderIds.length > 0) {
    return NextResponse.json({ success: false, reason: 'invalid_order', detail: 'invalid capability IDs in order' }, { status: 400 });
  }
  const sortOrders = requestedCaps.map(cap => order.indexOf(cap));

  // Build canonical snapshot of current selected capabilities for stale-read detection
  const currentSelectedSorted = [...currentSelected].sort();
  const currentOverridesSorted = [...overrides].sort();

  // Execute atomic RPC with full snapshot verification to prevent stale-read race
  const { data: result, error: rpcError } = await service.rpc('configure_business_capabilities', {
    p_business_id: businessId,
    p_capabilities: requestedCaps,
    p_sort_orders: sortOrders,
    p_expected_tier: business.subscription_tier,
    p_expected_trial_ends_at: business.trial_ends_at,
    p_expected_status: business.status,
    p_expected_selected: currentSelectedSorted,
    p_expected_overrides: currentOverridesSorted,
  });

  if (rpcError) {
    console.warn('[CAP_CONFIGURE] RPC error:', rpcError.message);
    const isConflict = rpcError.message?.includes('configuration_conflict');
    return NextResponse.json(
      { success: false, reason: isConflict ? 'configuration_conflict' : 'configuration_failed' },
      { status: isConflict ? 409 : 500 },
    );
  }

  try {
    const { emitServerEvent } = await import('@/lib/observability/server-events');
    const requestedSet = new Set(requestedCaps);
    const currentSet = new Set(currentSelected);
    // Newly enabled
    for (const cap of requestedCaps) {
      if (!currentSet.has(cap)) {
        emitServerEvent(request, 'capability.enabled', user.id, { business_id: businessId, capability: cap });
      }
    }
    // Newly disabled
    for (const cap of currentSelected) {
      if (!requestedSet.has(cap)) {
        emitServerEvent(request, 'capability.disabled', user.id, { business_id: businessId, capability: cap });
      }
    }
  } catch { /* instrumentation must never fail capability config */ }

  return NextResponse.json({ success: true, state: result });
}

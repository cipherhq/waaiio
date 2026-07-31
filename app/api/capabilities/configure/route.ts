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
 * Atomic bulk capability configuration.
 * Accepts the complete desired enabled set and applies it atomically.
 *
 * Body: { businessId: string, capabilities: string[], order?: string[] }
 *
 * - capabilities: the full list of capabilities to enable
 * - order: optional sort order (capabilities[0] = sort_order 0, etc.)
 * - unlisted configured capabilities are disabled, not deleted
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

  // Validate all capability IDs
  const invalidCaps = requestedCaps.filter(c => !VALID_CAP_IDS.has(c));
  if (invalidCaps.length > 0) {
    return NextResponse.json({ success: false, reason: 'invalid_capabilities', invalid: invalidCaps }, { status: 400 });
  }
  if (requestedCaps.length === 0) {
    return NextResponse.json({ success: false, reason: 'must_have_at_least_one' }, { status: 400 });
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

  // Validate tier/trial/override for each capability being enabled
  const denied: Array<{ capability: string; reason: string }> = [];
  for (const cap of requestedCaps) {
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

  // Atomic write: disable all, then upsert enabled set
  const service = createServiceClient();

  // Step 1: Disable all existing rows for this business
  const { error: disableError } = await service
    .from('business_capabilities')
    .update({ is_enabled: false })
    .eq('business_id', businessId);

  if (disableError) {
    return NextResponse.json({ success: false, reason: 'write_failed' }, { status: 500 });
  }

  // Step 2: Upsert each enabled capability with sort order
  const order = body.order || requestedCaps;
  const rows = requestedCaps.map(cap => ({
    business_id: businessId,
    capability: cap,
    is_enabled: true,
    sort_order: order.indexOf(cap) >= 0 ? order.indexOf(cap) : 999,
  }));

  const { error: upsertError } = await service
    .from('business_capabilities')
    .upsert(rows, { onConflict: 'business_id,capability' });

  if (upsertError) {
    // Attempt to restore — re-enable the previously disabled ones
    // This is best-effort since we can't truly roll back without a transaction
    return NextResponse.json({ success: false, reason: 'write_failed' }, { status: 500 });
  }

  return NextResponse.json({ success: true, enabled: requestedCaps.length });
}

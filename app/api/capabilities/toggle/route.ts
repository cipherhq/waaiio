import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { canModifyCapability } from '@/lib/capabilities/policy';
import type { CapabilityId } from '@/lib/capabilities/types';

/**
 * POST /api/capabilities/toggle
 *
 * Server-controlled capability write endpoint.
 * Replaces direct browser Supabase writes with server-side tier/trial/override validation.
 *
 * Body: { businessId: string, capability: string, enabled: boolean }
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
  let body: { businessId?: string; capability?: string; enabled?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, reason: 'invalid_body' }, { status: 400 });
  }

  const { businessId, capability, enabled } = body;
  if (!businessId || !capability || typeof enabled !== 'boolean') {
    return NextResponse.json({ success: false, reason: 'missing_fields' }, { status: 400 });
  }

  // Verify business ownership
  const { data: business, error: bizError } = await supabase
    .from('businesses')
    .select('id, owner_id, subscription_tier, trial_ends_at, status')
    .eq('id', businessId)
    .eq('owner_id', user.id)
    .maybeSingle();

  if (bizError || !business) {
    return NextResponse.json({ success: false, reason: 'business_not_found' }, { status: 404 });
  }

  // Load admin overrides for this business
  const { data: overrideRows } = await supabase
    .from('capability_overrides')
    .select('capability')
    .eq('business_id', businessId);

  const overrides = (overrideRows || []).map(r => r.capability as string);

  // Policy check
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

  // Atomic write via service client (bypasses owner-only INSERT RLS)
  const service = createServiceClient();
  const { error: writeError } = await service
    .from('business_capabilities')
    .upsert(
      { business_id: businessId, capability, is_enabled: enabled },
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

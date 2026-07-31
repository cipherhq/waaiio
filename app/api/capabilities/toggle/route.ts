import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { canModifyCapability } from '@/lib/capabilities/policy';
import { CAPABILITIES } from '@/lib/capabilities/types';
import { getMissingDependencies, getDependents } from '@/lib/capabilities/dependencies';
import type { CapabilityId } from '@/lib/capabilities/types';

const VALID_CAP_IDS = new Set<string>(CAPABILITIES.map(c => c.id));
const MAX_CUSTOM_LABEL_LENGTH = 50;
const MAX_SORT_ORDER = 9999;

type ToggleBody = {
  businessId?: string;
  capability?: string;
  enabled?: boolean;
  sort_order?: number;
  custom_label?: string | null;
};

function validateBody(body: unknown): { valid: true; data: ToggleBody } | { valid: false; reason: string } {
  if (!body || typeof body !== 'object') return { valid: false, reason: 'invalid_body' };
  const b = body as Record<string, unknown>;

  if (typeof b.businessId !== 'string' || !b.businessId) return { valid: false, reason: 'missing_business_id' };
  if (typeof b.capability !== 'string' || !b.capability) return { valid: false, reason: 'missing_capability' };
  if (!VALID_CAP_IDS.has(b.capability)) return { valid: false, reason: 'invalid_capability' };

  const data: ToggleBody = { businessId: b.businessId, capability: b.capability };
  let hasOperation = false;

  if ('enabled' in b) {
    if (typeof b.enabled !== 'boolean') return { valid: false, reason: 'enabled_must_be_boolean' };
    data.enabled = b.enabled;
    hasOperation = true;
  }
  if ('sort_order' in b) {
    if (typeof b.sort_order !== 'number' || !Number.isInteger(b.sort_order) || b.sort_order < 0 || b.sort_order > MAX_SORT_ORDER) {
      return { valid: false, reason: 'sort_order_invalid' };
    }
    data.sort_order = b.sort_order;
    hasOperation = true;
  }
  if ('custom_label' in b) {
    if (b.custom_label !== null && (typeof b.custom_label !== 'string' || b.custom_label.length > MAX_CUSTOM_LABEL_LENGTH)) {
      return { valid: false, reason: 'custom_label_invalid' };
    }
    data.custom_label = b.custom_label as string | null;
    hasOperation = true;
  }

  if (!hasOperation) return { valid: false, reason: 'no_operation' };
  return { valid: true, data };
}

/**
 * POST /api/capabilities/toggle
 *
 * Server-controlled capability write endpoint.
 * Supports: toggle is_enabled, update sort_order, update custom_label.
 * Metadata-only operations (sort_order, custom_label) require an existing row.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ success: false, reason: 'unauthorized' }, { status: 401 });
  }

  let rawBody: unknown;
  try { rawBody = await request.json(); } catch {
    return NextResponse.json({ success: false, reason: 'invalid_body' }, { status: 400 });
  }

  const validation = validateBody(rawBody);
  if (!validation.valid) {
    return NextResponse.json({ success: false, reason: validation.reason }, { status: 400 });
  }

  const { businessId, capability, enabled, sort_order, custom_label } = validation.data;
  const capId = capability as CapabilityId;

  // Verify business ownership and status
  const { data: business, error: bizError } = await supabase
    .from('businesses')
    .select('id, owner_id, subscription_tier, trial_ends_at, status')
    .eq('id', businessId!)
    .eq('owner_id', user.id)
    .maybeSingle();

  if (bizError || !business) {
    return NextResponse.json({ success: false, reason: 'business_not_found' }, { status: 404 });
  }
  if (business.status === 'suspended') {
    return NextResponse.json({ success: false, reason: 'business_suspended' }, { status: 403 });
  }

  // Load admin overrides — fail closed on error
  const { data: overrideRows, error: overrideError } = await supabase
    .from('capability_overrides')
    .select('capability')
    .eq('business_id', businessId!);

  if (overrideError) {
    return NextResponse.json({ success: false, reason: 'override_read_failed' }, { status: 500 });
  }

  const overrides = (overrideRows || []).map(r => r.capability as string);
  const service = createServiceClient();

  // ── Toggle operation (enable/disable) ──
  if (enabled !== undefined) {
    const check = canModifyCapability({
      capabilityId: capId,
      requestedState: enabled,
      tier: business.subscription_tier,
      trialEndsAt: business.trial_ends_at,
      overrides,
    });

    if (!check.allowed) {
      return NextResponse.json({ success: false, reason: check.reason }, { status: 403 });
    }

    // Dependency check for enabling
    if (enabled) {
      // Load currently enabled capabilities to check dependencies
      const { data: currentCaps, error: capsError } = await service
        .from('business_capabilities')
        .select('capability')
        .eq('business_id', businessId!)
        .eq('is_enabled', true);

      if (capsError) {
        return NextResponse.json({ success: false, reason: 'capability_read_failed' }, { status: 500 });
      }

      const currentEnabled = (currentCaps || []).map(r => r.capability as CapabilityId);
      const missing = getMissingDependencies(capId, currentEnabled);
      if (missing.length > 0) {
        return NextResponse.json(
          { success: false, reason: 'dependency_missing', missing_dependencies: missing },
          { status: 400 },
        );
      }
    }

    // Dependency check for disabling — auto-disable dependents
    if (!enabled) {
      const { data: currentCaps } = await service
        .from('business_capabilities')
        .select('capability')
        .eq('business_id', businessId!)
        .eq('is_enabled', true);

      const currentEnabled = (currentCaps || []).map(r => r.capability as CapabilityId);
      const dependents = getDependents(capId, currentEnabled);

      // Disable dependents first
      for (const dep of dependents) {
        await service
          .from('business_capabilities')
          .update({ is_enabled: false })
          .eq('business_id', businessId!)
          .eq('capability', dep);
      }
    }

    // Upsert the capability toggle
    const upsertPayload: Record<string, unknown> = {
      business_id: businessId,
      capability: capId,
      is_enabled: enabled,
    };
    if (sort_order !== undefined) upsertPayload.sort_order = sort_order;

    const { error: writeError } = await service
      .from('business_capabilities')
      .upsert(upsertPayload, { onConflict: 'business_id,capability' });

    if (writeError) {
      return NextResponse.json({ success: false, reason: 'write_failed' }, { status: 500 });
    }

    return NextResponse.json({ success: true, dependents_disabled: enabled ? [] : getDependents(capId, []) });
  }

  // ── Metadata-only operations (sort_order, custom_label) ──
  // These require an existing row — must NOT create or enable capabilities
  const updatePayload: Record<string, unknown> = {};
  if (sort_order !== undefined) updatePayload.sort_order = sort_order;
  if (custom_label !== undefined) updatePayload.custom_label = custom_label;

  const { data: updated, error: updateError } = await service
    .from('business_capabilities')
    .update(updatePayload)
    .eq('business_id', businessId!)
    .eq('capability', capId)
    .select('id')
    .maybeSingle();

  if (updateError) {
    return NextResponse.json({ success: false, reason: 'write_failed' }, { status: 500 });
  }
  if (!updated) {
    return NextResponse.json({ success: false, reason: 'capability_not_found' }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { CAPABILITIES } from '@/lib/capabilities/types';

const VALID_CAP_IDS = new Set<string>(CAPABILITIES.map(c => c.id));
const MAX_CUSTOM_LABEL_LENGTH = 50;
const MAX_SORT_ORDER = 9999;

/**
 * POST /api/capabilities/toggle
 *
 * Metadata-only capability operations: sort_order and custom_label.
 * Does NOT support enabling or disabling capabilities — use
 * POST /api/capabilities/configure for selected-state changes.
 *
 * Body: { businessId: string, capability: string, sort_order?: number, custom_label?: string | null }
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

  if (!rawBody || typeof rawBody !== 'object') {
    return NextResponse.json({ success: false, reason: 'invalid_body' }, { status: 400 });
  }

  const b = rawBody as Record<string, unknown>;

  if (typeof b.businessId !== 'string' || !b.businessId) {
    return NextResponse.json({ success: false, reason: 'missing_business_id' }, { status: 400 });
  }
  if (typeof b.capability !== 'string' || !VALID_CAP_IDS.has(b.capability)) {
    return NextResponse.json({ success: false, reason: 'invalid_capability' }, { status: 400 });
  }

  // Reject enabled field — use /api/capabilities/configure instead
  if ('enabled' in b) {
    return NextResponse.json(
      { success: false, reason: 'use_configure_endpoint', detail: 'Use POST /api/capabilities/configure for enable/disable operations' },
      { status: 400 },
    );
  }

  const updatePayload: Record<string, unknown> = {};
  let hasOperation = false;

  if ('sort_order' in b) {
    if (typeof b.sort_order !== 'number' || !Number.isInteger(b.sort_order) || b.sort_order < 0 || b.sort_order > MAX_SORT_ORDER) {
      return NextResponse.json({ success: false, reason: 'sort_order_invalid' }, { status: 400 });
    }
    updatePayload.sort_order = b.sort_order;
    hasOperation = true;
  }

  if ('custom_label' in b) {
    if (b.custom_label !== null && (typeof b.custom_label !== 'string' || b.custom_label.length > MAX_CUSTOM_LABEL_LENGTH)) {
      return NextResponse.json({ success: false, reason: 'custom_label_invalid' }, { status: 400 });
    }
    updatePayload.custom_label = b.custom_label;
    hasOperation = true;
  }

  if (!hasOperation) {
    return NextResponse.json({ success: false, reason: 'no_operation' }, { status: 400 });
  }

  // Verify business ownership and status
  const { data: business, error: bizError } = await supabase
    .from('businesses')
    .select('id, owner_id, status')
    .eq('id', b.businessId)
    .eq('owner_id', user.id)
    .maybeSingle();

  if (bizError || !business) {
    return NextResponse.json({ success: false, reason: 'business_not_found' }, { status: 404 });
  }
  if (business.status === 'suspended') {
    return NextResponse.json({ success: false, reason: 'business_suspended' }, { status: 403 });
  }

  // Metadata operations require an existing row — must NOT create capabilities
  const service = createServiceClient();
  const { data: updated, error: updateError } = await service
    .from('business_capabilities')
    .update(updatePayload)
    .eq('business_id', b.businessId)
    .eq('capability', b.capability)
    .select('id')
    .maybeSingle();

  if (updateError) {
    console.warn('[CAP_TOGGLE] Write error:', updateError.message);
    return NextResponse.json({ success: false, reason: 'write_failed' }, { status: 500 });
  }
  if (!updated) {
    return NextResponse.json({ success: false, reason: 'capability_not_found' }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}

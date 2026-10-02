import { NextRequest, NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';

export const dynamic = 'force-dynamic';

/**
 * Commercial config keys — managed exclusively via save_commercial_config() RPC.
 * This route refuses to modify them; they must go through the versioned RPC path.
 */
const COMMERCIAL_KEYS = new Set([
  'pricing_tiers', 'trial_days', 'broadcast_limits', 'conversation_limits',
  'default_platform_fee_percent', 'annual_discount_percentage',
  'payout_cooling_period_days', 'minimum_payout', 'payout_verification_limits',
  'transfer_expiry_hours', 'minimum_bank_transfer',
  'messaging_financial_gate', 'messaging_reservation_ttl_seconds',
  'fee_policy_enabled', 'category_fee_rates',
]);

/**
 * PUT /api/admin/platform-settings
 * Admin-only: update a non-commercial platform setting.
 */
export async function PUT(request: NextRequest) {
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { key, value } = body;
  if (typeof key !== 'string' || !key) {
    return NextResponse.json({ error: 'key must be a non-empty string' }, { status: 400 });
  }
  if (COMMERCIAL_KEYS.has(key)) {
    return NextResponse.json(
      { error: 'Commercial config keys must be updated via save_commercial_config RPC' },
      { status: 403 },
    );
  }

  const supabase = createServiceClient();
  const now = new Date().toISOString();

  const { error } = await supabase
    .from('platform_settings')
    .update({
      value,
      updated_by: admin.userId,
      updated_at: now,
    })
    .eq('key', key);

  if (error) {
    console.error('[PLATFORM_SETTINGS] PUT failed:', error.message);
    return NextResponse.json({ error: 'Failed to update setting' }, { status: 500 });
  }

  // Server-side audit
  const { error: auditError } = await supabase.from('admin_audit_logs').insert({
    actor_id: admin.userId,
    action: 'update_platform_setting',
    entity_type: 'platform_setting',
    entity_id: key,
    details: { key, new_value: value },
  });
  if (auditError) {
    console.error('[PLATFORM_SETTINGS] Audit log failed for PUT:', auditError.message);
  }

  return NextResponse.json({ success: true });
}

/**
 * POST /api/admin/platform-settings
 * Admin-only: create a new non-commercial platform setting.
 */
export async function POST(request: NextRequest) {
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { key, value, description } = body;
  if (typeof key !== 'string' || !key) {
    return NextResponse.json({ error: 'key must be a non-empty string' }, { status: 400 });
  }
  if (COMMERCIAL_KEYS.has(key)) {
    return NextResponse.json(
      { error: 'Commercial config keys must be created via save_commercial_config RPC' },
      { status: 403 },
    );
  }

  const supabase = createServiceClient();
  const now = new Date().toISOString();

  const { error } = await supabase
    .from('platform_settings')
    .insert({
      key,
      value,
      description: typeof description === 'string' ? description : null,
      updated_by: admin.userId,
      updated_at: now,
    });

  if (error) {
    console.error('[PLATFORM_SETTINGS] POST failed:', error.message);
    return NextResponse.json({ error: 'Failed to create setting' }, { status: 500 });
  }

  // Server-side audit
  const { error: auditError } = await supabase.from('admin_audit_logs').insert({
    actor_id: admin.userId,
    action: 'create_platform_setting',
    entity_type: 'platform_setting',
    entity_id: key,
    details: { key, value, description: typeof description === 'string' ? description : null },
  });
  if (auditError) {
    console.error('[PLATFORM_SETTINGS] Audit log failed for POST:', auditError.message);
  }

  return NextResponse.json({ success: true });
}

/**
 * DELETE /api/admin/platform-settings
 * Admin-only: delete a non-commercial platform setting.
 */
export async function DELETE(request: NextRequest) {
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { key } = body;
  if (typeof key !== 'string' || !key) {
    return NextResponse.json({ error: 'key must be a non-empty string' }, { status: 400 });
  }
  if (COMMERCIAL_KEYS.has(key)) {
    return NextResponse.json(
      { error: 'Commercial config keys cannot be deleted' },
      { status: 403 },
    );
  }

  const supabase = createServiceClient();

  const { error } = await supabase
    .from('platform_settings')
    .delete()
    .eq('key', key);

  if (error) {
    console.error('[PLATFORM_SETTINGS] DELETE failed:', error.message);
    return NextResponse.json({ error: 'Failed to delete setting' }, { status: 500 });
  }

  // Server-side audit
  const { error: auditError } = await supabase.from('admin_audit_logs').insert({
    actor_id: admin.userId,
    action: 'delete_platform_setting',
    entity_type: 'platform_setting',
    entity_id: key,
    details: { key },
  });
  if (auditError) {
    console.error('[PLATFORM_SETTINGS] Audit log failed for DELETE:', auditError.message);
  }

  return NextResponse.json({ success: true });
}

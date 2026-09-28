import { NextRequest, NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';
import { adminCorsHeaders } from '@/lib/admin-cors';
import { validateSourceLabel } from '@/lib/platform-campaigns/validation';

export const dynamic = 'force-dynamic';

/**
 * PUT /api/admin/platform-campaigns/[id]/assets/[assetId]
 * Update/deactivate an asset. No DELETE in Slice 1.
 * Revalidates channel as shared+active if channel changes.
 */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string; assetId: string }> }) {
  const origin = request.headers.get('origin');
  const cors = adminCorsHeaders(origin, 'PUT, OPTIONS');
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403, headers: cors });

  const { id: campaignId, assetId } = await params;
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  const supabase = createServiceClient();

  // Verify asset exists and belongs to this campaign
  const { data: existing } = await supabase
    .from('platform_campaign_assets')
    .select('id, campaign_id, channel_id, market')
    .eq('id', assetId)
    .eq('campaign_id', campaignId)
    .single();

  if (!existing) return NextResponse.json({ error: 'Asset not found' }, { status: 404, headers: cors });

  const updates: Record<string, unknown> = {};

  // Deactivation
  if (body.is_active !== undefined) {
    if (typeof body.is_active !== 'boolean') {
      return NextResponse.json({ error: 'is_active must be boolean' }, { status: 400, headers: cors });
    }
    updates.is_active = body.is_active;
  }

  // Source label — reject non-string/non-null values
  if (body.source_label !== undefined) {
    const labelErr = validateSourceLabel(body.source_label);
    if (labelErr) return NextResponse.json({ error: labelErr }, { status: 400, headers: cors });
    updates.source_label = body.source_label;
  }

  // Source type
  if (body.source_type !== undefined) {
    const valid = ['website_button', 'website_qr', 'instagram_link', 'instagram_qr', 'billboard_qr', 'flyer_qr', 'event_qr', 'direct_link', 'email_link', 'other'];
    if (!valid.includes(body.source_type as string)) {
      return NextResponse.json({ error: `source_type must be one of: ${valid.join(', ')}` }, { status: 400, headers: cors });
    }
    updates.source_type = body.source_type;
  }

  // Channel change — revalidate shared+active and derive market
  if (body.channel_id !== undefined && body.channel_id !== existing.channel_id) {
    const { data: channel } = await supabase
      .from('whatsapp_channels')
      .select('id, phone_number, country_code, channel_type, is_active')
      .eq('id', body.channel_id as string)
      .single();

    if (!channel) return NextResponse.json({ error: 'Channel not found' }, { status: 404, headers: cors });
    if (channel.channel_type !== 'shared') {
      return NextResponse.json({ error: 'Only shared Waaiio channels allowed' }, { status: 400, headers: cors });
    }
    if (!channel.is_active) {
      return NextResponse.json({ error: 'Channel is not active' }, { status: 400, headers: cors });
    }

    // Check campaign market_scope
    const { data: campaign } = await supabase
      .from('platform_campaigns')
      .select('market_scope')
      .eq('id', campaignId)
      .single();

    const scope = (campaign?.market_scope as string[]) || [];
    if (scope.length > 0 && !scope.includes(channel.country_code)) {
      return NextResponse.json({ error: `Channel market '${channel.country_code}' is outside campaign scope` }, { status: 400, headers: cors });
    }

    updates.channel_id = channel.id;
    updates.market = channel.country_code;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400, headers: cors });
  }

  const { data, error } = await supabase
    .from('platform_campaign_assets')
    .update(updates)
    .eq('id', assetId)
    .eq('campaign_id', campaignId)
    .select()
    .single();

  if (error || !data) return NextResponse.json({ error: 'Failed to update asset' }, { status: 500, headers: cors });

  await supabase.from('admin_audit_logs').insert({
    actor_id: admin.userId,
    action: updates.is_active === false ? 'platform_campaign_asset_deactivated' : 'platform_campaign_asset_updated',
    entity_type: 'platform_campaign_asset',
    entity_id: assetId,
    details: { campaign_id: campaignId, fields: Object.keys(updates) },
  }).then(() => {}, () => {});

  return NextResponse.json({ data }, { headers: cors });
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: adminCorsHeaders(request.headers.get('origin'), 'PUT, OPTIONS') });
}

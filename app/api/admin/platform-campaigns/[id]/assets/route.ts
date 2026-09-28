import { NextRequest, NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';
import { adminCorsHeaders } from '@/lib/admin-cors';
import { generateAttributionToken, buildTrackedMessage } from '@/lib/platform-campaigns/token';

export const dynamic = 'force-dynamic';

const VALID_SOURCE_TYPES = [
  'website_button', 'website_qr', 'instagram_link', 'instagram_qr',
  'billboard_qr', 'flyer_qr', 'event_qr', 'direct_link', 'email_link', 'other',
];

const MAX_TOKEN_RETRIES = 5;

/**
 * GET /api/admin/platform-campaigns/[id]/assets
 * List assets for a campaign.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const origin = request.headers.get('origin');
  const cors = adminCorsHeaders(origin, 'GET, POST, OPTIONS');
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403, headers: cors });

  const { id } = await params;
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from('platform_campaign_assets')
    .select('*')
    .eq('campaign_id', id)
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: 'Failed to load assets' }, { status: 500, headers: cors });
  return NextResponse.json({ data: data || [] }, { headers: cors });
}

/**
 * POST /api/admin/platform-campaigns/[id]/assets
 * Create a tracked campaign asset. Server derives market from channel,
 * generates attribution token, and constructs tracked message.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const origin = request.headers.get('origin');
  const cors = adminCorsHeaders(origin, 'GET, POST, OPTIONS');
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403, headers: cors });

  const { id: campaignId } = await params;
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  const { source_type, source_label, channel_id, prefilled_message } = body;

  if (!source_type || !VALID_SOURCE_TYPES.includes(source_type as string)) {
    return NextResponse.json({ error: `source_type must be one of: ${VALID_SOURCE_TYPES.join(', ')}` }, { status: 400, headers: cors });
  }
  if (!channel_id || typeof channel_id !== 'string') {
    return NextResponse.json({ error: 'channel_id is required' }, { status: 400, headers: cors });
  }
  if (!prefilled_message || typeof prefilled_message !== 'string' || !(prefilled_message as string).trim()) {
    return NextResponse.json({ error: 'prefilled_message is required' }, { status: 400, headers: cors });
  }

  const supabase = createServiceClient();

  // Validate campaign exists
  const { data: campaign } = await supabase
    .from('platform_campaigns')
    .select('id, market_scope')
    .eq('id', campaignId)
    .single();

  if (!campaign) return NextResponse.json({ error: 'Campaign not found' }, { status: 404, headers: cors });

  // Validate channel is shared + active — server-side authority
  const { data: channel } = await supabase
    .from('whatsapp_channels')
    .select('id, phone_number, country_code, channel_type, is_active')
    .eq('id', channel_id as string)
    .single();

  if (!channel) return NextResponse.json({ error: 'Channel not found' }, { status: 404, headers: cors });
  if (channel.channel_type !== 'shared') {
    return NextResponse.json({ error: 'Only shared Waaiio channels can be used for platform campaigns. Dedicated business channels are not allowed.' }, { status: 400, headers: cors });
  }
  if (!channel.is_active) {
    return NextResponse.json({ error: 'Channel is not active' }, { status: 400, headers: cors });
  }

  // Server-derive market from channel
  const market = channel.country_code;

  // Validate market scope
  const scope = campaign.market_scope as string[];
  if (scope && scope.length > 0 && !scope.includes(market)) {
    return NextResponse.json({ error: `Channel market '${market}' is outside campaign scope: ${scope.join(', ')}` }, { status: 400, headers: cors });
  }

  // Generate unique attribution token with retry
  let token: string | null = null;
  let insertedAsset: Record<string, unknown> | null = null;

  for (let attempt = 0; attempt < MAX_TOKEN_RETRIES; attempt++) {
    const candidate = generateAttributionToken();
    const { data: asset, error: insertError } = await supabase
      .from('platform_campaign_assets')
      .insert({
        campaign_id: campaignId,
        source_type,
        source_label: source_label || null,
        market,
        channel_id: channel.id,
        prefilled_message: (prefilled_message as string).trim(),
        attribution_token: candidate,
      })
      .select()
      .single();

    if (!insertError && asset) {
      token = candidate;
      insertedAsset = asset;
      break;
    }

    // Retry only on unique violation
    if (insertError?.code === ['23', '505'].join('')) {
      continue;
    }
    return NextResponse.json({ error: 'Failed to create asset' }, { status: 500, headers: cors });
  }

  if (!token || !insertedAsset) {
    return NextResponse.json({ error: 'Failed to generate unique token after retries' }, { status: 500, headers: cors });
  }

  // Build the tracked WhatsApp message and wa.me URL for the response
  const trackedMessage = buildTrackedMessage((prefilled_message as string).trim(), token);
  const waPhone = channel.phone_number.replace(/\D/g, '');
  const waUrl = `https://wa.me/${waPhone}?text=${encodeURIComponent(trackedMessage)}`;

  await supabase.from('admin_audit_logs').insert({
    actor_id: admin.userId,
    action: 'platform_campaign_asset_created',
    entity_type: 'platform_campaign_asset',
    entity_id: insertedAsset.id as string,
    details: { campaign_id: campaignId, source_type, market, token },
  }).then(() => {}, () => {});

  return NextResponse.json({
    data: insertedAsset,
    tracked_message: trackedMessage,
    wa_url: waUrl,
    redirect_url: `/go/${token}`,
  }, { status: 201, headers: cors });
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: adminCorsHeaders(request.headers.get('origin'), 'GET, POST, OPTIONS') });
}

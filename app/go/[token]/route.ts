import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { buildTrackedMessage, isValidToken } from '@/lib/platform-campaigns/token';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * GET /go/[token]
 *
 * Public tracked redirect. Resolves the asset by attribution token,
 * validates campaign/channel authority, records a click, and 302
 * redirects to the derived wa.me URL.
 *
 * No anon table privileges. Uses service client only.
 * Click recording failure does NOT block a valid redirect.
 * A click is anonymous funnel data — never represented as a known respondent.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  // Validate token against actual generator alphabet (rejects chars generator never emits)
  if (!token || !isValidToken(token)) {
    return new NextResponse('Not found', { status: 404 });
  }

  // Rate limit
  const limited = await rateLimitResponseAsync(getRateLimitKey(request, 'go-redirect'), 60, 60_000);
  if (limited) return limited;

  const normalizedToken = token.toUpperCase();
  const supabase = createServiceClient();

  // 1. Resolve asset
  const { data: asset } = await supabase
    .from('platform_campaign_assets')
    .select('id, campaign_id, channel_id, prefilled_message, is_active, attribution_token')
    .eq('attribution_token', normalizedToken)
    .single();

  if (!asset || !asset.is_active) {
    return new NextResponse('Not found', { status: 404 });
  }

  // 2. Resolve campaign
  const { data: campaign } = await supabase
    .from('platform_campaigns')
    .select('id, status, starts_at, ends_at')
    .eq('id', asset.campaign_id)
    .single();

  if (!campaign || campaign.status !== 'active') {
    return new NextResponse('Not found', { status: 404 });
  }

  // 3. Validate campaign timing
  const now = new Date();
  if (campaign.starts_at && new Date(campaign.starts_at) > now) {
    return new NextResponse('Not found', { status: 404 });
  }
  if (campaign.ends_at && new Date(campaign.ends_at) < now) {
    return new NextResponse('Not found', { status: 404 });
  }

  // 4. Resolve channel — require shared + active
  const { data: channel } = await supabase
    .from('whatsapp_channels')
    .select('phone_number, channel_type, is_active')
    .eq('id', asset.channel_id)
    .single();

  if (!channel || channel.channel_type !== 'shared' || !channel.is_active) {
    return new NextResponse('Not found', { status: 404 });
  }

  // 5. Derive wa.me URL server-side
  const trackedMessage = buildTrackedMessage(asset.prefilled_message, asset.attribution_token);
  const waPhone = channel.phone_number.replace(/\D/g, '');
  const waUrl = `https://wa.me/${waPhone}?text=${encodeURIComponent(trackedMessage)}`;

  // 6. Record click — awaited for lifecycle safety, error ignored for redirect validity
  const userAgent = (request.headers.get('user-agent') || '').slice(0, 512);
  const referrer = (request.headers.get('referer') || '').slice(0, 512);
  try {
    await supabase
      .from('platform_campaign_clicks')
      .insert({ asset_id: asset.id, user_agent: userAgent || null, referrer: referrer || null });
  } catch {
    // Click analytics failure does not block a valid redirect
  }

  // 7. 302 redirect
  return NextResponse.redirect(waUrl, 302);
}

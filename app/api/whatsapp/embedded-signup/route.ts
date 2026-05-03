import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';

/**
 * POST /api/whatsapp/embedded-signup
 *
 * Processes the callback from Meta's Embedded Signup flow.
 * Exchanges the auth code for a token, retrieves WABA + phone number,
 * and creates a whatsapp_channels record for the business.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { business_id, code } = await request.json();
  if (!business_id || !code) {
    return NextResponse.json({ error: 'Missing business_id or auth code' }, { status: 400 });
  }

  // Verify ownership
  const { data: biz } = await supabase
    .from('businesses')
    .select('id, name, country_code')
    .eq('id', business_id)
    .eq('owner_id', user.id)
    .single();
  if (!biz) return NextResponse.json({ error: 'Business not found' }, { status: 404 });

  const appId = process.env.NEXT_PUBLIC_META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const apiVersion = process.env.META_GRAPH_API_VERSION || 'v22.0';

  if (!appId || !appSecret) {
    return NextResponse.json({ error: 'Meta app not configured' }, { status: 500 });
  }

  try {
    // 1. Exchange code for short-lived token, then get long-lived token
    // For FB JS SDK with response_type=code, use /oauth/access_token with the code directly
    // Meta docs: https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow
    const tokenRes = await fetch(
      `https://graph.facebook.com/${apiVersion}/oauth/access_token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: appId,
          client_secret: appSecret,
          code,
          redirect_uri: `https://waaiio.com/dashboard/whatsapp/connect`,
        }).toString(),
      }
    );
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      logger.error('[EMBEDDED-SIGNUP] Token exchange failed:', JSON.stringify(tokenData));
      return NextResponse.json({
        error: 'Failed to exchange auth code',
        details: tokenData.error?.message || tokenData.error?.type || JSON.stringify(tokenData).slice(0, 200),
      }, { status: 400 });
    }

    const accessToken = tokenData.access_token;

    // 2. Get shared WABA IDs from the debug token
    const debugRes = await fetch(
      `https://graph.facebook.com/${apiVersion}/debug_token?input_token=${accessToken}`,
      { headers: { Authorization: `Bearer ${appId}|${appSecret}` } }
    );
    const debugData = await debugRes.json();
    const granularScopes = debugData.data?.granular_scopes || [];
    const wabaScope = granularScopes.find((s: Record<string, unknown>) => s.permission === 'whatsapp_business_management');
    const wabaIds: string[] = wabaScope?.target_ids || [];

    if (wabaIds.length === 0) {
      return NextResponse.json({ error: 'No WhatsApp Business Account was shared. Please try again and grant access.' }, { status: 400 });
    }

    const wabaId = wabaIds[0];

    // 3. Subscribe WABA to webhooks
    await fetch(
      `https://graph.facebook.com/${apiVersion}/${wabaId}/subscribed_apps`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );

    // 4. Get phone numbers for this WABA
    const phonesRes = await fetch(
      `https://graph.facebook.com/${apiVersion}/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const phonesData = await phonesRes.json();
    const phones = phonesData.data || [];

    if (phones.length === 0) {
      return NextResponse.json({ error: 'No phone numbers found on this WhatsApp Business Account' }, { status: 400 });
    }

    const phone = phones[0];
    const phoneNumberId = phone.id;
    const displayNumber = phone.display_phone_number;

    // 5. Register the phone number for cloud API (if not already)
    await fetch(
      `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/register`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ messaging_product: 'whatsapp', pin: '000000' }),
      }
    );

    // 6. Save channel in Waaiio
    const service = createServiceClient();

    // Deactivate any existing channels for this business
    await service.from('whatsapp_channels')
      .update({ is_active: false })
      .eq('business_id', business_id)
      .eq('is_active', true);

    // Create new channel
    const { data: channel, error: channelError } = await service
      .from('whatsapp_channels')
      .insert({
        business_id,
        provider: 'meta_cloud',
        phone_number_id: phoneNumberId,
        waba_id: wabaId,
        meta_access_token: accessToken,
        phone_number: displayNumber,
        display_name: phone.verified_name || biz.name,
        quality_rating: phone.quality_rating || null,
        country_code: biz.country_code || 'US',
        connection_method: 'embedded_signup',
        is_active: true,
      })
      .select()
      .single();

    if (channelError) {
      logger.error('[EMBEDDED-SIGNUP] Channel insert error:', channelError);
      return NextResponse.json({ error: 'Failed to save channel' }, { status: 500 });
    }

    // 7. Update business wa_method
    await service.from('businesses')
      .update({ wa_method: 'own_phone' })
      .eq('id', business_id);

    logger.debug('[EMBEDDED-SIGNUP] Success:', { businessId: business_id, wabaId, phoneNumberId, displayNumber });

    return NextResponse.json({
      success: true,
      channel_id: channel.id,
      phone_number: displayNumber,
      waba_id: wabaId,
    });
  } catch (error) {
    logger.error('[EMBEDDED-SIGNUP] Error:', (error as Error).message);
    return NextResponse.json({ error: 'Signup failed. Please try again.' }, { status: 500 });
  }
}

import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { MetaCloudService } from '@/lib/channels/meta-cloud';
import { logger } from '@/lib/logger';
import { safeLogErrorContext } from '@/lib/errors';
import { safeProviderError, isSafeIdentifier } from '@/lib/redact';

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
          redirect_uri: `${process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com'}/dashboard/whatsapp/connect`,
        }).toString(),
      }
    );
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      logger.error('[EMBEDDED-SIGNUP] Token exchange failed:', safeProviderError(tokenData));
      // NOTE: The response details field may expose provider error info including email/type.
      // This is a pre-existing API contract — changing it is deferred to a separate response-safety PR.
      return NextResponse.json({
        error: 'Failed to exchange auth code',
        details: tokenData.error?.message || tokenData.error?.type || JSON.stringify(tokenData).slice(0, 200),
      }, { status: 400 });
    }

    // Exchange short-lived token for long-lived token before storing
    let accessToken = tokenData.access_token;
    try {
      const longLivedData = await MetaCloudService.exchangeToken(accessToken);
      if (longLivedData.access_token) {
        accessToken = longLivedData.access_token;
        logger.debug('[EMBEDDED-SIGNUP] Exchanged for long-lived token');
      }
    } catch (exchangeErr) {
      logger.withContext({
        op: 'embedded-signup.long-lived-token',
        businessId: business_id,
        ...safeLogErrorContext(exchangeErr),
      }).error('[EMBEDDED-SIGNUP] Long-lived token exchange failed, proceeding with short-lived token');
    }

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

    // Deactivate any existing dedicated channels for this business
    await service.from('whatsapp_channels')
      .update({ is_active: false })
      .eq('business_id', business_id)
      .eq('channel_type', 'dedicated')
      .eq('is_active', true);

    // Create new channel
    const { data: channel, error: channelError } = await service
      .from('whatsapp_channels')
      .insert({
        business_id,
        provider: 'meta_cloud',
        channel_type: 'dedicated',
        phone_number_id: phoneNumberId,
        waba_id: wabaId,
        meta_access_token: accessToken,
        phone_number: displayNumber,
        display_name: phone.verified_name || biz.name,
        quality_rating: phone.quality_rating || null,
        country_code: biz.country_code || 'US',
        connection_method: 'transfer',
        connection_status: 'active',
        is_active: true,
      })
      .select()
      .single();

    if (channelError) {
      logger.withContext({
        op: 'embedded-signup.channel-insert',
        businessId: business_id,
        wabaId,
        ...(typeof channelError.code === 'string' && isSafeIdentifier(channelError.code) ? { errorCode: channelError.code } : {}),
      }).error('[EMBEDDED-SIGNUP] Channel insert failed');
      return NextResponse.json({ error: 'Failed to save channel' }, { status: 500 });
    }

    // 7. Update business — assign channel and set wa_method
    await service.from('businesses')
      .update({
        wa_method: 'transfer',
        whatsapp_channel_id: channel.id,
        assigned_channel_id: channel.id,
      })
      .eq('id', business_id);

    // 8. Auto-provision message templates (non-fatal)
    try {
      const { provisionTemplates } = await import('@/lib/channels/provision-templates');
      await provisionTemplates(wabaId, accessToken);
      logger.debug('[EMBEDDED-SIGNUP] Templates provisioned');
    } catch (err) {
      logger.withContext({
        op: 'embedded-signup.template-provisioning',
        businessId: business_id,
        wabaId,
        ...safeLogErrorContext(err),
      }).error('[EMBEDDED-SIGNUP] Template provisioning warning');
    }

    logger.debug('[EMBEDDED-SIGNUP] Success:', { businessId: business_id, wabaId, phoneNumberId, channelId: channel.id });

    return NextResponse.json({
      success: true,
      channel_id: channel.id,
      phone_number: displayNumber,
      waba_id: wabaId,
    });
  } catch (error) {
    logger.withContext({
      op: 'embedded-signup',
      businessId: business_id,
      ...safeLogErrorContext(error),
    }).error('[EMBEDDED-SIGNUP] Signup failed');
    return NextResponse.json({ error: 'Signup failed. Please try again.' }, { status: 500 });
  }
}

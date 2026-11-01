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

    // 5. Generate PIN once, use for both registration and candidate storage
    const { encryptToken } = await import('@/lib/encryption');
    const { randomInt } = await import('crypto');
    const pin = String(randomInt(100000, 1000000));

    // Register the phone number for cloud API with the generated PIN
    const regRes = await fetch(
      `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/register`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
      }
    );
    if (!regRes.ok) {
      const regData = await regRes.json().catch(() => ({}));
      logger.error('[EMBEDDED-SIGNUP] Phone registration failed:', safeProviderError(regData));
      return NextResponse.json({ error: 'Phone registration failed' }, { status: 422 });
    }

    // 6. #799: Use candidate system instead of direct writes
    const service = createServiceClient();

    // Read current business state for CAS snapshot
    const { data: bizFull } = await service
      .from('businesses')
      .select('id, assigned_channel_id, whatsapp_channel_id, wa_method')
      .eq('id', business_id)
      .single();

    const existingDedicated = await service
      .from('whatsapp_channels')
      .select('id')
      .eq('business_id', business_id)
      .eq('channel_type', 'dedicated')
      .eq('is_active', true)
      .maybeSingle();

    // Insert candidate with CAS snapshot (pin already generated above)
    const { data: candidate, error: candErr } = await service
      .from('whatsapp_channel_candidates')
      .insert({
        business_id,
        connection_source: 'embedded_signup',
        business_wa_method: 'transfer',
        provider: 'meta_cloud',
        phone_number: displayNumber,
        phone_number_normalized: displayNumber ? displayNumber.replace(/[^0-9]/g, '') : null,
        phone_number_id: phoneNumberId,
        waba_id: wabaId,
        meta_access_token: encryptToken(accessToken),
        display_name: phone.verified_name || biz.name,
        country_code: biz.country_code || 'US',
        status: 'ready', // registration + subscription already succeeded
        expected_assigned_channel_id: bizFull?.assigned_channel_id || null,
        expected_whatsapp_channel_id: bizFull?.whatsapp_channel_id || null,
        expected_wa_method: bizFull?.wa_method || null,
        replacing_dedicated_channel_id: existingDedicated?.data?.id || null,
        provider_state: { registered: true, webhook_subscribed: true },
        encrypted_registration_pin: encryptToken(pin),
      })
      .select('id')
      .single();

    if (candErr || !candidate) {
      if (candErr?.code === '23505') {
        return NextResponse.json({ error: 'A connection attempt is already in progress.' }, { status: 409 });
      }
      logger.withContext({
        op: 'embedded-signup.candidate-insert',
        businessId: business_id,
        ...(typeof candErr?.code === 'string' && isSafeIdentifier(candErr.code) ? { errorCode: candErr.code } : {}),
      }).error('[EMBEDDED-SIGNUP] Candidate creation failed');
      return NextResponse.json({ error: 'Failed to save channel' }, { status: 500 });
    }

    // Atomic promotion with merchant auth
    const { data: promoResult, error: promoErr } = await service.rpc(
      'promote_candidate_with_merchant_auth',
      {
        p_candidate_id: candidate.id,
        p_business_id: business_id,
        p_step_up_id: null, // step-up handled by the SQL function based on existing authority
        p_owner_user_id: user.id,
      },
    );

    if (promoErr) {
      const msg = promoErr.message || 'unknown';
      if (msg.includes('step_up_required')) {
        // Business has existing authority — needs MFA to replace
        return NextResponse.json({
          error: 'Two-factor authentication is required to replace your existing WhatsApp number.',
          code: 'STEP_UP_REQUIRED',
          candidate_id: candidate.id,
        }, { status: 403 });
      }
      logger.error('[EMBEDDED-SIGNUP] Promotion failed:', msg);
      await service.from('whatsapp_channel_candidates').update({
        status: 'failed', failure_reason: `Promotion failed: ${msg}`,
        updated_at: new Date().toISOString(),
      }).eq('id', candidate.id);
      return NextResponse.json({ error: 'Failed to save channel' }, { status: 500 });
    }

    if (!(promoResult as { ok?: boolean })?.ok) {
      await service.from('whatsapp_channel_candidates').update({
        status: 'failed', failure_reason: 'Promotion returned not-ok',
        updated_at: new Date().toISOString(),
      }).eq('id', candidate.id);
      return NextResponse.json({ error: 'Failed to save channel' }, { status: 500 });
    }

    const channelId = (promoResult as { channel_id?: string })?.channel_id;

    // Trial activation (non-fatal)
    try {
      await service.rpc('activate_trial_if_eligible', { p_business_id: business_id });
    } catch (trialErr) {
      console.warn('[EMBEDDED-SIGNUP] Trial activation failed (non-fatal):', trialErr);
    }

    // Reconcile paid allowance (non-fatal)
    try {
      await service.rpc('reconcile_paid_allowance', { p_business_id: business_id });
    } catch (reconcileErr) {
      console.warn('[EMBEDDED-SIGNUP] Paid allowance reconciliation (non-fatal):', reconcileErr);
    }

    // Auto-provision templates (non-fatal)
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

    logger.debug('[EMBEDDED-SIGNUP] Success:', { businessId: business_id, wabaId, phoneNumberId, channelId });

    try {
      const { emitServerEvent } = await import('@/lib/observability/server-events');
      emitServerEvent(request, 'whatsapp.connect_completed', user.id, { business_id: business_id, entity_id: channelId });
    } catch { /* instrumentation must never fail signup */ }

    return NextResponse.json({
      success: true,
      channel_id: channelId,
      phone_number: displayNumber,
      waba_id: wabaId,
    });
  } catch (error) {
    logger.withContext({
      op: 'embedded-signup',
      businessId: business_id,
      ...safeLogErrorContext(error),
    }).error('[EMBEDDED-SIGNUP] Signup failed');

    try {
      const { emitServerEvent } = await import('@/lib/observability/server-events');
      emitServerEvent(request, 'whatsapp.connect_failed', user?.id || 'unknown', { business_id: business_id });
    } catch { /* non-critical */ }

    return NextResponse.json({ error: 'Signup failed. Please try again.' }, { status: 500 });
  }
}

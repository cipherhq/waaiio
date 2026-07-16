import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { MetaCloudService } from '@/lib/channels/meta-cloud';
import { encryptToken } from '@/lib/encryption';
import { logger } from '@/lib/logger';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';

/**
 * POST /api/auth/facebook/callback
 *
 * Called after the Facebook Embedded Signup flow completes.
 * Accepts either:
 *   - access_token (already exchanged by /api/auth/facebook/discover)
 *   - code (legacy: will be exchanged here)
 *
 * Body: {
 *   business_id: string,
 *   access_token?: string,        // Pre-exchanged token from discover endpoint
 *   token_expires_at?: string,    // Token expiry from discover endpoint
 *   code?: string,                // Legacy: authorization code from FB.login
 *   waba_id: string,              // WhatsApp Business Account ID
 *   phone_number_id: string,      // Phone Number ID
 *   connection_method: 'transfer' | 'coexist',
 * }
 */
export async function POST(request: NextRequest) {
  const rateLimit = await rateLimitResponseAsync(getRateLimitKey(request, 'fb-callback'), 5, 60_000);
  if (rateLimit) return rateLimit;

  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
    }

    const {
      business_id,
      access_token: providedAccessToken,
      token_expires_at: providedTokenExpiresAt,
      code,
      waba_id: providedWabaId,
      phone_number_id: providedPhoneNumberId,
      connection_method,
    } = await request.json();

    if (!business_id || (!code && !providedAccessToken)) {
      return NextResponse.json(
        { message: 'Missing required fields: business_id and (access_token or code)' },
        { status: 400 }
      );
    }

    let waba_id = providedWabaId || '';
    let phone_number_id = providedPhoneNumberId || '';

    // Verify business ownership
    const { data: business } = await supabase
      .from('businesses')
      .select('id, owner_id, name, country_code, address')
      .eq('id', business_id)
      .single();

    if (!business || business.owner_id !== user.id) {
      return NextResponse.json({ message: 'Business not found or not owned by you' }, { status: 403 });
    }

    // Get access token — either pre-exchanged or from code
    let longLivedToken: string;
    let tokenExpiresAt: string | null = null;

    if (providedAccessToken) {
      // Token already exchanged by /api/auth/facebook/discover
      longLivedToken = providedAccessToken;
      tokenExpiresAt = providedTokenExpiresAt || null;
    } else {
      // Legacy path: exchange authorization code for access token
      const appId = (process.env.NEXT_PUBLIC_META_APP_ID || process.env.META_APP_ID || '').trim();
      const appSecret = (process.env.META_APP_SECRET || '').trim();

      if (!appId || !appSecret) {
        logger.error('Missing META_APP_ID or META_APP_SECRET env vars');
        return NextResponse.json(
          { message: 'Server configuration error: missing Meta app credentials' },
          { status: 500 }
        );
      }

      try {
        const tokenRes = await fetch(
          `https://graph.facebook.com/v22.0/oauth/access_token?client_id=${appId}&client_secret=${appSecret}&code=${code}`
        );
        if (!tokenRes.ok) {
          const errData = await tokenRes.json().catch(() => ({}));
          logger.error('Code exchange failed:', errData);
          return NextResponse.json(
            { message: 'Failed to exchange Facebook authorization code', error: errData },
            { status: 400 }
          );
        }
        const tokenData = await tokenRes.json();
        longLivedToken = tokenData.access_token;
        tokenExpiresAt = tokenData.expires_in
          ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
          : null;
      } catch (err) {
        logger.error('Code exchange network error:', err);
        return NextResponse.json(
          { message: 'Failed to exchange authorization code' },
          { status: 500 }
        );
      }
    }

    // Auto-discover WABA/phone IDs if not provided (e.g. popup opened as new tab)
    if (!waba_id || !phone_number_id) {
      const fallbackAppId = (process.env.NEXT_PUBLIC_META_APP_ID || process.env.META_APP_ID || '').trim();
      const fallbackAppSecret = (process.env.META_APP_SECRET || '').trim();
      try {
        // Use debug_token to find which WABAs were shared with our app
        const debugRes = await fetch(
          `https://graph.facebook.com/v22.0/debug_token?input_token=${longLivedToken}&access_token=${fallbackAppId}|${fallbackAppSecret}`
        );
        if (debugRes.ok) {
          const debugData = await debugRes.json();
          const scopes = debugData.data?.granular_scopes || [];
          const wabaScope = scopes.find(
            (s: any) => s.permission === 'whatsapp_business_management' && s.target_ids?.length > 0
          );
          if (wabaScope) {
            waba_id = waba_id || wabaScope.target_ids[wabaScope.target_ids.length - 1];
          }
        }

        // If we have a WABA ID, get the phone numbers
        if (waba_id && !phone_number_id) {
          const phonesRes = await fetch(
            `https://graph.facebook.com/v22.0/${waba_id}/phone_numbers?access_token=${longLivedToken}`
          );
          if (phonesRes.ok) {
            const phonesData = await phonesRes.json();
            const phones = phonesData.data || [];
            if (phones.length > 0) {
              phone_number_id = phones[phones.length - 1].id;
            }
          }
        }
      } catch (err) {
        logger.error('WABA auto-discovery failed:', err);
      }

      if (!waba_id || !phone_number_id) {
        return NextResponse.json(
          { message: 'Could not discover WhatsApp account. Please try again or use manual setup.' },
          { status: 400 }
        );
      }
    }

    // Get phone number info from Meta
    const cloudService = new MetaCloudService({
      accessToken: longLivedToken,
      phoneNumberId: phone_number_id,
      wabaId: waba_id,
    });

    let displayName = business.name;
    let phoneNumber = '';
    let qualityRating = '';
    let messagingLimit = '';

    try {
      const phoneInfo = await cloudService.getPhoneNumberInfo();
      displayName = phoneInfo.verified_name || business.name;
      phoneNumber = phoneInfo.display_phone_number || '';
      qualityRating = phoneInfo.quality_rating || '';
      messagingLimit = phoneInfo.messaging_limit || '';
    } catch (err) {
      logger.error('Failed to get phone info:', err);
      // Non-fatal — we can still create the channel
    }

    // Create or update the whatsapp_channels record
    const service = createServiceClient();

    // Check if channel already exists for this business
    const { data: existingChannel } = await service
      .from('whatsapp_channels')
      .select('id')
      .eq('business_id', business_id)
      .eq('provider', 'meta_cloud')
      .maybeSingle();

    const channelData = {
      business_id,
      country_code: business.country_code || 'NG',
      phone_number: phoneNumber,
      provider: 'meta_cloud',
      channel_type: 'dedicated',
      waba_id,
      phone_number_id,
      meta_access_token: encryptToken(longLivedToken),
      meta_token_expires_at: tokenExpiresAt,
      display_name: displayName,
      quality_rating: qualityRating,
      messaging_limit: messagingLimit,
      connection_method: connection_method || 'transfer',
      connection_status: 'active',
      is_active: true,
    };

    let channelId: string;

    if (existingChannel) {
      await service
        .from('whatsapp_channels')
        .update(channelData)
        .eq('id', existingChannel.id);
      channelId = existingChannel.id;
    } else {
      const { data: newChannel, error: insertError } = await service
        .from('whatsapp_channels')
        .insert(channelData)
        .select('id')
        .single();

      if (insertError) {
        logger.error('Failed to create channel:', insertError);
        return NextResponse.json(
          { message: 'Failed to create WhatsApp channel' },
          { status: 500 }
        );
      }
      channelId = newChannel.id;
    }

    // Link the channel to the business
    await service
      .from('businesses')
      .update({
        whatsapp_channel_id: channelId,
        assigned_channel_id: channelId,
        wa_method: connection_method || 'transfer',
      })
      .eq('id', business_id);

    // ── Full automation chain ──

    // 1. Register the phone number for Cloud API messaging — REQUIRED
    try {
      await cloudService.registerPhoneNumber();
      logger.debug('[FB-CALLBACK] Phone registered for Cloud API');
    } catch (regErr) {
      logger.error('[FB-CALLBACK] Phone registration FAILED:', regErr);
      await service
        .from('whatsapp_channels')
        .update({
          is_active: false,
          metadata: { registration_error: String(regErr) },
        })
        .eq('id', channelId);
      return NextResponse.json(
        {
          error: 'Phone registration failed. Please try again or contact support.',
          channel_id: channelId,
          recoverable: true,
        },
        { status: 422 }
      );
    }

    // 2. Subscribe Waaiio app to receive webhooks from their WABA — REQUIRED
    try {
      const subRes = await fetch(
        `https://graph.facebook.com/${process.env.META_GRAPH_API_VERSION || 'v22.0'}/${waba_id}/subscribed_apps`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${longLivedToken}` },
        }
      );
      if (!subRes.ok) {
        const subErrText = await subRes.text();
        throw new Error(`Subscription failed: ${subRes.status} ${subErrText}`);
      }
      const subData = await subRes.json();
      if (!subData.success) {
        throw new Error(`Subscription returned success=false: ${JSON.stringify(subData)}`);
      }
      logger.debug('[FB-CALLBACK] Webhook subscription: ok');
    } catch (subErr) {
      logger.error('[FB-CALLBACK] WABA subscription FAILED:', subErr);
      await service
        .from('whatsapp_channels')
        .update({
          is_active: false,
          metadata: { subscription_error: String(subErr) },
        })
        .eq('id', channelId);
      return NextResponse.json(
        {
          error: 'WhatsApp webhook subscription failed. Please try again or contact support.',
          channel_id: channelId,
          recoverable: true,
        },
        { status: 422 }
      );
    }

    // 3. Auto-set WhatsApp Business Profile (non-fatal)
    try {
      await cloudService.setBusinessProfile({
        about: `${business.name} — powered by Waaiio`,
        description: `Book appointments, make payments, and more — all on WhatsApp.`,
        address: business.address || undefined,
        websites: [process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com'],
      });
      logger.debug('[FB-CALLBACK] Business profile set');
    } catch (err) {
      logger.error('[FB-CALLBACK] Business profile warning:', err);
    }

    // 4. Auto-provision all Waaiio message templates on the business's WABA (non-fatal)
    try {
      const { provisionTemplates } = await import('@/lib/channels/provision-templates');
      const templateResult = await provisionTemplates(waba_id, longLivedToken);
      logger.debug('[FB-CALLBACK] Templates provisioned:', templateResult);
    } catch (err) {
      logger.error('[FB-CALLBACK] Template provisioning warning:', err);
    }

    return NextResponse.json({
      message: 'WhatsApp number connected successfully',
      channel_id: channelId,
      display_name: displayName,
      phone_number: phoneNumber,
      connection_status: 'active',
    });
  } catch (error) {
    logger.error('Facebook callback error:', error);
    return NextResponse.json(
      { message: 'Something went wrong' },
      { status: 500 }
    );
  }
}

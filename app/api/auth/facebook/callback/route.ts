import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { MetaCloudService } from '@/lib/channels/meta-cloud';
import { logger } from '@/lib/logger';

/**
 * POST /api/auth/facebook/callback
 *
 * Called after the Facebook Embedded Signup flow completes.
 * Receives the authorization code and WABA details from the frontend,
 * exchanges the code for a System User Access Token, and stores the channel credentials.
 *
 * Body: {
 *   business_id: string,
 *   code: string,               // Authorization code from FB.login (response_type: 'code')
 *   waba_id: string,            // WhatsApp Business Account ID
 *   phone_number_id: string,    // Phone Number ID from Embedded Signup
 *   connection_method: 'transfer' | 'coexist',
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
    }

    const {
      business_id,
      code,
      waba_id: providedWabaId,
      phone_number_id: providedPhoneNumberId,
      connection_method,
    } = await request.json();

    if (!business_id || !code) {
      return NextResponse.json(
        { message: 'Missing required fields: business_id, code' },
        { status: 400 }
      );
    }

    let waba_id = providedWabaId || '';
    let phone_number_id = providedPhoneNumberId || '';

    // Verify business ownership
    const { data: business } = await supabase
      .from('businesses')
      .select('id, owner_id, name, country_code')
      .eq('id', business_id)
      .single();

    if (!business || business.owner_id !== user.id) {
      return NextResponse.json({ message: 'Business not found or not owned by you' }, { status: 403 });
    }

    // Exchange the authorization code for an access token
    const appId = process.env.NEXT_PUBLIC_META_APP_ID || process.env.META_APP_ID || '';
    const appSecret = process.env.META_APP_SECRET || '';

    if (!appId || !appSecret) {
      logger.error('Missing META_APP_ID or META_APP_SECRET env vars');
      return NextResponse.json(
        { message: 'Server configuration error: missing Meta app credentials' },
        { status: 500 }
      );
    }

    let longLivedToken: string;
    let tokenExpiresAt: string | null = null;

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
      // Code exchange returns a long-lived token (60 days) or System User Access Token (never expires)
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

    // Auto-discover WABA/phone IDs if not provided (e.g. popup opened as new tab)
    if (!waba_id || !phone_number_id) {
      try {
        // Use debug_token to find which WABAs were shared with our app
        const debugRes = await fetch(
          `https://graph.facebook.com/v22.0/debug_token?input_token=${longLivedToken}&access_token=${appId.trim()}|${appSecret.trim()}`
        );
        if (debugRes.ok) {
          const debugData = await debugRes.json();
          const scopes = debugData.data?.granular_scopes || [];
          const wabaScope = scopes.find(
            (s: any) => s.scope === 'whatsapp_business_management' && s.target_ids?.length > 0
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
      meta_access_token: longLivedToken,
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
          { message: 'Failed to create WhatsApp channel', error: insertError.message },
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
        wa_method: connection_method || 'transfer',
      })
      .eq('id', business_id);

    // Register the phone number for Cloud API messaging
    try {
      await cloudService.registerPhoneNumber();
    } catch (err) {
      logger.error('Phone registration warning:', err);
      // Non-fatal — might already be registered
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
      { message: 'Internal server error', error: (error as Error).message },
      { status: 500 }
    );
  }
}

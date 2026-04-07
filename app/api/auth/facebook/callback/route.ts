import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { MetaCloudService } from '@/lib/channels/meta-cloud';

/**
 * POST /api/auth/facebook/callback
 *
 * Called after the Facebook Embedded Signup flow completes.
 * Receives the short-lived user token and WABA details from the frontend,
 * exchanges for a long-lived token, and stores the channel credentials.
 *
 * Body: {
 *   business_id: string,
 *   access_token: string,       // Short-lived token from FB.login
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
      access_token,
      waba_id,
      phone_number_id,
      connection_method,
    } = await request.json();

    if (!business_id || !access_token || !waba_id || !phone_number_id) {
      return NextResponse.json(
        { message: 'Missing required fields: business_id, access_token, waba_id, phone_number_id' },
        { status: 400 }
      );
    }

    // Verify business ownership
    const { data: business } = await supabase
      .from('businesses')
      .select('id, owner_id, name, country_code')
      .eq('id', business_id)
      .single();

    if (!business || business.owner_id !== user.id) {
      return NextResponse.json({ message: 'Business not found or not owned by you' }, { status: 403 });
    }

    // Exchange short-lived token for long-lived token
    let longLivedToken = access_token;
    let tokenExpiresAt: string | null = null;

    try {
      const exchanged = await MetaCloudService.exchangeToken(access_token);
      longLivedToken = exchanged.access_token;
      tokenExpiresAt = new Date(Date.now() + exchanged.expires_in * 1000).toISOString();
    } catch (err) {
      console.error('Token exchange failed, using short-lived token:', err);
      // Use the short-lived token for now — it lasts ~1 hour
      tokenExpiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
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
      console.error('Failed to get phone info:', err);
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
        console.error('Failed to create channel:', insertError);
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
      console.error('Phone registration warning:', err);
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
    console.error('Facebook callback error:', error);
    return NextResponse.json(
      { message: 'Internal server error', error: (error as Error).message },
      { status: 500 }
    );
  }
}

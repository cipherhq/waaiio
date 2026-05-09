import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';

const API_VERSION = process.env.META_GRAPH_API_VERSION || 'v22.0';

/**
 * POST /api/whatsapp/add-number
 *
 * Add a phone number to Waaiio's WABA and request OTP verification.
 * Body: { business_id, phone_number, display_name }
 *
 * POST /api/whatsapp/add-number?action=verify
 * Verify the OTP and complete registration.
 * Body: { business_id, otp }
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const action = request.nextUrl.searchParams.get('action');
  const body = await request.json();

  const wabaId = process.env.META_CLOUD_WABA_ID;
  const accessToken = process.env.META_CLOUD_ACCESS_TOKEN;

  if (!wabaId || !accessToken) {
    return NextResponse.json({ error: 'WhatsApp not configured on server' }, { status: 500 });
  }

  // ── REQUEST OTP ──
  if (!action || action === 'request') {
    const { business_id, phone_number, display_name } = body;

    if (!business_id || !phone_number) {
      return NextResponse.json({ error: 'Missing business_id or phone_number' }, { status: 400 });
    }

    // Verify ownership
    const { data: biz } = await supabase
      .from('businesses')
      .select('id, name, owner_id, country_code')
      .eq('id', business_id)
      .eq('owner_id', user.id)
      .single();
    if (!biz) return NextResponse.json({ error: 'Business not found' }, { status: 404 });

    // Clean phone number (remove spaces, dashes, ensure + prefix)
    const cleanPhone = phone_number.replace(/[\s\-()]/g, '');
    const phoneForMeta = cleanPhone.startsWith('+') ? cleanPhone.slice(1) : cleanPhone;

    try {
      // 1. Add phone number to Waaiio's WABA
      const addRes = await fetch(
        `https://graph.facebook.com/${API_VERSION}/${wabaId}/phone_numbers`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            cc: phoneForMeta.slice(0, phoneForMeta.length > 10 ? phoneForMeta.length - 10 : 1),
            phone_number: phoneForMeta,
            migrate_phone_number: true,
            verified_name: display_name || biz.name,
          }),
        }
      );

      const addData = await addRes.json();

      if (!addRes.ok) {
        logger.error('[ADD-NUMBER] Failed to add number:', addData);
        const msg = addData.error?.message || 'Failed to add phone number';
        return NextResponse.json({ error: msg }, { status: 400 });
      }

      const phoneNumberId = addData.id;

      // 2. Request OTP verification code
      const otpRes = await fetch(
        `https://graph.facebook.com/${API_VERSION}/${phoneNumberId}/request_code`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            code_method: 'SMS',
            language: 'en_US',
          }),
        }
      );

      const otpData = await otpRes.json();

      if (!otpRes.ok) {
        logger.error('[ADD-NUMBER] OTP request failed:', otpData);
        // Try voice call if SMS fails
        const voiceRes = await fetch(
          `https://graph.facebook.com/${API_VERSION}/${phoneNumberId}/request_code`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              code_method: 'VOICE',
              language: 'en_US',
            }),
          }
        );
        const voiceData = await voiceRes.json();
        if (!voiceRes.ok) {
          return NextResponse.json({ error: 'Failed to send verification code. ' + (voiceData.error?.message || '') }, { status: 400 });
        }
      }

      // Detect country code from phone number
      const countryCode = cleanPhone.startsWith('+234') ? 'NG'
        : cleanPhone.startsWith('+1') ? 'US'
        : cleanPhone.startsWith('+44') ? 'GB'
        : cleanPhone.startsWith('+91') ? 'IN'
        : biz.country_code || 'US';

      // Store channel — check if one already exists for this business
      const service = createServiceClient();
      const { data: existing } = await service
        .from('whatsapp_channels')
        .select('id')
        .eq('business_id', business_id)
        .eq('channel_type', 'dedicated')
        .maybeSingle();

      const channelPayload = {
        business_id,
        provider: 'meta_cloud',
        channel_type: 'dedicated',
        phone_number_id: phoneNumberId,
        waba_id: wabaId,
        meta_access_token: accessToken,
        phone_number: cleanPhone,
        display_name: display_name || biz.name,
        country_code: countryCode,
        connection_method: 'transfer' as const,
        connection_status: 'verifying' as const,
        is_active: false, // Not active until verified
      };

      if (existing) {
        await service.from('whatsapp_channels')
          .update(channelPayload)
          .eq('id', existing.id);
      } else {
        await service.from('whatsapp_channels')
          .insert(channelPayload);
      }

      return NextResponse.json({
        success: true,
        phone_number_id: phoneNumberId,
        message: 'Verification code sent. Check your phone for the OTP.',
      });
    } catch (error) {
      logger.error('[ADD-NUMBER] Error:', (error as Error).message);
      return NextResponse.json({ error: 'Failed to add number. Please try again.' }, { status: 500 });
    }
  }

  // ── VERIFY OTP ──
  if (action === 'verify') {
    const { business_id, otp } = body;

    if (!business_id || !otp) {
      return NextResponse.json({ error: 'Missing business_id or otp' }, { status: 400 });
    }

    // Verify ownership
    const { data: biz } = await supabase
      .from('businesses')
      .select('id, owner_id')
      .eq('id', business_id)
      .eq('owner_id', user.id)
      .single();
    if (!biz) return NextResponse.json({ error: 'Business not found' }, { status: 404 });

    const service = createServiceClient();

    // Get the pending channel
    const { data: channel } = await service
      .from('whatsapp_channels')
      .select('id, phone_number_id, phone_number, display_name')
      .eq('business_id', business_id)
      .eq('connection_status', 'verifying')
      .maybeSingle();

    if (!channel) {
      return NextResponse.json({ error: 'No pending number found. Please start over.' }, { status: 400 });
    }

    try {
      // Verify the code with Meta
      const verifyRes = await fetch(
        `https://graph.facebook.com/${API_VERSION}/${channel.phone_number_id}/verify_code`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ code: otp }),
        }
      );

      const verifyData = await verifyRes.json();

      if (!verifyRes.ok) {
        logger.error('[ADD-NUMBER] OTP verification failed:', verifyData);
        return NextResponse.json({ error: verifyData.error?.message || 'Invalid code. Please try again.' }, { status: 400 });
      }

      // Register the number for Cloud API messaging
      const regRes = await fetch(
        `https://graph.facebook.com/${API_VERSION}/${channel.phone_number_id}/register`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            pin: '000000',
          }),
        }
      );
      if (!regRes.ok) {
        const regData = await regRes.json();
        logger.error('[ADD-NUMBER] Phone registration failed:', regData);
        // Non-fatal — may already be registered
      }

      // Subscribe WABA to webhooks
      const subRes = await fetch(
        `https://graph.facebook.com/${API_VERSION}/${wabaId}/subscribed_apps`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );
      if (!subRes.ok) {
        logger.error('[ADD-NUMBER] Webhook subscription failed');
      }

      // Activate the channel
      await service.from('whatsapp_channels')
        .update({
          is_active: true,
          connection_status: 'active',
        })
        .eq('id', channel.id);

      // Update business — assign this channel
      await service.from('businesses')
        .update({
          wa_method: 'transfer',
          whatsapp_channel_id: channel.id,
          assigned_channel_id: channel.id,
        })
        .eq('id', business_id);

      // Auto-provision message templates (non-fatal)
      try {
        const { provisionTemplates } = await import('@/lib/channels/provision-templates');
        await provisionTemplates(wabaId, accessToken);
        logger.debug('[ADD-NUMBER] Templates provisioned');
      } catch (err) {
        logger.error('[ADD-NUMBER] Template provisioning warning:', err);
      }

      return NextResponse.json({
        success: true,
        phone_number: channel.phone_number,
        display_name: channel.display_name,
      });
    } catch (error) {
      logger.error('[ADD-NUMBER] Verify error:', (error as Error).message);
      return NextResponse.json({ error: 'Verification failed. Please try again.' }, { status: 500 });
    }
  }

  return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
}

import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { encryptToken } from '@/lib/encryption';
import { randomInt } from 'crypto';
import { logger } from '@/lib/logger';

const API_VERSION = process.env.META_GRAPH_API_VERSION || 'v22.0';

/**
 * POST /api/whatsapp/add-number
 *
 * Add a phone number to Waaiio's WABA and request OTP verification.
 * Uses the candidate system: creates a staging candidate, validates with
 * Meta provider, then atomically promotes to live channel on READY.
 *
 * Body: { business_id, phone_number, display_name }
 *
 * POST /api/whatsapp/add-number?action=verify
 * Verify the OTP and complete registration.
 * Body: { business_id, otp, candidate_id }
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
      .select('id, name, owner_id, country_code, assigned_channel_id, whatsapp_channel_id, wa_method')
      .eq('id', business_id)
      .eq('owner_id', user.id)
      .single();
    if (!biz) return NextResponse.json({ error: 'Business not found' }, { status: 404 });

    const cleanPhone = phone_number.replace(/[\s\-()]/g, '');
    const phoneForMeta = cleanPhone.startsWith('+') ? cleanPhone.slice(1) : cleanPhone;

    const service = createServiceClient();

    // Check for existing open candidate → 409 (H4: no reuse)
    const { data: openCandidate } = await service
      .from('whatsapp_channel_candidates')
      .select('id, status')
      .eq('business_id', business_id)
      .in('status', ['pending', 'validating', 'ready'])
      .maybeSingle();

    if (openCandidate) {
      return NextResponse.json(
        { error: 'A connection attempt is already in progress. Please complete or wait for it to expire.' },
        { status: 409 },
      );
    }

    // Cross-method check (H3): same phone under different method → 409
    const { data: crossMethodChannel } = await service
      .from('whatsapp_channels')
      .select('id, connection_method')
      .eq('phone_number', cleanPhone)
      .eq('channel_type', 'dedicated')
      .eq('is_active', true)
      .maybeSingle();

    if (crossMethodChannel && crossMethodChannel.connection_method !== 'transfer') {
      return NextResponse.json(
        { error: 'This number is already connected via a different method. Cross-method migration is not yet supported.' },
        { status: 409 },
      );
    }

    // Find existing active dedicated channel for CAS snapshot
    const { data: existingDedicated } = await service
      .from('whatsapp_channels')
      .select('id')
      .eq('business_id', business_id)
      .eq('channel_type', 'dedicated')
      .eq('is_active', true)
      .maybeSingle();

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
          body: JSON.stringify({ code_method: 'SMS', language: 'en_US' }),
        }
      );

      if (!otpRes.ok) {
        // Fallback to voice call if SMS fails
        const voiceRes = await fetch(
          `https://graph.facebook.com/${API_VERSION}/${phoneNumberId}/request_code`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ code_method: 'VOICE', language: 'en_US' }),
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

      // Generate secure registration PIN (H7: never '000000')
      const pin = String(randomInt(100000, 999999));

      // 3. Create candidate (not live channel)
      const { data: candidate, error: candErr } = await service
        .from('whatsapp_channel_candidates')
        .insert({
          business_id,
          provider: 'meta_cloud',
          phone_number: cleanPhone,
          phone_number_id: phoneNumberId,
          waba_id: wabaId,
          meta_access_token: null, // OTP path: platform token stays in env (H6 option a)
          display_name: display_name || biz.name,
          country_code: countryCode,
          connection_method: 'transfer',
          status: 'validating',
          // Immutable CAS snapshot (H2)
          expected_assigned_channel_id: biz.assigned_channel_id || null,
          expected_whatsapp_channel_id: biz.whatsapp_channel_id || null,
          expected_wa_method: biz.wa_method || null,
          replacing_dedicated_channel_id: existingDedicated?.id || null,
          provider_state: { phone_added: true, otp_requested: true },
          encrypted_registration_pin: encryptToken(pin),
        })
        .select('id')
        .single();

      if (candErr || !candidate) {
        // Partial unique index violation → another candidate was created concurrently
        if (candErr?.code === '23505') {
          return NextResponse.json(
            { error: 'A connection attempt is already in progress.' },
            { status: 409 },
          );
        }
        logger.error('[ADD-NUMBER] Candidate creation failed:', candErr);
        return NextResponse.json({ error: 'Failed to start connection. Please try again.' }, { status: 500 });
      }

      return NextResponse.json({
        success: true,
        phone_number_id: phoneNumberId,
        candidate_id: candidate.id,
        message: 'Verification code sent. Check your phone for the OTP.',
      });
    } catch (error) {
      logger.error('[ADD-NUMBER] Error:', (error as Error).message);
      return NextResponse.json({ error: 'Failed to add number. Please try again.' }, { status: 500 });
    }
  }

  // ── VERIFY OTP ──
  if (action === 'verify') {
    const { business_id, otp, candidate_id } = body;

    if (!business_id || !otp || !candidate_id) {
      return NextResponse.json({ error: 'Missing business_id, otp, or candidate_id' }, { status: 400 });
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

    // Get the candidate (not live channel)
    const { data: candidate } = await service
      .from('whatsapp_channel_candidates')
      .select('id, phone_number_id, phone_number, display_name, waba_id, encrypted_registration_pin, provider_state')
      .eq('id', candidate_id)
      .eq('business_id', business_id)
      .eq('status', 'validating')
      .single();

    if (!candidate) {
      return NextResponse.json({ error: 'No pending connection found. Please start over.' }, { status: 400 });
    }

    try {
      // 1. Verify the code with Meta (fatal on failure)
      const verifyRes = await fetch(
        `https://graph.facebook.com/${API_VERSION}/${candidate.phone_number_id}/verify_code`,
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

      // Update provider state
      const updatedState: Record<string, unknown> = { ...(candidate.provider_state as Record<string, unknown>), otp_verified: true };

      // 2. Register the number for Cloud API messaging (FATAL — H10)
      const regRes = await fetch(
        `https://graph.facebook.com/${API_VERSION}/${candidate.phone_number_id}/register`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            pin: candidate.encrypted_registration_pin
              ? (() => { const { decryptToken } = require('@/lib/encryption'); return decryptToken(candidate.encrypted_registration_pin); })()
              : String(randomInt(100000, 999999)),
          }),
        }
      );

      if (!regRes.ok) {
        const regData = await regRes.json();
        logger.error('[ADD-NUMBER] Phone registration FAILED:', regData);
        await service.from('whatsapp_channel_candidates').update({
          status: 'failed',
          failure_reason: `Phone registration failed: ${regData.error?.message || regRes.status}`,
          provider_state: { ...updatedState, registered: false },
          updated_at: new Date().toISOString(),
        }).eq('id', candidate.id);
        return NextResponse.json(
          { error: 'Phone registration failed. Please try again or contact support.', recoverable: true },
          { status: 422 },
        );
      }

      updatedState.registered = true;

      // 3. Subscribe WABA to webhooks (FATAL — H10)
      const subRes = await fetch(
        `https://graph.facebook.com/${API_VERSION}/${wabaId}/subscribed_apps`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );

      const subData = await subRes.json().catch(() => ({}));
      if (!subRes.ok || !(subData as { success?: boolean }).success) {
        logger.error('[ADD-NUMBER] Webhook subscription FAILED');
        await service.from('whatsapp_channel_candidates').update({
          status: 'failed',
          failure_reason: `Webhook subscription failed: ${subRes.status}`,
          provider_state: { ...updatedState, webhook_subscribed: false },
          updated_at: new Date().toISOString(),
        }).eq('id', candidate.id);
        return NextResponse.json(
          { error: 'WhatsApp webhook subscription failed. Please try again or contact support.', recoverable: true },
          { status: 422 },
        );
      }

      updatedState.webhook_subscribed = true;

      // 4. All READY gates passed — mark candidate ready
      await service.from('whatsapp_channel_candidates').update({
        status: 'ready',
        provider_state: updatedState,
        updated_at: new Date().toISOString(),
      }).eq('id', candidate.id);

      // 5. Atomic promotion (H8: single PostgreSQL transaction)
      const { data: promoResult, error: promoErr } = await service.rpc(
        'promote_channel_candidate',
        { p_candidate_id: candidate.id, p_business_id: business_id },
      );

      if (promoErr || !(promoResult as { ok?: boolean })?.ok) {
        const reason = (promoResult as { reason?: string })?.reason || promoErr?.message || 'unknown';
        logger.error('[ADD-NUMBER] Promotion failed:', reason);
        await service.from('whatsapp_channel_candidates').update({
          status: 'failed',
          failure_reason: `Promotion failed: ${reason}`,
          updated_at: new Date().toISOString(),
        }).eq('id', candidate.id);
        return NextResponse.json(
          { error: 'Channel activation failed. Please try again.', recoverable: true, reason },
          { status: 409 },
        );
      }

      // 6. Auto-provision message templates (non-fatal)
      try {
        const { provisionTemplates } = await import('@/lib/channels/provision-templates');
        await provisionTemplates(wabaId, accessToken);
        logger.debug('[ADD-NUMBER] Templates provisioned');
      } catch (err) {
        logger.error('[ADD-NUMBER] Template provisioning warning:', err);
      }

      return NextResponse.json({
        success: true,
        phone_number: candidate.phone_number,
        display_name: candidate.display_name,
        channel_id: (promoResult as { channel_id?: string })?.channel_id,
      });
    } catch (error) {
      logger.error('[ADD-NUMBER] Verify error:', (error as Error).message);
      return NextResponse.json({ error: 'Verification failed. Please try again.' }, { status: 500 });
    }
  }

  return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
}

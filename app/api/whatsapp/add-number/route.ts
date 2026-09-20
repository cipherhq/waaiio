import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { encryptToken, decryptToken } from '@/lib/encryption';
import { randomInt } from 'crypto';
import { logger } from '@/lib/logger';

const API_VERSION = process.env.META_GRAPH_API_VERSION || 'v22.0';

/** Normalize phone to digits only. */
function normalizePhone(phone: string): string {
  return phone.replace(/[^0-9]/g, '');
}

/**
 * POST /api/whatsapp/add-number
 * Actions: request (default) | verify | resend
 *
 * Uses the candidate system: creates a fenced candidate BEFORE any
 * provider mutation, validates with Meta, then atomically promotes.
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

  // ── REQUEST OTP (R9 §3: candidate fence BEFORE provider mutation) ──
  if (!action || action === 'request') {
    const { business_id, phone_number, display_name } = body;

    if (!business_id || !phone_number) {
      return NextResponse.json({ error: 'Missing business_id or phone_number' }, { status: 400 });
    }

    // 1. Authenticate + verify ownership
    const { data: biz } = await supabase
      .from('businesses')
      .select('id, name, owner_id, country_code, assigned_channel_id, whatsapp_channel_id, wa_method')
      .eq('id', business_id)
      .eq('owner_id', user.id)
      .single();
    if (!biz) return NextResponse.json({ error: 'Business not found' }, { status: 404 });

    const cleanPhone = phone_number.replace(/[\s\-()]/g, '');
    const phoneForMeta = cleanPhone.startsWith('+') ? cleanPhone.slice(1) : cleanPhone;

    // 2. Normalize phone + conflict check (R9 §2)
    const normalized = normalizePhone(cleanPhone);
    const service = createServiceClient();

    const { data: conflict } = await service.rpc('check_phone_conflict', {
      p_normalized_phone: normalized,
      p_business_id: business_id,
      p_connection_source: 'waaiio_hosted',
    });

    if ((conflict as { conflict?: boolean })?.conflict) {
      const reason = (conflict as { reason?: string })?.reason || 'phone_conflict';
      return NextResponse.json(
        { error: reason === 'phone_owned_by_other_business'
            ? 'This number is already connected to another business.'
            : reason === 'cross_source_migration_unsupported'
            ? 'This number is already connected via a different method. Cross-method migration is not yet supported.'
            : 'This number requires support assistance to reconnect. Please contact support.'
        },
        { status: 409 },
      );
    }

    // 3. Read current business authority + active dedicated channel
    const { data: existingDedicated } = await service
      .from('whatsapp_channels')
      .select('id')
      .eq('business_id', business_id)
      .eq('channel_type', 'dedicated')
      .eq('is_active', true)
      .maybeSingle();

    // 4. Generate secure PIN (H7)
    const pin = String(randomInt(100000, 1000000));

    // Detect country code
    const countryCode = cleanPhone.startsWith('+234') ? 'NG'
      : cleanPhone.startsWith('+1') ? 'US'
      : cleanPhone.startsWith('+44') ? 'GB'
      : cleanPhone.startsWith('+91') ? 'IN'
      : biz.country_code || 'US';

    // 5. INSERT candidate as pending with immutable CAS snapshot
    const { data: candidate, error: candErr } = await service
      .from('whatsapp_channel_candidates')
      .insert({
        business_id,
        connection_source: 'waaiio_hosted',
        business_wa_method: 'transfer',
        provider: 'meta_cloud',
        phone_number: cleanPhone,
        phone_number_normalized: normalized,
        waba_id: wabaId,
        meta_access_token: null, // OTP: platform token stays in env (H6a)
        display_name: display_name || biz.name,
        country_code: countryCode,
        status: 'pending',
        expected_assigned_channel_id: biz.assigned_channel_id || null,
        expected_whatsapp_channel_id: biz.whatsapp_channel_id || null,
        expected_wa_method: biz.wa_method || null,
        replacing_dedicated_channel_id: existingDedicated?.id || null,
        provider_state: {},
        encrypted_registration_pin: encryptToken(pin),
      })
      .select('id')
      .single();

    if (candErr || !candidate) {
      if (candErr?.code === '23505') {
        return NextResponse.json(
          { error: 'A connection attempt is already in progress.' },
          { status: 409 },
        );
      }
      logger.error('[ADD-NUMBER] Candidate creation failed:', candErr);
      return NextResponse.json({ error: 'Failed to start connection.' }, { status: 500 });
    }

    try {
      // 6. Only AFTER candidate INSERT: call Meta add/migrate phone
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
        logger.error('[ADD-NUMBER] Meta add number failed:', addData);
        await service.from('whatsapp_channel_candidates').update({
          status: 'failed',
          failure_reason: `Meta add number failed: ${addData.error?.message || addRes.status}`,
          provider_state: { phone_added: false },
          updated_at: new Date().toISOString(),
        }).eq('id', candidate.id);
        return NextResponse.json({ error: addData.error?.message || 'Failed to add phone number' }, { status: 400 });
      }

      const phoneNumberId = addData.id;

      // 7. Update candidate with phone_number_id
      await service.from('whatsapp_channel_candidates').update({
        phone_number_id: phoneNumberId,
        provider_state: { phone_added: true },
        updated_at: new Date().toISOString(),
      }).eq('id', candidate.id);

      // 8. Request SMS (VOICE fallback)
      const otpRes = await fetch(
        `https://graph.facebook.com/${API_VERSION}/${phoneNumberId}/request_code`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ code_method: 'SMS', language: 'en_US' }),
        }
      );

      if (!otpRes.ok) {
        const voiceRes = await fetch(
          `https://graph.facebook.com/${API_VERSION}/${phoneNumberId}/request_code`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ code_method: 'VOICE', language: 'en_US' }),
          }
        );
        const voiceData = await voiceRes.json();
        if (!voiceRes.ok) {
          await service.from('whatsapp_channel_candidates').update({
            status: 'failed',
            failure_reason: `OTP delivery failed: ${voiceData.error?.message || 'both SMS and VOICE failed'}`,
            provider_state: { phone_added: true, otp_requested: false },
            updated_at: new Date().toISOString(),
          }).eq('id', candidate.id);
          return NextResponse.json({ error: 'Failed to send verification code. ' + (voiceData.error?.message || '') }, { status: 400 });
        }
      }

      // 9. Mark candidate validating
      await service.from('whatsapp_channel_candidates').update({
        status: 'validating',
        provider_state: { phone_added: true, otp_requested: true },
        updated_at: new Date().toISOString(),
      }).eq('id', candidate.id);

      return NextResponse.json({
        success: true,
        phone_number_id: phoneNumberId,
        candidate_id: candidate.id,
        message: 'Verification code sent. Check your phone for the OTP.',
      });
    } catch (error) {
      logger.error('[ADD-NUMBER] Error:', (error as Error).message);
      await service.from('whatsapp_channel_candidates').update({
        status: 'failed',
        failure_reason: `Unexpected error: ${(error as Error).message}`,
        updated_at: new Date().toISOString(),
      }).eq('id', candidate.id);
      return NextResponse.json({ error: 'Failed to add number. Please try again.' }, { status: 500 });
    }
  }

  // ── RESEND OTP (R9 §4) ──
  if (action === 'resend') {
    const { business_id, candidate_id } = body;

    if (!business_id || !candidate_id) {
      return NextResponse.json({ error: 'Missing business_id or candidate_id' }, { status: 400 });
    }

    const { data: biz } = await supabase
      .from('businesses')
      .select('id').eq('id', business_id).eq('owner_id', user.id).single();
    if (!biz) return NextResponse.json({ error: 'Business not found' }, { status: 404 });

    const service = createServiceClient();

    const { data: candidate } = await service
      .from('whatsapp_channel_candidates')
      .select('id, phone_number_id, connection_source, status')
      .eq('id', candidate_id)
      .eq('business_id', business_id)
      .eq('connection_source', 'waaiio_hosted')
      .eq('status', 'validating')
      .single();

    if (!candidate) {
      return NextResponse.json({ error: 'No pending verification found.' }, { status: 400 });
    }

    try {
      const otpRes = await fetch(
        `https://graph.facebook.com/${API_VERSION}/${candidate.phone_number_id}/request_code`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ code_method: 'SMS', language: 'en_US' }),
        }
      );
      if (!otpRes.ok) {
        const voiceRes = await fetch(
          `https://graph.facebook.com/${API_VERSION}/${candidate.phone_number_id}/request_code`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ code_method: 'VOICE', language: 'en_US' }),
          }
        );
        if (!voiceRes.ok) {
          return NextResponse.json({ error: 'Failed to resend code.' }, { status: 400 });
        }
      }

      await service.from('whatsapp_channel_candidates').update({
        provider_state: { phone_added: true, otp_requested: true, resent: true },
        updated_at: new Date().toISOString(),
      }).eq('id', candidate.id);

      return NextResponse.json({ success: true, message: 'Verification code resent.' });
    } catch (error) {
      logger.error('[ADD-NUMBER] Resend error:', error);
      return NextResponse.json({ error: 'Failed to resend code.' }, { status: 500 });
    }
  }

  // ── VERIFY OTP (R9 §4: exact candidate_id required) ──
  if (action === 'verify') {
    const { business_id, otp, candidate_id } = body;

    if (!business_id || !otp || !candidate_id) {
      return NextResponse.json({ error: 'Missing business_id, otp, or candidate_id' }, { status: 400 });
    }

    const { data: biz } = await supabase
      .from('businesses')
      .select('id, owner_id').eq('id', business_id).eq('owner_id', user.id).single();
    if (!biz) return NextResponse.json({ error: 'Business not found' }, { status: 404 });

    const service = createServiceClient();

    const { data: candidate } = await service
      .from('whatsapp_channel_candidates')
      .select('id, phone_number_id, phone_number, display_name, waba_id, encrypted_registration_pin, provider_state')
      .eq('id', candidate_id)
      .eq('business_id', business_id)
      .eq('status', 'validating')
      .single();

    if (!candidate) {
      return NextResponse.json({ error: 'No pending verification found. Please start over.' }, { status: 400 });
    }

    try {
      // 1. Verify OTP (fatal)
      const verifyRes = await fetch(
        `https://graph.facebook.com/${API_VERSION}/${candidate.phone_number_id}/verify_code`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: otp }),
        }
      );

      const verifyData = await verifyRes.json();
      if (!verifyRes.ok) {
        logger.error('[ADD-NUMBER] OTP verification failed:', verifyData);
        return NextResponse.json({ error: verifyData.error?.message || 'Invalid code. Please try again.' }, { status: 400 });
      }

      const updatedState: Record<string, unknown> = {
        ...(candidate.provider_state as Record<string, unknown>),
        otp_verified: true,
      };

      // 2. Register phone (FATAL — H10)
      const pin = candidate.encrypted_registration_pin
        ? decryptToken(candidate.encrypted_registration_pin)
        : String(randomInt(100000, 1000000));

      const regRes = await fetch(
        `https://graph.facebook.com/${API_VERSION}/${candidate.phone_number_id}/register`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
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

      // 3. Subscribe webhooks (FATAL — H10)
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
          { error: 'WhatsApp webhook subscription failed. Please try again.', recoverable: true },
          { status: 422 },
        );
      }

      updatedState.webhook_subscribed = true;

      // 4. All READY gates passed
      await service.from('whatsapp_channel_candidates').update({
        status: 'ready',
        provider_state: updatedState,
        updated_at: new Date().toISOString(),
      }).eq('id', candidate.id);

      // 5. Atomic promotion
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

      // 6. Templates (non-fatal)
      try {
        const { provisionTemplates } = await import('@/lib/channels/provision-templates');
        await provisionTemplates(wabaId, accessToken);
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

import { NextResponse, type NextRequest } from 'next/server';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { generatePhoneOtp } from '@/lib/otp-phone-token';
import { MetaCloudService } from '@/lib/channels/meta-cloud';
import { createServiceClient } from '@/lib/supabase/service';
import { checkBruteForce } from '@/lib/brute-force';
import { logger } from '@/lib/logger';
import { safeLogErrorContext } from '@/lib/errors';

// Support all Waaiio countries: NG (+234), US (+1), GB (+44), CA (+1), GH (+233)
const PHONE_REGEX = /^\+[1-9][0-9]{6,14}$/;

// Approved Meta AUTHENTICATION template — delivers OTP without a 24-hour window
const OTP_TEMPLATE_NAME = 'waaiio_login_otp';
const OTP_TEMPLATE_LANGUAGE = 'en_US';

export async function POST(request: NextRequest) {
  try {
    const { phone } = await request.json();

    if (!phone || !PHONE_REGEX.test(phone)) {
      return NextResponse.json(
        { message: 'Invalid phone number. Use international format: +1XXXXXXXXXX' },
        { status: 400 },
      );
    }

    // Brute force: check IP-level block before sending OTP
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    const ipCheck = checkBruteForce(`ip:${ip}`);
    if (ipCheck.blocked) {
      return NextResponse.json(
        { message: 'Too many attempts. Please try again later.' },
        { status: 429 },
      );
    }

    // Rate limit: 3 per phone per 10 minutes + 10 per IP per 10 minutes
    const phoneLimit = await rateLimitResponseAsync(`otp-send:${phone}`, 3, 600_000);
    if (phoneLimit) return phoneLimit;
    const ipLimit = await rateLimitResponseAsync(getRateLimitKey(request, 'otp-send'), 10, 600_000);
    if (ipLimit) return ipLimit;

    // Generate OTP and server-side challenge
    const { code, challengeId } = await generatePhoneOtp(phone);

    // Send OTP via WhatsApp AUTHENTICATION template
    let sent = false;
    let deliveryPath: 'database_channel' | 'env_fallback' | null = null;
    let waMessageId: string | null = null;

    try {
      const supabase = createServiceClient();
      const { data: channel } = await supabase
        .from('whatsapp_channels')
        .select('phone_number_id, meta_access_token')
        .eq('provider', 'meta_cloud')
        .eq('is_active', true)
        .eq('channel_type', 'shared')
        .limit(1)
        .maybeSingle();

      if (channel?.phone_number_id && channel?.meta_access_token) {
        // #257: platform-scoped attempt recording (best-effort)
        let attemptId: string | null = null;
        try {
          const { createAttempt, markSending } = await import('@/lib/channels/attempt-recording');
          attemptId = await createAttempt(supabase, {
            businessId: null, attemptScope: 'platform', recipientPhone: phone,
            flowType: 'auth-otp', templateName: OTP_TEMPLATE_NAME,
          });
          if (attemptId) await markSending(supabase, attemptId);
        } catch { /* best-effort recording */ }

        const cloud = new MetaCloudService({
          phoneNumberId: channel.phone_number_id,
          accessToken: channel.meta_access_token,
        });
        const result = await cloud.sendAuthenticationTemplate({
          to: phone,
          templateName: OTP_TEMPLATE_NAME,
          languageCode: OTP_TEMPLATE_LANGUAGE,
          code,
        });
        waMessageId = result.messageId;
        if (attemptId && waMessageId) {
          try { const { markAccepted } = await import('@/lib/channels/attempt-recording'); await markAccepted(supabase, attemptId, waMessageId); } catch {}
        }
        deliveryPath = 'database_channel';
        sent = true;
      }
    } catch (err) {
      logger.withContext({ op: 'otp-send.whatsapp-channel', ...safeLogErrorContext(err) }).error('[OTP Send] WhatsApp channel send failed, trying env fallback');
    }

    // Fallback: use env-level Meta Cloud credentials
    if (!sent) {
      const phoneNumberId = process.env.META_CLOUD_PHONE_NUMBER_ID;
      const accessToken = process.env.META_CLOUD_ACCESS_TOKEN;

      if (!phoneNumberId || !accessToken) {
        return NextResponse.json(
          { message: 'WhatsApp OTP service is unavailable. Please try again later.' },
          { status: 503 },
        );
      }

      // #257: platform-scoped attempt recording (env fallback, best-effort)
      let attemptIdFb: string | null = null;
      try {
        const fbSupabase = createServiceClient();
        const { createAttempt, markSending } = await import('@/lib/channels/attempt-recording');
        attemptIdFb = await createAttempt(fbSupabase, {
          businessId: null, attemptScope: 'platform', recipientPhone: phone,
          flowType: 'auth-otp-fallback', templateName: OTP_TEMPLATE_NAME,
        });
        if (attemptIdFb) await markSending(fbSupabase, attemptIdFb);
      } catch { /* best-effort */ }

      const cloud = new MetaCloudService({ phoneNumberId, accessToken });
      const result = await cloud.sendAuthenticationTemplate({
        to: phone,
        templateName: OTP_TEMPLATE_NAME,
        languageCode: OTP_TEMPLATE_LANGUAGE,
        code,
      });
      waMessageId = result.messageId;
      if (attemptIdFb && waMessageId) {
        try { const fbSb = createServiceClient(); const { markAccepted } = await import('@/lib/channels/attempt-recording'); await markAccepted(fbSb, attemptIdFb, waMessageId); } catch {}
      }
      deliveryPath = 'env_fallback';
    }

    // Record delivery attempt for observability (non-blocking)
    if (waMessageId && deliveryPath) {
      try {
        const supabase = createServiceClient();
        const { error: obsError } = await supabase.from('otp_delivery_attempts').insert({
          challenge_id: challengeId,
          wa_message_id: waMessageId,
          delivery_path: deliveryPath,
        });
        if (obsError) {
          logger.withContext({ op: 'otp-send.observability', errorCode: obsError.code }).warn('[OTP Send] Failed to record delivery attempt');
        }
      } catch {
        // Thrown exception (network, etc.) — still non-blocking
        logger.withContext({ op: 'otp-send.observability' }).warn('[OTP Send] Failed to record delivery attempt');
      }
    }

    return NextResponse.json({
      message: 'OTP sent via WhatsApp',
      pin_id: challengeId,
    });
  } catch (err) {
    logger.withContext({ op: 'otp-send.error', ...safeLogErrorContext(err) }).error('[OTP Send] Error');
    return NextResponse.json(
      { message: 'Failed to send OTP. Please try again.' },
      { status: 500 },
    );
  }
}

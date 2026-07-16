import { NextResponse, type NextRequest } from 'next/server';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { generatePhoneOtp } from '@/lib/otp-phone-token';
import { MetaCloudService } from '@/lib/channels/meta-cloud';
import { createServiceClient } from '@/lib/supabase/service';
import { checkBruteForce } from '@/lib/brute-force';

// Support all Waaiio countries: NG (+234), US (+1), GB (+44), CA (+1), GH (+233)
const PHONE_REGEX = /^\+[1-9][0-9]{6,14}$/;

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

    // Generate OTP and HMAC-signed token (stateless)
    const { code, token } = generatePhoneOtp(phone);

    // Send OTP via WhatsApp using a shared Meta Cloud channel
    let sent = false;
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
        const cloud = new MetaCloudService({
          phoneNumberId: channel.phone_number_id,
          accessToken: channel.meta_access_token,
        });
        await cloud.sendText({
          to: phone,
          text: `Your Waaiio login code is: *${code}*\n\nThis code expires in 5 minutes. Do not share it with anyone.`,
        });
        sent = true;
      }
    } catch (err) {
      console.error('[OTP Send] WhatsApp channel send failed, trying env fallback:', err);
    }

    // Fallback: use env-level Meta Cloud credentials (shared number 12029226251)
    if (!sent) {
      const phoneNumberId = process.env.META_CLOUD_PHONE_NUMBER_ID;
      const accessToken = process.env.META_CLOUD_ACCESS_TOKEN;

      if (!phoneNumberId || !accessToken) {
        return NextResponse.json(
          { message: 'WhatsApp OTP service is unavailable. Please try again later.' },
          { status: 503 },
        );
      }

      const cloud = new MetaCloudService({ phoneNumberId, accessToken });
      await cloud.sendText({
        to: phone,
        text: `Your Waaiio login code is: *${code}*\n\nThis code expires in 5 minutes. Do not share it with anyone.`,
      });
    }

    return NextResponse.json({
      message: 'OTP sent via WhatsApp',
      pin_id: token,
    });
  } catch (err) {
    console.error('[OTP Send] Error:', err);
    return NextResponse.json(
      { message: 'Failed to send OTP. Please try again.' },
      { status: 500 },
    );
  }
}

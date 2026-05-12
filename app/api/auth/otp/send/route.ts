import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { rateLimitResponse, getRateLimitKey } from '@/lib/rate-limit';

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

    // Rate limit: 3 per phone per 10 minutes + 10 per IP per 10 minutes
    const phoneLimit = rateLimitResponse(`otp-send:${phone}`, 3, 600_000);
    if (phoneLimit) return phoneLimit;
    const ipLimit = rateLimitResponse(getRateLimitKey(request, 'otp-send'), 10, 600_000);
    if (ipLimit) return ipLimit;

    // Use Supabase phone OTP
    const supabase = await createClient();
    const { error } = await supabase.auth.signInWithOtp({ phone });

    if (error) {
      return NextResponse.json(
        { message: 'Failed to send OTP. Please try again.' },
        { status: 500 },
      );
    }

    return NextResponse.json({
      message: 'OTP sent successfully',
      pin_id: `supabase_${Date.now()}`,
    });
  } catch {
    return NextResponse.json(
      { message: 'Internal server error' },
      { status: 500 },
    );
  }
}

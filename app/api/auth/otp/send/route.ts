import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';

const PHONE_REGEX = /^\+234[0-9]{10}$/;

// In-memory rate limiter (replace with Redis in production)
const rateLimits = new Map<string, { count: number; windowStart: number }>();

export async function POST(request: NextRequest) {
  try {
    const { phone } = await request.json();

    if (!phone || !PHONE_REGEX.test(phone)) {
      return NextResponse.json(
        { message: 'Invalid Nigerian phone number. Use format: +234XXXXXXXXXX' },
        { status: 400 },
      );
    }

    // Rate limit: 3 per phone per 10 minutes
    const now = Date.now();
    const record = rateLimits.get(phone);
    if (record && now - record.windowStart < 600_000) {
      if (record.count >= 3) {
        return NextResponse.json(
          { message: 'Too many OTP requests. Please wait 10 minutes.' },
          { status: 429 },
        );
      }
      record.count++;
    } else {
      rateLimits.set(phone, { count: 1, windowStart: now });
    }

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

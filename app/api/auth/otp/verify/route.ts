import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function POST(request: NextRequest) {
  try {
    const { phone, otp } = await request.json();

    if (!phone || !otp || otp.length !== 6) {
      return NextResponse.json(
        { message: 'Phone number and 6-digit OTP are required' },
        { status: 400 },
      );
    }

    const supabase = await createClient();

    const { data, error } = await supabase.auth.verifyOtp({
      phone,
      token: otp,
      type: 'sms',
    });

    if (error) {
      return NextResponse.json(
        { message: 'Invalid or expired OTP' },
        { status: 401 },
      );
    }

    // Check if profile exists to determine new user
    const { data: profile } = await supabase
      .from('profiles')
      .select('first_name')
      .eq('id', data.user?.id)
      .single();

    const isNewUser = !profile?.first_name;

    return NextResponse.json({
      message: 'OTP verified successfully',
      user_id: data.user?.id,
      is_new_user: isNewUser,
    });
  } catch {
    return NextResponse.json(
      { message: 'Internal server error' },
      { status: 500 },
    );
  }
}

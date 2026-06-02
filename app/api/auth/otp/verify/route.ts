import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimitResponse } from '@/lib/rate-limit';
import { verifyPhoneOtp, generatePhonePassword } from '@/lib/otp-phone-token';

export async function POST(request: NextRequest) {
  try {
    const { phone, otp, pin_id } = await request.json();

    // Rate limit: 5 verify attempts per phone per 15 minutes
    if (phone) {
      const blocked = rateLimitResponse(`otp-verify:${phone}`, 5, 15 * 60 * 1000);
      if (blocked) return blocked;
    }

    if (!phone || !otp || !/^\d{6}$/.test(otp) || !pin_id) {
      return NextResponse.json(
        { message: 'Phone number, 6-digit OTP, and pin_id are required' },
        { status: 400 },
      );
    }

    // Verify OTP against HMAC-signed token
    const isValid = verifyPhoneOtp(phone, otp, pin_id);
    if (!isValid) {
      return NextResponse.json(
        { message: 'Invalid or expired OTP' },
        { status: 401 },
      );
    }

    // OTP verified — now find or create the Supabase user and create a session
    const serviceClient = createServiceClient();
    const phoneEmail = `${phone.replace(/\+/g, '')}@phone.waaiio.com`;

    // Check if a profile exists with this phone number
    const { data: existingProfile } = await serviceClient
      .from('profiles')
      .select('id')
      .eq('phone', phone)
      .maybeSingle();

    let userId: string;
    let isNewUser = false;

    if (existingProfile) {
      userId = existingProfile.id;
      // Update user password to allow sign-in
      const tempPassword = generatePhonePassword(phone);
      await serviceClient.auth.admin.updateUserById(userId, {
        password: tempPassword,
        phone_confirm: true,
      });

      // Sign in using the server client (sets cookies)
      const supabase = await createClient();
      // First we need the user's email to sign in
      const { data: userData } = await serviceClient.auth.admin.getUserById(userId);
      const userEmail = userData?.user?.email || phoneEmail;

      // Update email if it was different (e.g., user signed up with real email)
      // We still need to sign in with whatever email they have
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: userEmail,
        password: tempPassword,
      });

      if (signInError) {
        // If sign-in fails (e.g., email was different), try with phone email
        await serviceClient.auth.admin.updateUserById(userId, {
          email: phoneEmail,
          password: tempPassword,
          email_confirm: true,
        });

        const { error: retryError } = await supabase.auth.signInWithPassword({
          email: phoneEmail,
          password: tempPassword,
        });

        if (retryError) {
          console.error('[OTP Verify] Sign-in failed after retry:', retryError.message);
          return NextResponse.json(
            { message: 'Authentication failed. Please try again.' },
            { status: 500 },
          );
        }
      }
    } else {
      // New user — create account
      isNewUser = true;
      const tempPassword = generatePhonePassword(phone);

      const { data: newUser, error: createError } = await serviceClient.auth.admin.createUser({
        email: phoneEmail,
        password: tempPassword,
        phone,
        phone_confirm: true,
        email_confirm: true,
        user_metadata: { phone_verified: true },
      });

      if (createError || !newUser?.user) {
        console.error('[OTP Verify] Failed to create user:', createError?.message);
        return NextResponse.json(
          { message: 'Failed to create account. Please try again.' },
          { status: 500 },
        );
      }

      userId = newUser.user.id;

      // Sign in using the server client (sets cookies)
      const supabase = await createClient();
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: phoneEmail,
        password: tempPassword,
      });

      if (signInError) {
        console.error('[OTP Verify] Sign-in after create failed:', signInError.message);
        return NextResponse.json(
          { message: 'Account created but sign-in failed. Please try again.' },
          { status: 500 },
        );
      }
    }

    // Check if profile has first_name to determine if onboarding is needed
    const { data: profile } = await serviceClient
      .from('profiles')
      .select('first_name')
      .eq('id', userId)
      .maybeSingle();

    const needsOnboarding = isNewUser || !profile?.first_name;

    return NextResponse.json({
      message: 'OTP verified successfully',
      user_id: userId,
      is_new_user: needsOnboarding,
    });
  } catch (err) {
    console.error('[OTP Verify] Error:', err);
    return NextResponse.json(
      { message: 'Internal server error' },
      { status: 500 },
    );
  }
}

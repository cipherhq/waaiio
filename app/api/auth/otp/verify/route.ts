import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimitResponseAsync } from '@/lib/rate-limit';
import { verifyPhoneOtp, generatePhonePassword } from '@/lib/otp-phone-token';
import { checkBruteForce, recordFailure, clearFailures } from '@/lib/brute-force';
import { bindSession } from '@/lib/security/session-bind';
import { createSecurityEvent } from '@/lib/security/create-security-event';
import { logger } from '@/lib/logger';
import { safeLogErrorContext } from '@/lib/errors';

export async function POST(request: NextRequest) {
  try {
    const { phone, otp, pin_id } = await request.json();

    // Rate limit: 5 verify attempts per phone per 15 minutes
    if (phone) {
      const blocked = await rateLimitResponseAsync(`otp-verify:${phone}`, 5, 15 * 60 * 1000);
      if (blocked) return blocked;
    }

    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';

    // Brute force: check phone-level and IP-level blocks
    if (phone) {
      const phoneBf = checkBruteForce(`otp-phone:${phone}`);
      if (phoneBf.blocked) {
        return NextResponse.json(
          { message: 'Too many failed attempts. Please try again later.' },
          { status: 429 },
        );
      }
    }
    const ipBf = checkBruteForce(`ip:${ip}`);
    if (ipBf.blocked) {
      return NextResponse.json(
        { message: 'Too many attempts. Please try again later.' },
        { status: 429 },
      );
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
      // Record brute force failure for both phone and IP
      const phoneLock = recordFailure(`otp-phone:${phone}`);
      const ipLock = recordFailure(`ip:${ip}`);

      // Create security alert on lockout
      if (phoneLock.locked || ipLock.locked) {
        createSecurityEvent({
          eventType: 'security.brute_force',
          severity: 'critical',
          ip,
          metadata: { phone, phone_locked: phoneLock.locked, ip_locked: ipLock.locked },
        }).catch(() => {});
      }

      return NextResponse.json(
        { message: 'Invalid or expired OTP' },
        { status: 401 },
      );
    }

    // OTP valid — clear brute force records
    clearFailures(`otp-phone:${phone}`);
    clearFailures(`ip:${ip}`);

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
          logger.withContext({ op: 'otp-verify.sign-in-retry', ...safeLogErrorContext(retryError) }).error('[OTP Verify] Sign-in failed after retry');
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
        logger.withContext({ op: 'otp-verify.create-user', ...safeLogErrorContext(createError) }).error('[OTP Verify] Failed to create user');
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
        logger.withContext({ op: 'otp-verify.sign-in-after-create', ...safeLogErrorContext(signInError) }).error('[OTP Verify] Sign-in after create failed');
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

    // Bind session for security tracking (non-blocking)
    const ua = request.headers.get('user-agent') || 'unknown';
    const country = request.headers.get('x-vercel-ip-country') || undefined;
    bindSession({
      userId,
      sessionId: `otp-${userId}-${Date.now().toString(36)}`,
      ip,
      userAgent: ua,
      country,
    }).catch(() => {});

    return NextResponse.json({
      message: 'OTP verified successfully',
      user_id: userId,
      is_new_user: needsOnboarding,
    });
  } catch (err) {
    logger.withContext({ op: 'otp-verify.error', ...safeLogErrorContext(err) }).error('[OTP Verify] Error');
    return NextResponse.json(
      { message: 'Internal server error' },
      { status: 500 },
    );
  }
}

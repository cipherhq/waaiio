import { NextRequest, NextResponse } from 'next/server';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { rateLimitResponseAsync } from '@/lib/rate-limit';
import { verifyPhoneOtp } from '@/lib/otp-phone-token';
import { logger } from '@/lib/logger';
import { PASSWORD_MIN_LENGTH, newPasswordProblem, weakPasswordMessage } from '@/lib/password-policy';

/**
 * POST /api/account/password — change the signed-in user's password.
 *
 * The user proves it is them in one of two ways (Owner decision 2026-11-27):
 *  - their current password, confirmed with a throwaway client (same pattern
 *    as /api/payouts/setup) so the user's own session cookies are not rotated;
 *  - or a WhatsApp code sent to the phone confirmed on their account. People
 *    who sign in with a WhatsApp code do not know their account password.
 *    The code is checked against the account's own confirmed phone, never a
 *    phone supplied by the browser.
 * Attempts are limited per user. The new-password rule is the shared one
 * (lib/password-policy.ts, #1175 F6), the same as the Settings form.
 */

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

const CHECK_UNAVAILABLE = "We couldn't check that right now. Please try again in a moment.";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const limited = await rateLimitResponseAsync(`account-password:${user.id}`, MAX_ATTEMPTS, WINDOW_MS);
  if (limited) return limited;

  let body: { currentPassword?: unknown; newPassword?: unknown; otpCode?: unknown; challengeId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  const { currentPassword, newPassword, otpCode, challengeId } = body;

  if (typeof newPassword !== 'string' || newPassword.length < PASSWORD_MIN_LENGTH) {
    return NextResponse.json({ error: newPasswordProblem(typeof newPassword === 'string' ? newPassword : '') }, { status: 400 });
  }

  if (typeof otpCode === 'string' && otpCode.length > 0) {
    // WhatsApp code path: only the phone confirmed on this account counts.
    if (typeof challengeId !== 'string' || challengeId.length === 0) {
      return NextResponse.json({ error: 'Please request a new code.' }, { status: 400 });
    }
    const digits = (user.phone || '').replace(/\D/g, '');
    if (!digits || !user.phone_confirmed_at) {
      return NextResponse.json({ error: 'Your account has no confirmed WhatsApp number. Use your current password instead.' }, { status: 400 });
    }
    const result = await verifyPhoneOtp(`+${digits}`, otpCode.trim(), challengeId);
    if (!result.valid) {
      return NextResponse.json({ error: 'That code is incorrect or has expired.' }, { status: 403 });
    }
  } else {
    // Current password path.
    if (typeof currentPassword !== 'string' || currentPassword.length === 0) {
      return NextResponse.json({ error: 'Please enter your current password.' }, { status: 400 });
    }
    const identity = user.email ? { email: user.email } : user.phone ? { phone: user.phone } : null;
    if (!identity) {
      return NextResponse.json({ error: 'Your account has no email or phone to confirm the password with.' }, { status: 400 });
    }
    const authCheck = createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const { error: checkError } = await authCheck.auth.signInWithPassword({ ...identity, password: currentPassword });
    if (checkError) {
      // Only a wrong password is reported as wrong; Supabase limits or outages are not.
      const wrongPassword = checkError.status === 400 || checkError.code === 'invalid_credentials';
      if (!wrongPassword) {
        logger.withContext({ op: 'account.password.check', userId: user.id }).warn('[ACCOUNT] password check unavailable');
        return NextResponse.json({ error: CHECK_UNAVAILABLE }, { status: 503 });
      }
      return NextResponse.json({ error: 'Current password is incorrect.' }, { status: 403 });
    }
    // End the throwaway session; the user's own session is untouched.
    await authCheck.auth.signOut({ scope: 'local' }).catch(() => {});
  }

  const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
  if (updateError) {
    logger.withContext({ op: 'account.password', userId: user.id }).warn('[ACCOUNT] password update refused');
    return NextResponse.json({ error: weakPasswordMessage(updateError) ?? (updateError.message || 'Failed to update password.') }, { status: 400 });
  }

  return NextResponse.json({ success: true });
}

import { NextResponse, type NextRequest } from 'next/server';
import { authenticateRequest } from '@/lib/api-auth';
import { rateLimitResponseAsync } from '@/lib/rate-limit';
import { verifyPhoneOtp } from '@/lib/otp-phone-token';
import { checkBruteForce, recordFailure, clearFailures } from '@/lib/brute-force';
import { attachVerifiedPhone, isConnectedWaaiioNumber } from '@/lib/trial-credit/verified-phone';
import { logger } from '@/lib/logger';
import { safeLogErrorContext } from '@/lib/errors';

const PHONE_REGEX = /^\+[1-9][0-9]{6,14}$/;
const ATTACH_FAILED_MESSAGE = "We couldn't link this number to your account. It may already be linked to another Waaiio account. Use a different number, or contact support.";
const CONNECTED_NUMBER_MESSAGE = "This number is connected to Waaiio and can't receive codes. Use your personal or everyday business number.";

/**
 * Claim the free messaging credit by verifying a phone number (Owner decision
 * 2026-11-07). The code is sent by the existing /api/auth/otp/send. On a valid
 * code the number becomes the owner's confirmed phone and the normal trial
 * check (activate_trial_if_eligible, M465) runs, with all of its rules.
 */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return NextResponse.json({ message: 'Invalid request' }, { status: 400 }); }

  const auth = await authenticateRequest(request, { requireBusinessOwnership: true, businessIdKey: 'business_id', body });
  if (auth instanceof NextResponse) return auth;
  const { user, businessId, service } = auth;

  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';

  // Pre-check before a code is sent: a number connected to Waaiio can't
  // receive the code, so say so up front instead of after a wasted send.
  if (body.check === true) {
    if (!PHONE_REGEX.test(phone)) return NextResponse.json({ message: 'Enter a valid phone number.' }, { status: 400 });
    const checkLimited = await rateLimitResponseAsync(`claim-check:${user.id}`, 10, 10 * 60 * 1000);
    if (checkLimited) return checkLimited;
    try {
      if (await isConnectedWaaiioNumber(service, phone)) {
        return NextResponse.json({ code: 'connected_number', message: CONNECTED_NUMBER_MESSAGE }, { status: 400 });
      }
    } catch (err) {
      logger.withContext({ op: 'trial-credit.claim.check', ...safeLogErrorContext(err) }).error('[CLAIM] Number check failed');
      return NextResponse.json({ message: 'Something went wrong. Please try again.' }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  }

  const otp = typeof body.otp === 'string' ? body.otp.trim() : '';
  const pinId = typeof body.pin_id === 'string' ? body.pin_id : '';
  if (!PHONE_REGEX.test(phone) || !/^\d{6}$/.test(otp) || !pinId) {
    return NextResponse.json({ message: 'Enter your number and the 6-digit code.' }, { status: 400 });
  }

  // Same limits as the login code check.
  const limited = await rateLimitResponseAsync(`otp-verify:${phone}`, 5, 15 * 60 * 1000);
  if (limited) return limited;
  if (checkBruteForce(`otp-phone:${phone}`).blocked || checkBruteForce(`claim-user:${user.id}`).blocked) {
    return NextResponse.json({ message: 'Too many attempts. Please try again later.' }, { status: 429 });
  }

  try {
    if (await isConnectedWaaiioNumber(service, phone)) {
      return NextResponse.json({ code: 'connected_number', message: CONNECTED_NUMBER_MESSAGE }, { status: 400 });
    }

    const result = await verifyPhoneOtp(phone, otp, pinId);
    if (!result.valid) {
      recordFailure(`otp-phone:${phone}`);
      recordFailure(`claim-user:${user.id}`);
      return NextResponse.json({ code: 'invalid_code', message: 'That code is wrong or has expired. Please try again.' }, { status: 401 });
    }
    clearFailures(`otp-phone:${phone}`);
    clearFailures(`claim-user:${user.id}`);

    const attached = await attachVerifiedPhone(service, user.id, phone);
    if (!attached.ok) {
      if (attached.reason === 'phone_in_use') {
        return NextResponse.json({ code: 'phone_in_use', message: 'This number is already linked to another Waaiio account. Use a different number, or contact support.' }, { status: 409 });
      }
      if (attached.reason === 'other_phone_already_verified') {
        return NextResponse.json({ code: 'other_phone_already_verified', message: 'Your account already has a verified phone number.' }, { status: 409 });
      }
      // The code is already used up at this point, so never send the owner
      // back to retry it; the page returns them to the number step.
      logger.withContext({ op: 'trial-credit.claim.attach', step: attached.step, errorCode: attached.errorCode, errorStatus: attached.errorStatus })
        .error('[CLAIM] Could not save the verified phone');
      return NextResponse.json({ code: 'attach_failed', message: ATTACH_FAILED_MESSAGE }, { status: 500 });
    }

    const { data: trial, error: trialError } = await service.rpc('activate_trial_if_eligible', { p_business_id: businessId });
    if (trialError) {
      logger.withContext({ op: 'trial-credit.claim.activate', ...safeLogErrorContext(trialError) }).error('[CLAIM] Trial activation RPC error');
      return NextResponse.json({ verified: true, credited: false, reason: 'activation_error' });
    }
    const parsed = (typeof trial === 'string' ? JSON.parse(trial) : trial) as { activated?: boolean; reason?: string } | null;
    return NextResponse.json({ verified: true, credited: parsed?.activated === true, reason: parsed?.activated ? undefined : (parsed?.reason || 'unknown') });
  } catch (err) {
    logger.withContext({ op: 'trial-credit.claim', ...safeLogErrorContext(err) }).error('[CLAIM] Error');
    return NextResponse.json({ message: 'Something went wrong. Please try again.' }, { status: 500 });
  }
}

import { NextResponse, type NextRequest } from 'next/server';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { sendEmail } from '@/lib/email/client';
import { checkBruteForce, recordFailure, clearFailures } from '@/lib/brute-force';
import { logger } from '@/lib/logger';
import { safeLogErrorContext } from '@/lib/errors';
import { generateOtpChallenge, verifyOtpChallenge } from '@/lib/otp-challenge';

export async function POST(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action');

  if (action === 'verify') return handleVerify(request);
  return handleSend(request);
}

async function handleSend(request: NextRequest) {
  try {
    const { email } = await request.json();

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: 'Valid email address required' }, { status: 400 });
    }

    const emailLower = email.toLowerCase().trim();

    // Brute force: check IP-level block before proceeding
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    const ipCheck = checkBruteForce(`ip:${ip}`);
    if (ipCheck.blocked) {
      return NextResponse.json({ error: 'Too many attempts. Please try again later.' }, { status: 429 });
    }

    // Rate limit: 3 per email per 10min, 10 per IP per 10min
    const emailLimit = await rateLimitResponseAsync(`email-otp:${emailLower}`, 3, 600_000);
    if (emailLimit) return emailLimit;
    const ipLimit = await rateLimitResponseAsync(getRateLimitKey(request, 'email-otp'), 10, 600_000);
    if (ipLimit) return ipLimit;

    // Generate challenge — hashed storage, atomic consume, failed-attempt tracking
    const { code, challengeId } = await generateOtpChallenge('email', emailLower);

    // Send email
    await sendEmail({
      to: emailLower,
      subject: `${code} is your Waaiio verification code`,
      html: `
        <div style="font-family: sans-serif; max-width: 400px; margin: 0 auto; padding: 24px;">
          <h2 style="color: #6C2BD9; margin-bottom: 8px;">Verify your email</h2>
          <p style="color: #555; font-size: 14px;">Enter this code to continue your purchase:</p>
          <div style="background: #f5f0ff; border-radius: 12px; padding: 20px; text-align: center; margin: 16px 0;">
            <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #6C2BD9;">${code}</span>
          </div>
          <p style="color: #999; font-size: 12px;">This code expires in 5 minutes. If you didn't request this, ignore this email.</p>
          <p style="color: #ccc; font-size: 11px; margin-top: 24px;">Powered by Waaiio</p>
        </div>
      `,
    });

    return NextResponse.json({ success: true, challengeId });
  } catch (err) {
    logger.withContext({ op: 'email-otp.send', ...safeLogErrorContext(err) }).error('[EMAIL-OTP] Send error');
    return NextResponse.json({ error: 'Failed to send code' }, { status: 500 });
  }
}

async function handleVerify(request: NextRequest) {
  try {
    const { email, code, challengeId } = await request.json();

    if (!email || !code || !challengeId) {
      return NextResponse.json({ error: 'Email, code, and challengeId required' }, { status: 400 });
    }

    const emailLower = email.toLowerCase().trim();
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';

    // Brute force: check both email-level and IP-level blocks (defense-in-depth)
    const emailBf = checkBruteForce(`otp:${emailLower}`);
    if (emailBf.blocked) {
      return NextResponse.json({ error: 'Too many failed attempts. Please try again later.' }, { status: 429 });
    }
    const ipBf = checkBruteForce(`ip:${ip}`);
    if (ipBf.blocked) {
      return NextResponse.json({ error: 'Too many attempts. Please try again later.' }, { status: 429 });
    }

    // Rate limit: 5 attempts per email per 15min
    const limit = await rateLimitResponseAsync(`email-otp-verify:${emailLower}`, 5, 15 * 60 * 1000);
    if (limit) return limit;

    // Verify via challenge table — hashed comparison, atomic consume, failed-attempt tracking
    const codeStr = String(code).trim();
    const result = await verifyOtpChallenge('email', emailLower, codeStr, challengeId);

    if (!result.valid) {
      // Record brute force failure for both email and IP (defense-in-depth)
      recordFailure(`otp:${emailLower}`);
      recordFailure(`ip:${ip}`);

      const errorMap: Record<string, string> = {
        invalid_challenge: 'No code found. Request a new one.',
        expired: 'Code expired. Request a new one.',
        consumed: 'Code already used. Request a new one.',
        wrong_identifier: 'Incorrect code',
        wrong_otp: 'Incorrect code',
        max_attempts: 'Too many failed attempts. Request a new code.',
        concurrent: 'Verification failed. Please try again.',
      };

      return NextResponse.json(
        { error: errorMap[result.reason || ''] || 'Incorrect code' },
        { status: result.reason === 'expired' || result.reason === 'invalid_challenge' || result.reason === 'consumed' ? 400 : 401 },
      );
    }

    // Verified — clear brute force records
    clearFailures(`otp:${emailLower}`);
    clearFailures(`ip:${ip}`);

    // Generate HMAC token proving this email was verified (valid 15 min)
    const { createHmac } = await import('crypto');
    const secret = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    const expiresAtMs = Date.now() + 15 * 60 * 1000;
    const payload = `${emailLower}:${expiresAtMs}`;
    const signature = createHmac('sha256', secret).update(payload).digest('hex');
    const otpToken = `${payload}:${signature}`;

    return NextResponse.json({ verified: true, otpToken });
  } catch {
    return NextResponse.json({ error: 'Verification failed' }, { status: 500 });
  }
}

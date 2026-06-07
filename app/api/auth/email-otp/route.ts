import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimitResponse, getRateLimitKey } from '@/lib/rate-limit';
import { sendEmail } from '@/lib/email/client';
import { checkBruteForce, recordFailure, clearFailures } from '@/lib/brute-force';

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
    const emailLimit = rateLimitResponse(`email-otp:${emailLower}`, 3, 600_000);
    if (emailLimit) return emailLimit;
    const ipLimit = rateLimitResponse(getRateLimitKey(request, 'email-otp'), 10, 600_000);
    if (ipLimit) return ipLimit;

    // Generate 6-digit code using crypto-safe random
    const { randomInt } = await import('crypto');
    const code = String(randomInt(100000, 999999));
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5 minutes

    // Store in DB (upsert by email — replaces any existing code)
    const supabase = createServiceClient();
    await supabase
      .from('platform_settings')
      .upsert(
        { key: `otp:${emailLower}`, value: { code, expires_at: expiresAt }, description: 'Email OTP' },
        { onConflict: 'key' },
      );

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

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[EMAIL-OTP] Send error:', err);
    return NextResponse.json({ error: 'Failed to send code' }, { status: 500 });
  }
}

async function handleVerify(request: NextRequest) {
  try {
    const { email, code } = await request.json();

    if (!email || !code) {
      return NextResponse.json({ error: 'Email and code required' }, { status: 400 });
    }

    const emailLower = email.toLowerCase().trim();
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';

    // Brute force: check both email-level and IP-level blocks
    const emailBf = checkBruteForce(`otp:${emailLower}`);
    if (emailBf.blocked) {
      return NextResponse.json({ error: 'Too many failed attempts. Please try again later.' }, { status: 429 });
    }
    const ipBf = checkBruteForce(`ip:${ip}`);
    if (ipBf.blocked) {
      return NextResponse.json({ error: 'Too many attempts. Please try again later.' }, { status: 429 });
    }

    // Rate limit: 5 attempts per email per 15min
    const limit = rateLimitResponse(`email-otp-verify:${emailLower}`, 5, 15 * 60 * 1000);
    if (limit) return limit;

    // Fetch from DB
    const supabase = createServiceClient();
    const { data } = await supabase
      .from('platform_settings')
      .select('value')
      .eq('key', `otp:${emailLower}`)
      .maybeSingle();

    if (!data?.value) {
      return NextResponse.json({ error: 'No code found. Request a new one.' }, { status: 400 });
    }

    const stored = data.value as { code: string; expires_at: string };

    if (new Date() > new Date(stored.expires_at)) {
      // Cleanup expired
      await supabase.from('platform_settings').delete().eq('key', `otp:${emailLower}`);
      return NextResponse.json({ error: 'Code expired. Request a new one.' }, { status: 400 });
    }

    const { timingSafeEqual } = await import('crypto');
    const codeStr = String(code).trim();
    if (codeStr.length !== stored.code.length || !timingSafeEqual(Buffer.from(stored.code), Buffer.from(codeStr))) {
      // Record brute force failure for both email and IP
      recordFailure(`otp:${emailLower}`);
      recordFailure(`ip:${ip}`);
      return NextResponse.json({ error: 'Incorrect code' }, { status: 401 });
    }

    // Verified — clear brute force records, delete from DB, and issue a signed token
    clearFailures(`otp:${emailLower}`);
    clearFailures(`ip:${ip}`);
    await supabase.from('platform_settings').delete().eq('key', `otp:${emailLower}`);

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

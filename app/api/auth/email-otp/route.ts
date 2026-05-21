import { NextResponse, type NextRequest } from 'next/server';
import { rateLimitResponse, getRateLimitKey } from '@/lib/rate-limit';
import { sendEmail } from '@/lib/email/client';

// In-memory OTP store (sufficient for serverless — each instance handles its own verification)
const otpStore = new Map<string, { code: string; expiresAt: number }>();

// Cleanup expired entries periodically
function cleanupExpired() {
  const now = Date.now();
  for (const [key, entry] of otpStore) {
    if (now > entry.expiresAt) otpStore.delete(key);
  }
  if (otpStore.size > 10_000) {
    const excess = otpStore.size - 10_000;
    const iter = otpStore.keys();
    for (let i = 0; i < excess; i++) {
      const next = iter.next();
      if (!next.done) otpStore.delete(next.value);
    }
  }
}

export async function POST(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action'); // 'send' or 'verify'

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

    // Rate limit: 3 per email per 10min, 10 per IP per 10min
    const emailLimit = rateLimitResponse(`email-otp:${emailLower}`, 3, 600_000);
    if (emailLimit) return emailLimit;
    const ipLimit = rateLimitResponse(getRateLimitKey(request, 'email-otp'), 10, 600_000);
    if (ipLimit) return ipLimit;

    // Generate 4-digit code
    const code = String(Math.floor(1000 + Math.random() * 9000));

    // Store with 5-minute expiry
    cleanupExpired();
    otpStore.set(emailLower, { code, expiresAt: Date.now() + 5 * 60 * 1000 });

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

    // Rate limit: 5 attempts per email per 15min
    const limit = rateLimitResponse(`email-otp-verify:${emailLower}`, 5, 15 * 60 * 1000);
    if (limit) return limit;

    const entry = otpStore.get(emailLower);

    if (!entry) {
      return NextResponse.json({ error: 'No code found. Request a new one.' }, { status: 400 });
    }

    if (Date.now() > entry.expiresAt) {
      otpStore.delete(emailLower);
      return NextResponse.json({ error: 'Code expired. Request a new one.' }, { status: 400 });
    }

    if (entry.code !== String(code).trim()) {
      return NextResponse.json({ error: 'Incorrect code' }, { status: 401 });
    }

    // Verified — remove from store
    otpStore.delete(emailLower);

    return NextResponse.json({ verified: true });
  } catch {
    return NextResponse.json({ error: 'Verification failed' }, { status: 500 });
  }
}

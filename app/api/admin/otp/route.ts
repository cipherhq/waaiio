import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { sendEmail } from '@/lib/email/client';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { checkBruteForce, recordFailure, clearFailures } from '@/lib/brute-force';
import { randomInt, createHmac, timingSafeEqual } from 'crypto';
import { logger } from '@/lib/logger';

function corsHeaders(origin?: string | null) {
  const allowedOrigins = [
    process.env.ADMIN_ORIGIN || 'https://admin.waaiio.com',
    'http://localhost:8083',
  ];
  const allowed = origin && allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request.headers.get('origin')) });
}

export async function POST(request: NextRequest) {
  const origin = request.headers.get('origin');
  const cors = corsHeaders(origin);

  try {
    const body = await request.json();
    const { action } = body;

    if (action === 'send') return handleSend(request, body, cors);
    if (action === 'verify') return handleVerify(request, body, cors);

    return NextResponse.json({ error: 'Invalid action' }, { status: 400, headers: cors });
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400, headers: cors });
  }
}

/**
 * Send OTP via email or WhatsApp
 * Requires a valid Supabase session (user already authenticated with password)
 */
async function handleSend(request: NextRequest, body: Record<string, unknown>, cors: Record<string, string>) {
  const { email, method, userId } = body as { email?: string; method?: string; userId?: string };

  if (!email || !userId) {
    return NextResponse.json({ error: 'Email and userId are required' }, { status: 400, headers: cors });
  }
  if (method !== 'email' && method !== 'whatsapp') {
    return NextResponse.json({ error: 'Method must be email or whatsapp' }, { status: 400, headers: cors });
  }

  const emailLower = (email as string).toLowerCase().trim();

  const admin = await requirePlatformAdmin(request);
  if (!admin || admin.id !== userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: cors });
  }

  // Fetch phone for WhatsApp OTP delivery
  const supabase = createServiceClient();
  const { data: profile } = await supabase
    .from('profiles')
    .select('phone')
    .eq('id', admin.id)
    .maybeSingle();

  // Rate limit: 3 sends per email per 10 minutes
  const sendLimit = await rateLimitResponseAsync(`admin-otp-send:${emailLower}`, 3, 600_000);
  if (sendLimit) {
    // Attach CORS headers to rate limit response
    const rateLimitBody = await sendLimit.json();
    return NextResponse.json(rateLimitBody, { status: sendLimit.status, headers: cors });
  }

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const ipLimit = await rateLimitResponseAsync(getRateLimitKey(request, 'admin-otp-send'), 10, 600_000);
  if (ipLimit) {
    const rateLimitBody = await ipLimit.json();
    return NextResponse.json(rateLimitBody, { status: ipLimit.status, headers: cors });
  }

  // Generate 6-digit code
  const code = String(randomInt(100000, 999999));
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes

  // Create HMAC-signed token: email:code:expiresAt:hmac
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const payload = `${emailLower}:${code}:${expiresAt}`;
  const signature = createHmac('sha256', secret).update(payload).digest('hex');
  const otpToken = `${payload}:${signature}`;

  // Send code via chosen method
  if (method === 'email') {
    const result = await sendEmail({
      to: emailLower,
      subject: 'Your Waaiio Admin Login Code',
      html: `
        <div style="font-family: sans-serif; max-width: 400px; margin: 0 auto; padding: 24px;">
          <h2 style="color: #6C2BD9; margin-bottom: 8px;">Admin Login Verification</h2>
          <p style="color: #555; font-size: 14px;">Enter this code to complete your sign-in:</p>
          <div style="background: #f5f0ff; border-radius: 12px; padding: 20px; text-align: center; margin: 16px 0;">
            <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #6C2BD9;">${code}</span>
          </div>
          <p style="color: #999; font-size: 12px;">This code expires in 5 minutes. If you didn't request this, ignore this email.</p>
          <p style="color: #ccc; font-size: 11px; margin-top: 24px;">Powered by Waaiio</p>
        </div>
      `,
    });

    if (!result.success) {
      logger.error('[ADMIN-OTP] Failed to send email:', result.error);
      return NextResponse.json({ error: 'Failed to send verification code' }, { status: 500, headers: cors });
    }
  } else {
    // WhatsApp — send via Meta Cloud API
    if (!profile?.phone) {
      return NextResponse.json({ error: 'No phone number on your profile. Use email instead.' }, { status: 400, headers: cors });
    }

    const accessToken = process.env.META_CLOUD_ACCESS_TOKEN;
    const phoneNumberId = process.env.META_CLOUD_PHONE_NUMBER_ID;

    if (!accessToken || !phoneNumberId) {
      logger.error('[ADMIN-OTP] Missing META_CLOUD env vars for WhatsApp OTP');
      return NextResponse.json({ error: 'WhatsApp delivery is not configured. Use email instead.' }, { status: 500, headers: cors });
    }

    // Send a plain text message via Meta Cloud API
    const waPhone = profile!.phone!.replace(/\D/g, ''); // strip non-digits (safe — guarded by check above)
    try {
      const response = await fetch(`https://graph.facebook.com/v19.0/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: waPhone,
          type: 'text',
          text: { preview_url: false, body: `Your Waaiio admin login code: *${code}*. Expires in 5 minutes.` },
        }),
      });

      if (!response.ok) {
        const errBody = await response.text();
        logger.error('[ADMIN-OTP] WhatsApp send failed:', errBody);
        return NextResponse.json({ error: 'Failed to send WhatsApp message. Use email instead.' }, { status: 500, headers: cors });
      }
    } catch (err) {
      logger.error('[ADMIN-OTP] WhatsApp send error:', err);
      return NextResponse.json({ error: 'Failed to send WhatsApp message. Use email instead.' }, { status: 500, headers: cors });
    }
  }

  logger.info(`[ADMIN-OTP] Code sent via ${method} to ${emailLower}`);

  // Return the HMAC token — client stores it and sends back with verify
  return NextResponse.json({ success: true, otpToken }, { headers: cors });
}

/**
 * Verify OTP code
 * Compares the submitted code against the HMAC-signed token
 */
async function handleVerify(request: NextRequest, body: Record<string, unknown>, cors: Record<string, string>) {
  const { email, code, otpToken } = body as { email?: string; code?: string; otpToken?: string };

  if (!email || !code || !otpToken) {
    return NextResponse.json({ error: 'Email, code, and token are required' }, { status: 400, headers: cors });
  }

  const emailLower = (email as string).toLowerCase().trim();
  const codeStr = String(code).trim();
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';

  // Brute force check
  const emailBf = checkBruteForce(`admin-otp:${emailLower}`);
  if (emailBf.blocked) {
    return NextResponse.json({ error: 'Too many failed attempts. Please try again later.' }, { status: 429, headers: cors });
  }
  const ipBf = checkBruteForce(`ip:${ip}`);
  if (ipBf.blocked) {
    return NextResponse.json({ error: 'Too many attempts. Please try again later.' }, { status: 429, headers: cors });
  }

  // Rate limit: 5 verify attempts per email per 10 minutes
  const limit = await rateLimitResponseAsync(`admin-otp-verify:${emailLower}`, 5, 10 * 60 * 1000);
  if (limit) {
    const rateLimitBody = await limit.json();
    return NextResponse.json(rateLimitBody, { status: limit.status, headers: cors });
  }

  // Parse the HMAC token: email:code:expiresAt:hmac
  // Split from the right since email can contain colons
  const lastColon = otpToken.lastIndexOf(':');
  if (lastColon === -1) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 400, headers: cors });
  }
  const tokenSignature = otpToken.slice(lastColon + 1);
  const tokenRest = otpToken.slice(0, lastColon);

  // expiresAt is second-to-last
  const expiresColon = tokenRest.lastIndexOf(':');
  if (expiresColon === -1) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 400, headers: cors });
  }
  const expiresAtStr = tokenRest.slice(expiresColon + 1);
  const beforeExpires = tokenRest.slice(0, expiresColon);

  // code is third-to-last
  const codeColon = beforeExpires.lastIndexOf(':');
  if (codeColon === -1) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 400, headers: cors });
  }
  const tokenCode = beforeExpires.slice(codeColon + 1);
  const tokenEmail = beforeExpires.slice(0, codeColon);

  const expiresAt = parseInt(expiresAtStr, 10);

  // Verify HMAC signature
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const expectedPayload = `${tokenEmail}:${tokenCode}:${expiresAtStr}`;
  const expectedSig = createHmac('sha256', secret).update(expectedPayload).digest('hex');

  if (
    tokenSignature.length !== expectedSig.length ||
    !timingSafeEqual(Buffer.from(tokenSignature), Buffer.from(expectedSig))
  ) {
    recordFailure(`admin-otp:${emailLower}`);
    recordFailure(`ip:${ip}`);
    return NextResponse.json({ error: 'Invalid token' }, { status: 400, headers: cors });
  }

  // Check expiry
  if (isNaN(expiresAt) || Date.now() > expiresAt) {
    return NextResponse.json({ error: 'Code expired. Request a new one.' }, { status: 400, headers: cors });
  }

  // Verify email matches
  if (tokenEmail !== emailLower) {
    recordFailure(`admin-otp:${emailLower}`);
    return NextResponse.json({ error: 'Invalid token' }, { status: 400, headers: cors });
  }

  // Verify code using timingSafeEqual
  if (
    codeStr.length !== tokenCode.length ||
    !timingSafeEqual(Buffer.from(codeStr), Buffer.from(tokenCode))
  ) {
    recordFailure(`admin-otp:${emailLower}`);
    recordFailure(`ip:${ip}`);
    return NextResponse.json({ error: 'Incorrect code' }, { status: 401, headers: cors });
  }

  // Success — clear brute force records
  clearFailures(`admin-otp:${emailLower}`);
  clearFailures(`ip:${ip}`);

  logger.info(`[ADMIN-OTP] Verified for ${emailLower}`);

  return NextResponse.json({ verified: true }, { headers: cors });
}

import { createHmac, timingSafeEqual } from 'crypto';

const SECRET = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

/**
 * Verify the HMAC-signed OTP token issued by /api/auth/email-otp?action=verify.
 * Token format: `email:expiresAtMs:hmac`
 * Returns the verified email or null if invalid/expired.
 */
export function verifyOtpToken(token: string): string | null {
  const parts = token.split(':');
  if (parts.length !== 3) return null;

  const [email, expiresStr, signature] = parts;
  const expiresAt = parseInt(expiresStr, 10);

  if (isNaN(expiresAt) || Date.now() > expiresAt) return null;

  const payload = `${email}:${expiresStr}`;
  const expected = createHmac('sha256', SECRET).update(payload).digest('hex');

  if (
    signature.length !== expected.length ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    return null;
  }

  return email;
}

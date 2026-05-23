import { createHmac, timingSafeEqual } from 'crypto';

const SECRET = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

/**
 * Verify the HMAC-signed OTP token issued by /api/auth/email-otp?action=verify.
 * Token format: `email:expiresAtMs:hmac`
 * Handles emails containing colons by splitting from the right (HMAC is always 64 hex chars).
 * Returns the verified email or null if invalid/expired.
 */
export function verifyOtpToken(token: string): string | null {
  // HMAC-SHA256 hex is always 64 chars — split from the right
  const lastColon = token.lastIndexOf(':');
  if (lastColon === -1) return null;

  const signature = token.slice(lastColon + 1);
  const rest = token.slice(0, lastColon);

  const secondLastColon = rest.lastIndexOf(':');
  if (secondLastColon === -1) return null;

  const email = rest.slice(0, secondLastColon);
  const expiresStr = rest.slice(secondLastColon + 1);
  const expiresAt = parseInt(expiresStr, 10);

  if (!email || isNaN(expiresAt) || Date.now() > expiresAt) return null;

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

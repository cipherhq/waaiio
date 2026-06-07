import { createHmac, timingSafeEqual, randomBytes, randomInt } from 'crypto';

const SECRET = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Generate a 6-digit OTP and an HMAC-signed token that encodes
 * the phone, code, and expiry. Stateless — no DB storage needed.
 *
 * Token format: `phone:code:expiresAtMs:hmac`
 */
export function generatePhoneOtp(phone: string): { code: string; token: string } {
  const code = String(randomInt(100000, 999999));
  const expiresAt = Date.now() + OTP_TTL_MS;
  const payload = `${phone}:${code}:${expiresAt}`;
  const hmac = createHmac('sha256', SECRET).update(payload).digest('hex');
  const token = `${payload}:${hmac}`;
  return { code, token };
}

/**
 * Verify a phone OTP against the HMAC-signed token.
 * Returns the phone number if valid, null otherwise.
 */
export function verifyPhoneOtp(phone: string, code: string, token: string): boolean {
  if (!phone || !code || !token || !SECRET) return false;

  // Split from the right — HMAC is always 64 hex chars
  const lastColon = token.lastIndexOf(':');
  if (lastColon === -1) return false;

  const signature = token.slice(lastColon + 1);
  const rest = token.slice(0, lastColon);

  // rest = phone:code:expiresAtMs
  const secondLastColon = rest.lastIndexOf(':');
  if (secondLastColon === -1) return false;

  const expiresStr = rest.slice(secondLastColon + 1);
  const remaining = rest.slice(0, secondLastColon);

  // remaining = phone:code
  const codeColon = remaining.lastIndexOf(':');
  if (codeColon === -1) return false;

  const tokenPhone = remaining.slice(0, codeColon);
  const tokenCode = remaining.slice(codeColon + 1);
  const expiresAt = parseInt(expiresStr, 10);

  // Check expiry
  if (isNaN(expiresAt) || Date.now() > expiresAt) return false;

  // Verify phone and code match what was submitted
  if (tokenPhone !== phone || tokenCode !== code) return false;

  // Verify HMAC signature
  const payload = `${tokenPhone}:${tokenCode}:${expiresStr}`;
  const expected = createHmac('sha256', SECRET).update(payload).digest('hex');

  if (
    signature.length !== expected.length ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    return false;
  }

  return true;
}

/**
 * Generate a deterministic password for phone-based Supabase users.
 * This allows us to sign them in without storing passwords.
 * Changes each time — used as a one-time password for session creation.
 */
export function generatePhonePassword(phone: string): string {
  const nonce = randomBytes(16).toString('hex');
  return createHmac('sha256', SECRET).update(`${phone}:${nonce}`).digest('hex');
}

/**
 * OAuth State Management — cryptographic binding for provider callbacks.
 * Binds the callback to the initiating user and business.
 */
import { createHmac } from 'crypto';

function getSecret(): string {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.TOKEN_ENCRYPTION_KEY || 'dev-only';
}

/** Generate HMAC state token binding callback to user+business */
export function generateOAuthState(userId: string, businessId: string, accountId: string): string {
  const secret = getSecret();
  const expires = Date.now() + 30 * 60 * 1000; // 30 minutes
  const payload = `${userId}:${businessId}:${accountId}:${expires}`;
  const sig = createHmac('sha256', secret).update(payload).digest('hex').slice(0, 16);
  return `${payload}:${sig}`;
}

/** Verify HMAC state token — returns null if invalid, expired, or tampered */
export function verifyOAuthState(state: string): { userId: string; businessId: string; accountId: string } | null {
  const parts = state.split(':');
  if (parts.length !== 5) return null;
  const [userId, businessId, accountId, expiresStr, sig] = parts;
  const expires = parseInt(expiresStr, 10);
  if (isNaN(expires) || Date.now() > expires) return null;
  const secret = getSecret();
  const payload = `${userId}:${businessId}:${accountId}:${expiresStr}`;
  const expectedSig = createHmac('sha256', secret).update(payload).digest('hex').slice(0, 16);
  if (sig !== expectedSig) return null;
  return { userId, businessId, accountId };
}

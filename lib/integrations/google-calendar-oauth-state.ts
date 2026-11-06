/**
 * Signed OAuth `state` for the Google Calendar connect flow.
 *
 * The state is `${payload}.${sig}`:
 *   payload = base64url(JSON {u: userId, b: businessId, p: 'google_calendar', n: nonce, exp})
 *   sig     = base64url(HMAC-SHA256(key, payload))
 *
 * The nonce is also set in an httpOnly cookie scoped to the callback path, so a
 * state is only accepted in the browser that started the connect, for the user
 * who started it, before it expires.
 *
 * Key: a labelled sub-key derived from SUPABASE_SERVICE_ROLE_KEY, a server-only
 * secret already required in production (same source as lib/otp-token.ts).
 * No new env var. Signing and verifying fail closed when it is missing.
 *
 * The shared `oauth_connect_states` table only allows 'stripe' and 'square',
 * so this flow uses a signed state instead of a stored one (no schema change).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

export const GCAL_OAUTH_PROVIDER = 'google_calendar';
export const GCAL_NONCE_COOKIE = 'gcal_oauth_nonce';
export const GCAL_CALLBACK_PATH = '/api/integrations/google-calendar/callback';
export const GCAL_STATE_TTL_SECONDS = 600;

const KEY_LABEL = 'google-calendar-oauth-state:v1';
const BASE64URL = /^[A-Za-z0-9_-]+$/;

interface StatePayload {
  u: string;
  b: string;
  p: string;
  n: string;
  exp: number;
}

function getStateKey(): Buffer | null {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) return null;
  return createHmac('sha256', secret).update(KEY_LABEL).digest();
}

function sign(key: Buffer, payload: string): Buffer {
  return createHmac('sha256', key).update(payload).digest();
}

/** Cookie options for the nonce cookie (also used, with maxAge 0, to clear it). */
export function gcalNonceCookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: GCAL_CALLBACK_PATH,
    maxAge,
  };
}

/**
 * Create a signed state and the nonce to store in the cookie.
 * Returns null when no signing key is configured (caller must fail closed).
 */
export function createGoogleCalendarState(
  userId: string,
  businessId: string,
  nowMs: number = Date.now(),
): { state: string; nonce: string } | null {
  const key = getStateKey();
  if (!key) return null;

  const nonce = randomBytes(32).toString('base64url');
  const body: StatePayload = {
    u: userId,
    b: businessId,
    p: GCAL_OAUTH_PROVIDER,
    n: nonce,
    exp: Math.floor(nowMs / 1000) + GCAL_STATE_TTL_SECONDS,
  };
  const payload = Buffer.from(JSON.stringify(body)).toString('base64url');
  const sig = sign(key, payload).toString('base64url');
  return { state: `${payload}.${sig}`, nonce };
}

/**
 * Verify a state returned by Google.
 * Returns the business id from the signed payload, or null if the signature,
 * expiry, provider, user or cookie nonce does not match.
 */
export function verifyGoogleCalendarState(
  state: string,
  expected: { userId: string; cookieNonce: string | undefined | null },
  nowMs: number = Date.now(),
): { businessId: string } | null {
  const key = getStateKey();
  if (!key) return null;

  const parts = state.split('.');
  if (parts.length !== 2) return null;
  const [payload, sigPart] = parts;
  if (!payload || !sigPart || !BASE64URL.test(payload) || !BASE64URL.test(sigPart)) return null;

  const expectedSig = sign(key, payload);
  const givenSig = Buffer.from(sigPart, 'base64url');
  if (givenSig.length !== expectedSig.length || !timingSafeEqual(givenSig, expectedSig)) return null;

  let body: StatePayload;
  try {
    body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (
    !body ||
    typeof body.u !== 'string' ||
    typeof body.b !== 'string' ||
    typeof body.n !== 'string' ||
    typeof body.exp !== 'number' ||
    !body.b
  ) {
    return null;
  }

  if (Math.floor(nowMs / 1000) > body.exp) return null;
  if (body.p !== GCAL_OAUTH_PROVIDER) return null;
  if (body.u !== expected.userId) return null;

  const cookieNonce = expected.cookieNonce;
  if (!cookieNonce) return null;
  const a = Buffer.from(cookieNonce);
  const b = Buffer.from(body.n);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  return { businessId: body.b };
}

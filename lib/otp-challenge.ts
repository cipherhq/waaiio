/**
 * Channel-generic OTP challenge system — server-side, single-use, opaque challenges.
 *
 * Extends the phone OTP challenge pattern (lib/otp-phone-token.ts) to support
 * email and recurring verification channels using the same phone_otp_challenges
 * table with the M423 `channel` column.
 *
 * The `phone_hash` column stores an HMAC of the channel identifier:
 * - channel='email': HMAC of the email address
 * - channel='recurring': HMAC of the phone number
 *
 * OTP codes are stored as HMAC hashes, not plaintext.
 *
 * Requires:
 *   PHONE_OTP_HMAC_SECRET — dedicated 64+ hex-char secret for OTP hashing.
 *   Falls back to SUPABASE_SERVICE_ROLE_KEY only in non-production.
 *   Fails closed in production when the dedicated secret is missing or invalid.
 */

import { createHmac, timingSafeEqual, randomBytes, randomInt } from 'crypto';
import { createServiceClient } from '@/lib/supabase/service';

export type OtpChannel = 'email' | 'recurring';

const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_FAILED_ATTEMPTS = 5;
const MIN_SECRET_HEX_LENGTH = 64;
const HEX_PATTERN = /^[0-9a-fA-F]+$/;

/**
 * Resolve and validate the OTP HMAC secret.
 *
 * Production: requires PHONE_OTP_HMAC_SECRET with >= 64 hex chars.
 * Non-production: falls back to SUPABASE_SERVICE_ROLE_KEY or a dev default.
 */
function getOtpSecret(): string {
  const dedicated = process.env.PHONE_OTP_HMAC_SECRET;

  if (process.env.NODE_ENV === 'production') {
    if (!dedicated) {
      throw new Error('PHONE_OTP_HMAC_SECRET is required in production');
    }
    if (dedicated.length < MIN_SECRET_HEX_LENGTH) {
      throw new Error('PHONE_OTP_HMAC_SECRET must be at least 64 hexadecimal characters');
    }
    if (!HEX_PATTERN.test(dedicated)) {
      throw new Error('PHONE_OTP_HMAC_SECRET must contain only hexadecimal characters');
    }
    return dedicated;
  }

  // Non-production fallback
  if (dedicated) return dedicated;
  return process.env.SUPABASE_SERVICE_ROLE_KEY || 'dev-otp-secret';
}

/** HMAC-hash a value using the OTP secret. */
function hmacHash(value: string): string {
  return createHmac('sha256', getOtpSecret()).update(value).digest('hex');
}

/** Timing-safe comparison of two hex strings. */
function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// Export for testing only
export { hmacHash as _hmacHash, safeCompare as _safeCompare, MAX_FAILED_ATTEMPTS };

export interface OtpVerifyResult {
  valid: boolean;
  reason?: 'invalid_challenge' | 'expired' | 'consumed' | 'wrong_identifier' | 'wrong_otp' | 'max_attempts' | 'concurrent';
}

/**
 * Generate a 6-digit OTP and create a server-side challenge.
 *
 * Returns:
 *   code — the 6-digit OTP to send to the user
 *   challengeId — opaque 256-bit hex identifier for the client
 */
export async function generateOtpChallenge(
  channel: OtpChannel,
  identifier: string,
): Promise<{ code: string; challengeId: string }> {
  const code = String(randomInt(100000, 999999));
  const challengeId = randomBytes(32).toString('hex'); // 256-bit opaque ID
  const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();

  // Hash the identifier and OTP — never store plaintext
  const identifierHash = hmacHash(identifier);
  const otpHash = hmacHash(`${identifier}:${code}`);

  const supabase = createServiceClient();

  // Opportunistic cleanup of expired challenges (non-blocking)
  supabase.rpc('cleanup_expired_otp_challenges').then(() => {}, () => {});

  // Insert the challenge record with channel
  const { error } = await supabase.from('phone_otp_challenges').insert({
    challenge_id: challengeId,
    phone_hash: identifierHash, // physical column name kept as-is per CTO direction
    otp_hash: otpHash,
    channel,
    expires_at: expiresAt,
  });

  if (error) {
    throw new Error('Failed to create OTP challenge');
  }

  return { code, challengeId };
}

/**
 * Verify an OTP against a server-side challenge.
 *
 * - Validates the challenge exists for the given channel and is not expired/consumed/locked
 * - Verifies the identifier matches (via HMAC comparison)
 * - Verifies the OTP code matches (via HMAC comparison)
 * - Atomically consumes the challenge via otp_consume_challenge RPC
 * - Atomically increments failed-attempt counter via otp_record_failed_attempt RPC
 * - Rejects replay of consumed challenges
 */
export async function verifyOtpChallenge(
  channel: OtpChannel,
  identifier: string,
  code: string,
  challengeId: string,
): Promise<OtpVerifyResult> {
  if (!identifier || !code || !challengeId) {
    return { valid: false, reason: 'invalid_challenge' };
  }

  // Reject old plaintext token format (contains colons)
  if (challengeId.includes(':')) {
    return { valid: false, reason: 'invalid_challenge' };
  }

  const supabase = createServiceClient();

  // Fetch the challenge — filter by both challenge_id AND channel
  const { data: challenge, error: fetchErr } = await supabase
    .from('phone_otp_challenges')
    .select('id, phone_hash, otp_hash, expires_at, consumed_at, failed_attempts')
    .eq('challenge_id', challengeId)
    .eq('channel', channel)
    .maybeSingle();

  if (fetchErr || !challenge) {
    return { valid: false, reason: 'invalid_challenge' };
  }

  // Check if already consumed (replay protection)
  if (challenge.consumed_at) {
    return { valid: false, reason: 'consumed' };
  }

  // Check expiry
  if (new Date(challenge.expires_at) < new Date()) {
    return { valid: false, reason: 'expired' };
  }

  // Check failed-attempt limit
  if (challenge.failed_attempts >= MAX_FAILED_ATTEMPTS) {
    return { valid: false, reason: 'max_attempts' };
  }

  // Verify identifier matches (phone_hash column stores HMAC of the identifier)
  const identifierHash = hmacHash(identifier);
  if (!safeCompare(identifierHash, challenge.phone_hash)) {
    await recordFailedAttempt(supabase, challenge.id);
    return { valid: false, reason: 'wrong_identifier' };
  }

  // Verify OTP matches
  const otpHash = hmacHash(`${identifier}:${code}`);
  if (!safeCompare(otpHash, challenge.otp_hash)) {
    await recordFailedAttempt(supabase, challenge.id);
    return { valid: false, reason: 'wrong_otp' };
  }

  // Atomically consume via RPC — re-validates consumed_at, expires_at, failed_attempts
  const { data: consumedId } = await supabase.rpc('otp_consume_challenge', {
    p_challenge_id: challenge.id,
  });

  if (!consumedId) {
    return { valid: false, reason: 'concurrent' };
  }

  return { valid: true };
}

/**
 * Atomically increment failed attempts via database RPC.
 * The RPC guarantees no lost increments under concurrency and
 * refuses to increment consumed, expired, or locked challenges.
 */
async function recordFailedAttempt(supabase: ReturnType<typeof createServiceClient>, challengeId: string): Promise<void> {
  await supabase.rpc('otp_record_failed_attempt', {
    p_challenge_id: challengeId,
  });
}


/**
 * #597 F3: short-lived proof of WhatsApp OTP verification for cancelling
 * exactly one customer subscription. Issued only after verifyOtpChallenge()
 * has atomically consumed the challenge in /api/recurring/verify.
 *
 * A phone number and subscription UUID are public identifiers, NOT authority.
 * Domain separation prevents a proof being accepted as an OTP hash or another
 * type of signed token. Bearer proofs expire in five minutes and are scoped to
 * the exact subscription, preventing cross-subscription replay.
 */
const RECURRING_CANCEL_PROOF_TTL_MS = 5 * 60 * 1000;

interface RecurringCancelProof {
  v: 1;
  phone: string;
  subscriptionId: string;
  issuedAt: number;
  expiresAt: number;
}

export function issueRecurringCancellationProof(phone: string, subscriptionId: string): string {
  const issuedAt = Date.now();
  const payload: RecurringCancelProof = {
    v: 1, phone, subscriptionId,
    issuedAt,
    expiresAt: issuedAt + RECURRING_CANCEL_PROOF_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = hmacHash('waaiio:recurring-cancel:v1:' + encoded);
  return encoded + '.' + signature;
}

export function verifyRecurringCancellationProof(
  proof: unknown, phone: string, subscriptionId: string,
): boolean {
  if (typeof proof !== 'string' || proof.length > 1024) return false;
  const parts = proof.split('.');
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) ||
      !/^[a-f0-9]{64}$/.test(parts[1])) return false;

  const expected = hmacHash('waaiio:recurring-cancel:v1:' + parts[0]);
  if (!safeCompare(parts[1], expected)) return false;

  try {
    const decoded = Buffer.from(parts[0], 'base64url');
    if (decoded.toString('base64url') !== parts[0]) return false;
    const data = JSON.parse(decoded.toString('utf8')) as Partial<RecurringCancelProof>;
    const now = Date.now();
    return data.v === 1
      && data.phone === phone
      && data.subscriptionId === subscriptionId
      && Number.isSafeInteger(data.issuedAt)
      && Number.isSafeInteger(data.expiresAt)
      && (data.issuedAt as number) <= now
      && (data.expiresAt as number) > now
      && (data.expiresAt as number) - (data.issuedAt as number) === RECURRING_CANCEL_PROOF_TTL_MS;
  } catch {
    return false;
  }
}

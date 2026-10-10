/**
 * #591 Phase 2 — HMAC-signed one-time flow tokens.
 *
 * Binds a WhatsApp native form send to a specific recipient, form, and
 * business. The token is verified on nfm_reply to prevent forgery,
 * tampering, and replay attacks.
 *
 * Token format: base64url(payload) + '.' + base64url(hmac)
 * Payload: formId|phone|businessId|nonce|expiresAt
 */
import { createHmac, createHash, randomUUID } from 'crypto';

// ── Constants ──

/** Token time-to-live in milliseconds (30 minutes). */
const TOKEN_TTL_MS = 30 * 60 * 1000;

/** Separator between payload fields. Pipe is safe — never appears in UUIDs or E.164 phones. */
const FIELD_SEP = '|';

// ── Types ──

export interface FlowTokenResult {
  token: string;
  expiresAt: number; // Unix ms
}

export interface FlowTokenVerification {
  valid: boolean;
  nonce?: string;
  error?: string;
}

export class FlowTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlowTokenError';
  }
}

// ── Helpers ──

function getSecret(): string {
  const secret = process.env.FLOW_TOKEN_SECRET;
  if (!secret || secret.length < 32) {
    throw new FlowTokenError(
      'FLOW_TOKEN_SECRET must be set and at least 32 characters.',
    );
  }
  return secret;
}

function toBase64Url(buf: Buffer): string {
  return buf.toString('base64url');
}

function fromBase64Url(str: string): Buffer {
  return Buffer.from(str, 'base64url');
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

// ── Public API ──

/** Strip leading '+' to match Meta webhook msg.from format (digits only). */
export function normalizePhone(phone: string): string {
  return phone.startsWith('+') ? phone.slice(1) : phone;
}

/**
 * Generate a signed flow token binding a form to a specific recipient.
 *
 * @param formId - UUID of the form being sent
 * @param recipientPhone - E.164 phone number of the recipient
 * @param businessId - UUID of the owning business
 * @returns Signed token string and expiry timestamp
 */
export function generateFlowToken(
  formId: string,
  recipientPhone: string,
  businessId: string,
): FlowTokenResult {
  if (!formId || !recipientPhone || !businessId) {
    throw new FlowTokenError('formId, recipientPhone, and businessId are required.');
  }

  const secret = getSecret();
  const nonce = randomUUID();
  const expiresAt = Date.now() + TOKEN_TTL_MS;

  const normalizedPhone = normalizePhone(recipientPhone);
  const payload = [formId, normalizedPhone, businessId, nonce, String(expiresAt)].join(FIELD_SEP);
  const payloadB64 = toBase64Url(Buffer.from(payload, 'utf8'));
  const signature = sign(payload, secret);

  return {
    token: `${payloadB64}.${signature}`,
    expiresAt,
  };
}

/**
 * Verify a flow token's HMAC signature and binding claims.
 *
 * @param token - The full signed token string
 * @param formId - Expected form UUID
 * @param senderPhone - Phone from the webhook envelope (NOT from Flow payload)
 * @param businessId - Resolved business UUID (from channel, NOT from Flow payload)
 * @returns Verification result with nonce for replay-hash persistence
 */
export function verifyFlowToken(
  token: string,
  formId: string,
  senderPhone: string,
  businessId: string,
): FlowTokenVerification {
  if (!token || typeof token !== 'string') {
    return { valid: false, error: 'Missing or invalid token.' };
  }

  const dotIdx = token.indexOf('.');
  if (dotIdx < 1 || dotIdx === token.length - 1) {
    return { valid: false, error: 'Malformed token structure.' };
  }

  let secret: string;
  try {
    secret = getSecret();
  } catch {
    return { valid: false, error: 'Server token configuration error.' };
  }

  const payloadB64 = token.slice(0, dotIdx);
  const signatureB64 = token.slice(dotIdx + 1);

  // Decode payload
  let payload: string;
  try {
    payload = fromBase64Url(payloadB64).toString('utf8');
  } catch {
    return { valid: false, error: 'Invalid token encoding.' };
  }

  // Verify HMAC signature (constant-time via timingSafeEqual)
  const expectedSig = sign(payload, secret);
  const sigA = Buffer.from(signatureB64, 'base64url');
  const sigB = Buffer.from(expectedSig, 'base64url');

  if (sigA.length !== sigB.length) {
    return { valid: false, error: 'Invalid token signature.' };
  }

  // Use try-catch for timingSafeEqual in case of length mismatch edge cases
  let sigValid: boolean;
  try {
    const { timingSafeEqual } = require('crypto');
    sigValid = timingSafeEqual(sigA, sigB);
  } catch {
    sigValid = false;
  }

  if (!sigValid) {
    return { valid: false, error: 'Invalid token signature.' };
  }

  // Parse payload fields
  const parts = payload.split(FIELD_SEP);
  if (parts.length !== 5) {
    return { valid: false, error: 'Malformed token payload.' };
  }

  const [tokenFormId, tokenPhone, tokenBusinessId, nonce, expiresAtStr] = parts;
  const expiresAt = Number(expiresAtStr);

  // Check expiry
  if (isNaN(expiresAt) || Date.now() > expiresAt) {
    return { valid: false, error: 'Token has expired.' };
  }

  // Check binding claims
  if (tokenFormId !== formId) {
    return { valid: false, error: 'Token form mismatch.' };
  }
  if (tokenPhone !== normalizePhone(senderPhone)) {
    return { valid: false, error: 'Token phone mismatch.' };
  }
  if (tokenBusinessId !== businessId) {
    return { valid: false, error: 'Token business mismatch.' };
  }

  return { valid: true, nonce };
}

/**
 * Hash a flow token for database uniqueness constraint (replay prevention).
 * Uses SHA-256 to avoid storing the actual token in the database.
 */
export function hashFlowToken(token: string): string {
  if (!token) {
    throw new FlowTokenError('Token is required for hashing.');
  }
  return createHash('sha256').update(token).digest('hex');
}

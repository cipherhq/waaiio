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
  formVersionHash?: string;
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
 * The token embeds a SHA-256 hash of the form's effective configuration at
 * generation time, creating an immutable version binding. The hash covers
 * both the field schema (types, options, required flags) and the consent
 * configuration (settings.consent_label). At submission time the handler
 * recomputes the hash from the current DB state and rejects the submission
 * if the form was edited after delivery.
 *
 * @param formId - UUID of the form being sent
 * @param recipientPhone - E.164 phone number of the recipient
 * @param businessId - UUID of the owning business
 * @param formVersionHash - SHA-256 hex hash of the form's effective config at send time
 * @returns Signed token string and expiry timestamp
 */
export function generateFlowToken(
  formId: string,
  recipientPhone: string,
  businessId: string,
  formVersionHash: string,
): FlowTokenResult {
  if (!formId || !recipientPhone || !businessId) {
    throw new FlowTokenError('formId, recipientPhone, and businessId are required.');
  }
  if (!formVersionHash || formVersionHash.length !== 64) {
    throw new FlowTokenError('formVersionHash must be a 64-character SHA-256 hex string.');
  }

  const secret = getSecret();
  const nonce = randomUUID();
  const expiresAt = Date.now() + TOKEN_TTL_MS;

  const normalizedPhone = normalizePhone(recipientPhone);
  const payload = [formId, normalizedPhone, businessId, nonce, String(expiresAt), formVersionHash].join(FIELD_SEP);
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
  if (parts.length !== 6) {
    return { valid: false, error: 'Malformed token payload.' };
  }

  const [tokenFormId, tokenPhone, tokenBusinessId, nonce, expiresAtStr, formVersionHash] = parts;
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
  if (!formVersionHash || formVersionHash.length !== 64) {
    return { valid: false, error: 'Token missing schema version binding.' };
  }

  return { valid: true, nonce, formVersionHash };
}

/**
 * Hash a verified nonce for database uniqueness constraint (replay prevention).
 *
 * The replay identity is the nonce — an immutable UUID embedded in the signed
 * token payload — NOT the serialized token string. This ensures that equivalent
 * serializations (e.g. padding differences) cannot bypass the uniqueness check.
 * The nonce is only available after HMAC verification succeeds, so only
 * authentically issued tokens can occupy a replay slot.
 *
 * Uses SHA-256 to avoid storing the raw nonce in the database.
 */
export function hashNonceForReplay(nonce: string): string {
  if (!nonce) {
    throw new FlowTokenError('Verified nonce is required for replay hashing.');
  }
  return createHash('sha256').update(nonce).digest('hex');
}

/** Runtime v2 tokens bind the immutable provider publication and transport. */
export interface NativeTokenClaims {
  formId: string;
  businessId: string;
  publicationId: string;
  channelId: string;
  phoneNumberId: string;
  assetId: string;
  revision: string;
  phone: string;
  nonce: string;
  expiresAt: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validNativeClaims(c: NativeTokenClaims): boolean {
  return [c.formId, c.businessId, c.publicationId, c.channelId, c.nonce].every(v => UUID.test(v))
    && /^[1-9]\d{6,14}$/.test(c.phone) && /^\d{1,64}$/.test(c.phoneNumberId)
    && /^\d{1,64}$/.test(c.assetId) && /^[a-f0-9]{64}$/.test(c.revision)
    && Number.isSafeInteger(c.expiresAt);
}

export function generateNativeFlowToken(input: Omit<NativeTokenClaims, 'nonce' | 'expiresAt'>): FlowTokenResult {
  const claims: NativeTokenClaims = { ...input, phone: normalizePhone(input.phone), nonce: randomUUID(), expiresAt: Date.now() + TOKEN_TTL_MS };
  if (!validNativeClaims(claims)) throw new FlowTokenError('Invalid native publication binding.');
  const payload = `v2|${JSON.stringify(claims)}`;
  return { token: `${Buffer.from(payload).toString('base64url')}.${sign(payload, getSecret())}`, expiresAt: claims.expiresAt };
}

/** Authenticate BEFORE using a business claim on a shared transport. Legacy tokens fail closed. */
export function authenticateNativeFlowToken(token: unknown, senderPhone: string, channelId: string, phoneNumberId: string): NativeTokenClaims | null {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) return null;
  try {
    const payload = Buffer.from(parts[0], 'base64url').toString('utf8');
    if (!payload.startsWith('v2|')) return null;
    const a = Buffer.from(parts[1], 'base64url');
    const b = Buffer.from(sign(payload, getSecret()), 'base64url');
    const { timingSafeEqual } = require('crypto');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const c: NativeTokenClaims = JSON.parse(payload.slice(3));
    if (!c || !validNativeClaims(c) || c.expiresAt <= Date.now() || c.expiresAt > Date.now() + TOKEN_TTL_MS
      || c.phone !== normalizePhone(senderPhone) || c.channelId !== channelId || c.phoneNumberId !== phoneNumberId) return null;
    return c;
  } catch { return null; }
}

/** #1005 PR 3b: party RSVP form tokens (v3). Valid for 24 hours; bound to one invitation and transport. */
const PARTY_RSVP_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export interface PartyRsvpTokenClaims {
  inviteId: string;
  businessId: string;
  publicationId: string;
  channelId: string;
  phoneNumberId: string;
  assetId: string;
  questionRevision: number;
  phone: string;
  nonce: string;
  expiresAt: number;
}

function validPartyRsvpClaims(c: PartyRsvpTokenClaims): boolean {
  return [c.inviteId, c.businessId, c.publicationId, c.channelId, c.nonce].every(v => typeof v === 'string' && UUID.test(v))
    && typeof c.phone === 'string' && /^[1-9]\d{6,14}$/.test(c.phone)
    && typeof c.phoneNumberId === 'string' && /^\d{1,64}$/.test(c.phoneNumberId)
    && typeof c.assetId === 'string' && /^\d{1,64}$/.test(c.assetId)
    && Number.isSafeInteger(c.questionRevision) && c.questionRevision >= 0
    && Number.isSafeInteger(c.expiresAt);
}

export function generatePartyRsvpFlowToken(input: Omit<PartyRsvpTokenClaims, 'nonce' | 'expiresAt'>): FlowTokenResult {
  const claims: PartyRsvpTokenClaims = {
    ...input, phone: normalizePhone(input.phone), nonce: randomUUID(), expiresAt: Date.now() + PARTY_RSVP_TOKEN_TTL_MS,
  };
  if (!validPartyRsvpClaims(claims)) throw new FlowTokenError('Invalid party RSVP form binding.');
  const payload = `v3|${JSON.stringify(claims)}`;
  return { token: `${Buffer.from(payload).toString('base64url')}.${sign(payload, getSecret())}`, expiresAt: claims.expiresAt };
}

/** Authenticate before trusting any claim. Native form (v2) and legacy tokens fail closed. */
export function authenticatePartyRsvpFlowToken(token: unknown, senderPhone: string, channelId: string, phoneNumberId: string): PartyRsvpTokenClaims | null {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) return null;
  try {
    const payload = Buffer.from(parts[0], 'base64url').toString('utf8');
    if (!payload.startsWith('v3|')) return null;
    const a = Buffer.from(parts[1], 'base64url');
    const b = Buffer.from(sign(payload, getSecret()), 'base64url');
    const { timingSafeEqual } = require('crypto');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const c: PartyRsvpTokenClaims = JSON.parse(payload.slice(3));
    if (!c || typeof c !== 'object' || !validPartyRsvpClaims(c) || c.expiresAt <= Date.now()
      || c.expiresAt > Date.now() + PARTY_RSVP_TOKEN_TTL_MS
      || c.phone !== normalizePhone(senderPhone) || c.channelId !== channelId || c.phoneNumberId !== phoneNumberId) return null;
    return c;
  } catch { return null; }
}

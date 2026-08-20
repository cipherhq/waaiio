/**
 * Promo code cryptographic utilities.
 *
 * Uses HMAC-SHA256 for one-way hash lookup (primary code identification).
 * Uses existing Waaiio AES-256-GCM encryption for recoverable storage.
 *
 * Does NOT invent custom cryptography — reuses node:crypto and
 * existing encryption infrastructure.
 */
import { createHmac, randomBytes, randomInt } from 'crypto';
import { encryptToken, decryptToken } from '@/lib/encryption';

// HMAC key for code hashing — separate from encryption key
const PROMO_HMAC_KEY = process.env.PROMO_HMAC_KEY || process.env.TOKEN_ENCRYPTION_KEY || '';
const DEV_FALLBACK_KEY = 'dev-promo-key';

/**
 * Canonical HMAC key resolver — fail-closed in production.
 * Both hashPromoCode and hashPickupToken use this so security
 * semantics cannot diverge.
 */
function resolveHmacKey(): string {
  if (PROMO_HMAC_KEY) return PROMO_HMAC_KEY;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('PROMO_HMAC_KEY or TOKEN_ENCRYPTION_KEY must be configured in production');
  }
  return DEV_FALLBACK_KEY;
}

/**
 * Generate HMAC-SHA256 hash of a normalized promo code.
 * Used for indexed lookup — never store raw codes, always hash.
 */
export function hashPromoCode(normalizedCode: string): string {
  return createHmac('sha256', resolveHmacKey())
    .update(normalizedCode)
    .digest('hex');
}

/**
 * Encrypt a promo code for recoverable storage (export/recovery).
 * Uses existing Waaiio AES-256-GCM encryption.
 */
export function encryptPromoCode(normalizedCode: string): string {
  return encryptToken(normalizedCode);
}

/**
 * Decrypt a stored promo code.
 */
export function decryptPromoCode(encrypted: string): string {
  return decryptToken(encrypted);
}

// Alphabet split: letters + digits for guaranteed composition
const CODE_DIGITS = '234679';
const CODE_LETTERS = 'ACDEFGHJKMNPQRTUVWXYZ';
const CODE_ALPHABET = CODE_DIGITS + CODE_LETTERS; // 27 chars total

/**
 * Generate a single cryptographically secure random code.
 * Uses crypto.randomInt (rejection-sampled, no modulo bias).
 *
 * GUARANTEES at least one digit for bot routing compatibility.
 *
 * code_length = TOTAL length of the body (excluding prefix).
 * Total normalized code = prefix + body.
 */
export function generateSecureCode(bodyLength: number, prefix?: string): string {
  const chars: string[] = [];
  for (let i = 0; i < bodyLength; i++) {
    // randomInt is rejection-sampled — no modulo bias
    chars.push(CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)]);
  }

  // Guarantee at least one digit: if none present, replace a random position with a digit
  const hasDigit = chars.some(c => CODE_DIGITS.includes(c));
  if (!hasDigit && bodyLength > 0) {
    const pos = randomInt(0, bodyLength);
    chars[pos] = CODE_DIGITS[randomInt(0, CODE_DIGITS.length)];
  }

  const body = chars.join('');
  return prefix ? prefix + body : body;
}

/**
 * Generate a batch of unique codes with collision detection.
 * Bounded to chunk size — never holds the entire campaign.
 */
export function generateCodeBatch(
  count: number,
  bodyLength: number,
  prefix?: string,
): string[] {
  const seen = new Set<string>();
  const codes: string[] = [];
  let attempts = 0;
  const maxAttempts = count * 3;

  while (codes.length < count && attempts < maxAttempts) {
    const code = generateSecureCode(bodyLength, prefix);
    if (!seen.has(code)) {
      seen.add(code);
      codes.push(code);
    }
    attempts++;
  }

  return codes;
}

/**
 * Generate a human-readable claim reference with exactly 64 bits of entropy.
 * Format: WAA-XXXX-XXXX-XXXX-XXXX (16 uppercase hex chars from 8 random bytes)
 *
 * Old format: WAA-XXXXXX (6 hex chars from UUID = ~24 bits, 16.7M values)
 * New format: WAA-XXXX-XXXX-XXXX-XXXX (16 hex chars = exactly 64 bits)
 *
 * Uses crypto.randomBytes — no modulo bias, no alphabet mapping.
 */
export function generateClaimReference(): string {
  const hex = randomBytes(8).toString('hex').toUpperCase();
  return `WAA-${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`;
}

/**
 * Generate a 6-digit numeric OTP for secure pickup verification.
 * Uses crypto.randomInt (rejection-sampled, no modulo bias).
 */
export function generatePickupOtp(): string {
  return String(randomInt(100000, 999999));
}

/**
 * Generate HMAC for pickup verification token.
 * Domain-separated to prevent cross-use with code HMACs.
 *
 * Input: promo-pickup-v1 | business_id | redemption_id | phone_e164 | token
 *
 * A database leak cannot trivially enumerate 6-digit OTPs because the
 * HMAC key is not stored in the database.
 */
export function hashPickupToken(
  businessId: string,
  redemptionId: string,
  phoneE164: string,
  token: string,
): string {
  const input = `promo-pickup-v1|${businessId}|${redemptionId}|${phoneE164}|${token}`;
  return createHmac('sha256', resolveHmacKey()).update(input).digest('hex');
}

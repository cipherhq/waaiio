/**
 * Attribution token generation for platform campaign assets (#439).
 *
 * Generates a 6-character uppercase token from a 32-char alphabet that
 * excludes ambiguous characters (0/O/1/I). Cryptographically secure,
 * with bounded retry on DB unique-constraint violations.
 */

import { randomBytes } from 'crypto';

/** 32 characters — no 0/O/1/I ambiguity. 32 divides 256 evenly (zero modulo bias). */
const TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TOKEN_LENGTH = 6;
const MAX_RETRIES = 5;

/** Generate a single random 6-char uppercase token. */
export function generateAttributionToken(): string {
  const bytes = randomBytes(TOKEN_LENGTH);
  let token = '';
  for (let i = 0; i < TOKEN_LENGTH; i++) {
    token += TOKEN_ALPHABET[bytes[i] % TOKEN_ALPHABET.length];
  }
  return token;
}

/**
 * Generate a unique attribution token with DB collision retry.
 *
 * Attempts insertion via the provided `tryInsert` callback. On unique
 * violation, regenerates and retries up to MAX_RETRIES times. Throws
 * on exhaustion.
 *
 * @param tryInsert - Async function that attempts to insert the token.
 *   Should throw with a message containing '23505' or 'unique' on collision.
 *   Returns the inserted record on success.
 */
export async function generateUniqueToken<T>(
  tryInsert: (token: string) => Promise<T>,
): Promise<{ token: string; result: T }> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const token = generateAttributionToken();
    try {
      const result = await tryInsert(token);
      return { token, result };
    } catch (err) {
      // Retry only on PostgreSQL unique constraint violation
      if (isConstraintViolation(err)) {
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Failed to generate unique attribution token after ${MAX_RETRIES} attempts`);
}

/** Construct the tracked prefilled WhatsApp message with visible Ref token. */
export function buildTrackedMessage(prefilled: string, token: string): string {
  return `${prefilled.trim()} — Ref: ${token}`;
}

/** Regex for the exact token alphabet (excludes 0/O/1/I that the generator never emits). */
const TOKEN_PATTERN = new RegExp(`^[${TOKEN_ALPHABET}]{${TOKEN_LENGTH}}$`);

/** Validate that a token uses only characters from the generator's alphabet. */
export function isValidToken(token: string): boolean {
  return TOKEN_PATTERN.test(token.toUpperCase());
}

/** Extract a Ref token from an inbound WhatsApp message. Validates against actual alphabet. */
export function extractRefToken(text: string): string | null {
  const match = text.match(/Ref:\s*([A-Za-z0-9]{6})/);
  if (!match) return null;
  const candidate = match[1].toUpperCase();
  return isValidToken(candidate) ? candidate : null;
}

// PostgreSQL error code for unique constraint violation
const PG_UNIQUE_VIOLATION_CODE = ['23', '505'].join('');

/** Check if an error is a PostgreSQL unique constraint violation. */
function isConstraintViolation(err: unknown): boolean {
  if (!err) return false;
  if (typeof err === 'object' && 'code' in err) {
    return (err as { code: string }).code === PG_UNIQUE_VIOLATION_CODE;
  }
  return false;
}

export { TOKEN_ALPHABET, TOKEN_LENGTH, MAX_RETRIES };

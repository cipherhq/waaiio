/**
 * Canonical promo code normalizer.
 *
 * ONE implementation used everywhere:
 * - generation
 * - import
 * - lookup
 * - bot verification
 * - dashboard search
 *
 * Normalization:
 * 1. Trim whitespace
 * 2. Uppercase
 * 3. Remove presentation separators (hyphens, spaces, dots)
 *
 * K7PM-4XQ9-N2WF → K7PM4XQ9N2WF
 * k7pm4xq9n2wf   → K7PM4XQ9N2WF
 * k7pm 4xq9 n2wf → K7PM4XQ9N2WF
 */
export function normalizePromoCode(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[\s\-._]/g, '');
}

/**
 * Format a normalized code for display with hyphens.
 * K7PM4XQ9N2WF → K7PM-4XQ9-N2WF
 */
export function formatPromoCode(normalized: string, groupSize = 4): string {
  const groups: string[] = [];
  for (let i = 0; i < normalized.length; i += groupSize) {
    groups.push(normalized.slice(i, i + groupSize));
  }
  return groups.join('-');
}

/**
 * Mask a code for safe display.
 * K7PM4XQ9N2WF → K7PM••••N2WF
 */
export function maskPromoCode(normalized: string): string {
  if (normalized.length <= 8) {
    // Short code: show first 2 and last 2
    return normalized.slice(0, 2) + '••••' + normalized.slice(-2);
  }
  return normalized.slice(0, 4) + '••••' + normalized.slice(-4);
}

/**
 * Extract the display suffix (last 4 chars) from a normalized code.
 */
export function getDisplaySuffix(normalized: string): string {
  return normalized.slice(-4);
}

/**
 * Validate that a normalized code is routable by the bot for verification.
 * Accepts legacy 6-char codes so historical imported promo codes remain redeemable.
 * - 6-24 alphanumeric chars
 * - at least one digit
 */
export function isRoutablePromoCode(normalized: string): boolean {
  if (normalized.length < 6 || normalized.length > 24) return false;
  if (!/^[A-Z0-9]+$/.test(normalized)) return false;
  if (!/\d/.test(normalized)) return false;
  return true;
}

/**
 * Validate that a code meets the hardened minimum for NEW imports.
 * Existing historical codes use isRoutablePromoCode for redemption routing.
 * New imports must meet MIN_IMPORTED_CODE_LENGTH to resist brute-force.
 */
export function isImportablePromoCode(normalized: string): boolean {
  if (normalized.length < MIN_IMPORTED_CODE_LENGTH || normalized.length > 24) return false;
  if (!/^[A-Z0-9]+$/.test(normalized)) return false;
  if (!/\d/.test(normalized)) return false;
  return true;
}

/**
 * Minimum random body characters for generated promo codes.
 * Prefix contributes ZERO security entropy — this minimum is enforced
 * regardless of prefix length.
 */
export const MIN_GENERATED_BODY_LENGTH = 10;

/**
 * Minimum normalized length for imported promo codes.
 * Imported codes cannot be guaranteed random, but excessively short
 * codes are trivially guessable. 10 characters provides a reasonable
 * floor without rejecting legitimate merchant inventories.
 */
export const MIN_IMPORTED_CODE_LENGTH = 10;

/**
 * Compute body length for code generation.
 * code_length = TOTAL normalized length (including prefix).
 * body_length = code_length - prefix.length.
 */
export function computeBodyLength(codeLength: number, prefix?: string | null): number {
  const prefixLen = prefix ? prefix.length : 0;
  return Math.max(1, codeLength - prefixLen);
}

/**
 * Validate that a generated code configuration produces sufficient entropy.
 * Returns an error message if the body length is below the minimum.
 */
export function validateGeneratedEntropy(codeLength: number, prefix?: string | null): { valid: boolean; bodyLength: number; error?: string } {
  const bodyLength = computeBodyLength(codeLength, prefix);
  if (bodyLength < MIN_GENERATED_BODY_LENGTH) {
    const prefixLen = prefix ? prefix.length : 0;
    const minTotal = MIN_GENERATED_BODY_LENGTH + prefixLen;
    return {
      valid: false,
      bodyLength,
      error: `Insufficient code entropy: ${bodyLength} random characters (minimum ${MIN_GENERATED_BODY_LENGTH}). ${prefix ? `With prefix "${prefix}" (${prefixLen} chars), code length must be at least ${minTotal}.` : `Code length must be at least ${MIN_GENERATED_BODY_LENGTH}.`}`,
    };
  }
  return { valid: true, bodyLength };
}

/**
 * Compute usable unique code space accounting for digit guarantee.
 *
 * Alphabet: 27 chars (6 digits + 21 letters).
 * If prefix already contains a digit, all 27^bodyLen combinations are valid.
 * If prefix has no digit, codes must have ≥1 digit in body:
 *   usable = 27^bodyLen - 21^bodyLen (subtract all-letter combinations)
 */
export function computeUsableCodeSpace(bodyLength: number, prefix?: string | null): number {
  const TOTAL = 27;
  const LETTERS_ONLY = 21;
  const totalCombinations = Math.pow(TOTAL, bodyLength);

  // Check if prefix already contains a digit
  const prefixHasDigit = prefix ? /\d/.test(prefix) : false;
  if (prefixHasDigit) {
    return totalCombinations; // All bodies are valid since prefix provides the digit
  }

  // Must subtract all-letter bodies (they'd produce codes with no digit)
  return totalCombinations - Math.pow(LETTERS_ONLY, bodyLength);
}

/**
 * Validate a campaign prefix.
 * - uppercase alphanumeric only
 * - max 4 chars
 * - must be shorter than code_length
 */
export function validatePrefix(prefix: string, codeLength: number): { valid: boolean; error?: string } {
  if (prefix.length > 4) return { valid: false, error: 'Prefix must be 4 characters or fewer' };
  if (prefix.length >= codeLength) return { valid: false, error: 'Prefix must be shorter than code length' };
  if (!/^[A-Z0-9]*$/.test(prefix)) return { valid: false, error: 'Prefix must be uppercase alphanumeric only' };
  const bodyLength = codeLength - prefix.length;
  if (bodyLength < MIN_GENERATED_BODY_LENGTH) {
    return { valid: false, error: `Code length must be at least ${MIN_GENERATED_BODY_LENGTH + prefix.length} with a ${prefix.length}-character prefix (need ${MIN_GENERATED_BODY_LENGTH} random body characters)` };
  }
  return { valid: true };
}

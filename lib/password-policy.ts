/**
 * New-password rule for merchant accounts (#1175 F6, F7, Q2 A).
 *
 * Every place where a merchant chooses a new password uses this file, so the
 * minimum and the wording stay the same everywhere. It has no server-only
 * imports and is safe in the browser.
 *
 * - Waaiio checks the length itself.
 * - Passwords known from public breach lists are refused by Supabase once the
 *   Owner turns that setting on (#1175 §3.1 step 8). Waaiio turns Supabase's
 *   refusal into plain words (W4) here.
 * - Existing passwords are never re-checked: sign-in is not affected (F7).
 */

export const PASSWORD_MIN_LENGTH = 8;

/** W3: the password rule, shown before the merchant types and on refusal. */
export const PASSWORD_RULE_TEXT = 'Use at least 8 characters.';

/** W4: a password known from breach lists was refused. */
export const PASSWORD_BREACHED_TEXT =
  "This password has appeared in a data breach elsewhere, so it isn't safe. Please choose a different one.";

/** Returns W3 when the new password is too short, otherwise null. */
export function newPasswordProblem(password: string): string | null {
  return password.length < PASSWORD_MIN_LENGTH ? PASSWORD_RULE_TEXT : null;
}

interface MaybeAuthError {
  name?: unknown;
  code?: unknown;
  message?: unknown;
  reasons?: unknown;
}

/** True when Supabase refused the password itself (too short, breach list). */
export function isWeakPasswordError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as MaybeAuthError;
  return e.code === 'weak_password' || e.name === 'AuthWeakPasswordError';
}

/**
 * Plain words for Supabase's password refusal: W4 for a breach-list refusal,
 * W3 for any other weak-password reason. Returns null when the error is not a
 * password refusal, so callers keep their existing message for other errors.
 */
export function weakPasswordMessage(error: unknown): string | null {
  if (!isWeakPasswordError(error)) return null;
  const reasons = (error as MaybeAuthError).reasons;
  if (Array.isArray(reasons) && reasons.includes('pwned')) return PASSWORD_BREACHED_TEXT;
  if (Array.isArray(reasons) && reasons.length > 0) return PASSWORD_RULE_TEXT;
  // No reasons given: say breach only if Supabase's message says so.
  const message = String((error as MaybeAuthError).message ?? '').toLowerCase();
  if (message.includes('pwned') || message.includes('breach') || message.includes('leak')) return PASSWORD_BREACHED_TEXT;
  return PASSWORD_RULE_TEXT;
}

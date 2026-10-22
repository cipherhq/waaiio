/**
 * Sanitize a value before interpolating it into a Supabase `.or()` filter string.
 *
 * Supabase PostgREST `.or()` accepts a comma-separated string of conditions.
 * If user-supplied values contain `,`, `(`, or `)`, an attacker can inject
 * additional filter conditions (e.g. `phone.eq.+1234),email.eq.admin@evil.com`).
 *
 * This function strips those characters so the value is safe to interpolate.
 */
export function sanitizeFilterValue(value: string): string {
  return value.replace(/[,()]/g, '');
}

/**
 * Sanitize user search input for use in a PostgREST `.or()` ILIKE filter.
 *
 * Composes two protections in order:
 * 1. Escape ILIKE wildcards (`%` → `\%`, `_` → `\_`) so they match literally.
 * 2. Strip PostgREST filter delimiters (`,`, `(`, `)`) via `sanitizeFilterValue`.
 *
 * Returns the sanitized string ready for interpolation into `.or()` ILIKE conditions.
 * Returns empty string for whitespace-only input.
 */
export function sanitizeIlikeSearch(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  return sanitizeFilterValue(trimmed.replace(/[%_]/g, '\\$&'));
}

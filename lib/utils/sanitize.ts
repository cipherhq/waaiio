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

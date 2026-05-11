/**
 * Sanitize a value before interpolating it into a Supabase `.or()` filter string.
 *
 * Strips `,`, `(`, `)` to prevent PostgREST filter injection.
 */
export function sanitizeFilterValue(value: string): string {
  return value.replace(/[,()]/g, '');
}

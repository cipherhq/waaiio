/**
 * Narrow error classifier for Migration 199 toggle columns.
 *
 * Returns true ONLY when the error indicates that `allow_after_end_date`
 * or `allow_after_goal_met` is missing from the campaigns table.
 *
 * Does NOT match:
 * - unrelated missing columns (e.g. some_other_col)
 * - authentication errors (42501)
 * - RLS / JWT errors (PGRST301)
 * - network or connection errors
 * - malformed query errors
 */
export function isToggleColumnMissing(error: { code?: string; message?: string } | null): boolean {
  if (!error || !error.code) return false;
  // PostgreSQL 42703 = undefined_column; PGRST204 = PostgREST column-not-found
  if (error.code !== '42703' && error.code !== 'PGRST204') return false;
  const msg = (error.message || '').toLowerCase();
  return msg.includes('allow_after_end_date') || msg.includes('allow_after_goal_met');
}

/**
 * Platform Campaigns — canonical validation for create/update.
 *
 * Shared between POST and PUT route handlers.
 * All invalid inputs produce explicit 400 errors rather than falling through to Postgres.
 */

/**
 * Validate an ISO date string is actually parseable.
 * Returns null if valid, error message string if invalid.
 */
export function validateISODate(value: unknown, fieldName: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return `${fieldName} must be a string`;
  const d = new Date(value);
  if (isNaN(d.getTime())) return `${fieldName} is not a valid date`;
  return null;
}

/**
 * Validate date ordering: starts_at < ends_at.
 * `submitted` contains values from the current request body.
 * `existing` contains stored values from the DB (for partial updates).
 */
export function validateDateOrdering(
  submitted: { starts_at?: unknown; ends_at?: unknown },
  existing?: { starts_at?: string | null; ends_at?: string | null },
): string | null {
  // Resolve effective values: submitted overrides existing
  const effectiveStartsAt = submitted.starts_at !== undefined
    ? (submitted.starts_at as string | null)
    : (existing?.starts_at ?? null);
  const effectiveEndsAt = submitted.ends_at !== undefined
    ? (submitted.ends_at as string | null)
    : (existing?.ends_at ?? null);

  if (!effectiveStartsAt || !effectiveEndsAt) return null;

  const start = new Date(effectiveStartsAt);
  const end = new Date(effectiveEndsAt);

  // If either is unparseable, the individual validators above already catch it
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return null;

  if (start >= end) return 'starts_at must be before ends_at';
  return null;
}

/**
 * Validate and normalize market_scope.
 * Returns { normalized, error } — one will always be null.
 */
export function validateMarketScope(
  value: unknown,
): { normalized: string[] | null; error: string | null } {
  if (value === undefined) return { normalized: null, error: null };

  if (!Array.isArray(value)) {
    return { normalized: null, error: 'market_scope must be an array' };
  }

  const codes: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (typeof item !== 'string' || !item.trim()) {
      return { normalized: null, error: `market_scope[${i}] must be a non-empty string` };
    }
    codes.push(item.trim().toUpperCase());
  }

  // Remove duplicates
  const unique = [...new Set(codes)];
  return { normalized: unique, error: null };
}

/**
 * Validate source_label: must be null, or a non-empty string <= 200 chars.
 */
export function validateSourceLabel(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return 'source_label must be a string or null';
  if (value.length > 200) return 'source_label must be 200 characters or fewer';
  return null;
}

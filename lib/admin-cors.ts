/**
 * Shared Admin API CORS helper.
 *
 * Single source of truth for the admin-origin allowlist.
 * Mirrors the middleware allowlist and fails closed for unknown origins.
 */

/** Canonical admin-origin allowlist — matches middleware.ts. */
export function getAdminAllowedOrigins(): string[] {
  return [
    process.env.ADMIN_ORIGIN || 'https://admin.waaiio.com',
    'https://admin.waaiio.com',
    'https://admin-staging.waaiio.com',
    'http://localhost:8083',
  ];
}

/**
 * Resolve the Access-Control-Allow-Origin value for an admin API response.
 *
 * Returns the matched origin (echo-back) when it appears in the allowlist,
 * or an empty string when the origin is unsupported. An empty string causes
 * the browser to block the cross-origin response — fail-closed behaviour.
 */
export function resolveAdminOrigin(origin: string | null | undefined): string {
  if (!origin) return '';
  const allowed = getAdminAllowedOrigins();
  return allowed.includes(origin) ? origin : '';
}

/**
 * Build CORS response headers for an Admin API route.
 *
 * @param origin - The request Origin header value.
 * @param methods - Allowed HTTP methods for this route (default: POST, OPTIONS).
 */
export function adminCorsHeaders(
  origin: string | null | undefined,
  methods = 'POST, OPTIONS',
): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': resolveAdminOrigin(origin),
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

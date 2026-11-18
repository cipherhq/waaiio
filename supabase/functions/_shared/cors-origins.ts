/**
 * Browser origins allowed to call Waaiio edge functions.
 *
 * Runtime-neutral (no Deno-specific imports) so Vitest can load it. The admin
 * entries mirror getAdminAllowedOrigins() in lib/admin-cors.ts; keep the two
 * lists in step.
 */
export function edgeAllowedOrigins(appUrl?: string | null): string[] {
  return [
    appUrl || 'https://www.waaiio.com',
    'https://www.waaiio.com',
    'https://waaiio.com',
    'https://admin.waaiio.com',
    'https://admin-staging.waaiio.com',
  ];
}

/**
 * The Access-Control-Allow-Origin value for a request: the request's own
 * origin when it is allowed, otherwise '' so the browser blocks the response
 * (fail closed, never a fallback origin).
 */
export function resolveEdgeOrigin(origin: string | null | undefined, allowed: string[]): string {
  return origin && allowed.includes(origin) ? origin : '';
}

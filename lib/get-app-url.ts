/**
 * Safe application URL resolution.
 *
 * Returns a validated, normalized base URL for the current deployment.
 * Handles trailing newlines from misconfigured env vars, Preview
 * deployments, and falls back to the production URL.
 *
 * For server-side use only (API routes, middleware, server components).
 */

/**
 * Validate and normalize a candidate URL string.
 * Returns the origin (scheme + host) or null if invalid.
 *
 * Rejects:
 * - embedded CR/LF characters (after trim)
 * - non-https schemes (except http://localhost in development)
 * - credentials in the URL
 * - query strings, fragments, or non-URL input
 */
function validateOrigin(raw: string | undefined, allowLocalhost = false): string | null {
  if (!raw || typeof raw !== 'string') return null;

  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Reject embedded CR/LF after trimming
  if (/[\r\n]/.test(trimmed)) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  // Reject non-http(s) schemes (blocks javascript:, data:, file:, etc.)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;

  // Require https outside localhost
  if (parsed.protocol === 'http:' && !allowLocalhost) return null;
  if (parsed.protocol === 'http:' && allowLocalhost) {
    if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') return null;
  }

  // Reject credentials in URL
  if (parsed.username || parsed.password) return null;

  return parsed.origin;
}

/**
 * Get the application base URL for the current deployment.
 *
 * Priority:
 * 1. NEXT_PUBLIC_APP_URL (trimmed, validated)
 * 2. In Preview: Vercel system VERCEL_BRANCH_URL (runtime, not user-set)
 * 3. In Preview: Vercel system VERCEL_URL (runtime, not user-set)
 * 4. Fallback: https://www.waaiio.com
 */
export function getAppUrl(): string {
  // Primary: configured URL (trimmed to handle newline contamination)
  const configured = validateOrigin(process.env.NEXT_PUBLIC_APP_URL);
  if (configured) return configured;

  // Preview fallback: Vercel system vars (runtime, no NEXT_PUBLIC_ prefix)
  if (process.env.VERCEL_ENV === 'preview') {
    const branchUrl = process.env.VERCEL_BRANCH_URL;
    if (branchUrl) {
      const validated = validateOrigin(`https://${branchUrl}`);
      if (validated) return validated;
    }
    const vercelUrl = process.env.VERCEL_URL;
    if (vercelUrl) {
      const validated = validateOrigin(`https://${vercelUrl}`);
      if (validated) return validated;
    }
  }

  return 'https://www.waaiio.com';
}

/**
 * Build the CSRF allowed-origins list for the current deployment.
 *
 * Includes:
 * - The configured app origin (validated)
 * - www/non-www variant of the app origin
 * - In Preview: Vercel system branch URL and deployment URL
 * - Admin origins (configured and hardcoded)
 * - localhost origins (development only)
 *
 * Does NOT include arbitrary *.vercel.app origins.
 */
export function getCsrfAllowedOrigins(): string[] {
  const origins: string[] = [];

  // Configured app URL
  const appOrigin = validateOrigin(process.env.NEXT_PUBLIC_APP_URL);
  if (appOrigin) {
    origins.push(appOrigin);
    // www/non-www variant
    if (appOrigin.includes('www.')) {
      origins.push(appOrigin.replace('www.', ''));
    } else if (appOrigin.includes('://') && !appOrigin.includes('localhost')) {
      origins.push(appOrigin.replace('://', '://www.'));
    }
  }

  // Preview: add Vercel system-provided origins (not user-configurable)
  if (process.env.VERCEL_ENV === 'preview') {
    const branchUrl = process.env.VERCEL_BRANCH_URL;
    if (branchUrl) {
      const validated = validateOrigin(`https://${branchUrl}`);
      if (validated) origins.push(validated);
    }
    const vercelUrl = process.env.VERCEL_URL;
    if (vercelUrl) {
      const validated = validateOrigin(`https://${vercelUrl}`);
      if (validated) origins.push(validated);
    }
  }

  // Admin origins
  const adminOrigin = process.env.ADMIN_ORIGIN;
  if (adminOrigin) {
    const validated = validateOrigin(adminOrigin);
    if (validated) origins.push(validated);
  }
  origins.push('https://admin.waaiio.com');
  origins.push('https://admin-staging.waaiio.com');

  // Development
  origins.push('http://localhost:3000');
  origins.push('http://localhost:8083');

  // Deduplicate
  return [...new Set(origins)];
}

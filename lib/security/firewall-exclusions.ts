/**
 * Planned Vercel firewall paths for #1175 F15 / S10 (Owner step 9 and 10).
 *
 * This file is the reference the rollout runbook copies into the Vercel
 * dashboard. The code does not apply any firewall rule itself. The catalog
 * test (lib/__tests__/firewall-exclusions-list.test.ts) checks this list
 * against the real app/api routes, so a new webhook, callback, cron or
 * WhatsApp route cannot be left out of the exclusions unnoticed.
 */

/** Main-site paths that get the sign-in limits and the bot challenge (Q6 A). */
export const FIREWALL_SIGNIN_CODE_PATHS = [
  '/api/auth/otp/send',
  '/api/auth/otp/verify',
  '/api/auth/sign-in', // added by a later #1175 slice
] as const;

/** Main-site sign-in pages: the looser page limit and the bot challenge. */
export const FIREWALL_SIGNIN_PAGES = [
  '/login',
  '/get-started',
  '/forgot-password',
  '/reset-password',
  '/activate',
  '/dashboard/claim-credit',
] as const;

/**
 * Paths no firewall rule may limit or challenge (S10). Patterns are anchored
 * regular expressions on the request path.
 */
export const FIREWALL_EXCLUDED_PATTERNS: readonly RegExp[] = [
  /^\/api\/webhook(s)?(\/|$)/,              // all webhook routes, nested included
  /^\/api\/payments\/.*webhook/,            // payment webhooks (stripe, paypal, square, byo)
  /^\/api\/payments\/webhook(\/|$)/,
  /^\/api\/[^?]*callback(\/|$)/,            // provider return and callback routes
  /^\/api\/whatsapp(\/|$)/,                 // WhatsApp, including the Flow callback
  /^\/api\/cron(\/|$)/,
  /^\/api\/health(\/|$)/,
  /^\/payment-success(\/|$)/,              // payment provider return page
];

/**
 * The admin site's calls to the main site are excluded by origin, not path:
 * requests whose Origin is an allow-listed admin origin (lib/admin-cors.ts)
 * skip the main-site limits, except the sign-in route, which counts under
 * the sign-in code limit (S10).
 */
export const FIREWALL_ADMIN_ORIGIN_EXCLUSION = 'admin origins from lib/admin-cors.ts, except /api/auth/sign-in';

export function isFirewallExcluded(path: string): boolean {
  return FIREWALL_EXCLUDED_PATTERNS.some((re) => re.test(path));
}

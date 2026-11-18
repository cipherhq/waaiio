/**
 * Which "View Dashboard" links the admin console may open.
 *
 * The impersonate API returns `${NEXT_PUBLIC_APP_URL}/dashboard/impersonate?token=…`,
 * so production gives waaiio.com and staging gives staging.waaiio.com. Only
 * those exact app origins (plus this console's own origin, kept for local
 * use) and only the impersonate path are accepted. A prefix check would let
 * a look-alike host such as https://waaiio.com.evil.example through.
 */
const APP_ORIGINS = [
  'https://waaiio.com',
  'https://www.waaiio.com',
  'https://staging.waaiio.com',
];

export function isAllowedImpersonationUrl(url: unknown, currentOrigin: string): boolean {
  if (typeof url !== 'string') return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const originAllowed = APP_ORIGINS.includes(parsed.origin) || parsed.origin === currentOrigin;
  return originAllowed && parsed.pathname === '/dashboard/impersonate';
}

import { logger } from '@/lib/logger';

/**
 * Cloudflare Turnstile bot check, verified on the server.
 *
 * Fails closed: only a clear `success: true` from Cloudflare's siteverify counts
 * as a pass. A missing or bad token, an unreachable siteverify, or a missing
 * secret in production all refuse the request.
 *
 * Keys come from env vars only:
 * - NEXT_PUBLIC_TURNSTILE_SITE_KEY (browser widget)
 * - TURNSTILE_SECRET_KEY (server only, never sent to the browser)
 *
 * Outside production (local dev, tests) a missing secret falls back to
 * Cloudflare's documented always-pass test secret, so the form works locally
 * without real keys. Vercel production and preview builds run with
 * NODE_ENV=production, so they never use the test secret.
 */

export const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Cloudflare's documented test secret that always passes. Not a real secret. */
export const TURNSTILE_TEST_SECRET_KEY = '1x0000000000000000000000000000000AA';

/** Cloudflare caps token length at 2048 characters. */
const MAX_TOKEN_LENGTH = 2048;

export type TurnstileResult =
  | { ok: true }
  | { ok: false; status: 403 | 503; error: string };

function resolveSecret(opts?: { secret: string | undefined }): string | null {
  // When opts is given, only opts.secret is used: an unset sign-in secret
  // never falls back to the public-forms secret.
  const secret = (opts ? opts.secret : process.env.TURNSTILE_SECRET_KEY)?.trim();
  if (secret) return secret;
  if (process.env.NODE_ENV !== 'production') return TURNSTILE_TEST_SECRET_KEY;
  return null;
}

/**
 * @param opts optional `{ secret }` for a different widget (the sign-in
 *   widget, #1175 S5). When given, only that secret is used, even if it is
 *   unset. When omitted, TURNSTILE_SECRET_KEY is used, so public forms and
 *   demo-request are unchanged.
 */
export async function verifyTurnstileToken(token: unknown, opts?: { secret: string | undefined }): Promise<TurnstileResult> {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, status: 403, error: 'Please complete the security check and try again.' };
  }

  const secret = resolveSecret(opts);
  if (!secret) {
    logger.error('[TURNSTILE] Turnstile secret is not set; refusing submission');
    return { ok: false, status: 503, error: 'This form cannot accept responses right now. Please try again later.' };
  }

  try {
    const res = await fetch(TURNSTILE_SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, response: token }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      logger.warn('[TURNSTILE] siteverify returned HTTP', res.status);
      return { ok: false, status: 503, error: 'We could not check your submission. Please try again.' };
    }
    const result = (await res.json()) as { success?: unknown; 'error-codes'?: unknown };
    if (result?.success === true) return { ok: true };
    logger.warn('[TURNSTILE] token rejected', result?.['error-codes']);
    return { ok: false, status: 403, error: 'Security check failed. Please try again.' };
  } catch (err) {
    logger.warn('[TURNSTILE] siteverify unreachable:', (err as Error).message);
    return { ok: false, status: 503, error: 'We could not check your submission. Please try again.' };
  }
}

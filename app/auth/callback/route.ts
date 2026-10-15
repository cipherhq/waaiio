import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * GET /auth/callback
 *
 * Handles Supabase Auth email-confirmation and password-reset callbacks.
 * Accepts PKCE `code` or `token_hash + type` from the confirmation link.
 *
 * On success: exchanges for a session and redirects to the safe `next` path.
 * On failure: redirects to /login with a user-friendly error message.
 *
 * Open-redirect protection: `next` must be a relative path (starts with '/'
 * and NOT '//'); otherwise it falls back to '/get-started'.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const token_hash = searchParams.get('token_hash');
  const type = searchParams.get('type') as 'signup' | 'email' | 'recovery' | 'invite' | 'magiclink' | undefined;
  const rawNext = searchParams.get('next') || '/get-started';
  // Prevent open redirect — only allow relative paths, not protocol-relative or absolute URLs
  const next = (rawNext.startsWith('/') && !rawNext.startsWith('//')) ? rawNext : '/get-started';

  const supabase = await createClient();

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      return NextResponse.redirect(
        new URL(`/login?error=${encodeURIComponent('Your confirmation link is invalid or has expired. Please try signing up again or request a new link.')}`, request.url),
      );
    }
  } else if (token_hash && type) {
    const { error } = await supabase.auth.verifyOtp({ token_hash, type });
    if (error) {
      return NextResponse.redirect(
        new URL(`/login?error=${encodeURIComponent('Your confirmation link is invalid or has expired. Please try signing up again or request a new link.')}`, request.url),
      );
    }
  } else {
    // No code or token_hash — cannot verify anything
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent('Invalid confirmation link. Please check your email for the correct link or request a new one.')}`, request.url),
    );
  }

  // Success — session is established, redirect to allowed destination
  return NextResponse.redirect(new URL(next, request.url));
}

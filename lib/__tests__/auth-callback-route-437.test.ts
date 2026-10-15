/**
 * Auth callback — executable route-level tests (#437)
 *
 * Imports and invokes the real GET() handler from app/auth/callback/route.ts
 * with mocked Supabase auth behaviour. Does NOT duplicate route logic.
 *
 * Proves:
 * 1. code exchange success → exchangeCodeForSession called → redirect to /get-started
 * 2. code exchange error → redirect to /login?error=... (never to success path)
 * 3. token_hash + type=signup success → verifyOtp called with exact values → redirect
 * 4. token_hash verification error → error redirect
 * 5. no code / incomplete token → error redirect, no auth method called
 * 6. unsafe absolute/protocol-relative next → /get-started fallback (real route)
 * 7. safe alternate relative next remains allowed
 * 8. session/cookie limitation documented
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockExchangeCodeForSession = vi.fn();
const mockVerifyOtp = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve({
    auth: {
      exchangeCodeForSession: mockExchangeCodeForSession,
      verifyOtp: mockVerifyOtp,
    },
  }),
}));

// Import the real route handler AFTER mocks are in place
const { GET } = await import('@/app/auth/callback/route');

function makeRequest(params: Record<string, string>): NextRequest {
  const url = new URL('https://staging.waaiio.com/auth/callback');
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return new NextRequest(url);
}

function redirectUrl(response: Response): URL {
  const location = response.headers.get('location');
  if (!location) throw new Error('No Location header on redirect response');
  return new URL(location);
}

describe('Auth callback GET() — executable route tests (#437)', () => {
  beforeEach(() => {
    mockExchangeCodeForSession.mockReset();
    mockVerifyOtp.mockReset();
  });

  // ── 1. Code exchange success ──

  it('successful code exchange calls exchangeCodeForSession once and redirects to /get-started', async () => {
    mockExchangeCodeForSession.mockResolvedValue({ data: { session: {} }, error: null });

    const res = await GET(makeRequest({ code: 'pkce-abc-123', next: '/get-started' }));
    const dest = redirectUrl(res);

    expect(mockExchangeCodeForSession).toHaveBeenCalledOnce();
    expect(mockExchangeCodeForSession).toHaveBeenCalledWith('pkce-abc-123');
    expect(dest.pathname).toBe('/get-started');
    expect(dest.searchParams.has('error')).toBe(false);
    expect(mockVerifyOtp).not.toHaveBeenCalled();
  });

  // ── 2. Code exchange error ──

  it('failed code exchange redirects to /login?error and never to the success path', async () => {
    mockExchangeCodeForSession.mockResolvedValue({
      data: { session: null },
      error: { message: 'Invalid code or expired', status: 400 },
    });

    const res = await GET(makeRequest({ code: 'expired-code', next: '/get-started' }));
    const dest = redirectUrl(res);

    expect(dest.pathname).toBe('/login');
    expect(dest.searchParams.get('error')).toContain('invalid or has expired');
    // Must NOT redirect to /get-started
    expect(dest.pathname).not.toBe('/get-started');
  });

  // ── 3. token_hash + type=signup success ──

  it('successful verifyOtp with token_hash + type=signup redirects to safe next', async () => {
    mockVerifyOtp.mockResolvedValue({ data: { session: {} }, error: null });

    const res = await GET(makeRequest({
      token_hash: 'hash-abc-456',
      type: 'signup',
      next: '/get-started',
    }));
    const dest = redirectUrl(res);

    expect(mockVerifyOtp).toHaveBeenCalledOnce();
    expect(mockVerifyOtp).toHaveBeenCalledWith({ token_hash: 'hash-abc-456', type: 'signup' });
    expect(dest.pathname).toBe('/get-started');
    expect(dest.searchParams.has('error')).toBe(false);
    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
  });

  // ── 4. token_hash verification error ──

  it('failed verifyOtp redirects to /login?error', async () => {
    mockVerifyOtp.mockResolvedValue({
      data: { session: null },
      error: { message: 'Token has expired or is invalid', status: 400 },
    });

    const res = await GET(makeRequest({
      token_hash: 'bad-hash',
      type: 'signup',
      next: '/get-started',
    }));
    const dest = redirectUrl(res);

    expect(dest.pathname).toBe('/login');
    expect(dest.searchParams.get('error')).toContain('invalid or has expired');
  });

  // ── 5. Missing code and token → error redirect, no auth method called ──

  it('request with no code or token_hash redirects to /login?error', async () => {
    const res = await GET(makeRequest({}));
    const dest = redirectUrl(res);

    expect(dest.pathname).toBe('/login');
    expect(dest.searchParams.get('error')).toContain('Invalid confirmation link');
    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
    expect(mockVerifyOtp).not.toHaveBeenCalled();
  });

  it('request with only token_hash but no type redirects to /login?error', async () => {
    const res = await GET(makeRequest({ token_hash: 'hash-only' }));
    const dest = redirectUrl(res);

    expect(dest.pathname).toBe('/login');
    expect(dest.searchParams.get('error')).toContain('Invalid confirmation link');
    expect(mockVerifyOtp).not.toHaveBeenCalled();
  });

  it('request with only type but no token_hash redirects to /login?error', async () => {
    const res = await GET(makeRequest({ type: 'signup' }));
    const dest = redirectUrl(res);

    expect(dest.pathname).toBe('/login');
    expect(dest.searchParams.get('error')).toContain('Invalid confirmation link');
    expect(mockVerifyOtp).not.toHaveBeenCalled();
  });

  // ── 6. Unsafe next values → /get-started fallback (exercising real route) ──

  it('absolute URL next=https://evil.example falls back to /get-started', async () => {
    mockExchangeCodeForSession.mockResolvedValue({ data: { session: {} }, error: null });

    const res = await GET(makeRequest({ code: 'valid', next: 'https://evil.example' }));
    const dest = redirectUrl(res);

    expect(dest.pathname).toBe('/get-started');
  });

  it('protocol-relative next=//evil.example falls back to /get-started', async () => {
    mockExchangeCodeForSession.mockResolvedValue({ data: { session: {} }, error: null });

    const res = await GET(makeRequest({ code: 'valid', next: '//evil.example' }));
    const dest = redirectUrl(res);

    expect(dest.pathname).toBe('/get-started');
  });

  it('javascript: URI next falls back to /get-started', async () => {
    mockExchangeCodeForSession.mockResolvedValue({ data: { session: {} }, error: null });

    const res = await GET(makeRequest({ code: 'valid', next: 'javascript:alert(1)' }));
    const dest = redirectUrl(res);

    expect(dest.pathname).toBe('/get-started');
  });

  // ── 7. Safe alternate relative next ──

  it('safe alternate next=/dashboard is preserved on success', async () => {
    mockExchangeCodeForSession.mockResolvedValue({ data: { session: {} }, error: null });

    const res = await GET(makeRequest({ code: 'valid', next: '/dashboard' }));
    const dest = redirectUrl(res);

    expect(dest.pathname).toBe('/dashboard');
  });

  it('safe next=/reset-password is preserved on success', async () => {
    mockExchangeCodeForSession.mockResolvedValue({ data: { session: {} }, error: null });

    const res = await GET(makeRequest({ code: 'valid', next: '/reset-password' }));
    const dest = redirectUrl(res);

    expect(dest.pathname).toBe('/reset-password');
  });

  it('missing next defaults to /get-started on success', async () => {
    mockExchangeCodeForSession.mockResolvedValue({ data: { session: {} }, error: null });

    // No next param at all
    const res = await GET(makeRequest({ code: 'valid' }));
    const dest = redirectUrl(res);

    expect(dest.pathname).toBe('/get-started');
  });

  // ── 8. Session/cookie limitation ──
  // NOTE: The Supabase server client's `createClient()` internally manages
  // cookie-based session persistence via Next.js cookies(). In this test
  // harness the mock replaces the real client, so cookie mutation (session
  // establishment) is not observable. What IS proven:
  // - exchangeCodeForSession / verifyOtp is called with the correct args;
  // - the route only proceeds to the success redirect when no error is returned;
  // - the route never presents a failed verification as success.
  // Full session-establishment proof requires the #401 live staging E2E gate
  // (browser-level confirmation click → authenticated session → onboarding).
});

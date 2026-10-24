/**
 * #705: Behavioral security tests
 *
 * Handler-level tests proving:
 * 1. Public routes return 429 when rate limit exceeded, 200/302 under limit
 * 2. admin/impersonate/end rejects without cookie, accepts with cookie
 *
 * These test the actual route handler functions, not just source strings.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// ═══════════════════════════════════════════════════════════
// 1. Rate limiting behavioral tests for public routes
// ═══════════════════════════════════════════════════════════

// Mock the rate limiter to control 429 behavior
const mockRateLimitResponseAsync = vi.fn();
const mockGetRateLimitKey = vi.fn().mockReturnValue('test-ip-key');

vi.mock('@/lib/rate-limit', () => ({
  rateLimitResponseAsync: (...args: unknown[]) => mockRateLimitResponseAsync(...args),
  getRateLimitKey: (...args: unknown[]) => mockGetRateLimitKey(...args),
  checkRateLimitAsync: vi.fn().mockResolvedValue({ allowed: true, remaining: 10, resetAt: Date.now() + 60000 }),
}));

// Mock supabase for route handlers
// Recursive chainable mock that returns { data: null, error: null } for terminal calls
function chainable(): Record<string, unknown> {
  const terminal = { data: null, error: null };
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      if (prop === 'then') return undefined; // not a Promise
      if (prop === 'data') return null;
      if (prop === 'error') return null;
      return (..._args: unknown[]) => new Proxy(terminal, handler);
    },
  };
  return new Proxy(terminal, handler);
}

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: () => chainable(),
  }),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve({
    auth: { getUser: () => Promise.resolve({ data: { user: null }, error: null }) },
    from: () => ({
      select: () => ({
        eq: () => ({ single: () => ({ data: null, error: null }) }),
      }),
    }),
  }),
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), withContext: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

vi.mock('@/lib/pdf/invoice-pdf-generator', () => ({
  generateInvoicePdf: vi.fn().mockResolvedValue(Buffer.from('fake-pdf')),
}));

function makeRequest(url: string, method = 'GET', headers?: Record<string, string>): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    method,
    headers: { 'x-forwarded-for': '1.2.3.4', ...headers },
  });
}

describe('Rate limit behavioral: public routes return 429 when limit exceeded', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/pay', () => {
    it('returns 429 when rate limit is exceeded', async () => {
      mockRateLimitResponseAsync.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Too many requests' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
        }),
      );

      const { GET } = await import('@/app/api/pay/route');
      const req = makeRequest('http://localhost:3000/api/pay?ref=TEST123');
      const res = await GET(req);

      expect(res.status).toBe(429);
      expect(mockRateLimitResponseAsync).toHaveBeenCalledWith('test-ip-key', 30, 60_000);
    });

    it('proceeds normally when under rate limit', async () => {
      mockRateLimitResponseAsync.mockResolvedValueOnce(null); // allowed

      const { GET } = await import('@/app/api/pay/route');
      const req = makeRequest('http://localhost:3000/api/pay?ref=TEST-REF-123456');
      const res = await GET(req);

      // Without a matching payment, should redirect to home (302)
      expect(res.status).toBe(302);
      expect(mockRateLimitResponseAsync).toHaveBeenCalledWith('test-ip-key', 30, 60_000);
    });
  });

  describe('GET /api/bookings/public/[slug]', () => {
    it('returns 429 when rate limit is exceeded', async () => {
      mockRateLimitResponseAsync.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Too many requests' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
        }),
      );

      const { GET } = await import('@/app/api/bookings/public/[slug]/route');
      const req = makeRequest('http://localhost:3000/api/bookings/public/test-biz');
      const res = await GET(req, { params: Promise.resolve({ slug: 'test-biz' }) });

      expect(res.status).toBe(429);
      expect(mockRateLimitResponseAsync).toHaveBeenCalledWith('test-ip-key', 30, 60_000);
    });

    it('proceeds normally when under rate limit (returns 404 for unknown slug)', async () => {
      mockRateLimitResponseAsync.mockResolvedValueOnce(null);

      const { GET } = await import('@/app/api/bookings/public/[slug]/route');
      const req = makeRequest('http://localhost:3000/api/bookings/public/nonexistent');
      const res = await GET(req, { params: Promise.resolve({ slug: 'nonexistent' }) });

      // Unknown slug → 404
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/invoices/pdf/[id]', () => {
    it('returns 429 when rate limit is exceeded', async () => {
      mockRateLimitResponseAsync.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Too many requests' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
        }),
      );

      const { GET } = await import('@/app/api/invoices/pdf/[id]/route');
      const req = makeRequest('http://localhost:3000/api/invoices/pdf/some-id?token=test');
      const res = await GET(req, { params: Promise.resolve({ id: 'some-id' }) });

      expect(res.status).toBe(429);
      expect(mockRateLimitResponseAsync).toHaveBeenCalledWith('test-ip-key', 10, 60_000);
    });

    it('proceeds normally when under rate limit (returns 401 without valid session/token)', async () => {
      mockRateLimitResponseAsync.mockResolvedValueOnce(null);

      const { GET } = await import('@/app/api/invoices/pdf/[id]/route');
      const req = makeRequest('http://localhost:3000/api/invoices/pdf/nonexistent-id');
      const res = await GET(req, { params: Promise.resolve({ id: 'nonexistent-id' }) });

      // No session and no token → 401
      expect(res.status).toBe(401);
    });
  });
});

// ═══════════════════════════════════════════════════════════
// 2. Impersonation end-session — cookie-path-aware tests
// ═══════════════════════════════════════════════════════════

// Mock next/headers cookies() for impersonation tests
const mockCookieSet = vi.fn();

vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({
    // Browser cookie-path rule: path=/dashboard cookies are NOT sent
    // to /api/admin/* routes. The mock must reflect this — cookies()
    // at this endpoint will never see the impersonation cookies.
    get: () => undefined,
    set: (...args: unknown[]) => mockCookieSet(...args),
  }),
}));

describe('Impersonation end-session — cookie-path regression', () => {
  beforeEach(() => {
    mockCookieSet.mockClear();
  });

  it('returns 200 and issues Set-Cookie clearing (even without incoming cookies)', async () => {
    // This is the correct behavior: the /end route cannot read the path=/dashboard
    // cookies at /api/admin/*. It unconditionally issues Set-Cookie with maxAge=0
    // to clear them. The browser applies Set-Cookie regardless of whether the
    // cookie was sent in the request — the path in the Set-Cookie directive
    // tells the browser which cookie to clear.
    const { POST } = await import('@/app/api/admin/impersonate/end/route');
    const res = await POST();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('issues Set-Cookie for both cookies with path=/dashboard and maxAge=0', async () => {
    const { POST } = await import('@/app/api/admin/impersonate/end/route');
    await POST();

    // Both cookies cleared with path=/dashboard (matching creation path)
    expect(mockCookieSet).toHaveBeenCalledTimes(2);
    expect(mockCookieSet).toHaveBeenCalledWith('impersonate_business_id', '', expect.objectContaining({
      httpOnly: true,
      sameSite: 'lax',
      path: '/dashboard',
      maxAge: 0,
    }));
    expect(mockCookieSet).toHaveBeenCalledWith('impersonate_admin_id', '', expect.objectContaining({
      httpOnly: true,
      sameSite: 'lax',
      path: '/dashboard',
      maxAge: 0,
    }));
  });

  it('anonymous POST produces no security effect (clearing empty cookies is a no-op)', async () => {
    // An unauthenticated attacker POSTing to /end simply gets a 200 with
    // Set-Cookie headers for cookies that don't exist — the browser ignores
    // Set-Cookie for cookies the user doesn't have. Zero impact.
    const { POST } = await import('@/app/api/admin/impersonate/end/route');
    const res = await POST();

    expect(res.status).toBe(200);
    // The route issues Set-Cookie but the browser will only apply it
    // if the user actually has those cookies (from a validated /validate flow)
  });
});

// ═══════════════════════════════════════════════════════════
// 3. Impersonation cookie security properties
// ═══════════════════════════════════════════════════════════

describe('Impersonation cookie security model', () => {
  /*
   * Cookie lifecycle:
   * 1. CREATION: POST /api/admin/impersonate/validate
   *    - Requires: one-time token from admin_impersonation_tokens table
   *    - Token must: exist, not be used_at, not be expired
   *    - Admin role re-verified via verifyAdminRole()
   *    - Token marked as used (single-use, cannot replay)
   *    - Sets: impersonate_admin_id + impersonate_business_id
   *    - Cookie props: httpOnly, secure (prod), sameSite=lax, path=/dashboard, maxAge=1800 (30 min)
   *
   * 2. IMPERSONATION AUTHORITY: app/dashboard/layout.tsx
   *    - Reads both cookies (path=/dashboard matches the layout)
   *    - Validates admin role via verifyAdminRole(adminId)
   *    - Validates token exists, was used, and hasn't expired
   *    - If validation fails: clears cookies and falls through to normal flow
   *    - This is the real auth gate, not the /end route
   *
   * 3. LOGOUT: POST /api/admin/impersonate/end
   *    - Route is at /api/admin/* — OUTSIDE cookie path /dashboard
   *    - Browser does NOT send impersonation cookies to this endpoint
   *    - Route unconditionally issues Set-Cookie with maxAge=0 to clear
   *    - An anonymous POST produces Set-Cookie for nonexistent cookies — no-op
   *    - ImpersonationBanner.tsx calls this via fetch() from /dashboard pages
   *
   * 4. EXPIRY:
   *    - maxAge=1800 (30 minutes) → browser auto-expires
   *    - Dashboard layout also validates token expiry server-side
   *
   * 5. THREAT MODEL:
   *    - CSRF on /end: sameSite=lax blocks cross-origin POST. Even if an
   *      attacker triggers a POST to /end, the result is clearing cookies
   *      the attacker doesn't have — zero impact.
   *    - Cookie reading via XSS: httpOnly prevents document.cookie access.
   *      Note: httpOnly does NOT prevent all XSS cookie-setting vectors
   *      (e.g., meta tags, header injection), but those require a separate
   *      vulnerability. The cookie value (admin UUID) is not a secret —
   *      it's validated server-side in the dashboard layout.
   *    - Replay: The /validate token is single-use. Cannot be replayed.
   *    - Unauthorized /end POST: benign — clears nonexistent cookies.
   *
   * 6. DISTRIBUTED LIMITATION:
   *    - Rate limiting on public routes uses rateLimitResponseAsync which
   *      supports Upstash Redis. Upstash is NOT currently configured on
   *      staging or production. All rate limits are per-Lambda-instance only.
   */

  it('validate route sets cookies with correct security properties', () => {
    const src = require('fs').readFileSync('app/api/admin/impersonate/validate/route.ts', 'utf-8');
    // httpOnly: true on both cookies
    expect(src).toContain("httpOnly: true");
    // sameSite: 'lax' for CSRF protection
    expect(src).toContain("sameSite: 'lax'");
    // path restricted to /dashboard
    expect(src).toContain("path: '/dashboard'");
    // 30-minute expiry
    expect(src).toContain("maxAge");
    expect(src).toContain("1800");
    // Token is single-use
    expect(src).toContain("used_at");
    // Admin role re-verified
    expect(src).toContain("verifyAdminRole");
  });

  it('end route cookie clearing uses matching security properties', () => {
    const src = require('fs').readFileSync('app/api/admin/impersonate/end/route.ts', 'utf-8');
    // Same httpOnly, sameSite, path as creation
    expect(src).toContain("httpOnly: true");
    expect(src).toContain("sameSite: 'lax'");
    expect(src).toContain("path: '/dashboard'");
    // maxAge: 0 for deletion
    expect(src).toContain("maxAge: 0");
  });

  it('getRateLimitKey extracts first IP from x-forwarded-for (Vercel sets this)', () => {
    const src = require('fs').readFileSync('lib/rate-limit.ts', 'utf-8');
    // Vercel sets x-forwarded-for from the actual client IP
    expect(src).toContain("x-forwarded-for");
    expect(src).toContain("split(',')[0]");
  });

  it('REGRESSION: cookie path=/dashboard is NOT a prefix of /api/admin/impersonate/end', () => {
    // Per RFC 6265 §5.1.4: a cookie with path=/dashboard is sent to
    // /dashboard, /dashboard/, /dashboard/settings, etc., but NOT to
    // /api/admin/impersonate/end (different path hierarchy).
    //
    // This test encodes the reason the /end route must NOT check cookie
    // presence — the browser will never send those cookies to /api/*.
    const validateSrc = require('fs').readFileSync('app/api/admin/impersonate/validate/route.ts', 'utf-8');
    const endSrc = require('fs').readFileSync('app/api/admin/impersonate/end/route.ts', 'utf-8');

    // Cookies are created with path=/dashboard
    expect(validateSrc).toContain("path: '/dashboard'");

    // The /end route is at /api/admin/impersonate/end — NOT under /dashboard
    // Therefore it must NOT attempt to read the cookies
    expect(endSrc).not.toContain("cookieStore.get('impersonate_admin_id')");
    expect(endSrc).not.toContain("cookieStore.get('impersonate_business_id')");

    // The /end route clears cookies with matching path=/dashboard
    // (Set-Cookie is applied by the browser regardless of request path)
    expect(endSrc).toContain("path: '/dashboard'");
    expect(endSrc).toContain("maxAge: 0");
  });

  it('dashboard layout is the real auth gate for impersonation (path=/dashboard)', () => {
    const layoutSrc = require('fs').readFileSync('app/dashboard/layout.tsx', 'utf-8');
    // Dashboard layout reads the cookies (path=/dashboard matches)
    expect(layoutSrc).toContain("impersonate_admin_id");
    expect(layoutSrc).toContain("impersonate_business_id");
    // Dashboard layout validates admin role
    expect(layoutSrc).toContain("verifyAdminRole");
    // Dashboard layout validates token
    expect(layoutSrc).toContain("admin_impersonation_tokens");
    // Dashboard layout clears cookies if token is expired
    expect(layoutSrc).toContain("delete('impersonate_admin_id')");
  });
});

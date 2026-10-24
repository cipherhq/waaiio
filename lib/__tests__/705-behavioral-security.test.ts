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
// 2. Impersonation end-session behavioral tests
// ═══════════════════════════════════════════════════════════

// Mock next/headers cookies() for impersonation tests
const mockCookieStore = new Map<string, { value: string }>();
const mockCookieSet = vi.fn();

vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({
    get: (name: string) => mockCookieStore.get(name) || undefined,
    set: (...args: unknown[]) => mockCookieSet(...args),
  }),
}));

describe('Impersonation end-session behavioral tests', () => {
  beforeEach(() => {
    mockCookieStore.clear();
    mockCookieSet.mockClear();
  });

  it('returns 401 when no impersonation cookie is present (unauthorized)', async () => {
    // No cookies set → simulates anonymous or non-impersonating request
    const { POST } = await import('@/app/api/admin/impersonate/end/route');
    const res = await POST();

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('No active impersonation session');
    // Cookies should NOT be cleared when auth fails
    expect(mockCookieSet).not.toHaveBeenCalled();
  });

  it('clears cookies and returns success when impersonation cookie is present', async () => {
    // Simulate active impersonation session
    mockCookieStore.set('impersonate_admin_id', { value: 'admin-uuid-123' });
    mockCookieStore.set('impersonate_business_id', { value: 'biz-uuid-456' });

    const { POST } = await import('@/app/api/admin/impersonate/end/route');
    const res = await POST();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    // Both cookies cleared with maxAge: 0
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

  it('returns 401 when impersonate_admin_id cookie is absent but business cookie exists', async () => {
    // Edge case: business cookie set but admin cookie missing (malformed state)
    mockCookieStore.set('impersonate_business_id', { value: 'biz-uuid-456' });
    // impersonate_admin_id NOT set

    const { POST } = await import('@/app/api/admin/impersonate/end/route');
    const res = await POST();

    expect(res.status).toBe(401);
    expect(mockCookieSet).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════
// 3. Impersonation cookie security properties
// ═══════════════════════════════════════════════════════════

describe('Impersonation cookie security model documentation', () => {
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
   * 2. VALIDATION (in /end route):
   *    - Checks impersonate_admin_id cookie presence
   *    - Cookie is httpOnly → cannot be set by client JavaScript
   *    - Cookie is sameSite=lax → not sent on cross-origin POST (CSRF protection)
   *    - Cookie path=/dashboard → only sent on /dashboard/* routes
   *
   * 3. EXPIRY:
   *    - maxAge=1800 (30 minutes) → browser auto-expires
   *    - No server-side session invalidation (cookie is stateless after creation)
   *
   * 4. THREAT MODEL:
   *    - CSRF: sameSite=lax blocks cross-origin POST. An attacker's page cannot
   *      POST to /api/admin/impersonate/end and have the cookie sent.
   *    - Cookie forgery: httpOnly prevents JS access. Attacker cannot read or set
   *      the cookie via XSS. The value (admin UUID) is opaque and not validated
   *      against the DB on /end — it's a presence check, not identity verification.
   *    - Replay: The /validate token is single-use. Cannot be replayed to set new cookies.
   *    - Accepted limitation: The /end route checks cookie PRESENCE, not admin
   *      IDENTITY against the current DB state. If an admin is deactivated during
   *      an impersonation session, /end still works (clearing cookies is benign).
   *      The 30-minute maxAge limits the window.
   *
   * 5. DISTRIBUTED LIMITATION:
   *    - Rate limiting on public routes uses rateLimitResponseAsync which supports
   *      Upstash Redis for cross-instance rate limiting. However, Upstash is NOT
   *      currently configured on staging or production. Until UPSTASH_REDIS_REST_URL
   *      and UPSTASH_REDIS_REST_TOKEN are added to Vercel, all rate limits operate
   *      per-Lambda-instance only. This means an attacker could get N × limit
   *      effective requests across N serverless instances.
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
});

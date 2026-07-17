import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { fastHash, getCachedSession, setCachedSession, shouldTouch } from '@/lib/security/session-check';

type CookieEntry = { name: string; value: string; options: CookieOptions };

// ── Maintenance Mode Cache ──
let maintenanceCache: { value: boolean; expiresAt: number } | null = null;
const MAINTENANCE_CACHE_TTL = 30_000; // 30 seconds

async function isMaintenanceMode(supabase: ReturnType<typeof createServerClient>): Promise<boolean> {
  if (maintenanceCache && Date.now() < maintenanceCache.expiresAt) {
    return maintenanceCache.value;
  }
  try {
    const { data } = await supabase
      .from('platform_settings')
      .select('value')
      .eq('key', 'maintenance_mode')
      .single();
    const isOn = data?.value === true;
    maintenanceCache = { value: isOn, expiresAt: Date.now() + MAINTENANCE_CACHE_TTL };
    return isOn;
  } catch {
    return false; // fail open — don't block users if DB is down
  }
}

/** Apply common security headers to any response */
function applySecurityHeaders(response: NextResponse): NextResponse {
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-XSS-Protection', '1; mode=block');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  response.headers.set(
    'Permissions-Policy',
    'camera=(self), microphone=(self), geolocation=()',
  );
  response.headers.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''} https://js.stripe.com https://js.squareup.com https://js.paystack.co https://*.facebook.net https://*.facebook.com https://us-assets.i.posthog.com https://maps.googleapis.com https://www.paypal.com`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' https: data: blob:",
      "font-src 'self' data:",
      "media-src 'self' https://*.supabase.co blob:",
      `connect-src 'self' https://*.supabase.co wss://*.supabase.co${process.env.NEXT_PUBLIC_SUPABASE_URL?.startsWith('http://localhost') ? ' http://localhost:*' : ''} https://api.paystack.co https://api.stripe.com https://connect.squareup.com https://api.flutterwave.com https://*.facebook.com https://*.facebook.net https://us.i.posthog.com https://eu.i.posthog.com https://us-assets.i.posthog.com https://maps.googleapis.com https://*.googleapis.com https://*.sentry.io https://*.ingest.sentry.io`,
      "frame-src 'self' https://js.stripe.com https://js.squareup.com https://checkout.paystack.com https://checkout.flutterwave.com https://*.facebook.com https://*.facebook.net https://www.paypal.com",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  return response;
}

// ── Rate Limiting (in-memory, per IP) ──
const rateLimitStore = new Map<string, { count: number; resetAt: number }>();
const RL_CLEANUP_INTERVAL = 60_000;
let lastCleanup = Date.now();

function checkMiddlewareRateLimit(ip: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  // Periodic cleanup
  if (now - lastCleanup > RL_CLEANUP_INTERVAL) {
    lastCleanup = now;
    for (const [key, entry] of rateLimitStore) {
      if (now > entry.resetAt) rateLimitStore.delete(key);
    }
    // Cap at 50k entries
    if (rateLimitStore.size > 50_000) {
      const excess = rateLimitStore.size - 50_000;
      const iter = rateLimitStore.keys();
      for (let i = 0; i < excess; i++) {
        const next = iter.next();
        if (!next.done) rateLimitStore.delete(next.value);
      }
    }
  }

  const entry = rateLimitStore.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }
  entry.count++;
  return entry.count <= limit;
}

export async function middleware(request: NextRequest) {
  // Handle CORS preflight for admin API routes (called from admin.waaiio.com)
  if (request.method === 'OPTIONS' && request.nextUrl.pathname.startsWith('/api/admin/')) {
    const origin = request.headers.get('origin') || '';
    const allowedOrigins = [
      process.env.ADMIN_ORIGIN || 'https://admin.waaiio.com',
      'https://admin.waaiio.com',
      'https://admin-staging.waaiio.com',
      'http://localhost:8083', // dev
    ];
    if (!allowedOrigins.includes(origin)) {
      return new NextResponse(null, { status: 403 });
    }
    return new NextResponse(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  // CSRF protection: verify Origin header on state-mutating API requests
  const isStateMutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method);
  const isApiRoute = request.nextUrl.pathname.startsWith('/api/');
  const webhookReceiverPaths = [
    '/api/webhook/meta-cloud',
    '/api/webhooks/flutterwave', '/api/webhooks/paystack-transfer', '/api/webhooks/stripe-transfer',
    '/api/payments/stripe-webhook', '/api/payments/square-webhook', '/api/payments/paypal-webhook',
    '/api/payments/byo-webhook', '/api/payments/webhook',
    '/api/integrations/external-booking',
    '/api/partner/',
    '/api/invite-optin',
    '/api/checkin',
    '/api/whatsapp/flow-data',
    '/api/whatsapp/flow-callback',
    '/api/pay-link/pay',
  ];
  const isWebhook = webhookReceiverPaths.some(p => request.nextUrl.pathname.startsWith(p));
  if (isStateMutating && isApiRoute && !isWebhook) {
    const origin = request.headers.get('origin');
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://waaiio.com';
    const appOrigin = new URL(appUrl).origin;
    const allowedOrigins = [
      appOrigin,
      // Include both www and non-www variants
      appOrigin.includes('www.') ? appOrigin.replace('www.', '') : appOrigin.replace('://', '://www.'),
      process.env.ADMIN_ORIGIN || 'https://admin.waaiio.com',
      'https://admin.waaiio.com',
      'https://admin-staging.waaiio.com',
      'http://localhost:3000',
      'http://localhost:8083',
    ];
    if (origin && !allowedOrigins.includes(origin)) {
      return new NextResponse(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // ── Global API rate limiting ──
  if (isApiRoute) {
    const forwarded = request.headers.get('x-forwarded-for');
    const ip = forwarded?.split(',')[0]?.trim() || 'unknown';

    // Exempt webhook endpoints (authenticated via signatures, not IP)
    const isWebhookRoute = isWebhook
      || request.nextUrl.pathname.startsWith('/api/cron');

    if (!isWebhookRoute) {
      // Stricter rate limit for auth routes: 10 POST/min per IP
      const authPaths = ['/api/auth/', '/api/admin/login'];
      const isAuthRoute = authPaths.some(p => request.nextUrl.pathname.startsWith(p));
      if (isAuthRoute && isStateMutating) {
        const authKey = `bf:${ip}`;
        if (!checkMiddlewareRateLimit(authKey, 10, 60_000)) {
          return new NextResponse(
            JSON.stringify({ error: 'Too many authentication attempts. Please wait a few minutes.' }),
            { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '300' } },
          );
        }
      }

      // POST/PUT/PATCH/DELETE: 120 req/min, GET: 300 req/min (scaled for 1000+ users)
      const limit = isStateMutating ? 120 : 300;
      const key = `api:${ip}:${isStateMutating ? 'write' : 'read'}`;
      if (!checkMiddlewareRateLimit(key, limit, 60_000)) {
        return new NextResponse(
          JSON.stringify({ error: 'Too many requests. Please try again later.' }),
          { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '60' } },
        );
      }
    }
  }

  // Attach request ID for tracing (reuse incoming or generate new)
  const requestId = request.headers.get('x-request-id') || crypto.randomUUID().slice(0, 8);

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: CookieEntry[]) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, { ...options, path: '/' })
          );
        },
      },
    }
  );

  // Refresh session if expired
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // ── Session Binding Check ──
  // Compare current User-Agent against cached session to detect stolen tokens.
  // Only checks in-memory cache — no DB queries in middleware hot path.
  // Uses per-session cache keys (access_token suffix) so multi-device logins
  // don't invalidate each other.
  if (user && request.nextUrl.pathname.startsWith('/dashboard')) {
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    const ua = request.headers.get('user-agent') || '';
    const uaHash = fastHash(ua);

    // Derive a per-session identifier from the access token so each device/browser
    // gets its own cache entry. Falls back to user.id for edge cases.
    const { data: { session } } = await supabase.auth.getSession();
    const sessionSuffix = session?.access_token?.slice(-16) || 'default';
    const sessionKey = `${user.id}-${sessionSuffix}`;

    const cached = getCachedSession(sessionKey);
    if (cached) {
      // User-agent changed = different browser/device → force re-auth
      if (cached.uaHash !== uaHash) {
        const url = request.nextUrl.clone();
        url.pathname = '/login';
        url.searchParams.set('reason', 'session_expired');
        const response = NextResponse.redirect(url);
        response.cookies.delete('sb-access-token');
        response.cookies.delete('sb-refresh-token');
        return applySecurityHeaders(response);
      }
    } else {
      // First request or cache expired — cache current values
      setCachedSession(sessionKey, ip, uaHash);
    }
  }

  // ── Maintenance Mode Check ──
  // Check if maintenance_mode is enabled (cached 30s to avoid DB hit per request)
  const isPublicPage = !request.nextUrl.pathname.startsWith('/api/')
    && !request.nextUrl.pathname.startsWith('/dashboard')
    && !request.nextUrl.pathname.startsWith('/maintenance')
    && !request.nextUrl.pathname.startsWith('/_next')
    && !request.nextUrl.pathname.startsWith('/favicon');

  const isDashboardPage = request.nextUrl.pathname.startsWith('/dashboard');

  if (isPublicPage || isDashboardPage) {
    const maintenanceOn = await isMaintenanceMode(supabase);
    if (maintenanceOn) {
      // Public pages → redirect to maintenance page
      if (isPublicPage && request.nextUrl.pathname !== '/maintenance') {
        const url = request.nextUrl.clone();
        url.pathname = '/maintenance';
        return applySecurityHeaders(NextResponse.redirect(url));
      }
    }
  }

  // Protect dashboard routes
  const protectedPaths = ['/dashboard'];
  const isProtected = protectedPaths.some((p) =>
    request.nextUrl.pathname.startsWith(p)
  );

  if (!user && isProtected) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    const redirect = request.nextUrl.pathname;
    if (redirect.startsWith('/') && !redirect.startsWith('//')) {
      url.searchParams.set('redirect', redirect);
    }
    return applySecurityHeaders(NextResponse.redirect(url));
  }

  // Add no-store cache header for API routes
  if (request.nextUrl.pathname.startsWith('/api/')) {
    supabaseResponse.headers.set('Cache-Control', 'no-store');
  }

  // Prevent caching of auth-related responses
  const authPagePaths = ['/login', '/signup', '/forgot-password', '/api/auth/'];
  const isAuthPage = authPagePaths.some(p => request.nextUrl.pathname.startsWith(p));
  if (isAuthPage) {
    supabaseResponse.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    supabaseResponse.headers.set('Pragma', 'no-cache');
  }

  // Add CORS headers for admin API routes (cross-origin from admin.waaiio.com)
  if (request.nextUrl.pathname.startsWith('/api/admin/')) {
    const origin = request.headers.get('origin') || '';
    const allowedOrigins = [
      process.env.ADMIN_ORIGIN || 'https://admin.waaiio.com',
      'https://admin.waaiio.com',
      'https://admin-staging.waaiio.com',
      'http://localhost:8083', // dev
    ];
    if (allowedOrigins.includes(origin)) {
      supabaseResponse.headers.set('Access-Control-Allow-Origin', origin);
      supabaseResponse.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      supabaseResponse.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      supabaseResponse.headers.set('Access-Control-Allow-Credentials', 'true');
    }
  }

  supabaseResponse.headers.set('x-request-id', requestId);

  return applySecurityHeaders(supabaseResponse);
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};

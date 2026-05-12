import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

type CookieEntry = { name: string; value: string; options: CookieOptions };

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
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://js.stripe.com https://js.squareup.com https://js.paystack.co https://*.facebook.net https://*.facebook.com https://us-assets.i.posthog.com https://maps.googleapis.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' https: data: blob:",
      "font-src 'self' data:",
      "media-src 'self' https://*.supabase.co blob:",
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.paystack.co https://api.stripe.com https://connect.squareup.com https://api.flutterwave.com https://*.facebook.com https://*.facebook.net https://us.i.posthog.com https://eu.i.posthog.com https://us-assets.i.posthog.com https://maps.googleapis.com https://*.googleapis.com https://*.sentry.io https://*.ingest.sentry.io",
      "frame-src 'self' https://js.stripe.com https://js.squareup.com https://checkout.paystack.com https://checkout.flutterwave.com https://*.facebook.com https://*.facebook.net",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  return response;
}

export async function middleware(request: NextRequest) {
  // Handle CORS preflight for admin API routes (called from admin.waaiio.com)
  if (request.method === 'OPTIONS' && request.nextUrl.pathname.startsWith('/api/admin/')) {
    const origin = request.headers.get('origin') || '';
    const allowedOrigins = [
      process.env.ADMIN_ORIGIN || 'https://admin.waaiio.com',
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
  const isWebhook = request.nextUrl.pathname.startsWith('/api/webhook') || request.nextUrl.pathname.startsWith('/api/webhooks');
  if (isStateMutating && isApiRoute && !isWebhook) {
    const origin = request.headers.get('origin');
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://waaiio.com';
    const allowedOrigins = [
      new URL(appUrl).origin,
      process.env.ADMIN_ORIGIN || 'https://admin.waaiio.com',
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

  // Add CORS headers for admin API routes (cross-origin from admin.waaiio.com)
  if (request.nextUrl.pathname.startsWith('/api/admin/')) {
    const origin = request.headers.get('origin') || '';
    const allowedOrigins = [
      process.env.ADMIN_ORIGIN || 'https://admin.waaiio.com',
      'http://localhost:8083', // dev
    ];
    if (allowedOrigins.includes(origin)) {
      supabaseResponse.headers.set('Access-Control-Allow-Origin', origin);
      supabaseResponse.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      supabaseResponse.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }
  }

  return applySecurityHeaders(supabaseResponse);
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};

import { NextResponse, type NextRequest } from 'next/server';

/**
 * Verify that a cron request is authorized.
 * Accepts requests from:
 * 1. Vercel Cron (Authorization: Bearer <CRON_SECRET>)
 * 2. Requests with matching CRON_SECRET header
 * 3. If CRON_SECRET is not set, all requests are allowed (dev mode)
 */
export function verifyCronAuth(request: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;

  // Fail-closed: if CRON_SECRET is not set in production, block all requests
  if (!secret) {
    if (process.env.NODE_ENV === 'production' || process.env.VERCEL) {
      return NextResponse.json({ error: 'Cron secret not configured' }, { status: 500 });
    }
    return null; // Allow in local development only
  }

  const authHeader = request.headers.get('authorization');
  if (authHeader === `Bearer ${secret}`) return null; // Vercel cron

  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

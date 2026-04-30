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
  if (!secret) return null; // No secret configured = allow (dev mode)

  const authHeader = request.headers.get('authorization');
  if (authHeader === `Bearer ${secret}`) return null; // Vercel cron

  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'crypto';

/**
 * Verify that a cron request is authorized.
 * Accepts requests from:
 * 1. Vercel Cron (Authorization: Bearer <CRON_SECRET>)
 * 2. If CRON_SECRET is not set in production, blocks all requests (fail-closed)
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

  const authHeader = request.headers.get('authorization') || '';
  const expected = `Bearer ${secret}`;
  if (authHeader.length === expected.length && timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected))) {
    return null; // Authorized
  }

  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

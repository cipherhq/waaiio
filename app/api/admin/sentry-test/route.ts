import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { requirePlatformAdmin } from '@/lib/admin-auth';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/sentry-test
 *
 * Throws a tagged error to verify Sentry server-side capture is working.
 * Protected: requires platform admin with 'admin' role.
 */
export async function GET(request: NextRequest) {
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const testError = new Error('Sentry server-side test error — triggered by admin');
  Sentry.captureException(testError, {
    tags: {
      test: 'sentry-server-init',
      admin_id: admin.userId,
      environment: process.env.WAAIIO_ENVIRONMENT || process.env.VERCEL_ENV || 'unknown',
    },
  });

  await Sentry.flush(2000);

  return NextResponse.json({
    ok: true,
    message: 'Test error sent to Sentry',
    environment: process.env.WAAIIO_ENVIRONMENT || process.env.VERCEL_ENV || 'unknown',
  });
}

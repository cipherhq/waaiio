import { NextResponse, type NextRequest } from 'next/server';
import { verifyCronAuth } from '@/lib/cron-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/cron/platform-fee-overdue
 *
 * DISABLED: Direct transfer fees are now included in subscription pricing.
 * Per-transaction invoicing replaced by higher plan prices ($20 Growth / $45 Business).
 * Keeping this route for backward compatibility but it does nothing.
 */
export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  return NextResponse.json({
    message: 'Disabled — direct transfer fees included in subscription',
    markedOverdue: 0,
    remindersSent: 0,
    disabled: 0,
  });
}

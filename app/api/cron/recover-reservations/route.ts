import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { verifyCronAuth } from '@/lib/cron-auth';
import { logger } from '@/lib/logger';
import * as Sentry from '@sentry/nextjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  try {
    const supabase = createServiceClient();
    const { data, error } = await supabase.rpc('recover_expired_reservations');

    if (error) {
      logger.error('[CRON] Reservation recovery failed:', error.message);
      Sentry.captureException(error, { tags: { cron: 'recover-reservations' } });
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    if (data?.recovered > 0) {
      logger.info('[CRON] Recovered expired reservations:', data);
    }

    return NextResponse.json({ ok: true, ...data });
  } catch (err) {
    Sentry.captureException(err, { tags: { cron: 'recover-reservations' } });
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}

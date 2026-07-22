import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { verifyCronAuth } from '@/lib/cron-auth';
import { retryUndeliveredConfirmations } from '@/lib/payments/send-confirmation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Confirmation Retry Cron
 *
 * Retries undelivered payment confirmations:
 * - Unclaimed: confirmation_claimed_at IS NULL and confirmation_sent_at IS NULL
 * - Stale claims: claimed > 5 minutes ago but never sent (crashed worker)
 *
 * Safe to run frequently — sendProactiveConfirmation uses atomic claims internally.
 */
export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  const supabase = createServiceClient();
  const retried = await retryUndeliveredConfirmations(supabase);
  return NextResponse.json({ ok: true, retried });
}

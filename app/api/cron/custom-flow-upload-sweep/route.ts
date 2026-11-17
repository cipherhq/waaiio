import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { verifyCronAuth } from '@/lib/cron-auth';
import { sweepOrphanedUploads } from '@/lib/custom-flow-responses/upload-sweep';
import { reportFailure } from '@/lib/observability/report-failure';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Custom Flow orphaned-upload sweep (#1085): runs daily after the answers
 * retention job and deletes uploaded photos/PDFs over 24 hours old that no
 * answer points at. The rules are in lib/custom-flow-responses/upload-sweep.ts.
 * Any failure is reported and the rest of the run carries on; the response
 * is then 500 with the counts, so the next day's run retries.
 */
export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  let swept;
  try {
    swept = await sweepOrphanedUploads(createServiceClient());
  } catch (err) {
    // A throw stops the run before any further delete; report it, never its message.
    reportFailure(err, { area: 'cron', op: 'run', job: 'custom-flow-upload-sweep' });
    return NextResponse.json({ ok: false, error: 'sweep_crashed' }, { status: 500 });
  }
  const { root_failed, ...result } = swept;
  if (root_failed) return NextResponse.json({ ok: false, error: 'list_failed', ...result }, { status: 500 });
  if (result.failed) return NextResponse.json({ ok: false, error: 'sweep_failed', ...result }, { status: 500 });
  return NextResponse.json({ ok: true, ...result });
}

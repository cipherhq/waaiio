import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { verifyCronAuth } from '@/lib/cron-auth';
import { deleteAnswers, retentionCutoff } from '@/lib/custom-flow-responses/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const BATCH = 500;
const MAX_BATCHES = 20;

/**
 * Custom Flow answers retention (#1085, Owner rule on #1079): answers and
 * their uploaded files are deleted 12 months after they were given.
 * Runs daily. Each batch removes files before rows; if Storage fails the
 * rows are kept and the next run retries, so no file is left unreferenced.
 */
export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  const service = createServiceClient();
  const cutoff = retentionCutoff().toISOString();
  let deleted = 0;
  for (let round = 0; round < MAX_BATCHES; round++) {
    const { data, error } = await service.from('custom_flow_answers').select('id,business_id,file_path')
      .lt('created_at', cutoff).order('created_at').limit(BATCH);
    if (error) return NextResponse.json({ ok: false, error: 'read_failed', deleted }, { status: 500 });
    if (!data?.length) break;
    const byBusiness = new Map<string, { id: string; file_path: string | null }[]>();
    for (const row of data) byBusiness.set(row.business_id, [...(byBusiness.get(row.business_id) ?? []), row]);
    for (const [businessId, answers] of byBusiness) {
      const count = await deleteAnswers(service, service, businessId, answers);
      if (count === null) return NextResponse.json({ ok: false, error: 'delete_failed', deleted }, { status: 500 });
      deleted += count;
    }
    if (data.length < BATCH) break;
  }
  return NextResponse.json({ ok: true, deleted, cutoff });
}

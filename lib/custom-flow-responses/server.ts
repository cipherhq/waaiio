// Flow answers (#1085): who may read, download and delete Custom Flow answers.
// Owner rule: the business owner and that business's own active team read;
// only the owner deletes. Reading is history, so it does not need the
// custom-flow capability to be on (the existing read_history contract).
import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { resolveBusinessRole } from '@/lib/capabilities/resolve-role';
import { isUuid } from '@/lib/bot/custom-flow/data';
import { fail } from '@/lib/custom-flow-builder/server';

import { CUSTOM_FLOW_UPLOADS_BUCKET } from '@/lib/bot/custom-flow/answers';
export { CUSTOM_FLOW_UPLOADS_BUCKET };
/** Short-lived link lifetime for an uploaded photo or PDF (seconds). */
export const FILE_LINK_SECONDS = 300;
/** Answers kept before the daily retention job deletes them. */
export const RETENTION_MONTHS = 12;
export const answerColumns = 'id,flow_id,flow_version,response_id,customer_number,node_id,question,answer_type,value_text,value_date,file_path,file_mime,file_size,created_at';

export interface AnswersAccess {
  /** Signed-in, RLS-aware client: reads and deletes go through RLS too. */
  db: SupabaseClient;
  service: SupabaseClient;
  businessId: string;
  isOwner: boolean;
}

export async function authorizeAnswers(businessId: unknown): Promise<AnswersAccess | NextResponse> {
  const db = await createClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) return fail('unauthorized', 401);
  if (!isUuid(businessId)) return fail('invalid_business', 400);
  const service = createServiceClient();
  const role = await resolveBusinessRole(service, businessId, user.id);
  if (!role.ok) return fail(role.error === 'db_error' ? 'authorization_error' : 'business_not_found', role.error === 'db_error' ? 500 : 403);
  return { db, service, businessId, isOwner: role.isOwner };
}

/** The cutoff before which answers are deleted. */
export function retentionCutoff(now = new Date()): Date {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - RETENTION_MONTHS);
  return cutoff;
}

/**
 * Remove the stored files for these answers, then the answer rows. Files go
 * first: if Storage fails, the rows stay so nothing is silently orphaned and
 * the next attempt retries. Returns the number of rows deleted, or null.
 */
export async function deleteAnswers(
  rowsClient: SupabaseClient,
  service: SupabaseClient,
  businessId: string,
  answers: { id: string; file_path: string | null }[],
): Promise<number | null> {
  if (!answers.length) return 0;
  const files = answers.map(a => a.file_path).filter((p): p is string => !!p && p.startsWith(`${businessId}/`));
  if (files.length) {
    const { error } = await service.storage.from(CUSTOM_FLOW_UPLOADS_BUCKET).remove(files);
    if (error) return null;
  }
  const { data, error } = await rowsClient.from('custom_flow_answers').delete()
    .eq('business_id', businessId).in('id', answers.map(a => a.id)).select('id');
  if (error) return null;
  return data?.length ?? 0;
}

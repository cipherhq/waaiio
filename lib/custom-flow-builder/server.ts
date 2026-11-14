import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requireCapability } from '@/lib/capabilities/api-guard';
import { isUuid } from '@/lib/bot/custom-flow/data';

export const flowColumns = 'id,business_id,name,status,definition,version,published_definition,published_version,updated_at';
export const fail = (error: string, status: number) => NextResponse.json({ error }, { status });
export async function authorize(businessId: unknown) {
  const db = await createClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) return fail('unauthorized', 401);
  if (!isUuid(businessId)) return fail('invalid_business', 400);
  const guard = await requireCapability(db, createServiceClient(), { businessId, userId: user.id, capability: 'custom_flow', action: 'create_new' });
  if (!guard.allowed) return NextResponse.json(guard.denial, { status: guard.status });
  if (guard.business.status !== 'active') return fail('business_not_active', 403);
  return { db, businessId };
}
export async function boundedBody(request: NextRequest): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw Error('invalid_body');
  const decoder = new TextDecoder();
  let bytes = 0, body = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > 256 * 1024) { await reader.cancel(); throw Error('body_too_large'); }
    body += decoder.decode(chunk.value, { stream: true });
  }
  return JSON.parse(body + decoder.decode());
}

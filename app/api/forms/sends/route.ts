import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

/** Owner check shared by both handlers. Returns the user id or a response to send back. */
async function owner(businessId: unknown): Promise<string | NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (typeof businessId !== 'string' || !businessId) return NextResponse.json({ error: 'businessId required' }, { status: 400 });
  const { data: biz } = await supabase.from('businesses').select('id').eq('id', businessId).eq('owner_id', user.id).maybeSingle();
  if (!biz) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  return user.id;
}

/** GET /api/forms/sends?businessId=&formId= — a form's recent and scheduled sends. */
export async function GET(request: NextRequest) {
  const limited = await rateLimitResponseAsync(getRateLimitKey(request, 'form-sends'), 60, 60_000);
  if (limited) return limited;
  const businessId = request.nextUrl.searchParams.get('businessId');
  const formId = request.nextUrl.searchParams.get('formId');
  const auth = await owner(businessId);
  if (auth instanceof NextResponse) return auth;
  if (!formId) return NextResponse.json({ error: 'formId required' }, { status: 400 });

  const { data, error } = await createServiceClient().from('form_sends')
    .select('id, status, scheduled_at, completed_at, template_name, sent_count, failed_count, skipped_count, results, error_message, created_at')
    .eq('business_id', businessId!).eq('form_id', formId)
    .order('created_at', { ascending: false }).limit(20);
  if (error) {
    logger.warn('[FORMS] Send history unavailable:', error.message);
    return NextResponse.json({ error: 'Could not load sends' }, { status: 503 });
  }
  return NextResponse.json({ sends: data || [] }, { headers: { 'Cache-Control': 'no-store' } });
}

/** DELETE /api/forms/sends { id, businessId } — cancel a send that has not started. */
export async function DELETE(request: NextRequest) {
  const body = await request.json().catch(() => null) as { id?: unknown; businessId?: unknown } | null;
  const auth = await owner(body?.businessId);
  if (auth instanceof NextResponse) return auth;
  if (typeof body?.id !== 'string') return NextResponse.json({ error: 'id required' }, { status: 400 });

  const { data, error } = await createServiceClient().from('form_sends')
    .update({ status: 'cancelled', completed_at: new Date().toISOString(), updated_at: new Date().toISOString(), error_message: 'Cancelled by the business' })
    .eq('id', body.id).eq('business_id', body.businessId as string).eq('status', 'scheduled')
    .select('id');
  if (error) return NextResponse.json({ error: 'Could not cancel' }, { status: 500 });
  if (!data || data.length === 0) {
    return NextResponse.json({ error: 'This send has already started or is not scheduled' }, { status: 409 });
  }
  return NextResponse.json({ cancelled: true });
}

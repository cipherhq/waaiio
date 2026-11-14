import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requireCapability } from '@/lib/capabilities/api-guard';
import { isCalendarDate } from '@/lib/bot/flows/shared/typed-date';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function localTime(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(value)
    && isCalendarDate(value.slice(0, 10));
}

async function authorize(businessId: unknown, action: 'read_history' | 'create_new' | 'manage_existing') {
  const client = await createClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (typeof businessId !== 'string' || !UUID.test(businessId)) {
    return { error: NextResponse.json({ error: 'Invalid business' }, { status: 400 }) };
  }
  const service = createServiceClient();
  const guard = await requireCapability(client, service, { businessId, userId: user.id, capability: 'table_reservation', action });
  if (!guard.allowed) return { error: NextResponse.json(guard.denial, { status: guard.status }) };
  return { service, user, businessId };
}

export async function GET(request: NextRequest) {
  const auth = await authorize(request.nextUrl.searchParams.get('businessId'), 'read_history');
  if (auth.error) return auth.error;
  const holds = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await auth.service!.from('seating_holds').select('*')
      .eq('business_id', auth.businessId!).is('released_at', null).order('id').range(offset, offset + pageSize - 1);
    if (error) return NextResponse.json({ error: 'Unable to load holds. Try again.' }, { status: 500 });
    holds.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return NextResponse.json({ data: holds.sort((a, b) => a.starts_at.localeCompare(b.starts_at)) });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const auth = await authorize(body?.businessId, 'create_new');
  if (auth.error) return auth.error;
  if (!UUID.test(body.groupId || '') || !Array.isArray(body.resourceIds) || !body.resourceIds.length
    || body.resourceIds.some((id: unknown) => typeof id !== 'string' || !UUID.test(id))
    || !localTime(body.start) || !localTime(body.end) || body.start >= body.end
    || typeof body.wholeResource !== 'boolean' || typeof body.label !== 'string'
    || !body.label.trim() || body.label.trim().length > 100
    || (!body.wholeResource && (!Number.isInteger(body.seats) || body.seats < 1 || body.seats > 500))) {
    return NextResponse.json({ error: 'Unable to save hold. Try again.' }, { status: 400 });
  }
  const { data, error } = await auth.service!.rpc('create_seating_hold', {
    p_business_id: auth.businessId!, p_actor_id: auth.user!.id, p_group_id: body.groupId,
    p_resource_ids: body.resourceIds, p_start: body.start, p_end: body.end,
    p_seats: body.wholeResource ? null : body.seats, p_whole_resource: body.wholeResource, p_label: body.label.trim(),
  });
  if (error) {
    const conflict = error.code === '23514' || error.code === '40001';
    return NextResponse.json({ error: error.code === '40001' ? 'This resource changed. Try again.' : conflict
      ? 'These seats are no longer available. Choose another time or resource.'
      : 'Unable to save hold. Try again.' }, { status: conflict ? 409 : 500 });
  }
  return NextResponse.json({ data }, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const auth = await authorize(body?.businessId, 'manage_existing');
  if (auth.error) return auth.error;
  if (!UUID.test(body.groupId || '')) return NextResponse.json({ error: 'Invalid hold' }, { status: 400 });
  const { error } = await auth.service!.rpc('release_seating_hold', {
    p_business_id: auth.businessId!, p_actor_id: auth.user!.id, p_group_id: body.groupId,
  });
  if (error) return NextResponse.json({ error: 'Unable to release hold. Try again.' }, { status: 500 });
  return NextResponse.json({ success: true });
}

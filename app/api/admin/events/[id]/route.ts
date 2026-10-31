import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { adminCorsHeaders, resolveAdminOrigin } from '@/lib/admin-cors';
import { EVENT_UUID, EventMutationError, mutateEvent, parseEventMutation, readEventOperation } from '@/lib/events/event-mutation';

type Context = { params: Promise<{ id: string }> };
const METHODS = 'GET, PUT, OPTIONS';
function reply(request: NextRequest, body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { ...adminCorsHeaders(request.headers.get('origin'), METHODS), 'Cache-Control': 'no-store' } });
}
function originAllowed(request: NextRequest) {
  const origin = request.headers.get('origin');
  return !origin || !!resolveAdminOrigin(origin);
}
function failure(request: NextRequest, error: unknown) {
  if (error instanceof EventMutationError) return reply(request, { success: false, code: error.code, error: error.message }, error.status);
  return reply(request, { success: false, code: 'outcome_unknown', error: 'Could not confirm the event operation. Check its outcome before retrying.' }, 500);
}
export async function OPTIONS(request: NextRequest) {
  return reply(request, {}, originAllowed(request) ? 200 : 403);
}
export async function PUT(request: NextRequest, { params }: Context) {
  try {
    if (!originAllowed(request)) return reply(request, { error: 'Origin not allowed' }, 403);
    const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
    if (!admin) return reply(request, { error: 'Unauthorized' }, 403);
    const { id } = await params;
    if (!EVENT_UUID.test(id)) return reply(request, { error: 'Invalid event ID' }, 400);
    let body: unknown;
    try { body = await request.json(); } catch { return reply(request, { error: 'Invalid JSON body' }, 400); }
    const input = parseEventMutation(body);
    return reply(request, await mutateEvent(createServiceClient(), id, input, { id: admin.userId, kind: 'admin' }));
  } catch (error) { return failure(request, error); }
}
export async function GET(request: NextRequest, { params }: Context) {
  try {
    if (!originAllowed(request)) return reply(request, { error: 'Origin not allowed' }, 403);
    const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
    if (!admin) return reply(request, { error: 'Unauthorized' }, 403);
    const { id } = await params;
    if (!EVENT_UUID.test(id)) return reply(request, { error: 'Invalid event ID' }, 400);
    const service = createServiceClient();
    const { data: event, error } = await service.from('events').select('*').eq('id', id).maybeSingle();
    if (error) return reply(request, { error: 'Could not load event', code: 'readback_unavailable' }, 503);
    if (!event) return reply(request, { error: 'Event not found', code: 'not_found' }, 404);
    const operationId = request.nextUrl.searchParams.get('operation_id');
    if (operationId) return reply(request, await readEventOperation(service, id, event.business_id, operationId));
    return reply(request, { success: true, event, cancelled: event.status === 'cancelled' });
  } catch (error) { return failure(request, error); }
}

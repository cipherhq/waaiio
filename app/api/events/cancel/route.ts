import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { EVENT_UUID, EventMutationError, mutateEvent, parseEventMutation, readEventOperation } from '@/lib/events/event-mutation';

function failure(error: unknown) {
  if (error instanceof EventMutationError) return NextResponse.json({ success: false, code: error.code, error: error.message }, { status: error.status });
  return NextResponse.json({ success: false, code: 'outcome_unknown', error: 'Could not confirm the cancellation. Check its outcome before retrying.' }, { status: 500 });
}
async function ownedEvent(eventId: unknown) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) throw new EventMutationError('unauthorized', 401, 'Unauthorized');
  if (typeof eventId !== 'string' || !EVENT_UUID.test(eventId)) throw new EventMutationError('invalid_event', 400, 'Invalid event ID');
  const { data: event, error } = await supabase.from('events')
    .select('id,business_id,name,date,time,venue,price,status,updated_at,businesses!inner(owner_id)')
    .eq('id', eventId).maybeSingle();
  if (error) throw new EventMutationError('readback_unavailable', 503, 'Could not load event');
  if (!event) throw new EventMutationError('not_found', 404, 'Event not found');
  const business = event.businesses as unknown as { owner_id: string };
  if (business?.owner_id !== user.id) throw new EventMutationError('forbidden', 403, 'Forbidden');
  return { event, user };
}
/** Owner-authorized cancellation; uses the same transaction as Admin Save/Cancel. */
export async function POST(request: NextRequest) {
  try {
    let body: Record<string, unknown>;
    try {
      const value = await request.json();
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
      body = value;
    } catch { throw new EventMutationError('invalid_request', 400, 'Invalid JSON body'); }
    const allowed = new Set(['event_id', 'business_id', 'expected_updated_at', 'operation_id', 'changes']);
    if (Object.keys(body).some(key => !allowed.has(key))) throw new EventMutationError('invalid_request', 400, 'Unexpected request field');
    const { event, user } = await ownedEvent(body.event_id);
    const service = createServiceClient();
    // Preserve event_id-only callers without repeating historical cancellation effects.
    if (!body.operation_id && event.status === 'cancelled') {
      const { data: operation, error } = await service.from('event_mutation_operations')
        .select('id').eq('event_id', event.id).eq('business_id', event.business_id).eq('is_cancellation', true).maybeSingle();
      if (error) throw new EventMutationError('readback_unavailable', 503, 'Could not check cancellation history');
      if (!operation) throw new EventMutationError('legacy_cancellation_unverified', 409, 'This event was previously cancelled; its notification history cannot be verified.');
      return NextResponse.json(await readEventOperation(service, event.id, event.business_id, operation.id));
    }
    const input = parseEventMutation({
      business_id: body.business_id ?? event.business_id,
      expected_updated_at: 'expected_updated_at' in body ? body.expected_updated_at : event.updated_at,
      operation_id: body.operation_id ?? crypto.randomUUID(),
      changes: body.changes ?? { status: 'cancelled' },
    }, false);
    if (input.business_id !== event.business_id) throw new EventMutationError('identity_mismatch', 403, 'Event and business do not match');
    if (input.changes.status !== 'cancelled') throw new EventMutationError('invalid_changes', 400, 'This endpoint only cancels events');
    return NextResponse.json(await mutateEvent(service, event.id, input, { id: user.id, kind: 'merchant' }));
  } catch (error) { return failure(error); }
}
/** Read-only recovery after a lost cancellation response; no notification dispatch. */
export async function GET(request: NextRequest) {
  try {
    const { event } = await ownedEvent(request.nextUrl.searchParams.get('event_id'));
    const operationId = request.nextUrl.searchParams.get('operation_id');
    if (!operationId) return NextResponse.json({ success: true, event, cancelled: event.status === 'cancelled' }, { headers: { 'Cache-Control': 'no-store' } });
    return NextResponse.json(await readEventOperation(createServiceClient(), event.id, event.business_id, operationId), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return failure(error); }
}

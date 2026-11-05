import type { SupabaseClient } from '@supabase/supabase-js';
import { dispatchEventCancellation, readCancellationNotifications, type CancellationNotifications } from './event-cancellation-notifications';

export const EVENT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIELDS = ['name', 'date', 'time', 'venue', 'price', 'status'] as const;
const STATUSES = new Set(['draft', 'published', 'sold_out', 'cancelled', 'completed']);

export interface EventRecord {
  id: string; business_id: string; name: string; date: string; time: string | null;
  venue: string | null; price: number; status: string; updated_at: string;
  [key: string]: unknown;
}
export type EventChanges = Partial<Pick<EventRecord, typeof FIELDS[number]>>;
export interface EventMutationInput {
  business_id: string;
  expected_updated_at: string | null;
  operation_id: string;
  changes: EventChanges;
}
export interface EventMutationResult {
  success: true;
  committed: true;
  event: EventRecord;
  operation_id: string;
  /** True only for the operation that cancelled the event (including its replay). */
  cancelled: boolean;
  cancelled_tickets: number;
  refunds_pending: number;
  notifications: CancellationNotifications;
  replayed?: boolean;
}
export class EventMutationError extends Error {
  constructor(public code: string, public status: number, message: string) { super(message); }
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function invalid(message: string): never {
  throw new EventMutationError('invalid_request', 400, message);
}
export function parseEventMutation(value: unknown, requireAllFields = true): EventMutationInput {
  if (!object(value)) invalid('Invalid request body');
  const allowed = new Set(['business_id', 'expected_updated_at', 'operation_id', 'changes']);
  if (Object.keys(value).some(key => !allowed.has(key))) invalid('Unexpected request field');
  if (typeof value.business_id !== 'string' || !EVENT_UUID.test(value.business_id)) invalid('Invalid business ID');
  if (typeof value.operation_id !== 'string' || !EVENT_UUID.test(value.operation_id)) invalid('Invalid operation ID');
  const revision = value.expected_updated_at;
  if (revision !== null && (typeof revision !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(revision) ||
      !Number.isFinite(Date.parse(revision)))) invalid('Invalid event revision');
  if (!object(value.changes) || !Object.keys(value.changes).length) invalid('Changes are required');
  const changes = value.changes;
  if (Object.keys(changes).some(key => !(FIELDS as readonly string[]).includes(key))) invalid('Unexpected event field');
  if (requireAllFields && FIELDS.some(key => !(key in changes))) invalid('All six event fields are required');
  if ('name' in changes && (typeof changes.name !== 'string' || !changes.name.trim() || changes.name.length > 300)) invalid('Name must contain 1–300 characters');
  if ('venue' in changes && changes.venue !== null && (typeof changes.venue !== 'string' || changes.venue.length > 300)) invalid('Venue must contain at most 300 characters');
  if ('date' in changes) {
    if (typeof changes.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(changes.date)) invalid('Use a valid calendar date');
    const parsed = new Date(changes.date + 'T00:00:00.000Z');
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== changes.date) invalid('Use a valid calendar date');
  }
  if ('time' in changes && changes.time !== null &&
      (typeof changes.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,6})?)?$/.test(changes.time))) invalid('Use a valid time');
  if ('price' in changes && (typeof changes.price !== 'number' || !Number.isInteger(changes.price) || changes.price < 0 || changes.price > 2147483647)) invalid('Price must be a nonnegative integer');
  if ('status' in changes && (typeof changes.status !== 'string' || !STATUSES.has(changes.status))) invalid('Invalid event status');
  return { business_id: value.business_id, operation_id: value.operation_id, expected_updated_at: revision as string | null, changes: changes as EventChanges };
}
interface PersistedResult {
  success: boolean; reason?: string; event?: EventRecord; operation_id?: string; cancelled?: boolean;
  counts?: { cancelled_tickets?: number; recipients?: number; refunds_pending?: number };
  replayed?: boolean;
}
function checkedResult(value: unknown, eventId: string, businessId: string): PersistedResult & { event: EventRecord; operation_id: string } {
  const result = value as PersistedResult | null;
  if (result?.success !== true) {
    const reason = result?.reason || 'persistence_unconfirmed';
    const statuses: Record<string, number> = { not_found: 404, identity_mismatch: 403, invalid_changes: 400,
      revision_conflict: 409, operation_conflict: 409, event_cancellation_final: 409, legacy_cancellation_unverified: 409 };
    const messages: Record<string, string> = {
      revision_conflict: 'This event changed. Reload it before saving.',
      operation_conflict: 'This operation ID belongs to a different request.',
      event_cancellation_final: 'Cancellation is final. Create a new event to restart.',
      legacy_cancellation_unverified: 'This event was previously cancelled; its notification history cannot be verified.',
      not_found: 'Event not found', identity_mismatch: 'Event and business do not match',
    };
    throw new EventMutationError(reason, statuses[reason] || 500, messages[reason] || 'Event persistence could not be confirmed');
  }
  if (!result.event || result.event.id !== eventId || result.event.business_id !== businessId ||
      !result.operation_id || !EVENT_UUID.test(result.operation_id)) {
    throw new EventMutationError('persistence_unconfirmed', 500, 'Event persistence could not be confirmed');
  }
  return result as PersistedResult & { event: EventRecord; operation_id: string };
}
const noCancellationEffects = (): CancellationNotifications => ({ accepted: 0, pending: 0, failed: 0, ambiguous: 0, total: 0 });
function response(result: PersistedResult & { event: EventRecord; operation_id: string }, notifications: CancellationNotifications): EventMutationResult {
  return { success: true, committed: true, event: result.event, operation_id: result.operation_id,
    cancelled: result.cancelled === true, cancelled_tickets: result.counts?.cancelled_tickets || 0,
    refunds_pending: result.counts?.refunds_pending || 0, notifications, replayed: result.replayed };
}
export async function mutateEvent(
  service: SupabaseClient, eventId: string, input: EventMutationInput,
  actor: { id: string; kind: 'admin' | 'merchant' },
): Promise<EventMutationResult> {
  if (!EVENT_UUID.test(eventId)) invalid('Invalid event ID');
  const { data, error } = await service.rpc('mutate_event', {
    p_event_id: eventId, p_business_id: input.business_id, p_actor_id: actor.id, p_actor_kind: actor.kind,
    p_expected_updated_at: input.expected_updated_at, p_operation_id: input.operation_id, p_changes: input.changes,
  });
  if (error) throw new EventMutationError('persistence_unconfirmed', 500, 'Save outcome could not be confirmed. Check the operation before retrying.');
  const result = checkedResult(data, eventId, input.business_id);
  for (const [key, expected] of Object.entries(input.changes)) {
    const actual = result.event[key];
    const time = (value: unknown) => typeof value === 'string' && /^\d{2}:\d{2}$/.test(value) ? value + ':00' : value;
    if ((key === 'time' ? time(actual) !== time(expected) : actual !== expected)) {
      throw new EventMutationError('persistence_unconfirmed', 500, 'The persisted event did not match the requested changes. Check the operation before retrying.');
    }
  }
  // The transaction has committed. Delivery problems must never become an unsaved response.
  let notifications: CancellationNotifications;
  try {
    notifications = result.cancelled
      ? await dispatchEventCancellation(service, result.operation_id, result.event)
      : noCancellationEffects();
  } catch {
    notifications = { accepted: 0, pending: 0, failed: 0, ambiguous: 0, total: 0, unavailable: true };
  }
  return response(result, notifications);
}
export async function readEventOperation(
  service: SupabaseClient, eventId: string, businessId: string, operationId: string,
): Promise<EventMutationResult> {
  if (!EVENT_UUID.test(operationId)) invalid('Invalid operation ID');
  const { data, error } = await service.from('event_mutation_operations')
    .select('response_payload').eq('id', operationId).eq('event_id', eventId).eq('business_id', businessId).maybeSingle();
  if (error) throw new EventMutationError('readback_unavailable', 503, 'Could not check the save outcome');
  if (!data) throw new EventMutationError('operation_not_found', 404, 'No committed operation was found');
  const result = checkedResult(data.response_payload, eventId, businessId);
  let notifications: CancellationNotifications;
  try { notifications = result.cancelled === true ? await readCancellationNotifications(service, operationId) : noCancellationEffects(); }
  catch { notifications = { accepted: 0, pending: 0, failed: 0, ambiguous: 0, total: 0, unavailable: true }; }
  return response({ ...result, replayed: true }, notifications);
}

import type { SupabaseClient } from '@supabase/supabase-js';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { MetaApiError } from '@/lib/channels/meta-api-error';
import type { EventRecord } from './event-mutation';

export interface CancellationNotifications {
  accepted: number; pending: number; failed: number; ambiguous: number; total: number; unavailable?: boolean;
}
export async function readCancellationNotifications(service: SupabaseClient, operationId: string): Promise<CancellationNotifications> {
  const result: CancellationNotifications = { accepted: 0, pending: 0, failed: 0, ambiguous: 0, total: 0 };
  for (let start = 0; ; start += 1000) {
    const { data, error } = await service.from('event_cancellation_recipients').select('state')
      .eq('operation_id', operationId).order('id').range(start, start + 999);
    if (error) return { ...result, unavailable: true };
    for (const row of data || []) {
      result.total++;
      if (row.state === 'accepted') result.accepted++;
      else if (row.state === 'failed') result.failed++;
      else if (row.state === 'attempted' || row.state === 'ambiguous') result.ambiguous++;
      else result.pending++;
    }
    if (!data || data.length < 1000) return result;
  }
}
async function finalize(
  service: SupabaseClient, id: string, token: string,
  state: 'pending' | 'accepted' | 'failed' | 'ambiguous', messageId: string | null = null,
): Promise<boolean> {
  // Database-only retry: never re-emit after a provider attempt.
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, error } = await service.rpc('finalize_event_cancellation_notification', {
      p_recipient_id: id, p_claim_token: token, p_state: state, p_provider_message_id: messageId,
    });
    if (!error && data?.finalized === true) return true;
  }
  return false;
}
/** Bounded work per authorized request. Subsequent mutation replay resumes only unattempted work. */
export async function dispatchEventCancellation(
  service: SupabaseClient, operationId: string, event: EventRecord,
): Promise<CancellationNotifications> {
  const { data: recipients, error } = await service.from('event_cancellation_recipients')
    .select('id').eq('operation_id', operationId)
    .or('state.eq.pending,and(state.eq.claimed,claim_expires_at.lt.' + new Date().toISOString() + ')')
    .order('id').limit(20);
  if (error) return { accepted: 0, pending: 0, failed: 0, ambiguous: 0, total: 0, unavailable: true };
  if (!recipients?.length) return readCancellationNotifications(service, operationId);
  let resolved;
  try { resolved = await new ChannelResolver(service).resolveByBusinessId(event.business_id); }
  catch { return readCancellationNotifications(service, operationId); }
  if (!resolved?.sender) return readCancellationNotifications(service, operationId);
  const message = 'Event "' + event.name + '" on ' + event.date +
    ' has been cancelled. A refund will be processed if applicable. We apologize for any inconvenience.';
  for (const recipient of recipients) {
    const { data: claim, error: claimError } = await service.rpc('claim_event_cancellation_notification', {
      p_recipient_id: recipient.id,
    });
    if (claimError || claim?.claimed !== true || !claim.claim_token ||
        claim.operation_id !== operationId || !claim.recipient_phone) continue;
    const token = claim.claim_token as string;
    const { data: marked, error: markError } = await service.rpc('mark_event_cancellation_notification_attempted', {
      p_recipient_id: recipient.id, p_claim_token: token,
    });
    if (markError || marked?.marked !== true) continue;
    try {
      const result = await resolved.sender.sendText({
        to: claim.recipient_phone, text: message, noRetry: true, messageCategory: 'service',
      });
      if (result?.messageId) await finalize(service, recipient.id, token, 'accepted', result.messageId);
      else await finalize(service, recipient.id, token, 'ambiguous');
    } catch (error) {
      // A transport/5xx failure may have emitted. Never turn it into replay permission.
      const state = error instanceof MetaApiError && error.httpStatus >= 400 && error.httpStatus < 500
        ? 'failed' : 'ambiguous';
      await finalize(service, recipient.id, token, state);
    }
  }
  return readCancellationNotifications(service, operationId);
}

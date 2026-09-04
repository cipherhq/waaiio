/**
 * Edge Function attempt recording (#257)
 *
 * Deno-compatible shared boundary for recording message send attempts.
 * Each Edge Function wraps its Meta fetch() call with this helper.
 *
 * Gate OFF (default): recording failure does not block send.
 * Gate ON: recording failure blocks send (zero Meta emission).
 */

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

let gateEnabled = false;

export function setEdgeAttemptGate(enabled: boolean): void {
  gateEnabled = enabled;
}

/**
 * Record an attempt and execute the Meta send.
 * Wraps: INSERT attempt → mark sending → Meta fetch → link WAMID / mark failed.
 */
export async function withEdgeAttemptRecording(
  supabase: SupabaseClient,
  params: {
    businessId: string;
    recipientPhone: string;
    phoneNumberId?: string;
    templateName?: string;
    flowType?: string;
  },
  metaFetch: () => Promise<Response>,
): Promise<{ ok: boolean; wamid?: string }> {
  // 1. Create attempt
  let attemptId: string | null = null;
  try {
    const { data, error } = await supabase
      .from('message_send_attempts')
      .insert({
        business_id: params.businessId,
        attempt_scope: 'business',
        recipient_phone: params.recipientPhone,
        phone_number_id: params.phoneNumberId || null,
        template_name: params.templateName || null,
        flow_type: params.flowType || 'edge_function',
        status: 'pending_authorization',
        financial_disposition: 'pending_authorization',
      })
      .select('id')
      .single();

    if (error) throw error;
    attemptId = data.id;
  } catch (err) {
    if (gateEnabled) {
      console.error('[ATTEMPT] Gate ON: failed to create attempt — zero Meta emission:', err);
      return { ok: false };
    }
    console.warn('[ATTEMPT] Gate OFF: failed to create attempt, send proceeds:', err);
  }

  // 2. Mark sending (durable pre-emission)
  if (attemptId) {
    const { error: sendingErr } = await supabase
      .from('message_send_attempts')
      .update({ status: 'sending', sent_at: new Date().toISOString() })
      .eq('id', attemptId);

    if (sendingErr && gateEnabled) {
      console.error('[ATTEMPT] Gate ON: failed to mark sending — zero Meta emission:', sendingErr);
      return { ok: false };
    }
  }

  // 3. Execute Meta fetch
  let response: Response;
  try {
    response = await metaFetch();
  } catch (err) {
    // Transport failure — mark failed or ambiguous
    if (attemptId) {
      const errStr = String(err).toLowerCase();
      const isAmbiguous = /abort|timeout|econnreset|socket hang up/.test(errStr);
      await supabase
        .from('message_send_attempts')
        .update({
          status: isAmbiguous ? 'ambiguous' : 'failed_send',
          needs_reconciliation: isAmbiguous,
        })
        .eq('id', attemptId);
    }
    throw err;
  }

  // 4. Process response
  if (!response.ok) {
    if (attemptId) {
      await supabase
        .from('message_send_attempts')
        .update({ status: 'failed_send' })
        .eq('id', attemptId);
    }
    return { ok: false };
  }

  // 5. Link WAMID
  let wamid: string | undefined;
  try {
    const body = await response.json();
    wamid = body?.messages?.[0]?.id;
  } catch {
    // Response parse failure — message was sent but WAMID unknown
  }

  if (attemptId) {
    const { error: acceptErr } = await supabase
      .from('message_send_attempts')
      .update({
        status: 'accepted',
        meta_message_id: wamid || null,
        meta_accepted_at: new Date().toISOString(),
        needs_reconciliation: !wamid,
      })
      .eq('id', attemptId);

    if (acceptErr) {
      // WAMID persistence failure — mark for reconciliation, don't resend
      await supabase
        .from('message_send_attempts')
        .update({ needs_reconciliation: true })
        .eq('id', attemptId)
        .then(() => {}, () => {});
      console.error(`[ATTEMPT] WAMID persistence failed: attempt=${attemptId} wamid=${wamid}`);
    }
  }

  return { ok: true, wamid };
}

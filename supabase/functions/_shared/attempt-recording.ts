/**
 * Edge Function attempt recording (#257)
 *
 * Runtime-neutral shared boundary — works in both Deno and Node test.
 * Each Edge Function wraps its Meta send with withEdgeAttemptRecording.
 *
 * Lifecycle: attempt INSERT → #256 suspension guard → durable sending → Meta fetch → link WAMID.
 * Suspension blocks create a non-send attempt (stays pending_authorization) + zero Meta fetch.
 */

// Type-only import for SupabaseClient — works in both runtimes
type SupabaseClient = {
  from(table: string): {
    insert(data: Record<string, unknown>): { select(): { single(): Promise<{ data: { id: string } | null; error: unknown }> | { data: { id: string } | null; error: unknown } } };
    update(data: Record<string, unknown>): { eq(col: string, val: string): Promise<{ error: unknown }> | { error: unknown } };
    select(cols: string): { eq(col: string, val: string): { maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: unknown }> | { data: Record<string, unknown> | null; error: unknown } } };
  };
};

let gateEnabled = false;
export function setEdgeAttemptGate(enabled: boolean): void { gateEnabled = enabled; }

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
  /** #256 suspension check — must run AFTER attempt creation, BEFORE Meta fetch */
  suspensionCheck?: () => Promise<boolean>,
): Promise<{ ok: boolean; wamid?: string; attemptId?: string }> {
  // 1. Create attempt (before guard)
  let attemptId: string | null = null;
  try {
    const result = await supabase
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
      .select()
      .single();

    if (result.error) throw result.error;
    attemptId = result.data?.id || null;
  } catch (err) {
    if (gateEnabled) {
      console.error('[ATTEMPT] Gate ON: failed to create attempt — zero Meta emission:', err);
      return { ok: false };
    }
    console.warn('[ATTEMPT] Gate OFF: failed to create attempt, send proceeds:', err);
  }

  // 2. #256 suspension guard (after attempt, before emission)
  if (suspensionCheck) {
    const allowed = await suspensionCheck();
    if (!allowed) {
      // Attempt stays pending_authorization — no Meta emission occurred
      return { ok: false, attemptId: attemptId || undefined };
    }
  }

  // 3. Mark sending (durable pre-emission)
  if (attemptId) {
    const sendingResult = await supabase
      .from('message_send_attempts')
      .update({ status: 'sending', sent_at: new Date().toISOString() })
      .eq('id', attemptId);

    if (sendingResult.error && gateEnabled) {
      console.error('[ATTEMPT] Gate ON: failed to mark sending — zero Meta emission:', sendingResult.error);
      return { ok: false, attemptId: attemptId || undefined };
    }
  }

  // 4. Meta fetch
  let response: Response;
  try {
    response = await metaFetch();
  } catch (err) {
    if (attemptId) {
      const errStr = String(err).toLowerCase();
      const isAmbiguous = /abort|timeout|econnreset|socket hang up/.test(errStr);
      await supabase.from('message_send_attempts')
        .update({ status: isAmbiguous ? 'ambiguous' : 'failed_send', needs_reconciliation: isAmbiguous })
        .eq('id', attemptId);
    }
    throw err;
  }

  // 5. Process response
  if (!response.ok) {
    if (attemptId) {
      await supabase.from('message_send_attempts').update({ status: 'failed_send' }).eq('id', attemptId);
    }
    return { ok: false, attemptId: attemptId || undefined };
  }

  // 6. Link WAMID
  let wamid: string | undefined;
  try {
    const body = await response.json();
    wamid = body?.messages?.[0]?.id;
  } catch { /* response parse failure */ }

  if (attemptId) {
    const acceptResult = await supabase.from('message_send_attempts')
      .update({ status: 'accepted', meta_message_id: wamid || null, meta_accepted_at: new Date().toISOString(), needs_reconciliation: !wamid })
      .eq('id', attemptId);

    if (acceptResult.error) {
      // WAMID persistence failure — try reconciliation fallback
      try {
        await supabase.from('message_send_attempts').update({ needs_reconciliation: true }).eq('id', attemptId);
      } catch { /* best-effort */ }
      console.error(`[ATTEMPT] WAMID persistence failed: attempt=${attemptId} wamid=${wamid}`);
    }
  }

  return { ok: true, wamid, attemptId: attemptId || undefined };
}

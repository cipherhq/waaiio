/**
 * Edge Function attempt recording (#257) + financial authorization (#261)
 *
 * Runtime-neutral shared boundary — works in both Deno and Node test.
 * Each Edge Function wraps its Meta send with withEdgeAttemptRecording.
 *
 * Lifecycle:
 *   attempt INSERT → context (country + category) → #256 suspension guard →
 *   #261 financial authorization → durable sending → Meta fetch →
 *   link WAMID → drain unmatched statuses.
 *
 * Financial gate OFF: explicit enforcement_required=false → send proceeds, zero encumbrance.
 * Financial gate ON: authorized=true → reservation exists; authorized=false → zero Meta emission.
 * Any RPC/DB error or unexpected response → fail closed (zero Meta emission).
 * Provider failure after reservation → immediate release via settle_message_cost.
 * Ambiguous transport → remains reserved (reconciliation required).
 */

// Type-only import for SupabaseClient — works in both runtimes
type SupabaseClient = {
  from(table: string): {
    insert(data: Record<string, unknown>): { select(): { single(): Promise<{ data: { id: string } | null; error: unknown }> | { data: { id: string } | null; error: unknown } } };
    update(data: Record<string, unknown>): { eq(col: string, val: string): Promise<{ error: unknown }> | { error: unknown } };
    select(cols: string): { eq(col: string, val: string): { maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: unknown }> | { data: Record<string, unknown> | null; error: unknown } } };
  };
  rpc(fn: string, params: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
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
    messageCategory?: string;
    /** Canonical country resolver — injected by caller from _shared/phone-country.ts */
    resolveCountry?: (phone: string) => Promise<string | null> | string | null;
  },
  metaFetch: () => Promise<Response>,
  /** #256 suspension check — must run AFTER attempt creation, BEFORE Meta fetch */
  suspensionCheck?: () => Promise<boolean>,
): Promise<{ ok: boolean; wamid?: string; attemptId?: string }> {
  // 1. Create attempt (before guard)
  // #261: Attempt creation MUST succeed for business-scoped sends.
  // Without an attempt, financial authorization cannot run — fail closed.
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
    // #261: Attempt creation failure is always fatal for business sends.
    // Financial authorization requires the attempt row — zero Meta emission.
    console.error('[EDGE-ATTEMPT] Failed to create attempt — zero Meta emission:', err);
    return { ok: false };
  }

  if (!attemptId) {
    console.error('[EDGE-ATTEMPT] Attempt created but no ID returned — zero Meta emission');
    return { ok: false };
  }

  // 2. #261: Update attempt context (recipient country + message category)
  const resolveCountry = params.resolveCountry;
  const recipientCountryCode = resolveCountry
    ? await resolveCountry(params.recipientPhone)
    : null;
  const messageCategory = params.messageCategory || null;
  try {
    await supabase.from('message_send_attempts')
      .update({
        ...(recipientCountryCode ? { recipient_country_code: recipientCountryCode } : {}),
        ...(messageCategory ? { message_category: messageCategory } : {}),
      })
      .eq('id', attemptId);
  } catch {
    // Best-effort context update — does not block the send
  }

  // 3. #256 suspension guard (after attempt, before emission)
  if (suspensionCheck) {
    const allowed = await suspensionCheck();
    if (!allowed) {
      // Attempt stays pending_authorization — no Meta emission, no financial encumbrance
      return { ok: false, attemptId: attemptId || undefined };
    }
  }

  // 4. #261: Financial authorization gate
  // Fail-closed: ANY RPC/DB error => zero Meta emission. Only explicit
  // enforcement_required: false from a successful RPC call may skip authorization.
  let wasReserved = false;
  if (attemptId) {
    try {
      const { data: authResult, error: authError } = await supabase.rpc(
        'check_or_authorize_send', { p_attempt_id: attemptId },
      );

      if (authError) {
        console.error('[EDGE-ATTEMPT] check_or_authorize_send RPC error — fail closed:', authError.message);
        return { ok: false, attemptId };
      } else if (authResult) {
        const result = authResult as Record<string, unknown>;
        if (result.enforcement_required === false) {
          // Gate OFF: proceed (explicit successful response, zero encumbrance)
        } else if (result.authorized === true) {
          // Gate ON, authorized: reservation exists
          wasReserved = true;
        } else if (result.authorized === false) {
          // Gate ON, rejected: zero Meta emission
          console.warn(`[EDGE-ATTEMPT] Financial authorization denied: ${result.reason || 'unknown'}`);
          return { ok: false, attemptId };
        } else {
          // Unexpected response shape: fail closed
          console.error('[EDGE-ATTEMPT] check_or_authorize_send unexpected response — fail closed:', JSON.stringify(result));
          return { ok: false, attemptId };
        }
      } else {
        // Null data with no error: fail closed
        console.error('[EDGE-ATTEMPT] check_or_authorize_send returned null — fail closed');
        return { ok: false, attemptId };
      }
    } catch (finErr) {
      console.error('[EDGE-ATTEMPT] Financial authorization check failed — fail closed:', (finErr as Error).message);
      return { ok: false, attemptId };
    }
  }

  // 5. Mark sending (durable pre-emission)
  // #261: markSending MUST succeed for business sends — the attempt row
  // is authoritative. Cross-state trigger rejects if reservation was released.
  const sendingResult = await supabase
    .from('message_send_attempts')
    .update({ status: 'sending', sent_at: new Date().toISOString() })
    .eq('id', attemptId);

  if (sendingResult.error) {
    console.error('[EDGE-ATTEMPT] Failed to mark sending — zero Meta emission:', sendingResult.error);
    return { ok: false, attemptId };
  }

  // 6. Meta fetch
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
      // #261: Release reservation on non-ambiguous provider failure
      if (wasReserved && !isAmbiguous) {
        await settleEdgeAttempt(supabase, attemptId, 'released');
      }
      // Ambiguous: remains reserved — reconciliation required
    }
    throw err;
  }

  // 7. Process non-OK response
  if (!response.ok) {
    if (attemptId) {
      await supabase.from('message_send_attempts').update({ status: 'failed_send' }).eq('id', attemptId);
      // #261: Release reservation on deterministic provider failure
      if (wasReserved) {
        await settleEdgeAttempt(supabase, attemptId, 'released');
      }
    }
    return { ok: false, attemptId: attemptId || undefined };
  }

  // 8. Link WAMID
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
      console.error(`[EDGE-ATTEMPT] WAMID persistence failed: attempt=${attemptId} wamid=${wamid}`);
    }

    // #261: Drain any unmatched delivery statuses that arrived before WAMID linkage
    if (wamid) {
      try {
        await supabase.rpc('drain_unmatched_attempt_statuses', {
          p_attempt_id: attemptId,
          p_meta_message_id: wamid,
        });
      } catch {
        // Best-effort — race-safe via FOR UPDATE SKIP LOCKED in the RPC
      }
    }
  }

  return { ok: true, wamid, attemptId: attemptId || undefined };
}

/**
 * #261: Settle a message cost reservation via RPC.
 * On settlement failure: logs and marks needs_reconciliation = true.
 */
async function settleEdgeAttempt(
  supabase: SupabaseClient,
  attemptId: string,
  outcome: 'charged' | 'released',
): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc('settle_message_cost', {
      p_attempt_id: attemptId,
      p_outcome: outcome,
    });

    if (error) {
      console.error(`[EDGE-ATTEMPT] settle_message_cost(${outcome}) RPC error for attempt ${attemptId}: ${error.message}`);
      try {
        await supabase.from('message_send_attempts').update({ needs_reconciliation: true }).eq('id', attemptId);
      } catch { /* best-effort */ }
      return false;
    }

    const result = data as Record<string, unknown> | null;
    if (result && result.settled === false && result.reason !== 'already_terminally_settled') {
      console.warn(`[EDGE-ATTEMPT] settle_message_cost(${outcome}) rejected for attempt ${attemptId}: ${result.reason}`);
      try {
        await supabase.from('message_send_attempts').update({ needs_reconciliation: true }).eq('id', attemptId);
      } catch { /* best-effort */ }
      return false;
    }

    return true;
  } catch (err) {
    console.error(`[EDGE-ATTEMPT] settle_message_cost(${outcome}) exception for attempt ${attemptId}:`, (err as Error).message);
    try {
      await supabase.from('message_send_attempts').update({ needs_reconciliation: true }).eq('id', attemptId);
    } catch { /* best-effort */ }
    return false;
  }
}

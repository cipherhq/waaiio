/**
 * Terminal effect manifest client — typed wrappers for Phase A v15 RPCs.
 *
 * All functions accept a SupabaseClient (service_role) and return structured results.
 * These are thin wrappers; the DB RPCs enforce all authority/state-machine invariants.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

// ─── Payment context for determining applicable effects ───

interface PaymentContext {
  id: string;
  booking_id?: string | null;
  reservation_id?: string | null;
  order_id?: string | null;
  invoice_id?: string | null;
  campaign_id?: string | null;
}

/**
 * Determine the applicable Stage-3 effects for a payment based on its entity type
 * and available context (customer phone, email, sender, capabilities).
 */
export function computeApplicableEffects(
  payment: PaymentContext,
  opts: {
    hasCustomerPhone: boolean;
    hasGuestEmail?: boolean;
    hasSender?: boolean;
    hasLoyalty?: boolean;
    isTicketing?: boolean;
    skipLoyalty?: boolean;
    skipAutomation?: boolean;
    amountPaid?: number;
  },
): string[] {
  const effects: string[] = [];

  // Required external
  if (opts.hasCustomerPhone) effects.push('customer_whatsapp');
  effects.push('owner_notif_whatsapp');
  effects.push('owner_notif_email');
  if (payment.campaign_id) effects.push('donation_receipt_email');

  // Required internal
  if (payment.booking_id || payment.reservation_id || payment.campaign_id) {
    effects.push('owner_notif_inapp');
  }
  if (payment.invoice_id || payment.campaign_id) {
    effects.push('session_deactivation');
  }
  if (opts.hasLoyalty && !opts.skipLoyalty) effects.push('loyalty_award');
  if (opts.isTicketing) {
    effects.push('ticket_inventory_finalization');
    effects.push('ticket_row_creation');
  }

  // Optional
  effects.push('crm_visit_increment');
  effects.push('referral_generation');
  effects.push('membership_tier_assignment');
  effects.push('feedback_marker');
  if ((opts.amountPaid || 0) > 0) {
    effects.push('receipt_pdf_generation');
    if (opts.hasSender) effects.push('receipt_pdf_delivery');
  }
  if (opts.hasLoyalty && !opts.skipLoyalty && opts.hasSender) {
    effects.push('customer_loyalty_whatsapp');
  }
  if (!opts.skipAutomation) {
    effects.push('automation_rule_handoff');
    effects.push('automation_sequences');
  }
  if (payment.booking_id && opts.hasGuestEmail) effects.push('customer_booking_email');
  if (opts.isTicketing && opts.hasSender) effects.push('ticket_delivery_whatsapp');
  if (opts.isTicketing && opts.hasGuestEmail) effects.push('ticket_delivery_email');

  return effects;
}

// ─── Closed Stage-3 catalog (must match DB canonical mapping in migration 385) ───

interface EffectSpec {
  key: string;
  category: 'required_internal' | 'required_external' | 'optional';
  execution_class: 'internal' | 'external';
  provider_channel: string | null;
}

export const STAGE3_EFFECT_CATALOG: Record<string, EffectSpec> = {
  loyalty_award:                  { key: 'loyalty_award',                  category: 'required_internal',  execution_class: 'internal', provider_channel: null },
  ticket_inventory_finalization:  { key: 'ticket_inventory_finalization',  category: 'required_internal',  execution_class: 'internal', provider_channel: null },
  ticket_row_creation:            { key: 'ticket_row_creation',            category: 'required_internal',  execution_class: 'internal', provider_channel: null },
  session_deactivation:           { key: 'session_deactivation',           category: 'required_internal',  execution_class: 'internal', provider_channel: null },
  owner_notif_inapp:              { key: 'owner_notif_inapp',              category: 'required_internal',  execution_class: 'internal', provider_channel: null },
  customer_whatsapp:              { key: 'customer_whatsapp',              category: 'required_external',  execution_class: 'external', provider_channel: 'meta_whatsapp' },
  owner_notif_whatsapp:           { key: 'owner_notif_whatsapp',           category: 'required_external',  execution_class: 'external', provider_channel: 'meta_whatsapp' },
  owner_notif_email:              { key: 'owner_notif_email',              category: 'required_external',  execution_class: 'external', provider_channel: 'resend' },
  donation_receipt_email:         { key: 'donation_receipt_email',         category: 'required_external',  execution_class: 'external', provider_channel: 'resend' },
  customer_loyalty_whatsapp:      { key: 'customer_loyalty_whatsapp',      category: 'optional',           execution_class: 'external', provider_channel: 'meta_whatsapp' },
  receipt_pdf_generation:         { key: 'receipt_pdf_generation',         category: 'optional',           execution_class: 'internal', provider_channel: 'supabase_storage' },
  receipt_pdf_delivery:           { key: 'receipt_pdf_delivery',           category: 'optional',           execution_class: 'external', provider_channel: 'meta_whatsapp' },
  customer_booking_email:         { key: 'customer_booking_email',         category: 'optional',           execution_class: 'external', provider_channel: 'resend' },
  ticket_delivery_whatsapp:       { key: 'ticket_delivery_whatsapp',       category: 'optional',           execution_class: 'external', provider_channel: 'meta_whatsapp' },
  ticket_delivery_email:          { key: 'ticket_delivery_email',          category: 'optional',           execution_class: 'external', provider_channel: 'resend' },
  referral_generation:            { key: 'referral_generation',            category: 'optional',           execution_class: 'internal', provider_channel: null },
  crm_visit_increment:            { key: 'crm_visit_increment',            category: 'optional',           execution_class: 'internal', provider_channel: null },
  automation_rule_handoff:        { key: 'automation_rule_handoff',        category: 'optional',           execution_class: 'internal', provider_channel: null },
  automation_sequences:           { key: 'automation_sequences',           category: 'optional',           execution_class: 'internal', provider_channel: null },
  membership_tier_assignment:     { key: 'membership_tier_assignment',     category: 'optional',           execution_class: 'internal', provider_channel: null },
  feedback_marker:                { key: 'feedback_marker',                category: 'optional',           execution_class: 'internal', provider_channel: null },
};

// ─── Manifest initialization ───

export async function initializeManifest(
  supabase: SupabaseClient,
  paymentId: string,
  claimToken: string,
  applicableEffects: string[],
): Promise<{ ok: boolean; alreadyInitialized?: boolean; error?: string }> {
  const specs = applicableEffects.map(key => {
    const spec = STAGE3_EFFECT_CATALOG[key];
    if (!spec) throw new Error(`Unknown effect key: ${key}`);
    return spec;
  });

  const { data, error } = await supabase.rpc('initialize_terminal_effects', {
    p_payment_id: paymentId,
    p_claim_token: claimToken,
    p_effect_keys: specs.map(s => s.key),
    p_categories: specs.map(s => s.category),
    p_execution_classes: specs.map(s => s.execution_class),
    p_provider_channels: specs.map(s => s.provider_channel),
  });

  if (error) return { ok: false, error: error.message };
  if (data?.error) return { ok: false, error: data.error };
  return { ok: true, alreadyInitialized: data?.already_initialized === true };
}

// ─── Effect reservation ───

export async function reserveEffect(
  supabase: SupabaseClient,
  paymentId: string,
  effectKey: string,
  masterClaimToken: string,
): Promise<{ ok: boolean; effectToken?: string; error?: string }> {
  const { data, error } = await supabase.rpc('reserve_terminal_effect', {
    p_payment_id: paymentId,
    p_effect_key: effectKey,
    p_master_claim_token: masterClaimToken,
  });

  if (error) return { ok: false, error: error.message };
  if (!data?.reserved) return { ok: false, error: data?.reason };
  return { ok: true, effectToken: data.effect_token };
}

// ─── Completion RPCs ───

export async function completeInternal(
  supabase: SupabaseClient, paymentId: string, effectKey: string, effectToken: string,
): Promise<{ ok: boolean }> {
  const { data, error } = await supabase.rpc('complete_internal_effect', {
    p_payment_id: paymentId, p_effect_key: effectKey, p_effect_token: effectToken,
  });
  return { ok: !error && (data?.completed === true) };
}

export async function completeExternal(
  supabase: SupabaseClient, paymentId: string, effectKey: string, effectToken: string,
): Promise<{ ok: boolean }> {
  const { data, error } = await supabase.rpc('complete_external_effect', {
    p_payment_id: paymentId, p_effect_key: effectKey, p_effect_token: effectToken,
  });
  return { ok: !error && (data?.completed === true) };
}

export async function failExternal(
  supabase: SupabaseClient, paymentId: string, effectKey: string,
  effectToken: string, reason: string,
): Promise<{ ok: boolean }> {
  const { data, error } = await supabase.rpc('fail_external_effect', {
    p_payment_id: paymentId, p_effect_key: effectKey,
    p_effect_token: effectToken, p_failure_reason: reason,
  });
  return { ok: !error && (data?.failed === true) };
}

export async function markIndeterminate(
  supabase: SupabaseClient, paymentId: string, effectKey: string, effectToken: string,
): Promise<{ ok: boolean }> {
  const { data, error } = await supabase.rpc('mark_effect_indeterminate', {
    p_payment_id: paymentId, p_effect_key: effectKey, p_effect_token: effectToken,
  });
  return { ok: !error && (data?.marked === true) };
}

export async function skipOptional(
  supabase: SupabaseClient, paymentId: string, effectKey: string,
  effectToken: string, reason: string,
): Promise<{ ok: boolean }> {
  const { data, error } = await supabase.rpc('skip_optional_effect', {
    p_payment_id: paymentId, p_effect_key: effectKey,
    p_effect_token: effectToken, p_suppression_reason: reason,
  });
  return { ok: !error && (data?.skipped === true) };
}

// ─── Emission fence ───

export async function beginExternalEmission(
  supabase: SupabaseClient, paymentId: string, effectKey: string,
  masterClaimToken: string, effectToken: string,
): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await supabase.rpc('begin_terminal_external_emission', {
    p_payment_id: paymentId, p_effect_key: effectKey,
    p_master_claim_token: masterClaimToken, p_effect_token: effectToken,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: data?.authorized === true, error: data?.reason };
}

// ─── Rule-action seal ───

/**
 * Seal the payment's rule-action manifest. Handles concurrent UNIQUE loser:
 * if the seal fails with unique_violation, retries once to read the winner's manifest.
 * The caller MUST NOT re-evaluate current rules after a seal — use frozen rows only.
 */
export async function sealRuleActions(
  supabase: SupabaseClient,
  paymentId: string,
  actions: Array<{ rule_id: string; action_type: string; action_payload: object; action_fingerprint: string }>,
): Promise<{ ok: boolean; alreadySealed?: boolean; actionCount?: number }> {
  const { data, error } = await supabase.rpc('seal_payment_rule_actions', {
    p_payment_id: paymentId,
    p_actions: actions,
  });

  // Handle concurrent UNIQUE loser: unique_violation means another worker
  // already sealed. Retry once to get the winner's manifest.
  if (error && error.code === '23505') {
    const { data: retryData, error: retryErr } = await supabase.rpc('seal_payment_rule_actions', {
      p_payment_id: paymentId,
      p_actions: actions,
    });
    if (retryErr) return { ok: false };
    return {
      ok: retryData?.sealed === true,
      alreadySealed: retryData?.already_sealed === true,
      actionCount: retryData?.action_count,
    };
  }

  if (error) return { ok: false };
  return {
    ok: data?.sealed === true,
    alreadySealed: data?.already_sealed === true,
    actionCount: data?.action_count,
  };
}

/**
 * Read the frozen rule-action rows for execution (Phase 2).
 * NEVER re-reads bot_rules — uses only the sealed manifest.
 */
export async function readFrozenRuleActions(
  supabase: SupabaseClient,
  paymentId: string,
): Promise<Array<{ id: string; rule_id: string; action_type: string; action_payload: Record<string, unknown>; status: string }>> {
  const { data } = await supabase
    .from('payment_rule_action_executions')
    .select('id, rule_id, action_type, action_payload, status')
    .eq('payment_id', paymentId)
    .in('status', ['pending', 'sending']);
  return (data || []) as Array<{ id: string; rule_id: string; action_type: string; action_payload: Record<string, unknown>; status: string }>;
}

/**
 * Advance a rule action through its lifecycle via the SECURITY DEFINER RPC.
 * Legal transitions: pending→sending, pending→completed, sending→completed,
 * sending→indeterminate, pending→failed.
 */
export async function advanceRuleAction(
  supabase: SupabaseClient,
  paymentId: string,
  ruleId: string,
  targetStatus: 'sending' | 'completed' | 'indeterminate' | 'failed',
): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await supabase.rpc('advance_rule_action', {
    p_payment_id: paymentId,
    p_rule_id: ruleId,
    p_target_status: targetStatus,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: data?.advanced === true, error: data?.reason };
}

// ─── High-level effect lifecycle drivers ───

/**
 * Drive an internal effect through reserve → execute → complete.
 * If the effect doesn't exist in the manifest, returns ok:true (no-op for legacy/optional absence).
 */
export async function driveInternalEffect(
  supabase: SupabaseClient,
  paymentId: string,
  effectKey: string,
  masterClaimToken: string,
  executeFn: () => Promise<void>,
): Promise<{ ok: boolean; error?: string }> {
  const res = await reserveEffect(supabase, paymentId, effectKey, masterClaimToken);
  if (!res.ok) {
    // already_terminal is fine (idempotent), effect_not_in_manifest means not applicable
    if (res.error === 'effect_not_in_manifest' || res.error === 'already_terminal') return { ok: true };
    return res;
  }
  try {
    await executeFn();
    await completeInternal(supabase, paymentId, effectKey, res.effectToken!);
    return { ok: true };
  } catch (err) {
    // Internal effects that fail should not block the pipeline — log and continue
    return { ok: false, error: String(err) };
  }
}

/**
 * Drive an external effect through reserve → emission fence → provider call → complete/indeterminate.
 */
export async function driveExternalEffect(
  supabase: SupabaseClient,
  paymentId: string,
  effectKey: string,
  masterClaimToken: string,
  providerFn: () => Promise<boolean>, // returns true on success, false on failure
): Promise<{ ok: boolean; error?: string }> {
  const res = await reserveEffect(supabase, paymentId, effectKey, masterClaimToken);
  if (!res.ok) {
    if (res.error === 'effect_not_in_manifest' || res.error === 'already_terminal') return { ok: true };
    return res;
  }
  // Emission fence
  const emission = await beginExternalEmission(supabase, paymentId, effectKey, masterClaimToken, res.effectToken!);
  if (!emission.ok) {
    // Pre-emission failure
    await failExternal(supabase, paymentId, effectKey, res.effectToken!, emission.error || 'emission_denied');
    return { ok: false, error: emission.error };
  }
  try {
    const success = await providerFn();
    if (success) {
      await completeExternal(supabase, paymentId, effectKey, res.effectToken!);
    } else {
      await markIndeterminate(supabase, paymentId, effectKey, res.effectToken!);
    }
    return { ok: true };
  } catch {
    // Post-emission error: indeterminate (provider may have received the call)
    await markIndeterminate(supabase, paymentId, effectKey, res.effectToken!);
    return { ok: true }; // ok because indeterminate is a valid terminal state
  }
}

// ─── Termination ───

export async function terminatePaymentConfirmation(
  supabase: SupabaseClient, paymentId: string, claimToken: string, reason: string,
): Promise<{ ok: boolean; alreadyTerminated?: boolean; error?: string }> {
  const { data, error } = await supabase.rpc('terminate_payment_confirmation', {
    p_payment_id: paymentId, p_claim_token: claimToken, p_terminal_reason: reason,
  });
  if (error) return { ok: false, error: error.message };
  if (data?.terminated === true) {
    return { ok: true, alreadyTerminated: data?.already_terminated === true };
  }
  return { ok: false, error: data?.reason };
}

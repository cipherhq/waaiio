/**
 * Terminal effect manifest client — typed wrappers for Phase A v15 RPCs.
 *
 * All functions accept a SupabaseClient (service_role) and return structured results.
 * These are thin wrappers; the DB RPCs enforce all authority/state-machine invariants.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

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

export async function sealRuleActions(
  supabase: SupabaseClient,
  paymentId: string,
  actions: Array<{ rule_id: string; action_type: string; action_payload: object; action_fingerprint: string }>,
): Promise<{ ok: boolean; alreadySealed?: boolean; actionCount?: number }> {
  const { data, error } = await supabase.rpc('seal_payment_rule_actions', {
    p_payment_id: paymentId,
    p_actions: actions,
  });
  if (error) return { ok: false };
  return {
    ok: data?.sealed === true,
    alreadySealed: data?.already_sealed === true,
    actionCount: data?.action_count,
  };
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

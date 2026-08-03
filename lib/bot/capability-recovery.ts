/**
 * CAS-005 — Shared unavailable-capability recovery helper.
 *
 * One consistent implementation for all production paths that encounter
 * an unavailable capability. Never substitutes capabilities.
 */

import type { CapabilityId } from '@/lib/capabilities/types';
import { getCapabilityLabel } from '@/lib/capabilities/labels';
import type { SemanticFamily } from './semantic-types';
import { FAMILY_TO_CAPABILITIES } from './semantic-types';

// ── Rejected-request state cleanup ──────────────────────

/** All transactional session fields that must be cleared on rejection */
const REJECTED_TRANSACTIONAL_FIELDS = [
  'active_capability',
  'service_id', 'service_name', 'service_price', 'service_duration',
  'service_deposit', 'service_billing_type', 'service_recurring_interval',
  'skip_service', '_matched_service_ids',
  '_suggested_service_id', '_suggested_service_name',
  'date', 'selected_date', 'time', 'selected_time', '_time_preference',
  'party_size', 'ticket_quantity', 'amount',
  'cart', '_auto_added_to_cart', '_skip_browse', '_matched_product_ids',
  '_variant_hints', '_service_keyword',
  '_deep_link_capability',
  '_quick_rebook_service_id', '_quick_rebook_service_name',
  '_rebook_flow_type', '_rebook_is_giving', '_quick_rebook_sent',
  '_parsed_semantic_family', '_parsed_requested_action',
] as const;

/**
 * Clear all transactional state belonging to a rejected request.
 * Idempotent — safe to call multiple times.
 *
 * Preserves: customer identity, business identity, capabilities, conversation
 * log, language, session version, customer history, valid existing obligations.
 */
export function clearRejectedTransactionalState(
  sessionData: Record<string, unknown>,
): void {
  for (const field of REJECTED_TRANSACTIONAL_FIELDS) {
    delete sessionData[field];
  }
}

// ── Recovery message builder ────────────────────────────

/** Semantic family → customer-friendly label */
const FAMILY_LABELS: Record<string, string> = {
  service_time_booking: 'appointments',
  property_reservation: 'room reservations',
  table_reservation: 'table reservations',
  ordering: 'ordering',
  ticketing: 'event tickets',
  giving: 'donations',
  payment: 'payments',
  queue: 'queue check-in',
  waitlist: 'waitlist',
};

export interface RecoveryOptions {
  /** The semantic family the customer requested */
  requestedFamily?: SemanticFamily;
  /** Current effective user-facing capabilities */
  effectiveUserFacing: CapabilityId[];
  /** Business category for label resolution */
  businessCategory: string;
  /** Source of the request (for logging/context) */
  source?: 'free_text' | 'button' | 'keyword' | 'deep_link' | 'rebook' | 'resumed' | 'commit_guard';
}

/**
 * Build a customer-facing recovery message for an unavailable capability.
 * Shows what was requested, why it's unavailable, and valid alternatives.
 *
 * Never exposes: tier names, feature flags, database errors, internal IDs.
 */
export function buildRecoveryMessage(opts: RecoveryOptions): string {
  const { requestedFamily, effectiveUserFacing, businessCategory } = opts;

  // Identify what was requested in customer-friendly language
  const requestedLabel = requestedFamily ? FAMILY_LABELS[requestedFamily] || 'that service' : 'that service';

  // Build alternatives from current effective user-facing capabilities
  const alternatives = effectiveUserFacing
    .map(cap => getCapabilityLabel(cap, businessCategory))
    .filter(Boolean);

  const parts: string[] = [];

  // Statement: what's unavailable
  parts.push(`Sorry, ${requestedLabel} ${requestedLabel === 'ordering' ? 'is' : 'are'} not available here right now.`);

  // Valid alternatives
  if (alternatives.length > 0) {
    parts.push('');
    parts.push('You can still:');
    for (const alt of alternatives.slice(0, 5)) {
      parts.push(`• ${alt}`);
    }
    parts.push('');
    parts.push('Choose an option below or type what you would like to do.');
  } else {
    parts.push('');
    parts.push('Type *Hi* to start over, or try again later.');
  }

  return parts.join('\n');
}

/**
 * Build a recovery message when a specific capability (by ID) is unavailable.
 * Used by button/keyword/rebook paths that know the exact capability.
 */
export function buildCapabilityRecoveryMessage(
  capabilityId: string,
  effectiveUserFacing: CapabilityId[],
  businessCategory: string,
): string {
  // Map capability ID to semantic family for label resolution
  const familyEntry = Object.entries(FAMILY_TO_CAPABILITIES).find(
    ([, caps]) => caps.includes(capabilityId),
  );
  const family = familyEntry ? familyEntry[0] as SemanticFamily : null;

  return buildRecoveryMessage({
    requestedFamily: family,
    effectiveUserFacing,
    businessCategory,
  });
}

// ── Cleanup modes ──────────────────────────────────────

export type CleanupMode =
  | 'selection_rejection'    // At capability selection, chose unavailable
  | 'quick_rebook_rejection' // Quick rebook target unavailable
  | 'current_flow_revoked'   // Active CREATE_NEW capability revoked mid-flow
  | 'different_family_mid_flow'; // Asked for different unavailable family mid-flow

/**
 * Context-aware state cleanup.
 * Different modes preserve different state.
 */
export function cleanupByMode(
  sessionData: Record<string, unknown>,
  mode: CleanupMode,
): void {
  switch (mode) {
    case 'selection_rejection':
    case 'quick_rebook_rejection':
      // Clear all transactional state — customer hasn't started a flow yet
      clearRejectedTransactionalState(sessionData);
      break;

    case 'current_flow_revoked':
      // Active flow revoked — clear CREATE_NEW transactional state, move to menu
      clearRejectedTransactionalState(sessionData);
      break;

    case 'different_family_mid_flow':
      // Customer asked for a DIFFERENT unavailable family while in a valid flow.
      // Preserve the CURRENT valid flow state. Only clear ephemeral canonical state.
      // currentCanonical is already ephemeral (not persisted), so nothing to clear.
      break;
  }
}

// ── Mid-flow guard-denial recovery ─────────────────────

import type { SupabaseClient } from '@supabase/supabase-js';

export interface GuardRecoveryParams {
  supabase: SupabaseClient;
  sessionId: string;
  sessionVersion: number;
  sessionData: Record<string, unknown>;
  revokedCapability: string;
  effectiveCapabilities: CapabilityId[];
  businessCategory: string;
}

export interface GuardRecoveryResult {
  success: boolean;
  customerMessage: string;
  reason?: 'cas_conflict' | 'no_alternatives';
}

/**
 * Recover a session after a CREATE_NEW guard denial.
 * Cleans transactional state, moves to select_capability, persists via CAS.
 */
export async function recoverFromRevokedCapability(
  params: GuardRecoveryParams,
): Promise<GuardRecoveryResult> {
  const { supabase, sessionId, sessionVersion, sessionData, revokedCapability, effectiveCapabilities, businessCategory } = params;

  // Clean transactional state
  cleanupByMode(sessionData, 'current_flow_revoked');

  // Update effective capabilities in session
  sessionData.capabilities = effectiveCapabilities;

  // Build recovery message
  const { getUserFacingCapabilities } = await import('./handlers/flow-routing');
  const ufCaps = getUserFacingCapabilities(effectiveCapabilities);
  const customerMessage = buildCapabilityRecoveryMessage(revokedCapability, ufCaps, businessCategory);

  // Persist via CAS — move to select_capability
  const { data: casResult } = await supabase.rpc('update_session_cas', {
    p_session_id: sessionId,
    p_expected_version: sessionVersion,
    p_current_step: 'select_capability',
    p_session_data: sessionData,
  });

  if (!casResult?.success) {
    return { success: false, customerMessage, reason: 'cas_conflict' };
  }

  return { success: true, customerMessage };
}


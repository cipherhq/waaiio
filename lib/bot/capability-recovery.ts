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

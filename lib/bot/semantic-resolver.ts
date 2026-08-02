/**
 * CAS-004 — Semantic capability resolver.
 * Determines whether a semantic family + action can be fulfilled by the
 * business's current effective capabilities.
 *
 * This is NOT authorization (Phase 1 handles that).
 * This is conversational correctness: does the customer's request
 * match what's available?
 */

import type { SemanticFamily, RequestedAction } from './semantic-types';
import { FAMILY_TO_CAPABILITIES } from './semantic-types';
import type { CapabilityId } from '@/lib/capabilities/types';

export interface SemanticResolution {
  /** Whether routing should proceed */
  canRoute: boolean;
  /** The matched capability ID, if any */
  matchedCapability: CapabilityId | null;
  /** Why routing was denied */
  reason?: 'family_unavailable' | 'no_matching_capability' | 'unknown_family';
}

/**
 * Resolve whether a semantic family can be routed to an effective capability.
 *
 * Rules:
 * - CREATE_NEW: requires matching effective capability in the family
 * - MANAGE_EXISTING / READ_HISTORY / INFORMATIONAL / NAVIGATION: always allowed
 *   (these are handled by existing global handlers, not capability-gated flows)
 * - null family: cannot route (ambiguous)
 * - Generic booking may resolve to any SERVICE_TIME_BOOKING family member
 */
export function resolveSemanticCapability(
  family: SemanticFamily,
  action: RequestedAction,
  effectiveCapabilities: CapabilityId[],
): SemanticResolution {
  // Non-CREATE_NEW actions don't need capability routing
  if (action && action !== 'create_new') {
    return { canRoute: true, matchedCapability: null };
  }

  // Unknown/null family cannot route
  if (!family) {
    return { canRoute: false, matchedCapability: null, reason: 'unknown_family' };
  }

  const validCaps = FAMILY_TO_CAPABILITIES[family];
  if (!validCaps) {
    return { canRoute: false, matchedCapability: null, reason: 'unknown_family' };
  }

  // Find first effective capability in this family
  const matched = effectiveCapabilities.find(c => validCaps.includes(c));
  if (matched) {
    return { canRoute: true, matchedCapability: matched };
  }

  return { canRoute: false, matchedCapability: null, reason: 'family_unavailable' };
}

/**
 * Use business category to disambiguate a genuinely generic "book" request.
 * Only used when semanticFamily is null (ambiguous).
 * Returns a suggested family based on what's most likely for this category.
 */
export function disambiguateByCategory(
  category: string | null,
  effectiveCapabilities: CapabilityId[],
): SemanticFamily {
  if (!category) return null;

  // Category-specific default booking family
  const CATEGORY_BOOKING_FAMILY: Record<string, SemanticFamily> = {
    hotel: 'property_reservation',
    airbnb: 'property_reservation',
    shortlet: 'property_reservation',
    car_rental: 'property_reservation',
    restaurant: 'table_reservation',
    cafe: 'table_reservation',
    bar: 'table_reservation',
    // Everything else: service_time_booking
  };

  const suggested = CATEGORY_BOOKING_FAMILY[category] || 'service_time_booking';

  // Check if the suggested family has an effective capability
  const validCaps = FAMILY_TO_CAPABILITIES[suggested];
  if (validCaps && effectiveCapabilities.some(c => validCaps.includes(c))) {
    return suggested;
  }

  // Fallback: try any booking-family capability that's effective
  for (const family of ['service_time_booking', 'property_reservation', 'table_reservation'] as SemanticFamily[]) {
    const caps = FAMILY_TO_CAPABILITIES[family!];
    if (caps && effectiveCapabilities.some(c => caps.includes(c))) {
      return family;
    }
  }

  return null;
}

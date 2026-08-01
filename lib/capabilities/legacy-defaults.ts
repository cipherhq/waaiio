/**
 * Pure deterministic legacy-default capability resolver.
 *
 * For businesses with zero configured capability rows (legacy businesses
 * that were never explicitly configured through onboarding).
 *
 * This is the SINGLE source of truth for zero-row fallback behavior.
 * Used by: API guard, dashboard DashboardProvider, bot getEnabledCapabilities.
 *
 * Rules:
 * - No database calls
 * - No mutable runtime cache
 * - Same input always produces same result
 * - Does NOT auto-enable newly-added defaults for already-configured businesses
 *
 * @module server-only (no browser Supabase, no client state)
 */

import { CATEGORY_DEFAULT_CAPABILITIES, type CapabilityId } from '@/lib/capabilities/types';

/**
 * Get the default capabilities for a zero-row legacy business.
 * Returns the static category defaults or ['scheduling'] as final fallback.
 */
export function getLegacyDefaultCapabilities(category: string | null | undefined): CapabilityId[] {
  if (category && CATEGORY_DEFAULT_CAPABILITIES[category]) {
    return CATEGORY_DEFAULT_CAPABILITIES[category];
  }
  return ['scheduling'] as CapabilityId[];
}

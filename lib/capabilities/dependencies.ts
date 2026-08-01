// ═══════════════════════════════════════════════════════
// Capability Dependency Rules
// Pure logic — shared between server and client.
// ═══════════════════════════════════════════════════════

import type { CapabilityId } from '@/lib/capabilities/types';

/**
 * Dependency rules extracted from current product behavior.
 * Each entry: { capability, requires: CapabilityId[] }
 *
 * Source: app/dashboard/capabilities/page.tsx lines 172-178
 * - membership requires loyalty (they share the points system)
 */
export const CAPABILITY_DEPENDENCIES: Array<{ capability: CapabilityId; requires: CapabilityId[] }> = [
  { capability: 'membership', requires: ['loyalty'] },
];

/**
 * Given a capability being enabled, return any missing required dependencies.
 */
export function getMissingDependencies(
  capabilityId: CapabilityId,
  currentlyEnabled: CapabilityId[],
): CapabilityId[] {
  const rule = CAPABILITY_DEPENDENCIES.find(d => d.capability === capabilityId);
  if (!rule) return [];
  return rule.requires.filter(dep => !currentlyEnabled.includes(dep));
}

/**
 * Given a capability being disabled, return capabilities that depend on it
 * and should be warned about or auto-disabled.
 */
export function getDependents(
  capabilityId: CapabilityId,
  currentlyEnabled: CapabilityId[],
): CapabilityId[] {
  return CAPABILITY_DEPENDENCIES
    .filter(d => d.requires.includes(capabilityId) && currentlyEnabled.includes(d.capability))
    .map(d => d.capability);
}

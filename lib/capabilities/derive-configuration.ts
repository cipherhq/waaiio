/**
 * Pure state-transition helper for capability configuration.
 *
 * Derives the next order deterministically from the previous state
 * and the next selected capabilities, avoiding stale React state issues.
 *
 * Rules:
 * 1. Start with previousOrder
 * 2. Remove IDs no longer selected
 * 3. Preserve relative ordering for still-selected IDs
 * 4. Append newly selected IDs not already in the order
 * 5. Resulting order contains exactly the same IDs as nextEnabled
 */
import type { CapabilityId } from '@/lib/capabilities/types';

export interface CapabilityConfiguration {
  capabilities: CapabilityId[];
  order: CapabilityId[];
  previousCapabilities: CapabilityId[];
  previousOrder: CapabilityId[];
}

/**
 * Derive a consistent next order from previous order and next selected set.
 */
export function deriveNextOrder(
  previousOrder: CapabilityId[],
  nextEnabled: CapabilityId[],
): CapabilityId[] {
  const nextSet = new Set(nextEnabled);

  // Keep still-selected IDs in their previous relative order
  const stillSelected = previousOrder.filter(c => nextSet.has(c));

  // Find newly selected IDs not in previous order
  const stillSelectedSet = new Set(stillSelected);
  const newlyAdded = nextEnabled.filter(c => !stillSelectedSet.has(c));

  // Append new at the end
  return [...stillSelected, ...newlyAdded];
}

/**
 * Derive the full configuration transaction from a toggle operation.
 */
export function deriveCapabilityConfiguration(
  previousEnabled: CapabilityId[],
  previousOrder: CapabilityId[],
  nextEnabled: CapabilityId[],
): CapabilityConfiguration {
  const nextOrder = deriveNextOrder(previousOrder, nextEnabled);

  return {
    capabilities: nextEnabled,
    order: nextOrder,
    previousCapabilities: [...previousEnabled],
    previousOrder: [...previousOrder],
  };
}

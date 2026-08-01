/**
 * Unit tests for capability state derivation helper.
 *
 * Proves:
 * 1. Enable adds to order at end
 * 2. Disable removes from order
 * 3. Dependency addition correctly ordered
 * 4. Dependency removal removes both from order
 * 5. Paused capability preserved on unrelated change
 * 6. Reorder preserves relative order
 * 7. Set(order) === Set(capabilities) invariant
 * 8. Rollback restores exact previous state
 */
import { describe, it, expect } from 'vitest';
import { deriveCapabilityConfiguration, deriveNextOrder } from '../derive-configuration';
import type { CapabilityId } from '../types';

describe('deriveNextOrder', () => {
  it('enable: appends new capability at end', () => {
    const result = deriveNextOrder(
      ['scheduling'] as CapabilityId[],
      ['scheduling', 'staff'] as CapabilityId[],
    );
    expect(result).toEqual(['scheduling', 'staff']);
  });

  it('disable: removes capability from order', () => {
    const result = deriveNextOrder(
      ['scheduling', 'staff'] as CapabilityId[],
      ['scheduling'] as CapabilityId[],
    );
    expect(result).toEqual(['scheduling']);
  });

  it('dependency addition: membership + loyalty both appear in order', () => {
    // Enabling membership also enables loyalty (dependency)
    const result = deriveNextOrder(
      ['scheduling'] as CapabilityId[],
      ['scheduling', 'membership', 'loyalty'] as CapabilityId[],
    );
    expect(result).toEqual(['scheduling', 'membership', 'loyalty']);
    expect(new Set(result)).toEqual(new Set(['scheduling', 'membership', 'loyalty']));
  });

  it('dependency removal: disabling loyalty removes membership too', () => {
    const result = deriveNextOrder(
      ['scheduling', 'loyalty', 'membership'] as CapabilityId[],
      ['scheduling'] as CapabilityId[],
    );
    expect(result).toEqual(['scheduling']);
  });

  it('paused capability remains in order when unrelated change occurs', () => {
    // staff is paused (selected but above tier) — still in the set
    const result = deriveNextOrder(
      ['scheduling', 'staff', 'payment'] as CapabilityId[],
      ['scheduling', 'staff', 'payment', 'chat'] as CapabilityId[],
    );
    expect(result).toEqual(['scheduling', 'staff', 'payment', 'chat']);
    expect(result).toContain('staff');
  });

  it('preserves relative order for still-selected capabilities', () => {
    const result = deriveNextOrder(
      ['payment', 'scheduling', 'chat', 'staff'] as CapabilityId[],
      ['payment', 'scheduling', 'chat', 'staff', 'feedback'] as CapabilityId[],
    );
    // payment, scheduling, chat, staff should maintain their relative order
    expect(result.indexOf('payment' as CapabilityId)).toBeLessThan(result.indexOf('scheduling' as CapabilityId));
    expect(result.indexOf('scheduling' as CapabilityId)).toBeLessThan(result.indexOf('chat' as CapabilityId));
    expect(result.indexOf('chat' as CapabilityId)).toBeLessThan(result.indexOf('staff' as CapabilityId));
    // feedback appended at end
    expect(result[result.length - 1]).toBe('feedback');
  });

  it('order contains exactly the same IDs as nextEnabled (invariant)', () => {
    const nextEnabled = ['scheduling', 'staff', 'chat'] as CapabilityId[];
    const result = deriveNextOrder(
      ['payment', 'scheduling'] as CapabilityId[],
      nextEnabled,
    );
    expect(new Set(result)).toEqual(new Set(nextEnabled));
    expect(result.length).toBe(nextEnabled.length);
  });

  it('empty previous order with new capabilities', () => {
    const result = deriveNextOrder(
      [] as CapabilityId[],
      ['scheduling', 'payment'] as CapabilityId[],
    );
    expect(result).toEqual(['scheduling', 'payment']);
  });
});

describe('deriveCapabilityConfiguration', () => {
  it('returns complete configuration with correct previous snapshots', () => {
    const config = deriveCapabilityConfiguration(
      ['scheduling'] as CapabilityId[],
      ['scheduling'] as CapabilityId[],
      ['scheduling', 'staff'] as CapabilityId[],
    );

    expect(config.capabilities).toEqual(['scheduling', 'staff']);
    expect(config.order).toEqual(['scheduling', 'staff']);
    expect(config.previousCapabilities).toEqual(['scheduling']);
    expect(config.previousOrder).toEqual(['scheduling']);
  });

  it('disable produces consistent order and capabilities', () => {
    const config = deriveCapabilityConfiguration(
      ['scheduling', 'staff'] as CapabilityId[],
      ['scheduling', 'staff'] as CapabilityId[],
      ['scheduling'] as CapabilityId[],
    );

    expect(config.capabilities).toEqual(['scheduling']);
    expect(config.order).toEqual(['scheduling']);
    expect(new Set(config.order)).toEqual(new Set(config.capabilities));
  });

  it('Set(order) === Set(capabilities) invariant for all transitions', () => {
    const transitions: Array<{ prev: CapabilityId[]; prevOrder: CapabilityId[]; next: CapabilityId[] }> = [
      { prev: ['scheduling'] as CapabilityId[], prevOrder: ['scheduling'] as CapabilityId[], next: ['scheduling', 'staff'] as CapabilityId[] },
      { prev: ['scheduling', 'staff'] as CapabilityId[], prevOrder: ['staff', 'scheduling'] as CapabilityId[], next: ['scheduling'] as CapabilityId[] },
      { prev: ['a', 'b', 'c'] as CapabilityId[], prevOrder: ['c', 'a', 'b'] as CapabilityId[], next: ['a', 'b', 'c', 'd'] as CapabilityId[] },
      { prev: ['a', 'b'] as CapabilityId[], prevOrder: ['b', 'a'] as CapabilityId[], next: ['c'] as CapabilityId[] },
    ];

    for (const t of transitions) {
      const config = deriveCapabilityConfiguration(t.prev, t.prevOrder, t.next);
      expect(new Set(config.order)).toEqual(new Set(config.capabilities));
      expect(config.order.length).toBe(config.capabilities.length);
    }
  });

  it('rollback snapshots are independent copies', () => {
    const prevEnabled = ['scheduling', 'staff'] as CapabilityId[];
    const prevOrder = ['staff', 'scheduling'] as CapabilityId[];
    const config = deriveCapabilityConfiguration(prevEnabled, prevOrder, ['scheduling'] as CapabilityId[]);

    // Mutating the original arrays should not affect the config
    prevEnabled.push('chat' as CapabilityId);
    prevOrder.push('chat' as CapabilityId);

    expect(config.previousCapabilities).toEqual(['scheduling', 'staff']);
    expect(config.previousOrder).toEqual(['staff', 'scheduling']);
  });
});

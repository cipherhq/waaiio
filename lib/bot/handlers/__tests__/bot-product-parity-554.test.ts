import { describe, expect, it } from 'vitest';
import type { CapabilityId } from '@/lib/capabilities/types';
import {
  capabilityToFirstStep,
  getFirstStepFromCapabilities,
  getUserFacingCapabilities,
} from '../flow-routing';
import { isLoyaltyQuery } from '../global-queries';

describe('#554 bot product/contextual parity', () => {
  it('keeps Products primary while Instant Win remains contextual', () => {
    const capabilities: CapabilityId[] = ['ordering', 'promo_verification'];

    expect(getUserFacingCapabilities(capabilities)).toEqual(['ordering']);
    expect(getFirstStepFromCapabilities(capabilities, 'ordering')).toBe('browse_catalog');
  });

  it('keeps Services primary while Instant Win remains contextual', () => {
    const capabilities: CapabilityId[] = ['scheduling', 'promo_verification'];

    expect(getUserFacingCapabilities(capabilities)).toEqual(['scheduling']);
    expect(getFirstStepFromCapabilities(capabilities, 'scheduling')).toBe('select_service');
  });

  it('shows the normal capability picker when Products and Services are both primary', () => {
    const capabilities: CapabilityId[] = ['ordering', 'scheduling', 'promo_verification'];

    expect(getUserFacingCapabilities(capabilities)).toEqual(['ordering', 'scheduling']);
    expect(getFirstStepFromCapabilities(capabilities, 'ordering')).toBe('select_capability');
  });

  it('preserves the dedicated Instant Win entry for a promo-only business', () => {
    const capabilities: CapabilityId[] = ['promo_verification'];

    expect(getUserFacingCapabilities(capabilities)).toEqual([]);
    expect(capabilityToFirstStep('promo_verification')).toBe('promo_entry');
    expect(getFirstStepFromCapabilities(capabilities, 'ordering')).toBe('promo_entry');
  });

  it('keeps Loyalty contextual and directly routable to the existing rewards flow', () => {
    const capabilities: CapabilityId[] = ['ordering', 'loyalty'];

    expect(getUserFacingCapabilities(capabilities)).toEqual(['ordering']);
    expect(capabilityToFirstStep('loyalty')).toBe('loyalty_menu');
  });

  it.each([
    'my points',
    'rewards',
    'my rewards',
    'loyalty',
    'check my points',
    'show my rewards',
  ])('recognizes natural-language rewards query: %s', (text) => {
    expect(isLoyaltyQuery(text)).toBe(true);
  });

  it('does not mistake a normal product request for a rewards query', () => {
    expect(isLoyaltyQuery('I want to buy a wig')).toBe(false);
  });
});

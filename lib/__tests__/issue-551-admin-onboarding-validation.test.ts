import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/categoryConfig', () => ({
  loadCategories: vi.fn().mockResolvedValue(undefined),
  getAllCategoryKeys: () => ['restaurant', 'salon'],
}));

import { validateBusinessAuthorityInputs } from '@/lib/onboarding/validation';

function authorityService() {
  return {
    from: () => ({
      select: () => ({
        eq: async () => ({ data: [
          { code: 'NG', dialing_code: '+234' },
          { code: 'US', dialing_code: '+1' },
        ], error: null }),
      }),
    }),
  } as never;
}

describe('#551 authoritative onboarding validation', () => {
  it('accepts a configured country, canonical category, and matching phone', async () => {
    await expect(validateBusinessAuthorityInputs(authorityService(), { country: 'ng', category: 'restaurant', phone: '+2348012345678' }))
      .resolves.toMatchObject({ countryCode: 'NG', category: 'restaurant' });
  });

  it.each([
    [{ country: 'ZZ', category: 'restaurant', phone: '+2348012345678' }, 'Invalid or unsupported country'],
    [{ country: 'NG', category: 'invented', phone: '+2348012345678' }, 'Invalid category'],
    [{ country: 'NG', category: 'restaurant', phone: '+12025550123' }, "Phone number doesn't match selected country"],
  ])('fails closed for invalid authority input %#', async (input, message) => {
    await expect(validateBusinessAuthorityInputs(authorityService(), input)).rejects.toThrow(message);
  });
});

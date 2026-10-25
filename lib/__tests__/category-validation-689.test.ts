/**
 * #689: Category validation regression tests.
 *
 * Verifies:
 * - Active categories (all 91 including legacy mall_vendor/instagram_vendor) accepted
 * - Inactive/unknown categories rejected
 * - DB failure returns 503 "configuration unavailable", not 400 "Invalid category"
 * - Service client used on server (not browser client)
 * - Existing onboarding guards preserved
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { invalidateCategoryCache } from '@/lib/categoryConfig';

// The 89 approved category keys from BUSINESS_CATEGORIES
const APPROVED_89 = [
  'salon', 'barber', 'spa', 'tattoo', 'nail_tech', 'mua', 'lash_tech', 'medspa', 'waxing',
  'clinic', 'dental', 'veterinary', 'therapy', 'optician', 'physiotherapy',
  'restaurant', 'cafe', 'bar', 'lounge', 'bakery', 'catering', 'food_truck',
  'shop', 'food_delivery', 'pharmacy', 'supermarket', 'tailor', 'printing',
  'laundry', 'car_wash', 'mechanic', 'cleaning', 'plumber', 'pest_control', 'handyman', 'hvac', 'landscaping', 'electrician',
  'consultant', 'legal', 'accounting', 'travel_agency', 'coworking', 'security',
  'hotel', 'shortlet', 'car_rental',
  'events', 'event_services', 'cinema', 'music_studio',
  'church', 'mosque', 'ngo', 'crowdfunding_org',
  'gym', 'yoga', 'pilates', 'dance', 'martial_arts', 'bootcamp',
  'taxi', 'transport', 'logistics', 'courier', 'moving', 'bus',
  'school', 'tutor', 'driving_school', 'language_school', 'training_academy', 'daycare',
  'pet_grooming', 'dog_walking', 'pet_boarding', 'pet_training',
  'photographer', 'videographer', 'dj', 'graphic_designer', 'content_creator',
  'real_estate', 'property_manager', 'mortgage_broker',
  'government', 'car_park',
  'funeral', 'other',
];

// Legacy DB-active categories not in BUSINESS_CATEGORIES array
const LEGACY_DB_ACTIVE = ['mall_vendor', 'instagram_vendor'];

// All 91 active categories
const ALL_91 = [...APPROVED_89, ...LEGACY_DB_ACTIVE];

function mockServiceClient(categoryKeys: string[], queryFails = false) {
  const fromImpl = (table: string) => {
    if (table === 'category_templates') {
      return {
        select: () => ({
          eq: () => ({
            order: () => queryFails
              ? Promise.resolve({ data: null, error: { message: 'permission denied' } })
              : Promise.resolve({
                  data: categoryKeys.map((key, i) => ({
                    id: `cat-${key}`, key, label: key, icon: '', flow_type: 'scheduling',
                    is_active: true, sort_order: i, default_services: [], default_greeting: '',
                    labels: {}, default_capabilities: null, metadata: {},
                  })),
                  error: null,
                }),
          }),
        }),
      };
    }
    if (table === 'countries') {
      return {
        select: () => ({
          eq: async () => ({
            data: [{ code: 'NG', dialing_code: '+234' }, { code: 'US', dialing_code: '+1' }, { code: 'GH', dialing_code: '+233' }],
            error: null,
          }),
        }),
      };
    }
    return { select: () => ({ eq: async () => ({ data: null, error: null }) }) };
  };

  return { from: fromImpl, rpc: vi.fn() } as never;
}

// Must import AFTER cache is available (module-level cache)
const { validateBusinessAuthorityInputs } = await import('@/lib/onboarding/validation');

beforeEach(() => {
  invalidateCategoryCache();
});

describe('#689: category validation with service client', () => {
  it('accepts all 91 active categories (89 approved + 2 legacy) via service client', async () => {
    const service = mockServiceClient(ALL_91);
    for (const key of ALL_91) {
      const result = await validateBusinessAuthorityInputs(service, {
        country: 'NG', category: key, phone: '+2348012345678',
      });
      expect(result.category).toBe(key);
    }
  });

  it('accepts mall_vendor (the exact #689 failure case)', async () => {
    const service = mockServiceClient(ALL_91);
    const result = await validateBusinessAuthorityInputs(service, {
      country: 'NG', category: 'mall_vendor',
    });
    expect(result.category).toBe('mall_vendor');
  });

  it('accepts instagram_vendor (the other legacy category)', async () => {
    const service = mockServiceClient(ALL_91);
    const result = await validateBusinessAuthorityInputs(service, {
      country: 'NG', category: 'instagram_vendor',
    });
    expect(result.category).toBe('instagram_vendor');
  });

  it('rejects unknown/invalid categories', async () => {
    const service = mockServiceClient(ALL_91);
    await expect(validateBusinessAuthorityInputs(service, {
      country: 'NG', category: 'nonexistent_category',
    })).rejects.toThrow('Invalid category');
  });

  it('rejects empty category', async () => {
    const service = mockServiceClient(ALL_91);
    await expect(validateBusinessAuthorityInputs(service, {
      country: 'NG', category: '',
    })).rejects.toThrow('Invalid category');
  });
});

describe('#689: DB failure returns 503, not 400', () => {
  it('returns 503 "configuration unavailable" when category_templates query fails', async () => {
    const service = mockServiceClient(ALL_91, true);
    try {
      await validateBusinessAuthorityInputs(service, {
        country: 'NG', category: 'salon',
      });
      expect.unreachable('should have thrown');
    } catch (err: unknown) {
      const e = err as { message: string; status: number };
      expect(e.message).toContain('Category configuration unavailable');
      expect(e.status).toBe(503);
    }
  });

  it('does NOT silently fall back to 89-key list on DB failure', async () => {
    // Previously, DB failure would fall back to BUSINESS_CATEGORIES (89 keys)
    // and silently reject mall_vendor with "Invalid category" (400).
    // Now it should fail with 503 instead.
    const service = mockServiceClient(ALL_91, true);
    try {
      await validateBusinessAuthorityInputs(service, {
        country: 'NG', category: 'mall_vendor',
      });
      expect.unreachable('should have thrown');
    } catch (err: unknown) {
      const e = err as { message: string; status: number };
      // Must be 503, not 400 "Invalid category"
      expect(e.status).toBe(503);
      expect(e.message).not.toBe('Invalid category');
    }
  });
});

describe('#689: existing onboarding guards preserved', () => {
  it('rejects invalid country', async () => {
    const service = mockServiceClient(ALL_91);
    await expect(validateBusinessAuthorityInputs(service, {
      country: 'ZZ', category: 'salon',
    })).rejects.toThrow('Invalid or unsupported country');
  });

  it('rejects phone/country mismatch', async () => {
    const service = mockServiceClient(ALL_91);
    await expect(validateBusinessAuthorityInputs(service, {
      country: 'NG', category: 'salon', phone: '+12025550123',
    })).rejects.toThrow("Phone number doesn't match selected country");
  });

  it('normalizes country code to uppercase', async () => {
    const service = mockServiceClient(ALL_91);
    const result = await validateBusinessAuthorityInputs(service, {
      country: 'ng', category: 'salon',
    });
    expect(result.countryCode).toBe('NG');
  });

  it('trims category whitespace', async () => {
    const service = mockServiceClient(ALL_91);
    const result = await validateBusinessAuthorityInputs(service, {
      country: 'NG', category: '  salon  ',
    });
    expect(result.category).toBe('salon');
  });
});

describe('#689: loadCategoriesStrict behavior', () => {
  it('caches successful DB result and serves from cache on subsequent calls', async () => {
    const service = mockServiceClient(ALL_91);
    // First call populates cache
    await validateBusinessAuthorityInputs(service, { country: 'NG', category: 'salon' });
    // Second call should use cache — even with a failing service, cache serves
    const failingService = mockServiceClient(ALL_91, true);
    // Cache is fresh (60s TTL), so the strict loader returns cached data
    const result = await validateBusinessAuthorityInputs(failingService, {
      country: 'NG', category: 'mall_vendor',
    });
    expect(result.category).toBe('mall_vendor');
  });
});

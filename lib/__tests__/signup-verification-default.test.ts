/**
 * Signup default: new NG businesses get verification_level 'basic'
 * with the NG basic limit from country tiers.
 *
 * Behavioral test — mocks Supabase and verifies the insert payload.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture the insert payload
let capturedInsert: Record<string, unknown> | null = null;

vi.mock('@/lib/supabase/client', () => ({
  createClient: vi.fn(),
}));

vi.mock('@/lib/constants', async () => {
  const actual = await vi.importActual<typeof import('@/lib/constants')>('@/lib/constants');
  return {
    ...actual,
    getPayoutLimit: vi.fn().mockImplementation((cc: string, level: string) => {
      if (cc === 'NG' && level === 'basic') return 500_000;
      if (cc === 'US' && level === 'basic') return 100_000;
      return 0;
    }),
  };
});

vi.mock('@/lib/capabilities/service', () => ({
  initCapabilities: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/onboarding/finalize', () => ({
  finalizeOnboarding: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/payments/gateway-resolver', () => ({
  resolveCountryGateway: vi.fn().mockResolvedValue({ gateway: 'paystack' }),
}));

describe('provisionPendingBusiness sets verification defaults', () => {
  beforeEach(() => {
    capturedInsert = null;
    vi.clearAllMocks();
  });

  it('new NG business is basic with the NG basic limit', async () => {
    const mockService = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'businesses') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: null, error: null }),
              }),
            }),
            insert: (payload: Record<string, unknown>) => {
              capturedInsert = payload;
              return {
                select: () => ({
                  single: () => Promise.resolve({
                    data: { id: 'new-biz-id', bot_code: 'TEST', slug: 'test-biz' },
                    error: null,
                  }),
                }),
              };
            },
          };
        }
        if (table === 'category_templates') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () => Promise.resolve({ data: null, error: null }),
                }),
              }),
            }),
          };
        }
        if (table === 'whatsapp_config') {
          return {
            insert: () => Promise.resolve({ data: {}, error: null }),
          };
        }
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: null, error: null }),
            }),
          }),
        };
      }),
      rpc: vi.fn().mockResolvedValue({ data: { allocated: true }, error: null }),
    } as any;

    const { provisionPendingBusiness } = await import('@/lib/onboarding/provision-business');
    await provisionPendingBusiness(mockService, {
      ownerId: 'user-1',
      name: 'Test Biz',
      city: 'Lagos',
      address: '1 Test St',
      phone: '+2341234567890',
      category: 'restaurant',
      countryCode: 'NG',
    });

    expect(capturedInsert).not.toBeNull();
    expect(capturedInsert!.verification_level).toBe('basic');
    expect(capturedInsert!.payout_limit_monthly).toBe(500_000);
  });
});

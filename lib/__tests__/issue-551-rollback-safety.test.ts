import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';

// Mock dependencies before importing
vi.mock('@/lib/capabilities/service', () => ({
  initCapabilities: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/onboarding/finalize', () => ({
  finalizeOnboarding: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/payments/gateway-resolver', () => ({
  resolveCountryGateway: vi.fn().mockResolvedValue({ gateway: 'paystack' }),
}));
vi.mock('@/lib/constants', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    generateBotCode: () => 'TESTBOT',
    generateSlug: () => 'test-biz',
  };
});

import { provisionPendingBusiness, OnboardingProvisionError, type ProvisionBusinessInput } from '@/lib/onboarding/provision-business';
import { initCapabilities } from '@/lib/capabilities/service';
import { finalizeOnboarding } from '@/lib/onboarding/finalize';

const FAKE_BUSINESS = { id: 'biz-123', bot_code: 'TESTBOT', slug: 'test-biz' };

const BASE_INPUT: ProvisionBusinessInput = {
  ownerId: 'user-1',
  name: 'Test Biz',
  city: 'Lagos',
  address: '1 Test St',
  phone: '+2348000000000',
  category: 'restaurant',
  countryCode: 'NG' as any,
};

function mockService(overrides?: { whatsappInsertError?: string }) {
  const insertedTables: string[] = [];

  // Supabase query builders are thenables: `await insert(...)` resolves to { data, error }.
  const chainable = (result: { data?: unknown; error?: unknown }) => {
    const chain: Record<string, any> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.maybeSingle = async () => result;
    chain.single = async () => result;
    chain.then = (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
      Promise.resolve(result).then(resolve, reject);
    return chain;
  };

  return {
    service: {
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
            maybeSingle: async () => ({ data: null, error: null }),
          }),
        }),
        insert: () => {
          insertedTables.push(table);
          if (table === 'businesses') {
            return chainable({ data: { ...FAKE_BUSINESS }, error: null });
          }
          if (table === 'whatsapp_config' && overrides?.whatsappInsertError) {
            return chainable({ data: null, error: { message: overrides.whatsappInsertError } });
          }
          return chainable({ data: {}, error: null });
        },
      }),
    } as any,
    insertedTables,
  };
}

beforeEach(() => {
  vi.mocked(initCapabilities).mockReset().mockResolvedValue(undefined);
  vi.mocked(finalizeOnboarding).mockReset().mockResolvedValue(undefined);
});

describe('#551 rollback safety — provisionPendingBusiness carries businessId on failure', () => {
  it('happy path: returns business', async () => {
    const { service } = mockService();
    const result = await provisionPendingBusiness(service, BASE_INPUT);
    expect(result.id).toBe('biz-123');
  });

  it('WhatsApp config failure → OnboardingProvisionError WITH businessId', async () => {
    const { service } = mockService({ whatsappInsertError: 'duplicate key' });
    const err = await provisionPendingBusiness(service, BASE_INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OnboardingProvisionError);
    const ope = err as OnboardingProvisionError;
    expect(ope.message).toContain('WhatsApp configuration failed');
    expect(ope.businessId).toBe('biz-123');
  });

  it('capability init failure → OnboardingProvisionError WITH businessId', async () => {
    vi.mocked(initCapabilities).mockRejectedValueOnce(new Error('cap boom'));
    const { service } = mockService();
    const err = await provisionPendingBusiness(service, BASE_INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OnboardingProvisionError);
    expect((err as OnboardingProvisionError).businessId).toBe('biz-123');
  });

  it('finalization failure → OnboardingProvisionError WITH businessId', async () => {
    vi.mocked(finalizeOnboarding).mockRejectedValueOnce(new Error('finalize boom'));
    const { service } = mockService();
    const err = await provisionPendingBusiness(service, BASE_INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OnboardingProvisionError);
    expect((err as OnboardingProvisionError).businessId).toBe('biz-123');
  });
});

describe('#551 rollback safety — provisionAdminBusiness profile failure carries businessId', () => {
  it('profile update failure → throws OnboardingProvisionError with businessId', async () => {
    const adminAssisted = await import('@/lib/onboarding/admin-assisted');

    const service = {
      from: (table: string) => {
        if (table === 'businesses') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
                maybeSingle: async () => ({ data: null, error: null }),
              }),
            }),
            insert: () => ({
              select: () => ({
                single: async () => ({ data: { ...FAKE_BUSINESS }, error: null }),
              }),
            }),
          };
        }
        if (table === 'profiles') {
          return {
            update: () => ({
              eq: async () => ({ error: { message: 'profile write denied' } }),
            }),
          };
        }
        if (table === 'category_templates') {
          return {
            select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
          };
        }
        return {
          select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
          insert: () => ({ select: () => ({ single: async () => ({ data: {}, error: null }) }) }),
        };
      },
    } as any;

    const err = await adminAssisted.provisionAdminBusiness(
      service,
      {
        request_key: 'rk-1', owner_first_name: 'Jane', owner_last_name: 'Doe',
        owner_email: 'jane@example.com', owner_phone: '+2348000000001',
        business_name: 'Test Biz', country: 'NG', category: 'restaurant',
        city: 'Lagos', address: '1 Test St', business_phone: '+2348000000000',
        intended_plan: 'free' as any, capabilities: [], whatsapp_method: 'shared',
      },
      'user-1', 'onb-1',
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OnboardingProvisionError);
    expect((err as OnboardingProvisionError).message).toContain('profile');
    expect((err as OnboardingProvisionError).businessId).toBe('biz-123');
  });
});

describe('#551 rollback safety — admin route catch blocks extract businessId from error', () => {
  it('create route: extracts businessId from OnboardingProvisionError', () => {
    const src = readFileSync('app/api/admin/onboarding/route.ts', 'utf8');
    // Must extract businessId from error when local variable is unset
    expect(src).toContain('error instanceof OnboardingProvisionError');
    expect(src).toContain('error.businessId');
    // Must track cleanup failures explicitly
    expect(src).toContain('cleanupFailures');
    expect(src).not.toContain('failed safely');
    expect(src).toContain('Cleanup incomplete');
    expect(src).toContain('Resources cleaned up successfully');
  });

  it('retry route: extracts businessId from OnboardingProvisionError', () => {
    const src = readFileSync('app/api/admin/onboarding/[id]/route.ts', 'utf8');
    expect(src).toContain('retryError instanceof OnboardingProvisionError');
    expect(src).toContain('retryError.businessId');
    expect(src).toContain('cleanupFailures');
    expect(src).not.toContain('failed safely');
    expect(src).toContain('Cleanup incomplete');
  });

  it('cancel route: user-deletion failure after business deletion is explicit', () => {
    const src = readFileSync('app/api/admin/onboarding/[id]/route.ts', 'utf8');
    expect(src).toContain('was deleted but invited account');
    expect(src).toContain('partiallyApplied');
    expect(src).toContain('No resources were modified');
  });
});

import { describe, expect, it } from 'vitest';
import { requireCapability } from '@/lib/capabilities/api-guard';
import { applyDirectoryEligibility } from '@/lib/marketplace/search';
import { getPaymentLinkCreateDenial } from '@/lib/payments/payment-link-policy';
import { resolveCountryGateway } from '@/lib/payments/gateway-resolver';

// ── Helper: build a mock authenticated client that returns a specific business ──
function mockAuthClient(business: Record<string, unknown> | null) {
  return {
    from(table: string) {
      expect(table).toBe('businesses');
      return {
        select() {
          const chain = {
            eq: () => chain,
            maybeSingle: async () => ({ data: business, error: null }),
          };
          return chain;
        },
      };
    },
  } as never;
}

// ── Helper: build a mock service client with per-table behavior ──
// Supabase query builders are thenable — await resolves to { data, error }.
function mockServiceClient(tables: Record<string, { data?: unknown; error?: unknown }>) {
  return {
    from(table: string) {
      const behavior = tables[table] || { data: [], error: null };
      return {
        select() {
          const chain: Record<string, unknown> = {};
          const self = () => chain;
          chain.eq = self;
          chain.gt = self;
          chain.limit = self;
          chain.order = self;
          chain.maybeSingle = async () => behavior;
          // Make the chain thenable so `await service.from(t).select().eq()` resolves to { data, error }
          chain.then = (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
            Promise.resolve(behavior).then(resolve, reject);
          return chain;
        },
      };
    },
  } as never;
}

describe('#496 requireCapability — real guard execution', () => {
  const BUSINESS_ID = '11111111-1111-4111-8111-111111111111';
  const USER_ID = '22222222-2222-4222-8222-222222222222';

  const activeBusiness = {
    id: BUSINESS_ID,
    status: 'active',
    subscription_tier: 'free',
    trial_ends_at: null,
    category: 'restaurant',
  };

  const pendingBusiness = { ...activeBusiness, status: 'pending' };

  it('denies a pending business (lifecycle guard)', async () => {
    const result = await requireCapability(mockAuthClient(pendingBusiness), {} as never, {
      businessId: BUSINESS_ID, userId: USER_ID, capability: 'poll', action: 'create_new',
    });

    expect(result).toMatchObject({
      allowed: false,
      status: 403,
      denial: { reason: 'business_setup_incomplete', detail: 'complete_onboarding_first' },
    });
  });

  it('allows an active business with a configured and available capability', async () => {
    const service = mockServiceClient({
      business_capabilities: { data: [{ capability: 'poll', is_enabled: true, sort_order: 0 }] },
      capability_overrides: { data: [] },
      messaging_allowances: { data: [] },
    });

    const result = await requireCapability(mockAuthClient(activeBusiness), service, {
      businessId: BUSINESS_ID, userId: USER_ID, capability: 'poll', action: 'create_new',
    });

    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.business.id).toBe(BUSINESS_ID);
      expect(result.business.status).toBe('active');
    }
  });

  it('denies when capability is not configured (controlled denial, not 500)', async () => {
    const service = mockServiceClient({
      // poll NOT in the configured rows → unavailable
      business_capabilities: { data: [{ capability: 'scheduling', is_enabled: true, sort_order: 0 }] },
      capability_overrides: { data: [] },
      messaging_allowances: { data: [] },
    });

    const result = await requireCapability(mockAuthClient(activeBusiness), service, {
      businessId: BUSINESS_ID, userId: USER_ID, capability: 'poll', action: 'create_new',
    });

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.status).toBe(403);
      expect(result.denial.reason).toContain('capability');
    }
  });

  it('fails closed with override_read_error when capability_overrides read fails', async () => {
    const service = mockServiceClient({
      business_capabilities: { data: [{ capability: 'poll', is_enabled: true, sort_order: 0 }] },
      capability_overrides: { data: null, error: { message: 'permission denied for table capability_overrides' } },
      messaging_allowances: { data: [] },
    });

    const result = await requireCapability(mockAuthClient(activeBusiness), service, {
      businessId: BUSINESS_ID, userId: USER_ID, capability: 'poll', action: 'create_new',
    });

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.status).toBe(500);
      expect(result.denial.reason).toBe('override_read_error');
    }
  });
});

describe('#496 Scan-to-Pay lifecycle policy', () => {
  it('denies pending businesses before payment-link creation', () => {
    expect(getPaymentLinkCreateDenial('pending')).toEqual({
      status: 403,
      reason: 'business_setup_incomplete',
      message: 'Complete business setup before creating payment links.',
    });
  });

  it('denies suspended businesses but preserves active creation behavior', () => {
    expect(getPaymentLinkCreateDenial('suspended')?.reason).toBe('business_suspended');
    expect(getPaymentLinkCreateDenial('active')).toBeNull();
  });
});

describe('#496 canonical country gateway policy', () => {
  function countryClient(row: { payment_gateway: string | null; currency_code: string | null } | null) {
    return {
      from(table: string) {
        expect(table).toBe('countries');
        return {
          select(columns: string) {
            expect(columns).toBe('payment_gateway, currency_code');
            return {
              eq(column: string, value: unknown) {
                if (column === 'code') expect(value).toBe('NG');
                return {
                  eq(activeColumn: string, activeValue: unknown) {
                    expect(activeColumn).toBe('is_active');
                    expect(activeValue).toBe(true);
                    return {
                      async single() {
                        return row
                          ? { data: row, error: null }
                          : { data: null, error: { message: 'not found' } };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      },
    } as never;
  }

  it('resolves NG only from country authority to Paystack/NGN', async () => {
    await expect(resolveCountryGateway(countryClient({
      payment_gateway: 'paystack',
      currency_code: 'NGN',
    }), 'NG')).resolves.toEqual({
      gateway: 'paystack',
      currency: 'NGN',
      source: 'country_default',
    });
  });

  it('fails closed when the country has no configured gateway; there is no provider fallback', async () => {
    await expect(resolveCountryGateway(countryClient({
      payment_gateway: null,
      currency_code: 'NGN',
    }), 'NG')).resolves.toEqual({
      gateway: null,
      currency: null,
      source: null,
      reason: 'country_gateway_not_configured',
    });
  });
});

describe('#496 canonical public-directory eligibility', () => {
  it('uses the production helper to require active + bot_code + not opted out', () => {
    const calls: Array<[string, ...unknown[]]> = [];
    const query = {
      eq(...args: unknown[]) {
        calls.push(['eq', ...args]);
        return query;
      },
      not(...args: unknown[]) {
        calls.push(['not', ...args]);
        return query;
      },
      or(...args: unknown[]) {
        calls.push(['or', ...args]);
        return query;
      },
    };

    expect(applyDirectoryEligibility(query)).toBe(query);
    expect(calls).toEqual([
      ['eq', 'status', 'active'],
      ['not', 'bot_code', 'is', null],
      ['or', 'discovery_enabled.is.null,discovery_enabled.eq.true'],
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import { requireCapability } from '@/lib/capabilities/api-guard';
import { applyDirectoryEligibility } from '@/lib/marketplace/search';
import { getPaymentLinkCreateDenial } from '@/lib/payments/payment-link-policy';
import { resolveCountryGateway } from '@/lib/payments/gateway-resolver';

describe('#496 Poll production create_new guard', () => {
  it('denies a pending business through the exact requireCapability path used by POST /api/polls', async () => {
    const pendingBusiness = {
      id: '11111111-1111-4111-8111-111111111111',
      status: 'pending',
      subscription_tier: 'free',
      trial_ends_at: null,
      category: 'restaurant',
    };

    const supabase = {
      from(table: string) {
        expect(table).toBe('businesses');
        return {
          select(columns: string) {
            expect(columns).toContain('status');
            const chain = {
              eq: () => chain,
              maybeSingle: async () => ({ data: pendingBusiness, error: null }),
            };
            return chain;
          },
        };
      },
    } as never;

    const result = await requireCapability(supabase, {} as never, {
      businessId: pendingBusiness.id,
      userId: '22222222-2222-4222-8222-222222222222',
      capability: 'poll',
      action: 'create_new',
    });

    expect(result).toMatchObject({
      allowed: false,
      status: 403,
      denial: {
        reason: 'business_setup_incomplete',
        detail: 'complete_onboarding_first',
      },
    });
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

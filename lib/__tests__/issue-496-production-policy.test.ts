import { describe, expect, it } from 'vitest';
import { getPaymentLinkCreateDenial } from '@/lib/payments/payment-link-policy';
import { resolveCountryGateway } from '@/lib/payments/gateway-resolver';

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

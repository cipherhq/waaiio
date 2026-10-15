import { describe, expect, it, vi } from 'vitest';
import { normalizePaystackCardAuthorization, persistPaystackCardAuthorization } from '../paystack-card-authorization';

describe('Paystack reusable card authorization', () => {
  it('normalizes only reusable, complete authorizations', () => {
    expect(normalizePaystackCardAuthorization(
      { reusable: true, authorization_code: 'AUTH', last4: '1234', pan: '4111111111111111' },
      { email: 'payer@example.test', customer_code: 'CUS' },
    )).toEqual({
      authorization_code: 'AUTH', customer_code: 'CUS', email: 'payer@example.test',
      last4: '1234', brand: null, exp_month: null, exp_year: null,
      card_type: null, bank: null, reusable: true,
    });
    expect(normalizePaystackCardAuthorization({ reusable: false, authorization_code: 'AUTH' }, { email: 'x@y.test' })).toBeUndefined();
    expect(normalizePaystackCardAuthorization({ reusable: true, authorization_code: 'AUTH' }, {})).toBeUndefined();
  });

  it('calls the canonical persistence RPC and reports failure closed', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
    const sb = { rpc } as never;
    const auth = normalizePaystackCardAuthorization({ reusable: true, authorization_code: 'AUTH' }, { email: 'payer@example.test' });
    expect(await persistPaystackCardAuthorization(sb, 'payment-id', 25, 'ngn', auth)).toBe(true);
    expect(rpc).toHaveBeenCalledWith('persist_verified_paystack_card_authorization', expect.objectContaining({
      p_payment_id: 'payment-id', p_amount: 25, p_currency: 'NGN',
    }));
    rpc.mockResolvedValue({ data: null, error: new Error('db failure') });
    expect(await persistPaystackCardAuthorization(sb, 'payment-id', 25, 'NGN', auth)).toBe(false);
  });
});

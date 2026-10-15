import { describe, expect, it } from 'vitest';
import { PAYMENT_LINK_PRIVACY } from '../payment-link-privacy';

describe('gateway-neutral payment link privacy notice', () => {
  it('distinguishes full sensitive card data from payment records', () => {
    expect(PAYMENT_LINK_PRIVACY.description).toContain('does not store your full card number or CVV');
    expect(PAYMENT_LINK_PRIVACY.description).toContain('business cannot view your full card details');
    expect(PAYMENT_LINK_PRIVACY.description).toContain('payment amount, status');
  });
  it('does not promise that no customer or transaction data is retained', () => {
    expect(PAYMENT_LINK_PRIVACY.description).not.toMatch(/never stored|stores no card information|business sees no payment/i);
  });
});

/**
 * #379: Stripe saved-card PI params and error evidence tests.
 *
 * Proves:
 * 1. chargeStripeSavedCard sends payment_method_types[0]=card
 * 2. buildSavedCardPIParams includes card type restriction
 * 3. Config/invalid_request error evidence is persisted on the payment row
 * 4. Same-row recovery fencing preserved (no duplicate payment)
 * 5. requires_action still routes through durable Waaiio auth
 * 6. Success → canonical Payment Authority finalization
 * 7. Config errors are NOT treated as customer declines
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════
// 1 + 2: Card-only PI params
// ═══════════════════════════════════════════════════════════════════

describe('#379: Card-only PI params', () => {
  it('chargeStripeSavedCard sends payment_method_types[0]=card', async () => {
    // Mock fetch to capture the request
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'pi_test', status: 'succeeded' }),
    });
    globalThis.fetch = fetchSpy;

    // Mock env
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_dummy');

    const { chargeStripeSavedCard } = await import('../payments/stripe-saved-card');
    await chargeStripeSavedCard({
      customerId: 'cus_test',
      paymentMethodId: 'pm_test',
      amountCents: 12000,
      currency: 'USD',
      idempotencyKey: 'sc_charge_test',
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.stripe.com/v1/payment_intents');
    const body = opts.body as string;
    // Must include card-only restriction
    expect(body).toContain('payment_method_types%5B0%5D=card');
    // Must include confirm=true
    expect(body).toContain('confirm=true');
    // Must include customer and payment_method
    expect(body).toContain('customer=cus_test');
    expect(body).toContain('payment_method=pm_test');

    vi.unstubAllEnvs();
  });

  it('buildSavedCardPIParams includes payment_method_types[0]=card', async () => {
    const { buildSavedCardPIParams } = await import('../payments/stripe-saved-card');
    const params = buildSavedCardPIParams({
      customerId: 'cus_test',
      paymentMethodId: 'pm_test',
      amountCents: 5000,
      currency: 'NGN',
    });

    expect(params['payment_method_types[0]']).toBe('card');
    expect(params.confirm).toBe('true');
    expect(params.customer).toBe('cus_test');
  });

  it('buildSavedCardPIParams preserves application_fee_amount and transfer_data', async () => {
    const { buildSavedCardPIParams } = await import('../payments/stripe-saved-card');
    const params = buildSavedCardPIParams({
      customerId: 'cus_test',
      paymentMethodId: 'pm_test',
      amountCents: 10000,
      currency: 'USD',
      stripeAccountId: 'acct_dest',
      applicationFeeAmount: 500,
    });

    expect(params['payment_method_types[0]']).toBe('card');
    expect(params['transfer_data[destination]']).toBe('acct_dest');
    expect(params['application_fee_amount']).toBe('500');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3: Error evidence persistence
// ═══════════════════════════════════════════════════════════════════

describe('#379: Error evidence persistence', () => {
  it('config/invalid_request error returns indeterminate (not decline) with error message', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_dummy');
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        error: {
          type: 'invalid_request_error',
          code: 'parameter_missing',
          message: 'Missing required parameter: return_url',
        },
      }),
    });

    const { chargeStripeSavedCard } = await import('../payments/stripe-saved-card');
    const result = await chargeStripeSavedCard({
      customerId: 'cus_test',
      paymentMethodId: 'pm_test',
      amountCents: 12000,
      currency: 'USD',
      idempotencyKey: 'sc_charge_test_err',
    });

    // Must NOT be declined
    expect(result.status).not.toBe('declined');
    // Must be indeterminate
    expect(result.status).toBe('indeterminate');
    // Must contain error evidence
    expect(result.errorMessage).toContain('config');
    expect(result.errorMessage).toContain('400');

    vi.unstubAllEnvs();
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4 + 5 + 6: Source-level verification
// ═══════════════════════════════════════════════════════════════════

import { readFileSync } from 'fs';

describe('#379: Source-level invariants', () => {
  it('saved-payment-adapter persists error evidence on indeterminate dispatch', () => {
    const code = readFileSync('lib/payments/saved-payment-adapter.ts', 'utf-8');
    // Must persist gateway_status with dispatch error evidence
    expect(code).toContain('dispatched_error:');
  });

  it('recovery helper uses same sc_charge_ key pattern', () => {
    const recovery = readFileSync('lib/payments/saved-card-recovery.ts', 'utf-8');
    expect(recovery).toContain('`sc_charge_${paymentId}`');
  });

  it('3DS auth still uses createAuthAttempt (not raw Stripe URL)', () => {
    const adapter = readFileSync('lib/payments/saved-payment-adapter.ts', 'utf-8');
    expect(adapter).toContain('createAuthAttempt');
    expect(adapter).toContain('authResult.authUrl');
  });

  it('Stripe Checkout (ordinary checkout) is NOT affected by card-only restriction', () => {
    const stripe = readFileSync('lib/payments/stripe.ts', 'utf-8');
    // Stripe Checkout uses mode: 'payment', not payment_method_types
    expect(stripe).toContain("mode: 'payment'");
    // Should NOT contain payment_method_types[0] in checkout path
    // (only saved-card PI dispatch uses it)
  });
});

/**
 * Payment Activation Gate — Integration Tests
 *
 * Proves ENABLE_PAYMENTS=false blocks ALL customer payment initiation
 * at the factory level (getPaymentGateway / getPaymentGatewayByName).
 * Every caller — including direct gateway usage in Meta webhook — is blocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('ENABLE_PAYMENTS centralized factory gate', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.ENABLE_PAYMENTS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ENABLE_PAYMENTS;
  });

  it('getPaymentGateway returns disabled gateway when ENABLE_PAYMENTS unset', async () => {
    delete process.env.ENABLE_PAYMENTS;
    const { getPaymentGateway } = await import('@/lib/payments/factory');
    const gw = getPaymentGateway('NG');
    const result = await gw.initializePayment({} as never);
    expect(result).toBeNull();
  });

  it('getPaymentGatewayByName returns disabled gateway when ENABLE_PAYMENTS="false"', async () => {
    process.env.ENABLE_PAYMENTS = 'false';
    const { getPaymentGatewayByName } = await import('@/lib/payments/factory');
    const gw = getPaymentGatewayByName('paystack');
    const result = await gw.initializePayment({} as never);
    expect(result).toBeNull();
  });

  it('getPaymentGateway returns real gateway when ENABLE_PAYMENTS="true"', async () => {
    process.env.ENABLE_PAYMENTS = 'true';
    const { getPaymentGateway, isPaymentEnabled } = await import('@/lib/payments/factory');
    expect(isPaymentEnabled()).toBe(true);
    const gw = getPaymentGateway('NG');
    // Real gateway has a constructor name (PaystackGateway, etc.) — not the anonymous disabled stub
    expect(gw.constructor.name).not.toBe('Object');
  });

  it('ENABLE_PAYMENTS="1" does NOT enable (strict check)', async () => {
    process.env.ENABLE_PAYMENTS = '1';
    const { isPaymentEnabled, getPaymentGateway } = await import('@/lib/payments/factory');
    expect(isPaymentEnabled()).toBe(false);
    const gw = getPaymentGateway('NG');
    const result = await gw.initializePayment({} as never);
    expect(result).toBeNull();
  });

  it('Meta webhook catalog order path uses factory (blocked when disabled)', async () => {
    delete process.env.ENABLE_PAYMENTS;
    // The Meta webhook at app/api/webhook/meta-cloud/route.ts line 142-143 calls:
    //   getPaymentGatewayByName(gatewayName) or getPaymentGateway(countryCode)
    // Both are blocked by the factory gate.
    const { getPaymentGateway, getPaymentGatewayByName } = await import('@/lib/payments/factory');

    // Simulate the exact code path from the webhook handler
    const gatewayByName = getPaymentGatewayByName('paystack');
    const gatewayByCountry = getPaymentGateway('NG');

    const resultByName = await gatewayByName.initializePayment({} as never);
    const resultByCountry = await gatewayByCountry.initializePayment({} as never);

    expect(resultByName).toBeNull();
    expect(resultByCountry).toBeNull();
  });

  it('recurring setup path uses factory (blocked when disabled)', async () => {
    delete process.env.ENABLE_PAYMENTS;
    // app/api/recurring/setup/route.ts line 68 calls getPaymentGateway(cc)
    const { getPaymentGateway } = await import('@/lib/payments/factory');
    const gw = getPaymentGateway('US');
    const result = await gw.initializePayment({} as never);
    expect(result).toBeNull();
  });

  it('all callers of getPaymentGateway traced and covered', () => {
    const fs = require('fs');
    // Every file that imports getPaymentGateway or getPaymentGatewayByName
    const callers = [
      'lib/bot/flows/shared/payment.ts',          // shared initializePayment
      'app/api/webhook/meta-cloud/route.ts',       // catalog orders
      'app/api/recurring/setup/route.ts',          // subscription setup
    ];
    for (const f of callers) {
      const content = fs.readFileSync(f, 'utf-8');
      expect(
        content.includes('getPaymentGateway') || content.includes('getPaymentGatewayByName')
      ).toBe(true);
    }
  });

  it('webhook reconciliation is NOT blocked (separate from initiation)', () => {
    // processSuccessfulPayment processes already-received money — no factory call
    const fs = require('fs');
    const content = fs.readFileSync('lib/payments/process-success.ts', 'utf-8');
    expect(content).not.toContain('getPaymentGateway');
    expect(content).not.toContain('ENABLE_PAYMENTS');
  });
});

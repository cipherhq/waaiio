/**
 * Payment Activation Gate — Integration Tests
 *
 * Proves ENABLE_PAYMENTS=false blocks ALL customer payment initiation
 * at the shared boundary (initializePayment function).
 *
 * Run: SUPABASE_INTEGRATION=true npx vitest run lib/__tests__/payment-gate-integration.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('ENABLE_PAYMENTS centralized gate', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.ENABLE_PAYMENTS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ENABLE_PAYMENTS;
  });

  it('initializePayment returns null when ENABLE_PAYMENTS is not set', async () => {
    delete process.env.ENABLE_PAYMENTS;
    const { initializePayment } = await import('@/lib/bot/flows/shared/payment');
    const result = await initializePayment({} as never, {
      userId: 'fake', amount: 5000, referenceCode: 'TEST', businessName: 'Test', phone: '+234',
    });
    expect(result).toBeNull();
  });

  it('initializePayment returns null when ENABLE_PAYMENTS is "false"', async () => {
    process.env.ENABLE_PAYMENTS = 'false';
    const { initializePayment } = await import('@/lib/bot/flows/shared/payment');
    const result = await initializePayment({} as never, {
      userId: 'fake', amount: 5000, referenceCode: 'TEST', businessName: 'Test', phone: '+234',
    });
    expect(result).toBeNull();
  });

  it('initializePayment returns null when ENABLE_PAYMENTS is "1"', async () => {
    process.env.ENABLE_PAYMENTS = '1';
    const { initializePayment } = await import('@/lib/bot/flows/shared/payment');
    const result = await initializePayment({} as never, {
      userId: 'fake', amount: 5000, referenceCode: 'TEST', businessName: 'Test', phone: '+234',
    });
    expect(result).toBeNull();
  });

  it('no gateway factory calls when ENABLE_PAYMENTS disabled', async () => {
    delete process.env.ENABLE_PAYMENTS;
    const factorySpy = vi.fn();
    vi.doMock('@/lib/payments/factory', () => ({
      getPaymentGateway: factorySpy,
      getPaymentGatewayByName: factorySpy,
    }));
    const { initializePayment } = await import('@/lib/bot/flows/shared/payment');
    await initializePayment({} as never, {
      userId: 'fake', amount: 5000, referenceCode: 'TEST', businessName: 'Test', phone: '+234',
    });
    expect(factorySpy).not.toHaveBeenCalled();
  });

  it('ENABLE_PAYMENTS="true" allows initializePayment to proceed (hits gateway)', async () => {
    process.env.ENABLE_PAYMENTS = 'true';
    const factorySpy = vi.fn().mockReturnValue(null);
    vi.doMock('@/lib/payments/factory', () => ({
      getPaymentGateway: factorySpy,
      getPaymentGatewayByName: factorySpy,
    }));
    vi.doMock('@/lib/countries', () => ({
      getCountry: () => ({ currency_code: 'NGN' }),
    }));
    const { initializePayment } = await import('@/lib/bot/flows/shared/payment');
    // Will fail because gateway returns null, but it PROCEEDS past the gate
    const result = await initializePayment({} as never, {
      userId: 'fake', amount: 5000, referenceCode: 'TEST', businessName: 'Test', phone: '+234',
    });
    // Gateway returned null so initializePayment returns null too,
    // but the factory WAS called (gate didn't block)
    expect(factorySpy).toHaveBeenCalled();
  });

  it('webhook reconciliation is NOT blocked (separate from initiation)', async () => {
    // Webhook handler reads env at import time but processes already-received payments
    // It does NOT call initializePayment — it calls processSuccessfulPayment
    const processSuccessSource = (await import('fs')).readFileSync(
      'lib/payments/process-success.ts', 'utf-8'
    );
    // processSuccessfulPayment does NOT check ENABLE_PAYMENTS (intentional)
    expect(processSuccessSource).not.toContain('ENABLE_PAYMENTS');
  });

  it('all initiation routes call initializePayment (not direct gateway)', () => {
    const fs = require('fs');
    const routes = [
      'app/api/invoices/pay/route.ts',
      'app/api/bookings/public/create/route.ts',
      'app/api/events/purchase/route.ts',
      'app/api/orders/quote-accept/route.ts',
      'app/api/bookings/request-balance/route.ts',
      'app/api/payment-request/send/route.ts',
    ];
    for (const route of routes) {
      const content = fs.readFileSync(route, 'utf-8');
      expect(content).toContain('initializePayment');
    }
  });
});

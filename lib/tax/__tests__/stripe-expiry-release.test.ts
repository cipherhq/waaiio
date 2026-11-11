/**
 * Owner decision #980 (2026-11-11): a customer may pay again after a taxed
 * checkout ends. Real Stripe webhook route with mocked Supabase: an expired
 * taxed checkout is failed and released in one database step.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'crypto';
import { NextRequest } from 'next/server';

const SECRET = 'whsec_test_tax_expiry';
const state = vi.hoisted(() => ({
  payment: null as null | Record<string, unknown>,
  lookupError: null as null | Record<string, unknown>,
  rpcResult: true as unknown,
  rpcCalls: [] as Array<{ fn: string; args: unknown }>,
  paymentUpdates: [] as Array<Record<string, unknown>>,
}));

function client() {
  const chain = (table: string): any => new Proxy({}, {
    get(_t, prop: string) {
      if (prop === 'then') return (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null });
      if (prop === 'maybeSingle') return async () => ({ data: table === 'payments' ? state.payment : null, error: table === 'payments' ? state.lookupError : null });
      if (prop === 'single') return async () => ({ data: null, error: null });
      if (prop === 'update') return (payload: Record<string, unknown>) => {
        if (table === 'payments') state.paymentUpdates.push(payload);
        return chain(table);
      };
      return () => chain(table);
    },
  });
  return {
    from: (table: string) => chain(table),
    rpc: vi.fn(async (fn: string, args: unknown) => {
      state.rpcCalls.push({ fn, args });
      return { data: state.rpcResult, error: null };
    }),
  };
}

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => client() }));
vi.mock('@/lib/payments/send-confirmation', () => ({ sendProactiveConfirmation: vi.fn() }));
vi.mock('@/lib/alerts/create-alert', () => ({ createAlert: vi.fn() }));
vi.mock('@/lib/email/client', () => ({ sendEmail: vi.fn() }));
vi.mock('@/lib/email/templates', () => ({ subscriptionRenewalReceiptEmail: vi.fn(() => ({ subject: 's', html: 'h' })) }));
vi.mock('@/lib/payments/notify-charge-failed', () => ({ notifyCustomerChargeFailed: vi.fn() }));
vi.mock('@/lib/logger', () => {
  const noop = vi.fn();
  const ctx = { error: noop, warn: noop, info: noop };
  return { logger: { info: noop, warn: noop, error: noop, withContext: vi.fn(() => ctx) } };
});
vi.mock('@/lib/errors', () => ({ safeLogErrorContext: vi.fn(() => ({})) }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

vi.stubEnv('STRIPE_WEBHOOK_SECRET', SECRET);
const { POST } = await import('@/app/api/payments/stripe-webhook/route');

async function expire(sessionId: string) {
  const body = JSON.stringify({ type: 'checkout.session.expired', id: `evt_${sessionId}`, data: { object: { id: sessionId, object: 'checkout.session' } } });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const sig = createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex');
  return POST(new NextRequest('https://example.com/api/payments/stripe-webhook', {
    method: 'POST', body, headers: { 'stripe-signature': `t=${timestamp},v1=${sig}` },
  }));
}

describe('Stripe checkout expiry on a taxed sale (#980)', () => {
  beforeEach(() => { state.payment = null; state.lookupError = null; state.rpcResult = true; state.rpcCalls = []; state.paymentUpdates = []; });

  it('releases the taxed attempt atomically instead of only marking it failed', async () => {
    state.payment = { id: 'pay-tax', amount: 12, business_id: 'biz', gateway: 'stripe', tax_allocation: { grossAmount: 1200 } };
    expect((await expire('cs_tax_expired')).status).toBe(200);
    expect(state.rpcCalls).toEqual([{ fn: 'confirm_merchant_tax_payment_failure_980',
      args: { p_payment_id: 'pay-tax', p_gateway: 'stripe', p_reference: 'cs_tax_expired', p_status: 'expired' } }]);
    expect(state.paymentUpdates).toEqual([]);
  });

  it('asks Stripe to resend when the payment lookup fails, changing nothing', async () => {
    state.lookupError = { message: 'db unavailable' };
    expect((await expire('cs_lookup_error')).status).toBe(500);
    expect(state.rpcCalls).toEqual([]);
    expect(state.paymentUpdates).toEqual([]);
  });

  it('keeps the existing plain failure update for untaxed payments', async () => {
    state.payment = { id: 'pay-plain', amount: 12, business_id: 'biz', gateway: 'stripe', tax_allocation: null };
    expect((await expire('cs_plain_expired')).status).toBe(200);
    expect(state.rpcCalls.filter(c => c.fn === 'confirm_merchant_tax_payment_failure_980')).toEqual([]);
    expect(state.paymentUpdates).toContainEqual({ status: 'failed', gateway_status: 'expired' });
  });
});

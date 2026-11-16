/**
 * #1068: Stripe API 2026-09-30.endive rejects the legacy `payment_method_types`
 * ("The `payment_method_types` parameter is no longer supported", HTTP 400,
 * invalid_request_error, param payment_method_types). Saved-card PaymentIntents and the
 * recurring / messaging top-up Checkout flows retry once with the Endive card allowlist,
 * only on that exact rejection. Real modules; only Stripe HTTP (fetch) and DB are faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
type Call = { url: string; headers: Record<string, string>; body: Record<string, string> };

vi.mock('@/lib/logger', () => {
  const l: Record<string, unknown> = { error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn() };
  l.withContext = () => l;
  return { logger: l };
});

const ENDIVE_REJECTION = {
  error: {
    type: 'invalid_request_error',
    param: 'payment_method_types',
    message: 'The `payment_method_types` parameter is no longer supported. Payment methods are now managed from your Dashboard settings.',
  },
};

/** Stripe stub: replies from `answer(body)`; records every call. */
function stubStripe(answer: (body: Record<string, string>) => { status: number; json: Row }) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = Object.fromEntries(new URLSearchParams(String(init?.body || '')));
    calls.push({ url, headers: (init?.headers || {}) as Record<string, string>, body });
    const { status, json } = answer(body);
    return { ok: status < 300, status, json: async () => json, headers: { get: () => null } } as unknown as Response;
  }));
  return calls;
}
const endiveAccount = (success: Row) => (body: Record<string, string>) =>
  body['payment_method_types[0]'] ? { status: 400, json: ENDIVE_REJECTION } : { status: 200, json: success };

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('STRIPE_SECRET_KEY', 'stripe-test-key-1068');
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('saved-card PaymentIntent (#1068)', () => {
  const legacy = {
    customer: 'cus_1', payment_method: 'pm_1', amount: '5000', currency: 'usd', confirm: 'true', 'payment_method_types[0]': 'card',
  };

  it('Endive account: one retry with the card allowlist under a derived key, then charged', async () => {
    const calls = stubStripe(endiveAccount({ id: 'pi_1', status: 'succeeded' }));
    const { chargeStripeSavedCard } = await import('../stripe-saved-card');
    const result = await chargeStripeSavedCard({
      customerId: 'cus_1', paymentMethodId: 'pm_1', amountCents: 5000, currency: 'USD', idempotencyKey: 'sc_charge_pay-1',
    });
    expect(result).toEqual({ status: 'succeeded', paymentIntentId: 'pi_1' });
    expect(calls).toHaveLength(2);
    expect(calls[0].headers['Idempotency-Key']).toBe('sc_charge_pay-1');
    expect(calls[1].url).toBe('https://api.stripe.com/v1/payment_intents');
    expect(calls[1].headers['Idempotency-Key']).toBe('sc_charge_pay-1_endive_card');
    expect(calls[1].body).toMatchObject({ 'allowed_payment_method_types[0]': 'card', customer: 'cus_1', payment_method: 'pm_1', amount: '5000' });
    expect(calls[1].body).not.toHaveProperty('payment_method_types[0]');
  });

  it('older API version: the legacy request is used as before, no retry', async () => {
    const calls = stubStripe(() => ({ status: 200, json: { id: 'pi_2', status: 'succeeded' } }));
    const { postSavedCardPaymentIntent } = await import('../stripe-saved-card');
    const res = await postSavedCardPaymentIntent(legacy, 'sc_charge_pay-2');
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].body['payment_method_types[0]']).toBe('card');
  });

  it('any other 400 is not retried', async () => {
    const calls = stubStripe(() => ({ status: 400, json: { error: { type: 'invalid_request_error', param: 'amount' } } }));
    const { postSavedCardPaymentIntent } = await import('../stripe-saved-card');
    const res = await postSavedCardPaymentIntent(legacy, 'sc_charge_pay-3');
    expect(res.httpStatus).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it('a rejection even after the allowlist retry fails cleanly as not charged, with bounded evidence', async () => {
    const calls = stubStripe(() => ({ status: 400, json: ENDIVE_REJECTION }));
    const { chargeStripeSavedCard } = await import('../stripe-saved-card');
    const result = await chargeStripeSavedCard({
      customerId: 'cus_1', paymentMethodId: 'pm_1', amountCents: 5000, currency: 'USD', idempotencyKey: 'sc_charge_pay-4',
    });
    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({
      status: 'declined',
      errorMessage: 'Saved card payment could not be completed',
      errorEvidence: { httpStatus: 400, type: 'invalid_request_error', param: 'payment_method_types', classification: 'request_rejected' },
    });
  });

  it('recovery replays the stored legacy params and converges on the same derived key', async () => {
    const { postSavedCardPaymentIntent } = await import('../stripe-saved-card');
    const calls = stubStripe(endiveAccount({ id: 'pi_5', status: 'succeeded' }));
    await postSavedCardPaymentIntent(legacy, 'sc_charge_pay-5');
    await postSavedCardPaymentIntent(legacy, 'sc_charge_pay-5');
    const endiveKeys = calls.filter(c => c.body['allowed_payment_method_types[0]']).map(c => c.headers['Idempotency-Key']);
    expect(endiveKeys).toEqual(['sc_charge_pay-5_endive_card', 'sc_charge_pay-5_endive_card']);
  });
});

describe('card-only Checkout Sessions (#1068)', () => {
  const params = { mode: 'payment', 'payment_method_types[0]': 'card', 'line_items[0][quantity]': '1' };

  it('Endive account: retried once with the card allowlist', async () => {
    const calls = stubStripe(endiveAccount({ id: 'cs_1', url: 'https://checkout.stripe.test/1' }));
    const { createCardOnlyCheckoutSession } = await import('../stripe-checkout-failure');
    const data = await createCardOnlyCheckoutSession('stripe-test-key-1068', params);
    expect(data).toMatchObject({ id: 'cs_1', url: 'https://checkout.stripe.test/1' });
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(calls[1].body).toMatchObject({ 'allowed_payment_method_types[0]': 'card', mode: 'payment' });
    expect(calls[1].body).not.toHaveProperty('payment_method_types[0]');
  });

  it('older API version or another error: single request', async () => {
    const ok = stubStripe(() => ({ status: 200, json: { id: 'cs_2', url: 'https://checkout.stripe.test/2' } }));
    const { createCardOnlyCheckoutSession } = await import('../stripe-checkout-failure');
    await createCardOnlyCheckoutSession('k', params);
    expect(ok).toHaveLength(1);
    const bad = stubStripe(() => ({ status: 400, json: { error: { type: 'invalid_request_error', param: 'line_items[0][price]' } } }));
    const data = await createCardOnlyCheckoutSession('k', params);
    expect(bad).toHaveLength(1);
    expect(data.url).toBeUndefined();
  });

  it('recurring Checkout works on an Endive account', async () => {
    const calls = stubStripe(endiveAccount({ id: 'cs_sub', url: 'https://checkout.stripe.test/sub' }));
    const { createRecurringCheckout } = await import('../stripe-recurring');
    const session = await createRecurringCheckout({
      amount: 20, currency: 'USD', interval: 'month', businessName: 'BalaShop', serviceName: 'Plan',
    } as Parameters<typeof createRecurringCheckout>[0]);
    expect(session).toEqual({ sessionId: 'cs_sub', url: 'https://checkout.stripe.test/sub' });
    expect(calls[1].body).toMatchObject({ mode: 'subscription', 'allowed_payment_method_types[0]': 'card' });
  });
});

describe('merchant messaging top-up by Stripe (#1068)', () => {
  it('creates the Checkout Session on an Endive account and records it', async () => {
    const updates: Row[] = [];
    const chain = (table: string): Record<string, unknown> => {
      const c: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'insert']) c[m] = vi.fn(() => c);
      c.update = vi.fn((v: Row) => { updates.push({ table, ...v }); return c; });
      const row: Record<string, Row> = {
        businesses: { id: 'biz-1', owner_id: 'user-1', country_code: 'US' },
        countries: { currency_code: 'USD', payment_gateway: 'stripe' },
        platform_settings: { value: { USD: [{ label: '$5', amount_minor: 500 }] } },
        messaging_topup_purchases: { id: 'purchase-1' },
        profiles: { email: 'owner@example.com' },
      };
      c.single = vi.fn(async () => ({ data: row[table] ?? null, error: null }));
      return c;
    };
    vi.doMock('@/lib/supabase/server', () => ({
      createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) }, from: chain }),
    }));
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: () => ({ from: chain, rpc: vi.fn(async () => ({ data: 'cfg-1', error: null })) }),
    }));
    const calls = stubStripe(endiveAccount({ id: 'cs_topup', url: 'https://checkout.stripe.test/topup' }));
    const { POST } = await import('@/app/api/messaging/topup/route');
    const res = await POST(new Request('http://localhost/api/messaging/topup', {
      method: 'POST', body: JSON.stringify({ business_id: 'biz-1', package_amount_minor: 500 }),
    }) as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ authorization_url: 'https://checkout.stripe.test/topup', reference: 'cs_topup' });
    expect(calls.map(c => c.url)).toEqual(['https://api.stripe.com/v1/checkout/sessions', 'https://api.stripe.com/v1/checkout/sessions']);
    expect(calls[1].body).toMatchObject({ 'allowed_payment_method_types[0]': 'card', 'line_items[0][price_data][unit_amount]': '500' });
    expect(updates).toContainEqual({ table: 'messaging_topup_purchases', provider_checkout_id: 'cs_topup' });
  });
});

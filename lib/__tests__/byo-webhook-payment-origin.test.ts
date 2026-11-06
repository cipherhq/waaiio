/**
 * BYO webhook acts only on payments created on the merchant's own provider
 * account (origin 'byo') for the same business and gateway.
 *
 * Runs the real route handler; Supabase, encryption, Sentry, the success
 * handler and the provider verify call (fetch) are stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'crypto';
import { NextRequest } from 'next/server';

const SECRET = 'sk_test_byo_origin';
const BIZ = 'biz-1';
const REF = 'WA-PY-ORIGIN-1';

let paymentRow: Record<string, unknown> | null;
let credGateway: 'paystack' | 'flutterwave';
const { successHandler } = vi.hoisted(() => ({ successHandler: vi.fn(async () => 'finalized') }));
const fetchMock = vi.fn();

function chain(result: { data: unknown; error: unknown }) {
  const c: Record<string, unknown> = {};
  const self = () => c;
  c.select = self; c.eq = self; c.in = self; c.is = self;
  c.maybeSingle = () => Promise.resolve(result);
  c.single = () => Promise.resolve(result);
  return c;
}

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      if (table === 'business_payment_credentials') {
        return chain({
          data: {
            secret_key: SECRET,
            gateway: credGateway,
            webhook_secret_hash: credGateway === 'flutterwave' ? 'fw-hash' : null,
          },
          error: null,
        });
      }
      if (table === 'payments') return chain({ data: paymentRow, error: null });
      if (table === 'processed_webhook_events') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
          upsert: () => Promise.resolve({ data: [{ id: 'evt' }], error: null }),
        };
      }
      return chain({ data: null, error: null });
    },
  }),
}));
vi.mock('@/lib/encryption', () => ({ decryptToken: (s: string) => s }));
vi.mock('@/lib/payments/webhook-handler', () => ({
  processPaystackChargeSuccess: successHandler,
  processPaystackChargeFailed: vi.fn(),
}));
vi.mock('@sentry/nextjs', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));

import { POST } from '@/app/api/payments/byo-webhook/[businessId]/route';

function paystackRequest() {
  const body = JSON.stringify({ event: 'charge.success', data: { reference: REF, amount: 500000, currency: 'NGN' } });
  const sig = createHmac('sha512', SECRET).update(body).digest('hex');
  return new NextRequest(new URL(`http://localhost/api/payments/byo-webhook/${BIZ}`), {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json', 'x-paystack-signature': sig },
  });
}

function flutterwaveRequest() {
  const body = JSON.stringify({ event: 'charge.completed', data: { tx_ref: REF, id: 42, amount: 5000, currency: 'NGN' } });
  return new NextRequest(new URL(`http://localhost/api/payments/byo-webhook/${BIZ}`), {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json', 'verif-hash': 'fw-hash' },
  });
}

const params = { params: Promise.resolve({ businessId: BIZ }) };

function pending(overrides: Record<string, unknown>) {
  return { id: 'pay-1', status: 'pending', amount: 5000, currency: 'NGN', gateway: 'paystack', ...overrides };
}

beforeEach(() => {
  credGateway = 'paystack';
  successHandler.mockClear();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ data: { status: 'success', amount: 500000, currency: 'NGN', reference: REF } }),
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('BYO webhook refuses payments not created on the merchant account', () => {
  it.each([
    ['platform origin', { metadata: { payment_origin: 'platform' } }],
    ['connected split origin', { metadata: { payment_origin: 'connect', connect: true } }],
    ['no origin recorded', { metadata: {} }],
    ['unknown origin', { metadata: { payment_origin: 'other' } }],
    ['BYO for another business', { metadata: { payment_origin: 'byo', byo_business_id: 'biz-2' } }],
    ['BYO on another gateway', { gateway: 'flutterwave', metadata: { payment_origin: 'byo' } }],
  ])('%s: acknowledged, not verified, not processed', async (_label, overrides) => {
    paymentRow = pending(overrides);

    const res = await POST(paystackRequest(), params);

    expect(res.status).toBe(200);
    expect((await res.json()).received).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(successHandler).not.toHaveBeenCalled();
  });
});

describe('BYO webhook still processes genuine BYO payments', () => {
  it('explicit byo origin for this business is verified and processed', async () => {
    paymentRow = pending({ metadata: { payment_origin: 'byo', byo: true, byo_business_id: BIZ, provider_connection_id: 'cred-1' } });

    const res = await POST(paystackRequest(), params);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(successHandler).toHaveBeenCalledTimes(1);
  });

  it('legacy BYO payment marked byo:true is still processed', async () => {
    paymentRow = pending({ metadata: { byo: true, byo_business_id: BIZ } });

    const res = await POST(paystackRequest(), params);

    expect(res.status).toBe(200);
    expect(successHandler).toHaveBeenCalledTimes(1);
  });

  it('Flutterwave BYO payment reaches provider verification', async () => {
    credGateway = 'flutterwave';
    paymentRow = pending({ gateway: 'flutterwave', metadata: { payment_origin: 'byo', byo_business_id: BIZ } });

    await POST(flutterwaveRequest(), params);

    expect(fetchMock).toHaveBeenCalled();
  });

  it('Flutterwave platform payment is not verified', async () => {
    credGateway = 'flutterwave';
    paymentRow = pending({ gateway: 'flutterwave', metadata: { payment_origin: 'platform' } });

    const res = await POST(flutterwaveRequest(), params);

    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(successHandler).not.toHaveBeenCalled();
  });
});

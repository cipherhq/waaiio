// cancelSubscriptionAtPeriodEnd (Owner decision 2026-11-18: stopping a Waaiio
// plan's renewal keeps it until the paid period ends). fetch is synthetic; no
// network call is made.
import { afterEach, describe, expect, it, vi } from 'vitest';

async function load(key: string) {
  vi.resetModules();
  vi.stubEnv('STRIPE_SECRET_KEY', key);
  return import('@/lib/payments/stripe-recurring');
}

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('cancelSubscriptionAtPeriodEnd', () => {
  it('sets cancel_at_period_end and never deletes the subscription', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'sub_1', status: 'active', cancel_at_period_end: true })));
    vi.stubGlobal('fetch', fetchMock);
    const { cancelSubscriptionAtPeriodEnd } = await load('sk_test_synthetic');
    expect(await cancelSubscriptionAtPeriodEnd('sub_1')).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.stripe.com/v1/subscriptions/sub_1');
    expect(init.method).toBe('POST');
    expect(String(init.body)).toBe('cancel_at_period_end=true');
  });

  it('is not confirmed unless Stripe says so', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'No such subscription' } }), { status: 404 })));
    const { cancelSubscriptionAtPeriodEnd } = await load('sk_test_synthetic');
    expect(await cancelSubscriptionAtPeriodEnd('sub_missing')).toBe(false);
  });

  it('refuses without a key instead of reporting success', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { cancelSubscriptionAtPeriodEnd } = await load('');
    await expect(cancelSubscriptionAtPeriodEnd('sub_1')).rejects.toThrow(/missing Stripe secret key/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * #1062 follow-up: a customer email on a reserved test domain (.invalid, .test, .example,
 * .localhost) must never reach Paystack as the payer email. Own-account (BYO) and Connect
 * routes forward opts.userEmail; a reserved one must fall back to the internal alias, the
 * same fallback used when no email is given. Real emails and the shared-platform route are
 * unchanged. Drives the real PaystackGateway with only provider HTTP (fetch) stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

function stubPaystackFetch() {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Row }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers || {}) as Record<string, string>, body: JSON.parse(String(init?.body || '{}')) });
    const payload = { status: true, data: { authorization_url: 'https://checkout.paystack.test/x', reference: 'ref-x', access_code: 'ac' } };
    return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) } as unknown as Response;
  }));
  return calls;
}

const supabase = { from: vi.fn(), rpc: vi.fn(async () => ({ data: null, error: null })) };
const base = {
  userId: 'u1', amount: 10000, currency: 'NGN', referenceCode: 'REF-1',
  businessName: 'Biz', phone: '+12404844862', businessId: 'biz-1', existingPaymentId: 'pay-pre-1',
};
const BYO = { isByo: true, byoSecretKey: 'sk_test_merchant_unit', byoPlatformSubaccount: 'ACCT_waaiio', byoBusinessId: 'biz-1' };
const CONNECT = { connectAccountId: 'ACCT_connect' };

async function sentEmail(extra: Row): Promise<{ email: unknown; alias: string }> {
  const calls = stubPaystackFetch();
  const { PaystackGateway } = await import('@/lib/payments/paystack');
  const { internalPaymentEmailAlias, canonicalSavedCardPhone } = await import('@/lib/payments/saved-card-compat');
  const result = await new PaystackGateway().initializePayment({ supabase: supabase as never, ...base, ...extra });
  expect(result?.url).toBe('https://checkout.paystack.test/x');
  expect(calls).toHaveLength(1);
  return { email: calls[0].body.email, alias: internalPaymentEmailAlias(canonicalSavedCardPhone(base.phone)!) };
}

beforeEach(() => {
  vi.resetModules();
  process.env.PAYSTACK_SECRET_KEY = 'sk_test_platform_unit';
  vi.doMock('@/lib/logger', () => {
    const l: Record<string, unknown> = { error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn() };
    l.withContext = () => l;
    return { logger: l };
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.PAYSTACK_SECRET_KEY;
});

describe('Paystack payer email never uses a reserved test domain (#1062)', () => {
  for (const reserved of ['qa@example.invalid', 'a@shop.test', 'b@x.example', 'c@localhost', 'D@Example.INVALID', 'e@x.invalid.']) {
    it(`BYO: ${reserved} falls back to the internal alias`, async () => {
      const { email, alias } = await sentEmail({ ...BYO, userEmail: reserved });
      expect(email).toBe(alias);
    });
    it(`Connect: ${reserved} falls back to the internal alias`, async () => {
      const { email, alias } = await sentEmail({ ...CONNECT, userEmail: reserved });
      expect(email).toBe(alias);
    });
  }

  for (const real of ['ada@gmail.com', 'ops@example.com', 'c@invalid.com', 'd@test.ng']) {
    it(`BYO: real email ${real} is still sent unchanged`, async () => {
      const { email } = await sentEmail({ ...BYO, userEmail: real });
      expect(email).toBe(real);
    });
  }

  it('BYO: no email still uses the alias', async () => {
    const { email, alias } = await sentEmail({ ...BYO });
    expect(email).toBe(alias);
  });

  it('shared platform: always the alias, real or reserved', async () => {
    for (const userEmail of ['ada@gmail.com', 'qa@example.invalid']) {
      vi.resetModules();
      const { email, alias } = await sentEmail({ userEmail });
      expect(email).toBe(alias);
    }
  });
});

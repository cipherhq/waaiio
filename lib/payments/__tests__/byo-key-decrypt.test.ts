/**
 * BYO (merchant-connected) Paystack checkout must send the merchant's
 * plaintext secret key to Paystack, not the encrypted value stored in
 * business_payment_credentials.secret_key.
 *
 * Staging evidence 2026-11-12: TestBiz booking WA-BK-8012 failed with
 * Paystack `invalid_Key` because routing passed the iv:tag:cipher string
 * through as the Bearer token, and the bot fell back to bank transfer only.
 *
 * Real code under test: bot initializePayment → resolvePaymentRoutingAuthority
 * → classifyBusinessPaymentCredential → Paystack gateway initializePayment.
 * Only the Supabase client, provider HTTP (fetch), gateway resolution and the
 * trial lookup are mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

const ENC_KEY = 'b'.repeat(64);
const PLATFORM_KEY = 'sk_test_platform_unit';
const BYO_KEY = 'sk_test_merchant_unit';

function makeSupabase(credential: Row | null) {
  const from = vi.fn((table: string) => {
    let op: 'select' | 'insert' | 'update' = 'select';
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'neq', 'not', 'in', 'is', 'like', 'order', 'limit', 'lte', 'gte', 'lt', 'gt']) {
      chain[m] = vi.fn(() => chain);
    }
    const respond = (terminal: 'single' | 'maybeSingle' | 'list') => {
      if (table === 'business_payment_credentials') return { data: credential, error: null };
      if (table === 'platform_config_versions') return { data: { id: 'cfg-1', config_snapshot: { fee_policy_enabled: true, pricing_tiers: { free: { feePercentage: 3, feeFlat: 0 } } } }, error: null };
      if (table === 'businesses') return { data: { subscription_tier: 'free', trial_ends_at: null, custom_fee_percentage: null, custom_fee_flat: null, payment_channels: null, payout_mode: 'platform_managed' }, error: null };
      if (table === 'payments' && op === 'insert') return { data: { id: 'pay-1' }, error: null };
      if (table === 'payments' && op === 'update') return { data: terminal === 'list' ? [{ id: 'pay-1' }] : { id: 'pay-1' }, error: null };
      return { data: null, error: null };
    };
    chain.insert = vi.fn(() => { op = 'insert'; return chain; });
    chain.update = vi.fn(() => { op = 'update'; return chain; });
    chain.single = vi.fn(async () => respond('single'));
    chain.maybeSingle = vi.fn(async () => respond('maybeSingle'));
    chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(respond('list')).then(res, rej);
    return chain;
  });
  return { from, rpc: vi.fn(async () => ({ data: null, error: null })) };
}

function stubPaystackFetch() {
  const calls: Array<{ url: string; authorization: string; body: Row }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const headers = (init?.headers || {}) as Record<string, string>;
    calls.push({ url: String(url), authorization: headers.Authorization, body: JSON.parse(String(init?.body || '{}')) });
    const payload = { status: true, data: { authorization_url: 'https://checkout.paystack.test/x', reference: 'ref-x', access_code: 'ac' } };
    return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) } as unknown as Response;
  }));
  return calls;
}

async function storedCredential(over: Row = {}): Promise<Row> {
  const { encryptToken } = await import('@/lib/encryption');
  return {
    id: 'cred-1',
    secret_key: encryptToken(BYO_KEY),
    platform_subaccount_code: 'ACCT_waaiio',
    connect_account_id: null,
    connection_type: null,
    ...over,
  };
}

async function runCheckout(credential: Row | null) {
  const { initializePayment } = await import('@/lib/bot/flows/shared/payment');
  return initializePayment(makeSupabase(credential) as never, {
    userId: 'u1', amount: 10000, referenceCode: 'REF-BYO', businessName: 'Biz', phone: '+2348012345678',
    businessId: 'biz-1', transactionCategory: 'scheduling',
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.stubEnv('TOKEN_ENCRYPTION_KEY', ENC_KEY);
  vi.stubEnv('PAYSTACK_SECRET_KEY', PLATFORM_KEY);
  vi.doMock('@/lib/logger', () => {
    const l: Record<string, unknown> = { error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn() };
    l.withContext = () => l;
    return { logger: l };
  });
  vi.doMock('@/lib/payments/gateway-resolver', () => ({
    resolveBusinessGateway: vi.fn().mockResolvedValue({ gateway: 'paystack', currency: 'NGN', source: 'country_default' }),
    resolveCountryGateway: vi.fn(),
  }));
  vi.doMock('@/lib/trial-status', () => ({ resolveTrialStatus: vi.fn().mockResolvedValue(false) }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('BYO Paystack checkout uses the decrypted merchant key', () => {
  it('routing returns the plaintext key for an encrypted stored credential', async () => {
    const cred = await storedCredential();
    expect(String(cred.secret_key)).not.toContain('sk_test_'); // fixture really is encrypted
    const { resolvePaymentRoutingAuthority } = await import('@/lib/payments/resolve-stripe-routing');
    const routing = await resolvePaymentRoutingAuthority(makeSupabase(cred) as never, 'biz-1', 'paystack', 10000);
    expect(routing?.classification).toBe('byo');
    expect(routing?.byoSecretKey).toBe(BYO_KEY);
    expect(routing?.byoPlatformSubaccount).toBe('ACCT_waaiio');
  });

  it('bot checkout calls Paystack with Bearer <merchant sk_> and the Waaiio fee subaccount', async () => {
    const calls = stubPaystackFetch();
    const cred = await storedCredential();
    const result = await runCheckout(cred);

    expect(result?.url).toBe('https://checkout.paystack.test/x');
    const init = calls.find(c => c.url.includes('/transaction/initialize'));
    expect(init).toBeDefined();
    expect(init!.authorization).toBe(`Bearer ${BYO_KEY}`);
    expect(init!.authorization).not.toContain(String(cred.secret_key));
    expect(init!.body.subaccount).toBe('ACCT_waaiio');
  });

  it('fails closed (no Paystack call, no platform key) when the stored key cannot be decrypted', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const calls = stubPaystackFetch();
    const cred = await storedCredential({ secret_key: 'aa:bb:cc' });
    const result = await runCheckout(cred);

    expect(result).toBeNull();
    expect(calls.filter(c => c.url.includes('paystack'))).toHaveLength(0);
  });
});

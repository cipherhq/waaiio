import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

const boundary = vi.hoisted(() => ({
  service: vi.fn(),
  rateLimit: vi.fn(),
}));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: boundary.service }));
vi.mock('@/lib/rate-limit', () => ({
  rateLimitResponseAsync: boundary.rateLimit,
  getRateLimitKey: () => 'synthetic-invoice-client',
}));
vi.mock('@/lib/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), withContext: vi.fn() };
  logger.withContext.mockReturnValue(logger);
  return { logger };
});
vi.mock('@/lib/observability', () => ({
  observe: (_name: string, _context: unknown, run: () => Promise<unknown>) => run(),
  observeProvider: (_context: unknown, run: () => Promise<unknown>) => run(),
}));

type Row = Record<string, unknown>;
type DbResult = { data: Row | null; error: { code: string; message: string } | null };
type Failure = 'insert' | 'post-lookup-missing' | 'post-lookup-error' | 'identity-update';
type Predicate = (row: Row) => boolean;
const TOKEN = 'synthetic-public-invoice-token';
const INVOICE = 'invoice-fixture';
const BUSINESS = 'business-fixture';
const PROFILE = '11111111-1111-4111-8111-111111111111';
const PAYSTACK_REFERENCE = 'provider-reference-distinct-12345678';
const PAYSTACK_ACCESS = 'access-code-distinct';
const PAYSTACK_URL = 'https://checkout.paystack.com/authorization-destination';
const STRIPE_REFERENCE = 'cs_test_synthetic_invoice';
const STRIPE_URL = 'https://checkout.stripe.com/c/pay/synthetic-invoice';
const error = (code: string): DbResult => ({ data: null, error: { code, message: 'Synthetic database failure' } });

/**
 * Stateful external-boundary double, not a replacement initializer/adapter.
 * Implements the public payments.user_id -> profiles.id nullable FK and invoice
 * linkage. Unknown tables, RPCs and provider requests fail after each test even
 * when production code catches the thrown error.
 */
class Fixture {
  invoice: Row = {
    id: INVOICE, business_id: BUSINESS, token: TOKEN, reference_code: 'SYNTHETIC-INVOICE',
    total_amount: 125, amount_paid: 25, currency: 'NGN', status: 'viewed',
    token_expires_at: null, customer_phone: '+12025550123',
    customer_email: 'payer@example.invalid', customer_name: 'Synthetic payer',
  };
  business: Row = {
    id: BUSINESS, name: 'Synthetic business', country_code: 'NG',
    payment_gateway: 'stripe', payout_mode: 'platform_managed', payment_channels: null,
  };
  country: Row = { code: 'NG', is_active: true, payment_gateway: 'paystack', currency_code: 'NGN' };
  payments: Row[] = [];
  profiles = new Set([PROFILE]);
  inserts: Row[] = [];
  events: string[] = [];
  unexpected: string[] = [];
  requests: Array<{ url: string; init?: RequestInit }> = [];
  failure?: Failure;
  providerFails = false;
  helperMetadataOverride: { checkout_url: unknown } | undefined;
  fallbackFails = false;
  fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    this.requests.push({ url, init });
    if (url === 'https://api.paystack.co/transaction/initialize' && init?.method === 'POST') {
      this.events.push('provider-initialize');
      return Response.json(this.providerFails
        ? { status: false, message: 'Synthetic rejection' }
        : { status: true, data: {
          reference: PAYSTACK_REFERENCE, access_code: PAYSTACK_ACCESS, authorization_url: PAYSTACK_URL,
        } });
    }
    if (url === 'https://api.stripe.com/v1/checkout/sessions' && init?.method === 'POST') {
      this.events.push('provider-initialize');
      return Response.json(this.providerFails
        ? { error: { message: 'Synthetic rejection' } }
        : { id: STRIPE_REFERENCE, url: STRIPE_URL });
    }
    if (url === 'https://api.stripe.com/v1/checkout/sessions/' + STRIPE_REFERENCE && !init?.method) {
      if (this.fallbackFails) throw new Error('Synthetic retrieval failure');
      return Response.json({ id: STRIPE_REFERENCE, url: STRIPE_URL });
    }
    this.unexpected.push('provider:' + url);
    throw new Error('Unexpected provider request');
  });
  client = {
    from: (table: string) => new Query(this, table),
    rpc: async (name: string) => {
      if (name === 'provision_stripe_customer_cas') {
        return { data: { current_state: 'provider_confirmed', provider_customer_id: 'cus_synthetic' }, error: null };
      }
      this.unexpected.push('rpc:' + name);
      throw new Error('Unexpected RPC');
    },
  };
  stripe() {
    this.business.country_code = 'US';
    this.business.payment_gateway = 'paystack'; // Deprecated override must lose to country authority.
    this.country = { code: 'US', is_active: true, payment_gateway: 'stripe', currency_code: 'USD' };
    this.invoice.currency = 'USD';
  }
  seedPending(gateway: 'paystack' | 'stripe' = 'paystack') {
    if (gateway === 'stripe') this.stripe();
    this.payments.push({
      id: 'payment-existing', invoice_id: INVOICE, business_id: BUSINESS, user_id: null,
      amount: 100, currency: this.country.currency_code, gateway, status: 'pending',
      gateway_reference: gateway === 'paystack' ? PAYSTACK_REFERENCE : STRIPE_REFERENCE,
      metadata: { checkout_url: gateway === 'paystack' ? PAYSTACK_URL : STRIPE_URL },
    });
  }
  rows(table: string): Row[] {
    switch (table) {
      case 'invoices': return [this.invoice];
      case 'businesses': return [this.business];
      case 'countries': return [this.country];
      case 'payments': return this.payments;
      case 'business_payment_credentials': return [];
      default:
        this.unexpected.push('table:' + table);
        throw new Error('Unexpected table');
    }
  }
}

class Query implements PromiseLike<DbResult> {
  private columns = '*';
  private predicates: Predicate[] = [];
  private operation: 'select' | 'insert' | 'update' = 'select';
  private payload: Row = {};
  private result?: DbResult;
  constructor(private fixture: Fixture, private table: string) {}
  select(columns = '*') { this.columns = columns; return this; }
  eq(column: string, value: unknown) { this.predicates.push(row => row[column] === value); return this; }
  not(column: string, _operator: string, value: unknown) { this.predicates.push(row => row[column] !== value); return this; }
  like(column: string, pattern: string) {
    this.predicates.push(row => typeof row[column] === 'string' && String(row[column]).startsWith(pattern.replace(/%$/, '')));
    return this;
  }
  order() { return this; }
  limit() { return this; }
  insert(payload: Row) { this.operation = 'insert'; this.payload = structuredClone(payload); return this; }
  update(payload: Row) { this.operation = 'update'; this.payload = structuredClone(payload); return this; }
  single() { return Promise.resolve(this.execute()); }
  maybeSingle() { return Promise.resolve(this.execute()); }
  then<TResult1 = DbResult, TResult2 = never>(
    fulfilled?: ((value: DbResult) => TResult1 | PromiseLike<TResult1>) | null,
    rejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(fulfilled, rejected);
  }
  private execute(): DbResult {
    if (this.result) return this.result;
    this.result = this.run();
    return this.result;
  }
  private run(): DbResult {
    const f = this.fixture;
    if (this.operation === 'insert') {
      if (this.table !== 'payments') {
        f.unexpected.push('insert:' + this.table);
        throw new Error('Unexpected insert');
      }
      f.events.push('payment-insert');
      f.inserts.push(structuredClone(this.payload));
      if (f.failure === 'insert') return error('23514');
      if (this.payload.user_id !== null && !f.profiles.has(String(this.payload.user_id))) return error('23503');
      if (this.payload.invoice_id !== INVOICE || this.payload.business_id !== BUSINESS) return error('23503');
      if (f.payments.some(row => row.gateway_reference === this.payload.gateway_reference)) return error('23505');
      const row = { ...this.payload, id: 'payment-created' };
      f.payments.push(row);
      return { data: structuredClone(row), error: null };
    }
    const matches = f.rows(this.table).filter(row => this.predicates.every(matchesRow => matchesRow(row)));
    if (this.operation === 'update') {
      if (this.table === 'payments' && this.payload.payment_authority_version === 1) {
        f.events.push('identity-update');
        if (f.failure === 'identity-update') return error('42501');
      }
      for (const row of matches) Object.assign(row, structuredClone(this.payload));
      return { data: matches[0] ? structuredClone(matches[0]) : null, error: null };
    }
    // This is the shared post-provider persistence check, not the route URL helper.
    if (this.table === 'payments' && this.columns === 'id, metadata') {
      f.events.push('post-provider-lookup');
      if (f.failure === 'post-lookup-missing') return { data: null, error: null };
      if (f.failure === 'post-lookup-error') return error('08006');
    }
    const row = matches[0] ? structuredClone(matches[0]) : null;
    if (row && this.table === 'payments' && this.columns === 'gateway, gateway_reference, metadata' && f.helperMetadataOverride) {
      row.metadata = { ...row.metadata as Row, ...f.helperMetadataOverride };
    }
    return { data: row, error: null };
  }
}

let fixture: Fixture;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv('PAYSTACK_SECRET_KEY', 'synthetic-paystack-key');
  vi.stubEnv('STRIPE_SECRET_KEY', 'synthetic-stripe-key');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://invoice.example.invalid');
  fixture = new Fixture();
  boundary.service.mockReturnValue(fixture.client);
  boundary.rateLimit.mockResolvedValue(null);
  vi.stubGlobal('fetch', fixture.fetch);
});
afterEach(() => {
  expect(fixture.unexpected).toEqual([]);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
async function post(body: Row = { token: TOKEN }) {
  const { POST } = await import('@/app/api/invoices/pay/route');
  return POST(new NextRequest('https://invoice.example.invalid/api/invoices/pay', {
    method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
  }));
}
async function expectWithheld() {
  const response = await post();
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: 'Failed to initialize payment. Please contact the business.' });
}
function stripeParams() {
  const request = fixture.requests.find(r => r.url === 'https://api.stripe.com/v1/checkout/sessions');
  expect(request).toBeDefined();
  return new URLSearchParams(String(request?.init?.body));
}

describe('public invoice checkout through real initializer and adapters (#762 W21)', () => {
  it('fresh Paystack persists an anonymous invoice payment and returns the exact provider URL', async () => {
    const response = await post({ token: TOKEN, amount: 1, currency: 'USD', gateway: 'stripe', businessId: 'untrusted' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: PAYSTACK_URL, reference: PAYSTACK_REFERENCE });
    expect(fixture.inserts).toHaveLength(1);
    expect(fixture.payments).toHaveLength(1);
    expect(fixture.payments[0]).toMatchObject({
      user_id: null, invoice_id: INVOICE, business_id: BUSINESS, amount: 100, currency: 'NGN',
      gateway: 'paystack', payment_authority_version: 1,
      metadata: { access_code: PAYSTACK_ACCESS, checkout_url: PAYSTACK_URL, payment_origin: 'platform' },
    });
    expect(fixture.invoice.payment_id).toBe('payment-created');
    expect(fixture.events).toEqual(['provider-initialize', 'payment-insert', 'post-provider-lookup', 'identity-update']);
    expect(fixture.requests).toHaveLength(1);
    expect(JSON.parse(String(fixture.requests[0].init?.body))).toMatchObject({
      amount: 10000, currency: 'NGN', reference: 'SYNTHETIC-INVOICE', metadata: { user_id: null },
    });
  });

  it.each(['paystack', 'stripe'] as const)('reuses the exact stored %s URL without another initialization or insert', async gateway => {
    fixture.seedPending(gateway);
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      url: gateway === 'paystack' ? PAYSTACK_URL : STRIPE_URL,
      reference: gateway === 'paystack' ? PAYSTACK_REFERENCE : STRIPE_REFERENCE,
    });
    expect(fixture.requests).toEqual([]);
    expect(fixture.inserts).toEqual([]);
    expect(fixture.payments).toHaveLength(1);
  });

  it.each<Failure>(['insert', 'post-lookup-missing', 'post-lookup-error', 'identity-update'])(
    'withholds checkout on %s failure after provider initialization', async failure => {
      fixture.failure = failure;
      await expectWithheld();
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.inserts).toHaveLength(1);
      expect(fixture.events).toContain('post-provider-lookup');
      if (failure === 'insert') expect(fixture.payments).toEqual([]);
      if (failure === 'identity-update') {
        expect(fixture.payments[0].gateway_status).toBe('review_required:identity_persist_failed');
        expect(fixture.payments[0].payment_authority_version).toBeUndefined();
      }
    },
  );

  it('fails closed on provider rejection without creating a payment', async () => {
    fixture.providerFails = true;
    await expectWithheld();
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.inserts).toEqual([]);
  });

  it('does not initialize again for a pending payment without a checkout URL', async () => {
    fixture.seedPending();
    fixture.payments[0].metadata = {};
    await expectWithheld();
    expect(fixture.requests).toEqual([]);
    expect(fixture.inserts).toEqual([]);
  });

  it('quarantine wins over pending reuse', async () => {
    fixture.seedPending();
    fixture.payments[0].gateway_status = 'review_required:synthetic';
    await expectWithheld();
    expect(fixture.requests).toEqual([]);
    expect(fixture.inserts).toEqual([]);
  });

  it('fresh Stripe omits anonymous user metadata, persists null, and returns the exact URL', async () => {
    fixture.stripe();
    const response = await post({ token: TOKEN, amount: 1, currency: 'NGN', gateway: 'paystack' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: STRIPE_URL, reference: STRIPE_REFERENCE });
    expect(fixture.requests).toHaveLength(1);
    expect(stripeParams().has('metadata[user_id]')).toBe(false);
    expect(stripeParams().get('line_items[0][price_data][unit_amount]')).toBe('10000');
    expect(stripeParams().get('line_items[0][price_data][currency]')).toBe('usd');
    expect(fixture.payments[0]).toMatchObject({
      user_id: null, invoice_id: INVOICE, amount: 100, currency: 'USD', gateway: 'stripe',
      metadata: { stripe_session_id: STRIPE_REFERENCE, checkout_url: STRIPE_URL },
    });
    expect(fixture.events).toEqual(['provider-initialize', 'payment-insert', 'post-provider-lookup', 'identity-update']);
  });

  it('preserves a non-null authenticated Stripe payer through shared initialization', async () => {
    fixture.stripe();
    const { initializePayment } = await import('@/lib/bot/flows/shared/payment');
    const result = await initializePayment(fixture.client as unknown as SupabaseClient, {
      invoiceId: INVOICE, businessId: BUSINESS, userId: PROFILE, amount: 100,
      referenceCode: 'SYNTHETIC-INVOICE', businessName: 'Synthetic business', phone: '+12025550123',
    });
    expect(result).not.toBeNull();
    expect(stripeParams().get('metadata[user_id]')).toBe(PROFILE);
    expect(fixture.payments[0].user_id).toBe(PROFILE);
  });

  it('rejects a non-null payer without a profile in the stateful schema fixture', async () => {
    const { initializePayment } = await import('@/lib/bot/flows/shared/payment');
    const result = await initializePayment(fixture.client as unknown as SupabaseClient, {
      invoiceId: INVOICE, businessId: BUSINESS, userId: '00000000-0000-0000-0000-000000000000',
      amount: 100, referenceCode: 'SYNTHETIC-INVOICE', businessName: 'Synthetic business', phone: '+12025550123',
    });
    expect(result).toBeNull();
    expect(fixture.events).toEqual(['provider-initialize', 'payment-insert', 'post-provider-lookup']);
    expect(fixture.payments).toEqual([]);
  });

  it.each([undefined, null, '', '   ', 123])('preserves the Stripe session fallback for unusable stored URL %s', async checkoutUrl => {
    fixture.stripe();
    fixture.helperMetadataOverride = { checkout_url: checkoutUrl };
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: STRIPE_URL, reference: STRIPE_REFERENCE });
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.requests[1].url).toBe('https://api.stripe.com/v1/checkout/sessions/' + STRIPE_REFERENCE);
  });

  it('preserves the short-link fallback when Stripe session retrieval fails', async () => {
    fixture.stripe();
    fixture.helperMetadataOverride = { checkout_url: null };
    fixture.fallbackFails = true;
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      url: 'https://invoice.example.invalid/api/pay?ref=' + STRIPE_REFERENCE.slice(-8), reference: STRIPE_REFERENCE,
    });
  });

  it('uses the existing short-link fallback instead of fabricating a Paystack URL', async () => {
    fixture.helperMetadataOverride = { checkout_url: null };
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      url: 'https://invoice.example.invalid/api/pay?ref=' + PAYSTACK_REFERENCE.slice(-8), reference: PAYSTACK_REFERENCE,
    });
    expect(fixture.requests).toHaveLength(1);
  });

  it.each([
    ['missing token', {}, 400, 'Token is required'],
    ['unknown token', { token: 'unknown-synthetic-token' }, 404, 'Invoice not found'],
  ])('rejects %s before provider work', async (_label, body, status, message) => {
    const response = await post(body as Row);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: message });
    expect(fixture.requests).toEqual([]);
    expect(fixture.inserts).toEqual([]);
  });

  it.each([
    ['paid', { status: 'paid' }, 'Invoice already paid'],
    ['cancelled', { status: 'cancelled' }, 'Invoice has been cancelled'],
    ['expired', { token_expires_at: '2000-01-01T00:00:00Z' }, 'Payment link has expired'],
    ['zero balance', { amount_paid: 125 }, 'Invoice already paid'],
    ['negative balance', { amount_paid: 126 }, 'Invoice already paid'],
  ])('rejects %s before provider work', async (_label, patch, message) => {
    Object.assign(fixture.invoice, patch);
    const response = await post();
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: message });
    expect(fixture.requests).toEqual([]);
    expect(fixture.inserts).toEqual([]);
  });

  it('preserves the rate-limit response without creating a service client', async () => {
    boundary.rateLimit.mockResolvedValue(Response.json({ error: 'rate limited' }, { status: 429 }));
    expect((await post()).status).toBe(429);
    expect(boundary.rateLimit).toHaveBeenCalledWith('synthetic-invoice-client', 10, 60_000);
    expect(boundary.service).not.toHaveBeenCalled();
    expect(fixture.requests).toEqual([]);
  });

  it.each([
    { is_active: false },
    { payment_gateway: null },
    { currency_code: null },
    { currency_code: 'invalid' },
  ])('fails closed when canonical country authority is unavailable: %j', async patch => {
    Object.assign(fixture.country, patch);
    await expectWithheld();
    expect(fixture.requests).toEqual([]);
    expect(fixture.inserts).toEqual([]);
  });
});

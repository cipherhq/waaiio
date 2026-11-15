import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ error: vi.fn(), context: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { error: h.error, warn: vi.fn(), info: vi.fn(), debug: vi.fn(), withContext: (ctx: unknown) => { h.context(ctx); return { error: h.error }; } } }));
vi.mock('@/lib/observability', () => ({ observeProvider: async (_: unknown, fn: () => Promise<unknown>) => fn() }));
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); vi.stubEnv('PAYSTACK_SECRET_KEY', 'sk_test_canary_DO_NOT_LOG'); vi.stubEnv('FALLBACK_EMAIL_DOMAIN', 'whatsapp.waaiio.com'); vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.invalid'); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
async function initialize(payload: unknown, status: unknown = 400) {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => ({ status, json: async () => payload })); vi.stubGlobal('fetch', fetch);
  const { PaystackGateway } = await import('../paystack');
  const from = vi.fn();
  const result = await new PaystackGateway().initializePayment({ supabase: { from } as never, existingPaymentId: 'existing', userId: 'u1', amount: 5000, currency: 'NGN', referenceCode: 'DEMO-VALIDATION-1', businessName: 'Demo', phone: '+2348012345678' });
  return { result, fetch, from };
}
describe('actual Paystack adapter validation diagnostic', () => {
  it('logs only a fixed hint and HTTP status while preserving its request and failure result', async () => {
    const { result, fetch, from } = await initialize({ status: false, code: 'invalid_params', message: 'Invalid email address: canary-person@example.invalid sk_test_CANARY_SECRET +2348098765432', payload: { secret: 'sk_test_CANARY_SECRET' } });
    expect(result).toBeNull(); expect(fetch).toHaveBeenCalledOnce(); expect(from).not.toHaveBeenCalled();
    expect(h.error).toHaveBeenCalledWith('[PAYSTACK] Initialize failed:', 'status=false, code=invalid_params', { validation_hint: 'email', http_status: 400 });
    const logs = JSON.stringify([h.error.mock.calls, h.context.mock.calls]);
    for (const secret of ['canary-person', 'CANARY_SECRET', '2348098765432', 'sk_test_canary_DO_NOT_LOG']) expect(logs).not.toContain(secret);
    const req = JSON.parse(fetch.mock.calls[0][1]!.body as string);
    expect(req).toMatchObject({ email: '2348012345678@whatsapp.waaiio.com', amount: 500000, currency: 'NGN', reference: 'DEMO-VALIDATION-1', metadata: { reference_code: 'DEMO-VALIDATION-1' } });
  });
});

import { paystackValidationDiagnostic } from '../paystack-validation-diagnostic';
describe('bounded Paystack validation classification', () => {
  it.each([
    [{ message: 'Invalid email address' }, 'email'],
    [{ message: 'Amount is invalid' }, 'amount'],
    [{ message: 'Unsupported currency' }, 'currency'],
    [{ message: 'Invalid transaction reference' }, 'reference_invalid'],
    [{ message: 'Duplicate Transaction Reference' }, 'reference_duplicate'],
    [{ message: 'Transaction reference already exists' }, 'reference_duplicate'],
    [{ message: 'Invalid callback_url' }, 'callback_url'],
    [{ message: 'Payment channels are invalid' }, 'channels'],
    [{ error: { code: 'invalid_metadata' } }, 'metadata'],
    [{ error: { code: 'invalid_params', field: 'email' } }, 'email'],
    [{ message: 'Invalid parameters' }, 'unknown'],
    [{ message: 'Invalid email and invalid amount' }, 'unknown'],
    [{ code: 'duplicate_reference', message: 'Invalid email' }, 'unknown'],
    [{ message: 'Customer wrote about email and amount' }, 'unknown'],
    [{ field: 'email' }, 'unknown'],
    [{ code: 'constructor' }, 'unknown'],
    [null, 'unknown'],
    [[], 'unknown'],
  ])('classifies %j only as an allowlisted hint', (body, hint) => {
    expect(paystackValidationDiagnostic(body, 400)).toEqual({ validation_hint: hint, http_status: 400 });
  });
  it('ignores inherited properties, accessors, coercion and oversized messages', () => {
    const getter = vi.fn(() => 'Invalid email');
    const toString = vi.fn(() => 'Invalid email');
    const bodies = [Object.create({ message: 'Invalid email' }), Object.defineProperty({}, 'message', { get: getter }), { message: { toString } }, { message: 'Invalid email' + 'x'.repeat(2048) }, new Proxy({}, { getPrototypeOf() { throw new Error('canary-secret'); } })];
    for (const body of bodies) expect(paystackValidationDiagnostic(body)).toEqual({ validation_hint: 'unknown' });
    expect(getter).not.toHaveBeenCalled(); expect(toString).not.toHaveBeenCalled();
  });
  it.each([undefined, '400', NaN, Infinity, 400.5, 99, 600])('omits non-HTTP status %s', status => {
    expect(paystackValidationDiagnostic({ message: 'Invalid email' }, status)).toEqual({ validation_hint: 'email' });
  });
  it('emits no input-derived strings even when a recognized field includes secrets and payload echoes', () => {
    const value = paystackValidationDiagnostic(JSON.parse('{"message":"Invalid email CANARY-PII@example.invalid sk_test_CANARY +2348098765432","__proto__":{"code":"invalid_amount"},"payload":{"authorization":"Bearer CANARY","customer":{"name":"CANARY"}}}'), 422);
    expect(value).toEqual({ validation_hint: 'email', http_status: 422 });
    expect(JSON.stringify(value)).not.toContain('CANARY');
  });
});

describe('adapter success and malformed failures', () => {
  it.each([null, [], { status: false, code: 'invalid_params', message: { secret: 'sk_test_CANARY' } }, JSON.parse('{"status":false,"message":"unknown CANARY@example.invalid","__proto__":{"message":"Invalid email"}}')])('returns its existing failure result without leaking malformed response %j', async payload => {
    const f = await initialize(payload, '400');
    expect(f.result).toBeNull(); expect(f.fetch).toHaveBeenCalledOnce(); expect(f.from).not.toHaveBeenCalled();
    expect(JSON.stringify([h.error.mock.calls, h.context.mock.calls])).not.toContain('CANARY');
  });
  it('keeps successful initialization unchanged and emits no failure diagnostic', async () => {
    const f = await initialize({ status: true, data: { authorization_url: 'https://checkout.example.invalid/demo', reference: 'DEMO-VALIDATION-1', access_code: 'canary-access' } }, 200);
    expect(f.result).toEqual({ url: 'https://checkout.example.invalid/demo', reference: 'DEMO-VALIDATION-1' });
    expect(f.fetch).toHaveBeenCalledOnce(); expect(f.from).not.toHaveBeenCalled(); expect(h.error).not.toHaveBeenCalled();
  });
});

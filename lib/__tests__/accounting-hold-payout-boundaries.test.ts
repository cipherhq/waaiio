import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as approve } from '@/app/api/admin/payouts/[id]/approve/route';
import { POST as confirm } from '@/app/api/admin/payouts/[id]/confirm-settlement/route';
import { POST as force } from '@/app/api/admin/payouts/[id]/force-settle/route';
import { POST as generate } from '@/app/api/admin/payouts/generate/route';
import { GET as cron } from '@/app/api/cron/auto-payout/route';

const f = vi.hoisted(() => ({ hold: vi.fn(), consume: vi.fn(), audit: vi.fn(), provider: vi.fn(), writes: vi.fn(), rpc: vi.fn(), reads: [] as string[], mode: 'single', seedRelease: false }));
vi.mock('@/lib/payouts/accounting-hold', () => ({ getMerchantAccountingHold: f.hold }));
vi.mock('@/lib/admin-auth', () => ({ requirePlatformAdmin: async () => ({ id: 'admin', userId: 'admin', role: 'admin', aal: 'aal2' }) }));
vi.mock('@/lib/admin-step-up', () => ({ consumeStepUp: f.consume, StepUpError: class extends Error {} }));
vi.mock('@/lib/admin-audit', () => ({ logAdminAudit: f.audit }));
vi.mock('@/lib/cron-auth', () => ({ verifyCronAuth: () => null }));
vi.mock('@/lib/observability/cron', () => ({ createCronLogger: () => ({ started: vi.fn(), completed: vi.fn(), failed: vi.fn() }) }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@/lib/logger', () => { const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }; return { logger: { ...log, withContext: () => log } }; });
vi.mock('@/lib/errors', () => ({ safeLogErrorContext: () => ({}) }));
vi.mock('@/lib/email/client', () => ({ sendEmail: f.provider }));
vi.mock('@/lib/email/templates', () => ({ payoutApprovedEmail: vi.fn(), payoutPaidEmail: vi.fn(), payoutFailedEmail: vi.fn() }));
vi.mock('@/lib/countries', () => ({ loadCountries: vi.fn() }));
vi.mock('@/lib/constants', () => ({ getCurrencyCode: () => 'NGN', getPaymentGatewayForCountry: () => 'paystack' }));
vi.mock('@/lib/platformSettings', () => ({ loadPlatformSettings: async () => ({ payout_cooling_period_days: 7, fraud_velocity_threshold: 100, minimum_payout: 1 }) }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => client }));
const business = { id: 'business-1', country_code: 'NG', created_at: '2020-01-01', verification_level: 'verified' };
const client = {
  rpc: f.rpc,
  from(table: string) {
    let columns = ''; let write = false;
    const q: Record<string, any> = {};
    for (const method of ['eq', 'in', 'is', 'gte', 'lte', 'limit', 'order', 'not', 'neq']) q[method] = () => q;
    q.select = (value: string) => { columns = value; f.reads.push(table + ':' + value); return q; };
    for (const method of ['insert', 'update', 'delete', 'upsert']) q[method] = (payload: unknown) => { write = true; f.writes(table, method, payload); return q; };
    const result = () => {
      if (write) return { data: [], error: null };
      if (f.mode === 'single') return { data: { id: 'payout-1', business_id: 'business-1', status: 'paid', transfer_method: 'manual_bank', currency: 'NGN' }, error: null };
      if (table === 'businesses') return { data: [business], error: null };
      if (f.mode === 'generate' && table === 'business_payouts') return { data: null, error: { message: 'dedup control' } };
      if (f.mode === 'cron' && f.seedRelease && table === 'business_payouts' && columns === 'id, business_id, currency, flags') return { data: [{ id: 'old-held', business_id: business.id, currency: 'NGN', flags: [] }], error: null };
      if (f.mode === 'cron' && f.seedRelease && table === 'payout_accounts') return { data: [{ business_id: business.id, is_active: true }], error: null };
      return { data: [], error: null };
    };
    q.single = async () => result(); q.maybeSingle = async () => result();
    q.then = (resolve: any, reject: any) => Promise.resolve(result()).then(resolve, reject);
    return q;
  },
};
const request = () => new NextRequest('https://example.invalid/api/payouts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transfer_method: 'manual_bank', transfer_reference: 'fixture-reference', reason: 'fixture prior authority evidence', attestation: true, stepUpId: 'step-1' }) });
const context = () => ({ params: Promise.resolve({ id: 'payout-1' }) });
beforeEach(() => {
  vi.clearAllMocks(); f.mode = 'single'; f.seedRelease = false; f.reads = [];
  f.hold.mockResolvedValue(true); f.consume.mockResolvedValue(undefined); f.audit.mockResolvedValue(undefined);
  f.provider.mockImplementation(() => { throw Error('Provider network forbidden in fixture'); });
  vi.stubGlobal('fetch', f.provider); vi.stubEnv('ENABLE_PAYOUTS', 'true');
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function noAuthority() { expect(f.writes).not.toHaveBeenCalled(); expect(f.rpc).not.toHaveBeenCalled(); expect(f.provider).not.toHaveBeenCalled(); }

describe.each([['approve', approve], ['confirm', confirm], ['force', force]] as const)('%s actual held-domain handler', (_name, handler) => {
  it('denies held business before step-up consumption or payout/provider mutation', async () => {
    const response = await handler(request(), context());
    expect(response.status).toBe(409); expect((await response.json()).code).toBe('merchant_accounting_held');
    expect(f.hold).toHaveBeenCalledWith(client, 'business-1'); expect(f.consume).not.toHaveBeenCalled(); noAuthority();
  });
  it('fails closed before authority when hold lookup fails', async () => {
    f.hold.mockRejectedValue(new Error('fixture database unavailable'));
    const response = await handler(request(), context());
    expect(response.status).toBe(503); expect((await response.json()).error).toBe('Unable to verify accounting reconciliation state');
    expect(f.consume).not.toHaveBeenCalled(); noAuthority();
  });
  it('lets unheld requests reach unchanged payout-status validation', async () => {
    f.hold.mockResolvedValue(false);
    const response = await handler(request(), context()); const body = await response.json();
    expect(response.status).toBe(400); expect(body.error).toMatch(/status/i); expect(body.code).not.toBe('merchant_accounting_held');
    expect(f.hold).toHaveBeenCalledWith(client, 'business-1'); noAuthority();
  });
});
describe('generation authority boundary', () => {
  it('counts held business without creating payout or touching its financial rows', async () => {
    f.mode = 'generate'; const response = await generate(request()); const body = await response.json();
    expect(response.status).toBe(200); expect(body).toMatchObject({ created: 0, held: 0, skipped: 1, failed: 0, accounting_held: 1, message: '1 businesses awaiting accounting reconciliation' });
    expect(JSON.stringify(body)).not.toContain('business-1');
    expect(f.consume).toHaveBeenCalledWith(expect.anything(), 'step-1', 'payout_generate', null, { action: 'generate' });
    expect(f.audit).toHaveBeenCalledWith(expect.objectContaining({ details: expect.objectContaining({ needs_attention: [], payouts_held: 0 }) }));
    expect(f.reads.every(read => read.startsWith('businesses:'))).toBe(true); noAuthority();
  });
  it('reports lookup failure and does not generate', async () => {
    f.mode = 'generate'; f.hold.mockRejectedValue(Error('fixture unavailable'));
    const response = await generate(request()); expect(response.status).toBe(207);
    expect(await response.json()).toMatchObject({ created: 0, failed: 1, held: 0 }); noAuthority();
  });
  it('lets unheld generation reach existing dedup checks', async () => {
    f.mode = 'generate'; f.hold.mockResolvedValue(false);
    const response = await generate(request()); expect(response.status).toBe(207);
    expect(f.reads.some(read => read.startsWith('business_payouts:'))).toBe(true); noAuthority();
  });
});
describe('scheduled payout authority boundaries', () => {
  it('does not generate or auto-release an existing payout for a held business', async () => {
    f.mode = 'cron'; f.seedRelease = true;
    const response = await cron(new NextRequest('https://example.invalid/api/cron/auto-payout'));
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ generated: 0, transferred: 0, released: 0, held: 1 }); noAuthority();
  });
  it('fails closed on lookup failure with no new authority', async () => {
    f.mode = 'cron'; f.hold.mockRejectedValue(Error('fixture unavailable'));
    const response = await cron(new NextRequest('https://example.invalid/api/cron/auto-payout'));
    expect(response.status).toBe(500); noAuthority();
  });
  it('rechecks hold state before releasing an older payout and fails closed if that read fails', async () => {
    f.mode = 'cron'; f.seedRelease = true;
    f.hold.mockResolvedValueOnce(false).mockRejectedValueOnce(Error('fixture release lookup unavailable'));
    const response = await cron(new NextRequest('https://example.invalid/api/cron/auto-payout'));
    expect(response.status).toBe(500); expect(f.hold).toHaveBeenCalledTimes(2); noAuthority();
  });
  it('preserves ordinary eligible release for an unheld business', async () => {
    f.mode = 'cron'; f.seedRelease = true; f.hold.mockResolvedValue(false);
    const response = await cron(new NextRequest('https://example.invalid/api/cron/auto-payout'));
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ generated: 0, transferred: 0, released: 1 });
    expect(f.writes.mock.calls).toEqual([['business_payouts', 'update', { status: 'approved' }]]);
    expect(f.rpc).not.toHaveBeenCalled(); expect(f.provider).not.toHaveBeenCalled();
  });
});

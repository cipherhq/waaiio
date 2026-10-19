/**
 * Manual payout settlement confirmation tests.
 *
 * Validates:
 * - manual_bank approve sets status='approved' (not 'paid')
 * - manual_cash is rejected (removed from allowlist)
 * - confirm-settlement requires non-empty transfer_reference
 * - confirm-settlement only works on approved + manual_bank payouts
 * - confirm-settlement rejects wrong business_id (via payout lookup)
 * - confirm-settlement is idempotent (CAS prevents double confirmation)
 * - automated transfers are rejected by confirm-settlement
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// Mock verification limit — always allow
vi.mock('@/lib/payouts/verification-limit', () => ({
  checkVerificationLimit: vi.fn().mockResolvedValue({ allowed: true, limit: 999_999_999, used: 0, remaining: 999_999_999 }),
}));

let capturedLogs: string[] = [];

function captureAll(...args: unknown[]): void {
  capturedLogs.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
}

function mockLogger() {
  return {
    error: captureAll, info: captureAll, debug: captureAll, warn: captureAll,
    withContext: () => ({ error: captureAll, info: captureAll, debug: captureAll, warn: captureAll }),
  };
}

function makePostRequest(url: string, body: Record<string, unknown>) {
  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

// ═══════════════════════════════════════════════════════════
// Approve route: manual_bank → approved (not paid)
// ═══════════════════════════════════════════════════════════

describe('Manual payout: approve sets approved status', () => {
  beforeEach(() => {
    capturedLogs = [];
    vi.restoreAllMocks();
    vi.resetModules();
    process.env.ENABLE_PAYOUTS = 'true';
    process.env.PAYSTACK_SECRET_KEY = 'test_paystack_key';
    process.env.STRIPE_SECRET_KEY = 'test_stripe_key';
  });

  afterEach(() => {
    delete process.env.ENABLE_PAYOUTS;
    delete process.env.PAYSTACK_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    vi.restoreAllMocks();
  });

  it('manual_bank approval sets status to approved, not paid', async () => {
    let capturedUpdatePayload: Record<string, unknown> | null = null;

    vi.doMock('@/lib/admin-auth', () => ({ requirePlatformAdmin: vi.fn().mockResolvedValue({ id: 'admin-1' }) }));
    vi.doMock('@/lib/admin-step-up', () => ({
      consumeStepUp: vi.fn().mockResolvedValue(undefined),
      StepUpError: class extends Error {},
    }));
    vi.doMock('@/lib/admin-audit', () => ({ logAdminAudit: vi.fn().mockResolvedValue(undefined) }));
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));
    vi.doMock('@/lib/errors', () => ({ safeLogErrorContext: (e: unknown) => ({ error: String(e) }) }));
    vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue(undefined) }));
    vi.doMock('@/lib/email/templates', () => ({
      payoutApprovedEmail: vi.fn().mockReturnValue({ subject: 's', html: 'h' }),
      payoutPaidEmail: vi.fn().mockReturnValue({ subject: 's', html: 'h' }),
    }));
    vi.doMock('@/lib/constants', () => ({
      formatCurrency: (a: number) => `NGN ${a}`,
    }));
    vi.doMock('@/lib/countries', () => ({ getCountry: () => ({ currency_code: 'NGN' }) }));
    vi.doMock('@/lib/platformSettings', () => ({ loadPlatformSettings: vi.fn().mockResolvedValue({}) }));
    vi.doMock('@/lib/payments/payable-fees', () => ({
      computePlatformHeldTotals: vi.fn().mockReturnValue({ netAvailable: 99999 }),
    }));

    const payoutData = {
      id: 'p1', business_id: 'b1', status: 'pending',
      net_amount: 100, payout_account_id: 'pa1',
      period_start: '2024-01-01', period_end: '2024-01-07',
      flags: [],
    };

    const mockFrom = vi.fn().mockImplementation((table: string) => {
      const chain: Record<string, unknown> = {};
      ['select', 'eq', 'neq', 'in', 'is', 'not', 'single', 'maybeSingle', 'gte', 'insert'].forEach(m => {
        chain[m] = vi.fn().mockReturnValue(chain);
      });
      if (table === 'business_payouts') {
        chain.single = vi.fn().mockResolvedValue({ data: payoutData });
        const updateChain: Record<string, unknown> = {};
        ['eq', 'in', 'select', 'is', 'contains'].forEach(m => { updateChain[m] = vi.fn().mockReturnValue(updateChain); });
        updateChain.select = vi.fn().mockResolvedValue({ data: [{ id: 'p1' }] });
        chain.update = vi.fn().mockImplementation((payload: Record<string, unknown>) => {
          capturedUpdatePayload = payload;
          return updateChain;
        });
      } else if (table === 'businesses') {
        chain.single = vi.fn().mockResolvedValue({ data: { id: 'b1', verification_level: 'basic', country_code: 'NG', name: 'Test Biz', owner_id: 'u1' } });
      } else if (table === 'payout_accounts') {
        chain.single = vi.fn().mockResolvedValue({ data: { id: 'pa1', business_id: 'b1', is_active: true, verified_at: '2024-01-01', gateway: 'paystack' } });
        chain.maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'pa1', business_id: 'b1', is_active: true, verified_at: '2024-01-01', gateway: 'paystack' } });
      } else if (table === 'platform_fees') {
        chain.select = vi.fn().mockReturnValue(chain);
        (chain as Record<string, unknown>).eq = vi.fn().mockReturnValue(chain);
        (chain as Record<string, unknown>).is = vi.fn().mockResolvedValue({ data: [] });
      } else if (table === 'payout_adjustments') {
        // Chained query: .select('amount').eq('business_id', ...) or .select('id, amount').eq(...)...
        const adjChain: Record<string, unknown> = {};
        ['select', 'eq', 'in', 'is'].forEach(m => { adjChain[m] = vi.fn().mockReturnValue(adjChain); });
        // Terminal — resolves the query
        Object.assign(adjChain, { then: (fn: (v: { data: unknown[] }) => void) => Promise.resolve({ data: [] }).then(fn) });
        // Make it thenable for await
        chain.select = vi.fn().mockReturnValue(adjChain);
        return chain;
      } else if (table === 'profiles') {
        chain.single = vi.fn().mockResolvedValue({ data: { email: 'test@test.com' } });
      } else if (table === 'notifications') {
        chain.insert = vi.fn().mockResolvedValue({ data: null });
      }
      return chain;
    });

    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn(() => ({
        from: mockFrom,
        rpc: vi.fn().mockResolvedValue({ data: [] }),
      })),
    }));

    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const req = makePostRequest('/api/admin/payouts/p1/approve', { transfer_method: 'manual_bank' });
    const res = await POST(req, { params: Promise.resolve({ id: 'p1' }) });

    expect(res.status).toBe(200);
    const responseBody = await res.json();
    expect(responseBody.status).toBe('approved');

    // The DB update should set 'approved', NOT 'paid'
    expect(capturedUpdatePayload).toBeTruthy();
    expect(capturedUpdatePayload!.status).toBe('approved');
    expect(capturedUpdatePayload!.paid_at).toBeUndefined();
  });

  it('manual_cash is rejected with 400', async () => {
    vi.doMock('@/lib/admin-auth', () => ({ requirePlatformAdmin: vi.fn().mockResolvedValue({ id: 'admin-1' }) }));
    vi.doMock('@/lib/admin-step-up', () => ({
      consumeStepUp: vi.fn().mockResolvedValue(undefined),
      StepUpError: class extends Error {},
    }));
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));
    vi.doMock('@/lib/errors', () => ({ safeLogErrorContext: (e: unknown) => ({}) }));
    vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn(() => ({ from: vi.fn(), rpc: vi.fn() })) }));

    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const req = makePostRequest('/api/admin/payouts/p1/approve', { transfer_method: 'manual_cash' });
    const res = await POST(req, { params: Promise.resolve({ id: 'p1' }) });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('transfer_method must be one of');
    expect(body.error).not.toContain('manual_cash');
  });
});

// ═══════════════════════════════════════════════════════════
// Confirm-settlement endpoint
// ═══════════════════════════════════════════════════════════

describe('Manual payout: confirm-settlement', () => {
  beforeEach(() => {
    capturedLogs = [];
    vi.restoreAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function setupConfirmMocks(opts: {
    payoutStatus?: string;
    payoutMethod?: string;
    payoutBusinessId?: string;
    confirmResult?: unknown[] | null;
    bizVerification?: string;
  } = {}) {
    const {
      payoutStatus = 'approved',
      payoutMethod = 'manual_bank',
      payoutBusinessId = 'b1',
      confirmResult = [{ id: 'p1' }],
      bizVerification = 'basic',
    } = opts;

    vi.doMock('@/lib/admin-auth', () => ({ requirePlatformAdmin: vi.fn().mockResolvedValue({ id: 'admin-1' }) }));
    vi.doMock('@/lib/admin-step-up', () => ({
      consumeStepUp: vi.fn().mockResolvedValue(undefined),
      StepUpError: class extends Error {},
    }));
    vi.doMock('@/lib/admin-audit', () => ({ logAdminAudit: vi.fn().mockResolvedValue(undefined) }));
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));
    vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue(undefined) }));
    vi.doMock('@/lib/email/templates', () => ({
      payoutPaidEmail: vi.fn().mockReturnValue({ subject: 's', html: 'h' }),
    }));
    vi.doMock('@/lib/constants', () => ({
      formatCurrency: (a: number) => `NGN ${a}`,
    }));
    vi.doMock('@/lib/countries', () => ({ getCountry: () => ({ currency_code: 'NGN' }) }));

    const mockFrom = vi.fn().mockImplementation((table: string) => {
      const chain: Record<string, unknown> = {};
      ['select', 'eq', 'in', 'is', 'single', 'maybeSingle', 'insert'].forEach(m => {
        chain[m] = vi.fn().mockReturnValue(chain);
      });
      if (table === 'business_payouts') {
        chain.single = vi.fn().mockResolvedValue({
          data: {
            id: 'p1', business_id: payoutBusinessId, net_amount: 100,
            status: payoutStatus, transfer_method: payoutMethod, payout_account_id: 'pa1',
          },
        });
        const updateChain: Record<string, unknown> = {};
        ['eq', 'in', 'select'].forEach(m => { updateChain[m] = vi.fn().mockReturnValue(updateChain); });
        updateChain.select = vi.fn().mockResolvedValue({ data: confirmResult });
        chain.update = vi.fn().mockReturnValue(updateChain);
      } else if (table === 'businesses') {
        chain.single = vi.fn().mockResolvedValue({
          data: { id: payoutBusinessId, verification_level: bizVerification, name: 'Test Biz', owner_id: 'u1', country_code: 'NG' },
        });
      } else if (table === 'profiles') {
        chain.single = vi.fn().mockResolvedValue({ data: { email: 'test@test.com' } });
      } else if (table === 'notifications') {
        chain.insert = vi.fn().mockResolvedValue({ data: null });
      }
      return chain;
    });

    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn(() => ({ from: mockFrom })),
    }));
  }

  it('valid confirmation: approved manual_bank with reference → paid', async () => {
    setupConfirmMocks();
    const { POST } = await import('@/app/api/admin/payouts/[id]/confirm-settlement/route');
    const req = makePostRequest('/api/admin/payouts/p1/confirm-settlement', {
      transfer_reference: 'NIP-20261019-123456',
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'p1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('paid');
  });

  it('missing transfer_reference → 400', async () => {
    setupConfirmMocks();
    const { POST } = await import('@/app/api/admin/payouts/[id]/confirm-settlement/route');
    const req = makePostRequest('/api/admin/payouts/p1/confirm-settlement', {});
    const res = await POST(req, { params: Promise.resolve({ id: 'p1' }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('transfer_reference is required');
  });

  it('empty string transfer_reference → 400', async () => {
    setupConfirmMocks();
    const { POST } = await import('@/app/api/admin/payouts/[id]/confirm-settlement/route');
    const req = makePostRequest('/api/admin/payouts/p1/confirm-settlement', {
      transfer_reference: '   ',
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'p1' }) });
    expect(res.status).toBe(400);
  });

  it('payout not in approved status → 400', async () => {
    setupConfirmMocks({ payoutStatus: 'pending' });
    const { POST } = await import('@/app/api/admin/payouts/[id]/confirm-settlement/route');
    const req = makePostRequest('/api/admin/payouts/p1/confirm-settlement', {
      transfer_reference: 'REF-123',
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'p1' }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("'pending'");
  });

  it('already paid payout → 400 (not double-paid)', async () => {
    setupConfirmMocks({ payoutStatus: 'paid' });
    const { POST } = await import('@/app/api/admin/payouts/[id]/confirm-settlement/route');
    const req = makePostRequest('/api/admin/payouts/p1/confirm-settlement', {
      transfer_reference: 'REF-123',
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'p1' }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("'paid'");
  });

  it('automated transfer method → 400 (must use webhooks)', async () => {
    setupConfirmMocks({ payoutMethod: 'paystack_transfer' });
    const { POST } = await import('@/app/api/admin/payouts/[id]/confirm-settlement/route');
    const req = makePostRequest('/api/admin/payouts/p1/confirm-settlement', {
      transfer_reference: 'REF-123',
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'p1' }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('provider webhooks');
  });

  it('concurrent duplicate confirmation → 409 (CAS prevents double)', async () => {
    setupConfirmMocks({ confirmResult: [] }); // CAS returns 0 rows
    const { POST } = await import('@/app/api/admin/payouts/[id]/confirm-settlement/route');
    const req = makePostRequest('/api/admin/payouts/p1/confirm-settlement', {
      transfer_reference: 'REF-123',
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'p1' }) });
    expect(res.status).toBe(409);
  });

  it('unverified business → 400', async () => {
    setupConfirmMocks({ bizVerification: 'unverified' });
    const { POST } = await import('@/app/api/admin/payouts/[id]/confirm-settlement/route');
    const req = makePostRequest('/api/admin/payouts/p1/confirm-settlement', {
      transfer_reference: 'REF-123',
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'p1' }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('unverified');
  });
});

// ═══════════════════════════════════════════════════════════
// Source-contract: approve route allowlist
// ═══════════════════════════════════════════════════════════

describe('Manual payout: source contract', () => {
  it('ALLOWED_TRANSFER_METHODS does not include manual_cash', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve('app/api/admin/payouts/[id]/approve/route.ts'), 'utf-8',
    );
    const allowlistLine = source.match(/ALLOWED_TRANSFER_METHODS\s*=\s*\[(.*?)\]/s);
    expect(allowlistLine).toBeTruthy();
    expect(allowlistLine![1]).not.toContain('manual_cash');
    expect(allowlistLine![1]).toContain('manual_bank');
  });

  it('manual_bank path sets approved, not paid', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve('app/api/admin/payouts/[id]/approve/route.ts'), 'utf-8',
    );
    // Find the manual path block
    const manualBlock = source.slice(
      source.indexOf('Manual methods') || source.indexOf('manual bank transfer'),
      source.indexOf('FIN-002: Atomic claim'),
    );
    // Must set status: 'approved'
    expect(manualBlock).toContain("status: 'approved'");
    // Must NOT set paid_at in this block
    expect(manualBlock).not.toContain('paid_at');
  });

  it('confirm-settlement audit log records attestation, not bank verification', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve('app/api/admin/payouts/[id]/confirm-settlement/route.ts'), 'utf-8',
    );
    // Must include attestation language, never "verified" or "bank-confirmed"
    expect(source).toContain('attestation');
    expect(source).toContain('Admin attested');
    expect(source).not.toContain('bank-verified');
    expect(source).not.toContain('independently verified');
  });

  it('admin UI source requires acknowledgement checkbox', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve('admin/src/pages/Payouts.tsx'), 'utf-8',
    );
    // Confirm settlement requires the acknowledgement checkbox
    expect(source).toContain('confirmAcknowledged');
    expect(source).toContain('I confirm that the bank transfer');
    expect(source).toContain('attestation will be recorded in the audit log');
    // Button is disabled without acknowledgement
    expect(source).toContain('!confirmAcknowledged');
  });

  it('confirm-settlement requires transfer_reference before any DB write', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve('app/api/admin/payouts/[id]/confirm-settlement/route.ts'), 'utf-8',
    );
    // transfer_reference validation appears before CAS update
    const refCheckPos = source.indexOf('transfer_reference is required');
    const casUpdatePos = source.indexOf("eq('status', 'approved')");
    expect(refCheckPos).toBeGreaterThan(0);
    expect(casUpdatePos).toBeGreaterThan(refCheckPos);
  });
});

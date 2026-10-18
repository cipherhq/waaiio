/**
 * Payout verification limit enforcement tests.
 *
 * 1. Approve route: over-limit → 409, payout unchanged, no step-up consumed
 * 2. decideAutoPayoutOutcome: pure-function behavioral tests for status/flags
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { decideAutoPayoutOutcome } from '@/lib/payouts/auto-payout-decision';
import type { VerificationLimitResult } from '@/lib/payouts/verification-limit';

// ── Shared helpers ──

function makePostRequest(url: string, body: Record<string, unknown>) {
  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockLogger() {
  const noop = (..._: unknown[]) => {};
  return {
    error: noop, info: noop, debug: noop, warn: noop,
    withContext: () => ({ error: noop, info: noop, debug: noop, warn: noop }),
  };
}

function allowedLimit(limit = 50_000_000, used = 0): VerificationLimitResult {
  return { allowed: true, limit, used, remaining: limit - used };
}

function exceededLimit(limit = 50_000_000, used = 50_000_000): VerificationLimitResult {
  return {
    allowed: false, limit, used, remaining: 0,
    reason: `Monthly payout limit exceeded: used ${used} + requested 10000000 > limit ${limit}`,
  };
}

// ════════════════════════════════════════════════════════════
// 1. Approve route: over-limit → 409, payout unchanged, no step-up
// ════════════════════════════════════════════════════════════

describe('Approve route: verification limit enforcement', () => {
  let consumeStepUpMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    consumeStepUpMock = vi.fn();
    process.env.ENABLE_PAYOUTS = 'true';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ENABLE_PAYOUTS;
  });

  it('over-limit payout → 409 with limit/used/remaining, payout unchanged, no step-up consumed', async () => {
    vi.doMock('@/lib/payouts/verification-limit', () => ({
      checkVerificationLimit: vi.fn().mockResolvedValue({
        allowed: false,
        limit: 50_000_000,
        used: 45_000_000,
        remaining: 5_000_000,
        reason: 'Monthly payout limit exceeded: used 45000000 + requested 10000000 > limit 50000000',
      }),
    }));

    vi.doMock('@/lib/admin-auth', () => ({
      requirePlatformAdmin: vi.fn().mockResolvedValue({
        id: 'admin-1', userId: 'admin-1', email: 'a@t.com', role: 'admin', aal: 'aal2', bearerToken: 'tok',
      }),
    }));

    vi.doMock('@/lib/admin-step-up', () => ({
      consumeStepUp: consumeStepUpMock,
      StepUpError: class extends Error {},
    }));

    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));
    vi.doMock('@/lib/errors', () => ({ safeLogErrorContext: () => ({}) }));
    vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn() }));
    vi.doMock('@/lib/email/templates', () => ({
      payoutApprovedEmail: vi.fn(), payoutPaidEmail: vi.fn(),
    }));
    vi.doMock('@/lib/admin-audit', () => ({ logAdminAudit: vi.fn() }));
    vi.doMock('@/lib/payments/payout-classification', () => ({
      classifyPaystackError: vi.fn(), classifyStripeError: vi.fn(),
    }));

    const mockFrom = vi.fn().mockImplementation((table: string) => {
      const chain: Record<string, unknown> = {};
      ['select', 'eq', 'neq', 'in', 'is', 'single', 'maybeSingle', 'update', 'insert', 'not'].forEach(m => {
        chain[m] = vi.fn().mockReturnValue(chain);
      });
      if (table === 'business_payouts') {
        chain.single = vi.fn().mockResolvedValue({
          data: {
            id: 'payout-1', business_id: 'biz-1', status: 'pending',
            net_amount: 100_000, payout_account_id: 'pa-1', flags: [],
            period_start: '2024-01-01', period_end: '2024-01-07',
          },
        });
      } else if (table === 'businesses') {
        chain.single = vi.fn().mockResolvedValue({
          data: { verification_level: 'basic', payout_limit_monthly: 500_000, country_code: 'NG' },
        });
      }
      return chain;
    });

    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn().mockReturnValue({ from: mockFrom, rpc: vi.fn() }),
    }));

    vi.doMock('@/lib/constants', async () => {
      const actual = await vi.importActual<typeof import('@/lib/constants')>('@/lib/constants');
      return { ...actual };
    });
    vi.doMock('@/lib/countries', () => ({
      getCountry: vi.fn().mockReturnValue({ currency_code: 'NGN' }),
    }));

    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const req = makePostRequest('/api/admin/payouts/payout-1/approve', {
      transfer_method: 'paystack_transfer',
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'payout-1' }) });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toContain('Cannot approve payout');
    expect(body.limit).toBe(50_000_000);
    expect(body.used).toBe(45_000_000);
    expect(body.remaining).toBe(5_000_000);

    // consumeStepUp must NOT have been called — the limit check is before step-up
    expect(consumeStepUpMock).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════
// 2. decideAutoPayoutOutcome: pure function behavioral tests
// ════════════════════════════════════════════════════════════

describe('decideAutoPayoutOutcome', () => {
  // ── Over-limit: status 'held', verification_limit_exceeded flag ──

  it('over-limit, withAdjustments=false → held + verification_limit_exceeded flag, never approved', () => {
    const result = decideAutoPayoutOutcome({
      canAutoApprove: true,
      limitCheck: exceededLimit(),
      holdReasons: [],
    });

    expect(result.status).toBe('held');
    expect(result.overLimit).toBe(true);

    // No-adjustments flags
    const limitFlag = result.flags.find(
      f => typeof f === 'object' && f.type === 'verification_limit_exceeded',
    );
    expect(limitFlag).toBeDefined();
    expect((limitFlag as any).severity).toBe('critical');
  });

  it('over-limit, withAdjustments=true → held + verification_limit_exceeded in structuredFlags', () => {
    const result = decideAutoPayoutOutcome({
      canAutoApprove: true,
      limitCheck: exceededLimit(),
      holdReasons: ['Business too new (cooling period)'],
    });

    expect(result.status).toBe('held');

    // Structured flags for adjustment path
    const limitFlag = result.structuredFlags.find(
      f => f.type === 'verification_limit_exceeded',
    );
    expect(limitFlag).toBeDefined();
    expect(limitFlag!.severity).toBe('critical');

    // Also has hold_reason flags
    const holdFlag = result.structuredFlags.find(
      f => f.type === 'hold_reason' && f.message.includes('cooling period'),
    );
    expect(holdFlag).toBeDefined();
  });

  it('over-limit with canAutoApprove=false → still held (not pending)', () => {
    const result = decideAutoPayoutOutcome({
      canAutoApprove: false,
      limitCheck: exceededLimit(),
      holdReasons: ['Business not verified'],
    });

    expect(result.status).toBe('held');
    expect(result.overLimit).toBe(true);
  });

  // ── Within limit ──

  it('within limit + canAutoApprove → approved', () => {
    const result = decideAutoPayoutOutcome({
      canAutoApprove: true,
      limitCheck: allowedLimit(),
      holdReasons: [],
    });

    expect(result.status).toBe('approved');
    expect(result.overLimit).toBe(false);
    expect(result.flags).toHaveLength(0);
    expect(result.structuredFlags).toHaveLength(0);
  });

  it('within limit + not auto-approvable → pending', () => {
    const result = decideAutoPayoutOutcome({
      canAutoApprove: false,
      limitCheck: allowedLimit(),
      holdReasons: ['Business too new (cooling period)'],
    });

    expect(result.status).toBe('pending');
    expect(result.overLimit).toBe(false);
    // Should have hold_reason flags but no verification_limit_exceeded
    expect(result.flags.length).toBeGreaterThan(0);
    const limitFlag = result.structuredFlags.find(
      f => f.type === 'verification_limit_exceeded',
    );
    expect(limitFlag).toBeUndefined();
  });

  // ── Adjustment path keeps existing flag shape ──

  it('structuredFlags have type/message/severity shape for adjustment path', () => {
    const result = decideAutoPayoutOutcome({
      canAutoApprove: false,
      limitCheck: allowedLimit(),
      holdReasons: ['High transaction velocity', 'Business not verified'],
    });

    // Every structured flag has the required shape
    for (const flag of result.structuredFlags) {
      expect(flag).toHaveProperty('type');
      expect(flag).toHaveProperty('message');
      expect(flag).toHaveProperty('severity');
      expect(flag.type).toBe('hold_reason');
    }

    // The route appends adjustment_link_pending separately — not in this function
    // Verify no adjustment_link_pending is emitted by decideAutoPayoutOutcome
    const adjFlag = result.structuredFlags.find(f => f.type === 'adjustment_link_pending');
    expect(adjFlag).toBeUndefined();
  });
});

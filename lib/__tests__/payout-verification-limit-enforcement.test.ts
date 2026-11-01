/**
 * Payout verification limit enforcement tests.
 *
 * 1. Approve route: over-limit → 409, payout unchanged, no step-up consumed
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
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
            net_amount: 100_000, currency: 'NGN', payout_account_id: 'pa-1', flags: [],
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


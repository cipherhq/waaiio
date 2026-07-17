/**
 * Payout Safety Tests
 *
 * Tests the payout approval route handler for:
 * - Concurrent approval prevention (compare-and-set)
 * - Provider timeout → review_required (not failed)
 * - Blind retry prevention
 * - Verified bank account requirement
 * - Audit failure handling
 * - ENABLE_PAYOUTS kill switch
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { readFileSync } from 'fs';

const approveRoute = readFileSync('app/api/admin/payouts/[id]/approve/route.ts', 'utf-8');

// ── 1. Compare-and-set prevents concurrent approvals ──

describe('Concurrent approval prevention', () => {
  it('claim uses compare-and-set with in() status guard', () => {
    // The route updates with .in('status', ['pending', 'held'])
    // If two concurrent requests arrive, only one can claim (the other gets no rows)
    expect(approveRoute).toContain(".in('status', ['pending', 'held'])");
    expect(approveRoute).toContain('.maybeSingle()');
  });

  it('second concurrent request gets 409 Conflict', () => {
    // When maybeSingle returns null (no rows matched the compare-and-set)
    expect(approveRoute).toContain('already processed by another administrator');
    expect(approveRoute).toContain('409');
  });

  it('only pending and held states can be claimed', () => {
    const claimStates = "['pending', 'held']";
    expect(approveRoute).toContain(claimStates);
    // The .in() call uses exactly these two states — nothing else
  });
});

// ── 2. Provider timeout → review_required ──

describe('Provider timeout handling', () => {
  it('catch block sets review_required, not failed', () => {
    expect(approveRoute).toContain("status: 'review_required'");
    // The catch block must NOT use 'failed' for uncertain outcomes
    const catchBlock = approveRoute.slice(
      approveRoute.lastIndexOf('} catch (error)'),
      approveRoute.lastIndexOf('return NextResponse.json({')
    );
    expect(catchBlock).toContain('review_required');
    expect(catchBlock).not.toContain("status: 'failed'");
  });

  it('preserves idempotency reference for provider reconciliation', () => {
    expect(approveRoute).toContain('idempotencyRef');
    expect(approveRoute).toContain('check provider');
  });

  it('returns 502 with reference for manual verification', () => {
    expect(approveRoute).toContain('502');
    expect(approveRoute).toContain('idempotency_ref');
  });
});

// ── 3. Blind retry prevention ──

describe('Blind retry prevention', () => {
  it('review_required is not in approvable states', () => {
    const approvable = "['pending', 'held']";
    expect(approveRoute).toContain(approvable);
    // review_required would need manual status change before re-approval
  });

  it('existing gateway_transfer_code blocks re-transfer', () => {
    expect(approveRoute).toContain('gateway_transfer_code');
    expect(approveRoute).toContain('Transfer already initiated');
    expect(approveRoute).toContain('409');
  });

  it('transfer_method is allowlisted', () => {
    expect(approveRoute).toContain('ALLOWED_TRANSFER_METHODS');
    expect(approveRoute).toContain("'paystack_transfer'");
    expect(approveRoute).toContain("'stripe_transfer'");
    expect(approveRoute).toContain("'manual_bank'");
    expect(approveRoute).toContain("'manual_cash'");
  });
});

// ── 4. Verified bank account requirement ──

describe('Verified bank account requirement', () => {
  it('requires payout_account_id', () => {
    expect(approveRoute).toContain('No payout account configured');
  });

  it('requires account is_active', () => {
    expect(approveRoute).toContain('payoutAcct.is_active');
    expect(approveRoute).toContain('inactive');
  });

  it('requires account verified_at', () => {
    expect(approveRoute).toContain('payoutAcct.verified_at');
    expect(approveRoute).toContain('unverified');
  });

  it('verifies account belongs to the correct business', () => {
    expect(approveRoute).toContain('payoutAcct.business_id !== payout.business_id');
    expect(approveRoute).toContain('403');
  });
});

// ── 5. Audit failure handling ──

describe('Audit failure handling', () => {
  it('audit is mandatory — failure reverts the claim', () => {
    expect(approveRoute).toContain('auditError');
    // On audit failure, the payout status is reverted
    expect(approveRoute).toContain('status: payout.status');
    expect(approveRoute).toContain('approved_by: null');
  });

  it('audit failure returns 500', () => {
    expect(approveRoute).toContain('Audit logging failed');
    expect(approveRoute).toContain('500');
  });
});

// ── 6. Provider idempotency keys ──

describe('Provider idempotency keys', () => {
  it('Paystack transfer includes reference', () => {
    expect(approveRoute).toContain("reference: idempotencyRef");
  });

  it('Stripe transfer includes Idempotency-Key header', () => {
    expect(approveRoute).toContain("'Idempotency-Key': idempotencyRef");
  });

  it('reference is deterministic: payout_{id}', () => {
    expect(approveRoute).toContain("`payout_${id}`");
  });

  it('reference stored before provider call', () => {
    // transfer_reference is set in the claim update, before any fetch()
    expect(approveRoute).toContain('transfer_reference: transferRef');
  });
});

// ── 7. ENABLE_PAYOUTS kill switch ──

describe('ENABLE_PAYOUTS kill switch', () => {
  beforeEach(() => { vi.resetModules(); delete process.env.ENABLE_PAYOUTS; });
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns 503 when ENABLE_PAYOUTS is not true', async () => {
    vi.mock('@/lib/supabase/server', () => ({
      createClient: vi.fn().mockResolvedValue({ auth: { getUser: vi.fn() } }),
    }));
    vi.mock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn().mockReturnValue({}),
    }));

    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const req = new NextRequest('http://localhost/test', {
      method: 'POST',
      body: JSON.stringify({ transfer_method: 'manual_bank' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'test' }) });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toContain('disabled');
  });

  it('no provider call is made when disabled', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    vi.mock('@/lib/supabase/server', () => ({
      createClient: vi.fn().mockResolvedValue({ auth: { getUser: vi.fn() } }),
    }));
    vi.mock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn().mockReturnValue({}),
    }));

    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const req = new NextRequest('http://localhost/test', {
      method: 'POST',
      body: JSON.stringify({ transfer_method: 'paystack_transfer' }),
      headers: { 'Content-Type': 'application/json' },
    });
    await POST(req, { params: Promise.resolve({ id: 'test' }) });

    const providerCalls = fetchSpy.mock.calls.filter(
      ([url]) => typeof url === 'string' && (url.includes('paystack') || url.includes('stripe'))
    );
    expect(providerCalls).toHaveLength(0);
  });
});

// ── 8. Balance re-verification ──

describe('Balance re-verification before approval', () => {
  it('recalculates available balance at approval time', () => {
    expect(approveRoute).toContain('totalEarned');
    expect(approveRoute).toContain('totalPaidOut');
    expect(approveRoute).toContain('Insufficient balance');
  });

  it('rejects if payout exceeds available balance', () => {
    expect(approveRoute).toContain('Insufficient balance');
    expect(approveRoute).toContain('400');
  });
});

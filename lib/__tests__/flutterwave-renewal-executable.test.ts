/**
 * Flutterwave Renewal — Executable Production-Path Tests
 *
 * Uses the REAL processFlutterwaveRenewal helper with mocked provider boundaries.
 * NOT source-string tests — these execute the actual decision logic.
 */
import { describe, it, expect, vi } from 'vitest';
import { processFlutterwaveRenewal, type FlwRenewalDeps } from '@/lib/payments/flutterwave-renewal';
import type { ChargeOutcome } from '@/lib/payments/flutterwave-recurring';

function mockSub(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'sub-001', business_id: 'biz-001', amount: 50, currency: 'NGN',
    authorization_code: 'auth-token', customer_email: 'test@example.com',
    customer_phone: '+2341234567890', service_id: 'svc-001',
    frequency: 'monthly', failure_count: 0,
    ...overrides,
  };
}

function mockDeps(opts: {
  claimResult?: Record<string, unknown>;
  chargeOutcome?: ChargeOutcome;
  verifyOutcome?: string | null; // 'successful', 'pending', 'failed', 'unknown', null (timeout)
  verifyAmount?: number;
  verifyCurrency?: string;
  finalizeResult?: Record<string, unknown>;
  failureResult?: Record<string, unknown>;
}): FlwRenewalDeps {
  const rpcMock = vi.fn().mockImplementation((name: string) => {
    if (name === 'claim_recurring_billing_cycle') {
      return Promise.resolve({
        data: opts.claimResult ?? { claimed: true, stable_ref: 'flw-sub-001-2026-08-04', attempt_ref: 'flw-sub-001-2026-08-04-a1', reconcile_required: false, provider_verified: false },
        error: null,
      });
    }
    if (name === 'finalize_token_recurring_charge') {
      return Promise.resolve({ data: opts.finalizeResult ?? { success: true, payment_id: 'pay-001' }, error: null });
    }
    if (name === 'record_flutterwave_definitive_failure') {
      return Promise.resolve({ data: opts.failureResult ?? { recorded: true, failure_count: 1 }, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  });

  const updateMock = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null, error: null }) });
  const fromMock = vi.fn().mockReturnValue({ update: updateMock });

  return {
    supabase: { rpc: rpcMock, from: fromMock } as any,
    chargeTokenFn: vi.fn().mockResolvedValue({ outcome: opts.chargeOutcome ?? 'successful', reference: 'flw-sub-001-2026-08-04-a1' }),
    verifyTransactionFn: vi.fn().mockResolvedValue(
      opts.verifyOutcome === null ? null : {
        outcome: opts.verifyOutcome ?? 'successful',
        amount: opts.verifyAmount ?? 50,
        currency: opts.verifyCurrency ?? 'NGN',
        providerStatus: opts.verifyOutcome ?? 'successful',
      }
    ),
  };
}

describe('Flutterwave renewal — executable production tests', () => {
  it('1. fresh cycle: charge called with attempt ref a1', async () => {
    const deps = mockDeps({ chargeOutcome: 'successful' });
    const result = await processFlutterwaveRenewal(deps, mockSub());

    expect(result.action).toBe('finalized');
    // chargeToken called with attempt ref
    expect(deps.chargeTokenFn).toHaveBeenCalledWith(
      'auth-token', 50, 'test@example.com', 'flw-sub-001-2026-08-04-a1', 'NGN', undefined,
    );
  });

  it('2. pending charge: no failure, no recharge', async () => {
    const deps = mockDeps({ chargeOutcome: 'pending' });
    const result = await processFlutterwaveRenewal(deps, mockSub());

    expect(result.action).toBe('skipped');
    expect(result.reason).toBe('charge_pending');
    // failure RPC NOT called
    expect((deps.supabase as any).rpc).not.toHaveBeenCalledWith('record_flutterwave_definitive_failure', expect.anything());
  });

  it('3. unknown/timeout charge: no failure, no recharge', async () => {
    const deps = mockDeps({ chargeOutcome: 'unknown' });
    const result = await processFlutterwaveRenewal(deps, mockSub());

    expect(result.action).toBe('skipped');
    expect(result.reason).toBe('charge_unknown');
    expect((deps.supabase as any).rpc).not.toHaveBeenCalledWith('record_flutterwave_definitive_failure', expect.anything());
  });

  it('4. successful charge: verify and finalize', async () => {
    const deps = mockDeps({ chargeOutcome: 'successful' });
    const result = await processFlutterwaveRenewal(deps, mockSub());

    expect(result.action).toBe('finalized');
    expect(result.paymentId).toBe('pay-001');
    // verify called with attempt ref
    expect(deps.verifyTransactionFn).toHaveBeenCalledWith('flw-sub-001-2026-08-04-a1');
    // finalize called with billing cycle ref
    expect((deps.supabase as any).rpc).toHaveBeenCalledWith('finalize_token_recurring_charge', expect.objectContaining({
      p_stable_ref: 'flw-sub-001-2026-08-04',
    }));
  });

  it('5. definitive failure: atomic RPC called', async () => {
    const deps = mockDeps({ chargeOutcome: 'failed', failureResult: { recorded: true, failure_count: 1 } });
    const result = await processFlutterwaveRenewal(deps, mockSub());

    expect(result.action).toBe('failure_recorded');
    expect(result.failureCount).toBe(1);
    expect((deps.supabase as any).rpc).toHaveBeenCalledWith('record_flutterwave_definitive_failure', expect.objectContaining({
      p_subscription_id: 'sub-001',
      p_stable_ref: 'flw-sub-001-2026-08-04',
    }));
  });

  it('6. failure RPC returns already_recorded: no double increment', async () => {
    const deps = mockDeps({ chargeOutcome: 'failed', failureResult: { recorded: false, reason: 'already_recorded' } });
    const result = await processFlutterwaveRenewal(deps, mockSub());

    expect(result.action).toBe('skipped');
    expect(result.reason).toBe('already_recorded');
  });

  it('7. internal exception: no failure RPC called', async () => {
    const deps = mockDeps({});
    deps.chargeTokenFn = vi.fn().mockRejectedValue(new Error('import crash'));
    const result = await processFlutterwaveRenewal(deps, mockSub());

    expect(result.action).toBe('error');
    expect(result.reason).toBe('internal_exception');
    expect((deps.supabase as any).rpc).not.toHaveBeenCalledWith('record_flutterwave_definitive_failure', expect.anything());
  });

  it('8. recovered claim with provider already successful: finalize, no recharge', async () => {
    const deps = mockDeps({
      claimResult: { claimed: true, stable_ref: 'flw-sub-001-2026-08-04', attempt_ref: 'flw-sub-001-2026-08-04-a1', reconcile_required: false, provider_verified: true },
    });
    const result = await processFlutterwaveRenewal(deps, mockSub());

    expect(result.action).toBe('finalized');
    // chargeToken should NOT have been called
    expect(deps.chargeTokenFn).not.toHaveBeenCalled();
  });

  it('9. recovered stale claim: reconciliation uses same attempt ref', async () => {
    const deps = mockDeps({
      claimResult: { claimed: true, stable_ref: 'flw-sub-001-2026-08-04', attempt_ref: 'flw-sub-001-2026-08-04-a1', reconcile_required: true, provider_verified: false },
      verifyOutcome: 'successful',
    });
    const result = await processFlutterwaveRenewal(deps, mockSub());

    expect(result.action).toBe('finalized');
    // verify called with the SAME attempt ref (not a new one)
    expect(deps.verifyTransactionFn).toHaveBeenCalledWith('flw-sub-001-2026-08-04-a1');
    // chargeToken NOT called (reconciliation found success)
    expect(deps.chargeTokenFn).not.toHaveBeenCalled();
  });

  it('10. recovered stale claim + pending reconciliation: no recharge', async () => {
    const deps = mockDeps({
      claimResult: { claimed: true, stable_ref: 'flw-sub-001-2026-08-04', attempt_ref: 'flw-sub-001-2026-08-04-a1', reconcile_required: true, provider_verified: false },
      verifyOutcome: 'pending',
    });
    const result = await processFlutterwaveRenewal(deps, mockSub());

    expect(result.action).toBe('skipped');
    expect(deps.chargeTokenFn).not.toHaveBeenCalled();
  });

  it('11. claim not granted: skipped', async () => {
    const deps = mockDeps({ claimResult: { claimed: false, reason: 'already_claimed' } });
    const result = await processFlutterwaveRenewal(deps, mockSub());

    expect(result.action).toBe('skipped');
    expect(result.reason).toBe('already_claimed');
  });

  it('12. verification amount mismatch: not finalized', async () => {
    const deps = mockDeps({ chargeOutcome: 'successful', verifyAmount: 999 });
    const result = await processFlutterwaveRenewal(deps, mockSub());

    expect(result.action).toBe('error');
    expect(result.reason).toBe('verification_failed');
  });

  // ── NEW: recovered definitively failed attempt ──

  it('13. recovered a1 + verify=failed → record failure, NO charge', async () => {
    const deps = mockDeps({
      claimResult: { claimed: true, stable_ref: 'flw-sub-001-2026-08-04', attempt_ref: 'flw-sub-001-2026-08-04-a1', reconcile_required: true, provider_verified: false },
      verifyOutcome: 'failed',
      failureResult: { recorded: true, failure_count: 1 },
    });
    const result = await processFlutterwaveRenewal(deps, mockSub());

    expect(result.action).toBe('failure_recorded');
    expect(result.failureCount).toBe(1);
    // chargeToken must NOT have been called — failure recorded and stopped
    expect(deps.chargeTokenFn).not.toHaveBeenCalled();
    // failure RPC called
    expect((deps.supabase as any).rpc).toHaveBeenCalledWith('record_flutterwave_definitive_failure', expect.anything());
  });

  it('14. next retry after failure → new attempt a2 charged IMMEDIATELY', async () => {
    const deps = mockDeps({
      claimResult: { claimed: true, stable_ref: 'flw-sub-001-2026-08-04', attempt_ref: 'flw-sub-001-2026-08-04-a2', reconcile_required: false, provider_verified: false },
      chargeOutcome: 'successful',
    });
    // Mock chargeToken to return the correct a2 reference
    deps.chargeTokenFn = vi.fn().mockResolvedValue({ outcome: 'successful', reference: 'flw-sub-001-2026-08-04-a2' });
    const result = await processFlutterwaveRenewal(deps, mockSub());

    expect(result.action).toBe('finalized');
    // chargeToken called with a2 (not a1)
    expect(deps.chargeTokenFn).toHaveBeenCalledWith(
      'auth-token', 50, 'test@example.com', 'flw-sub-001-2026-08-04-a2', 'NGN', undefined,
    );
    // verifyTransaction NOT called before charge (reconcile_required=false)
    // But IS called after charge success for verification
    expect(deps.verifyTransactionFn).toHaveBeenCalledWith('flw-sub-001-2026-08-04-a2');
  });

  it('15. returned tx_ref != expected → no finalization', async () => {
    const deps = mockDeps({ chargeOutcome: 'successful' });
    deps.chargeTokenFn = vi.fn().mockResolvedValue({ outcome: 'successful', reference: 'WRONG-REF' });
    const result = await processFlutterwaveRenewal(deps, mockSub());

    expect(result.action).toBe('error');
    expect(result.reason).toBe('provider_ref_mismatch');
  });

  it('16. X-Idempotency-Key: same attemptRef → same key', async () => {
    // The chargeToken function sends X-Idempotency-Key = reference (the attemptRef)
    // This is verified structurally since the mock doesn't exercise the actual fetch
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../payments/flutterwave-recurring.ts'), 'utf-8');
    expect(source).toContain("'X-Idempotency-Key': reference");
  });
});

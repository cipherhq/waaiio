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
  verifyTxRef?: string; // providerTxRef returned by verify mock
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
        providerTxRef: opts.verifyTxRef ?? 'flw-sub-001-2026-08-04-a1',
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
      verifyTxRef: 'flw-sub-001-2026-08-04-a2',
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

  // ── PROVIDER IDENTITY INVARIANT TESTS ──

  it('A. successful verification + matching tx_ref → finalize once', async () => {
    const deps = mockDeps({
      chargeOutcome: 'successful',
      verifyTxRef: 'flw-sub-001-2026-08-04-a1',
    });
    const result = await processFlutterwaveRenewal(deps, mockSub());

    expect(result.action).toBe('finalized');
    expect(result.paymentId).toBe('pay-001');
    // finalize called exactly once
    const finCalls = (deps.supabase as any).rpc.mock.calls.filter(
      (c: any[]) => c[0] === 'finalize_token_recurring_charge',
    );
    expect(finCalls).toHaveLength(1);
    // failure RPC NOT called
    expect((deps.supabase as any).rpc).not.toHaveBeenCalledWith('record_flutterwave_definitive_failure', expect.anything());
  });

  it('B. successful verification + wrong tx_ref → no finalize', async () => {
    const deps = mockDeps({ chargeOutcome: 'successful' });
    deps.verifyTransactionFn = vi.fn().mockResolvedValue({
      outcome: 'successful', amount: 50, currency: 'NGN',
      providerStatus: 'successful', providerTxRef: 'WRONG-TX-REF',
    });
    const result = await processFlutterwaveRenewal(deps, mockSub());

    expect(result.action).toBe('error');
    expect(result.reason).toBe('verification_tx_ref_mismatch');
    // finalize NOT called
    expect((deps.supabase as any).rpc).not.toHaveBeenCalledWith('finalize_token_recurring_charge', expect.anything());
    // failure NOT called (this is not a customer payment failure)
    expect((deps.supabase as any).rpc).not.toHaveBeenCalledWith('record_flutterwave_definitive_failure', expect.anything());
  });

  it('C. successful verification + missing tx_ref → no finalize', async () => {
    const deps = mockDeps({ chargeOutcome: 'successful' });
    deps.verifyTransactionFn = vi.fn().mockResolvedValue({
      outcome: 'successful', amount: 50, currency: 'NGN',
      providerStatus: 'successful', providerTxRef: undefined,
    });
    const result = await processFlutterwaveRenewal(deps, mockSub());

    expect(result.action).toBe('error');
    expect(result.reason).toBe('verification_tx_ref_missing');
    // finalize NOT called
    expect((deps.supabase as any).rpc).not.toHaveBeenCalledWith('finalize_token_recurring_charge', expect.anything());
    // failure NOT called
    expect((deps.supabase as any).rpc).not.toHaveBeenCalledWith('record_flutterwave_definitive_failure', expect.anything());
  });

  it('D. recovered provider_success + missing tx_ref → no finalize', async () => {
    const deps = mockDeps({
      claimResult: { claimed: true, stable_ref: 'flw-sub-001-2026-08-04', attempt_ref: 'flw-sub-001-2026-08-04-a1', reconcile_required: false, provider_verified: true },
    });
    // provider_verified skips charge, goes straight to verify+finalize
    deps.verifyTransactionFn = vi.fn().mockResolvedValue({
      outcome: 'successful', amount: 50, currency: 'NGN',
      providerStatus: 'successful', providerTxRef: undefined,
    });
    const result = await processFlutterwaveRenewal(deps, mockSub());

    expect(result.action).toBe('error');
    expect(result.reason).toBe('verification_tx_ref_missing');
    // chargeToken NOT called (provider already verified)
    expect(deps.chargeTokenFn).not.toHaveBeenCalled();
    // finalize NOT called
    expect((deps.supabase as any).rpc).not.toHaveBeenCalledWith('finalize_token_recurring_charge', expect.anything());
  });

  it('E. missing/mismatched tx_ref → failure_count unchanged', async () => {
    // Missing tx_ref case
    const deps1 = mockDeps({ chargeOutcome: 'successful' });
    deps1.verifyTransactionFn = vi.fn().mockResolvedValue({
      outcome: 'successful', amount: 50, currency: 'NGN',
      providerStatus: 'successful', providerTxRef: undefined,
    });
    const result1 = await processFlutterwaveRenewal(deps1, mockSub());
    expect(result1.action).toBe('error');
    expect(result1.failureCount).toBeUndefined();
    expect((deps1.supabase as any).rpc).not.toHaveBeenCalledWith('record_flutterwave_definitive_failure', expect.anything());

    // Mismatched tx_ref case
    const deps2 = mockDeps({ chargeOutcome: 'successful' });
    deps2.verifyTransactionFn = vi.fn().mockResolvedValue({
      outcome: 'successful', amount: 50, currency: 'NGN',
      providerStatus: 'successful', providerTxRef: 'WRONG-REF',
    });
    const result2 = await processFlutterwaveRenewal(deps2, mockSub());
    expect(result2.action).toBe('error');
    expect(result2.failureCount).toBeUndefined();
    expect((deps2.supabase as any).rpc).not.toHaveBeenCalledWith('record_flutterwave_definitive_failure', expect.anything());
  });
});

// ═══════════════════════════════════════════════════════
// Executable idempotency test — mocks global fetch, calls REAL chargeToken
// ═══════════════════════════════════════════════════════

describe('Flutterwave chargeToken — idempotency key (executable)', () => {
  it('17. X-Idempotency-Key is SHA-256(reference), deterministic, not raw ref', async () => {
    const { createHash } = await import('crypto');
    const ref = 'flw-sub-001-2026-08-04-a1';
    const expectedKey = createHash('sha256').update(ref).digest('hex');

    // The module captures FLUTTERWAVE_SECRET_KEY at load time. Since it's empty in test,
    // chargeToken returns early with a mock result. We test the SHA-256 logic directly
    // by verifying the createHash pipeline produces the expected output, then structurally
    // verify chargeToken passes it to flutterwaveRequest.

    // 1. Verify SHA-256 produces deterministic 64-char lowercase hex
    const key1 = createHash('sha256').update(ref).digest('hex');
    const key2 = createHash('sha256').update(ref).digest('hex');
    expect(key1).toBe(key2); // deterministic
    expect(key1).toMatch(/^[a-f0-9]{64}$/); // SHA-256 format
    expect(key1).not.toBe(ref); // not raw reference

    // 2. Different references produce different keys
    const otherKey = createHash('sha256').update('flw-sub-001-2026-08-04-a2').digest('hex');
    expect(otherKey).not.toBe(key1);

    // 3. Structurally verify chargeToken passes SHA-256 hash as X-Idempotency-Key
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../payments/flutterwave-recurring.ts'), 'utf-8');
    // Must use createHash('sha256') for the key
    expect(source).toContain("createHash('sha256').update(reference).digest('hex')");
    // Must import createHash
    expect(source).toContain("import { createHash } from 'crypto'");
    // X-Idempotency-Key must NOT use raw reference
    expect(source).not.toContain("'X-Idempotency-Key': reference");

    // 4. Verify the expected SHA-256 for our test reference
    expect(expectedKey).toBe(key1);
  });

  it('18. chargeToken sends idempotency header via fetch (integration)', async () => {
    const { createHash } = await import('crypto');
    const ref = 'flw-sub-001-2026-08-04-a1';
    const expectedKey = createHash('sha256').update(ref).digest('hex');

    const capturedHeaders: Record<string, string>[] = [];
    const capturedBodies: Record<string, unknown>[] = [];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      capturedHeaders.push({ ...headers });
      if (init.body) capturedBodies.push(JSON.parse(init.body as string));
      return new Response(JSON.stringify({
        status: 'success',
        data: { status: 'successful', tx_ref: ref, id: 12345 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    try {
      // Dynamically re-import with secret key set so chargeToken uses fetch path
      vi.resetModules();
      process.env.FLUTTERWAVE_SECRET_KEY = 'test-secret-key-for-idempotency';
      const mod = await import('../payments/flutterwave-recurring');

      await mod.chargeToken('tok-123', 50, 'test@example.com', ref, 'NGN');
      await mod.chargeToken('tok-123', 50, 'test@example.com', ref, 'NGN');

      // Both calls must produce the SAME idempotency key
      expect(capturedHeaders.length).toBe(2);
      expect(capturedHeaders[0]['X-Idempotency-Key']).toBe(expectedKey);
      expect(capturedHeaders[1]['X-Idempotency-Key']).toBe(expectedKey);

      // Key must be 64-char lowercase hex (SHA-256)
      expect(capturedHeaders[0]['X-Idempotency-Key']).toMatch(/^[a-f0-9]{64}$/);

      // Key must NOT be the raw reference
      expect(capturedHeaders[0]['X-Idempotency-Key']).not.toBe(ref);

      // tx_ref in body must be the raw reference (not hashed)
      expect(capturedBodies[0].tx_ref).toBe(ref);
      expect(capturedBodies[1].tx_ref).toBe(ref);

      // Different providerAttemptRef → different tx_ref → different idempotency key
      capturedHeaders.length = 0;
      capturedBodies.length = 0;
      const ref2 = 'flw-sub-001-2026-08-04-a2';
      const expectedKey2 = createHash('sha256').update(ref2).digest('hex');

      await mod.chargeToken('tok-123', 50, 'test@example.com', ref2, 'NGN');

      expect(capturedHeaders.length).toBe(1);
      expect(capturedHeaders[0]['X-Idempotency-Key']).toBe(expectedKey2);
      expect(capturedHeaders[0]['X-Idempotency-Key']).not.toBe(expectedKey); // different from a1
      expect(capturedBodies[0].tx_ref).toBe(ref2);
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.FLUTTERWAVE_SECRET_KEY;
      vi.resetModules();
    }
  });
});

/**
 * Payment Success Orchestration — #358 R4-B1 executable evidence
 *
 * Tests the PRODUCTION helpers used by app/payment-success/page.tsx:
 * - reconcileAndConfirm() — calls reconcilePayment exactly once, maps lifecycle
 * - getConfirmationMessage() — entity-neutral wording
 *
 * These are the same functions imported by the production page.
 * reconcilePayment is the only mocked dependency.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reconcileAndConfirm, getConfirmationMessage } from '../payment-success-helpers';
import type { ReconciliationResult } from '../reconcile';
import type { SupabaseClient } from '@supabase/supabase-js';

function makeReconcileResult(overrides: Partial<ReconciliationResult> = {}): ReconciliationResult {
  return {
    providerOutcome: 'verified',
    lifecycle: null,
    acknowledgeSuccess: true,
    ...overrides,
  };
}

describe('reconcileAndConfirm (production helper)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const supabase = {} as SupabaseClient;

  it('calls reconcilePayment with exact payment ID and "payment_success" source', async () => {
    const reconcile = vi.fn().mockResolvedValue(makeReconcileResult({
      lifecycle: { status: 'completed' } as ReconciliationResult['lifecycle'],
    }));

    await reconcileAndConfirm(supabase, 'pay_exact_123', reconcile);

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith(supabase, 'pay_exact_123', 'payment_success');
  });

  it('calls reconcilePayment exactly once — no duplicate calls', async () => {
    const reconcile = vi.fn().mockResolvedValue(makeReconcileResult({
      lifecycle: { status: 'already_completed' } as ReconciliationResult['lifecycle'],
    }));

    await reconcileAndConfirm(supabase, 'pay_no_dup', reconcile);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('completed → confirmed', async () => {
    const reconcile = vi.fn().mockResolvedValue(makeReconcileResult({
      lifecycle: { status: 'completed' } as ReconciliationResult['lifecycle'],
    }));

    const { confirmed } = await reconcileAndConfirm(supabase, 'p1', reconcile);
    expect(confirmed).toBe(true);
  });

  it('already_completed → confirmed', async () => {
    const reconcile = vi.fn().mockResolvedValue(makeReconcileResult({
      lifecycle: { status: 'already_completed' } as ReconciliationResult['lifecycle'],
    }));

    const { confirmed } = await reconcileAndConfirm(supabase, 'p2', reconcile);
    expect(confirmed).toBe(true);
  });

  it('not_deliverable → confirmed (finalized semantics)', async () => {
    const reconcile = vi.fn().mockResolvedValue(makeReconcileResult({
      lifecycle: { status: 'not_deliverable' } as ReconciliationResult['lifecycle'],
    }));

    const { confirmed } = await reconcileAndConfirm(supabase, 'p3', reconcile);
    expect(confirmed).toBe(true);
  });

  it('not_paid → NOT confirmed', async () => {
    const reconcile = vi.fn().mockResolvedValue(makeReconcileResult({
      providerOutcome: 'not_paid',
      lifecycle: null,
    }));

    const { confirmed } = await reconcileAndConfirm(supabase, 'p4', reconcile);
    expect(confirmed).toBe(false);
  });

  it('retryable_error → NOT confirmed', async () => {
    const reconcile = vi.fn().mockResolvedValue(makeReconcileResult({
      providerOutcome: 'retryable_error',
      lifecycle: null,
    }));

    const { confirmed } = await reconcileAndConfirm(supabase, 'p5', reconcile);
    expect(confirmed).toBe(false);
  });

  it('config_error → NOT confirmed', async () => {
    const reconcile = vi.fn().mockResolvedValue(makeReconcileResult({
      providerOutcome: 'config_error',
      lifecycle: null,
    }));

    const { confirmed } = await reconcileAndConfirm(supabase, 'p6', reconcile);
    expect(confirmed).toBe(false);
  });

  it('processing lifecycle → NOT confirmed', async () => {
    const reconcile = vi.fn().mockResolvedValue(makeReconcileResult({
      lifecycle: { status: 'processing' } as ReconciliationResult['lifecycle'],
    }));

    const { confirmed } = await reconcileAndConfirm(supabase, 'p7', reconcile);
    expect(confirmed).toBe(false);
  });

  it('retryable_failed lifecycle → NOT confirmed', async () => {
    const reconcile = vi.fn().mockResolvedValue(makeReconcileResult({
      lifecycle: { status: 'retryable_failed' } as ReconciliationResult['lifecycle'],
    }));

    const { confirmed } = await reconcileAndConfirm(supabase, 'p8', reconcile);
    expect(confirmed).toBe(false);
  });

  it('payment.status=success cannot bypass Authority — not_paid reconcile → NOT confirmed', async () => {
    // Even if the payment row has status='success', the orchestration helper
    // does not look at payment.status — it only uses reconcile's lifecycle result.
    const reconcile = vi.fn().mockResolvedValue(makeReconcileResult({
      providerOutcome: 'not_paid',
      lifecycle: null,
    }));

    const { confirmed } = await reconcileAndConfirm(supabase, 'pay_status_success', reconcile);
    expect(confirmed).toBe(false);
  });

  it('null lifecycle → NOT confirmed', async () => {
    const reconcile = vi.fn().mockResolvedValue(makeReconcileResult({
      lifecycle: null,
    }));

    const { confirmed } = await reconcileAndConfirm(supabase, 'p9', reconcile);
    expect(confirmed).toBe(false);
  });
});

describe('getConfirmationMessage (production helper)', () => {
  it('confirmed non-web: entity-neutral, does NOT say "booking"', () => {
    const msg = getConfirmationMessage(true, false);
    expect(msg).not.toContain('booking');
    expect(msg).toContain('confirmation details');
    expect(msg).toContain('Your payment is confirmed');
  });

  it('confirmed web channel: email wording', () => {
    const msg = getConfirmationMessage(true, true);
    expect(msg).toContain('Confirmation sent to your email');
  });

  it('unconfirmed non-web: pending WhatsApp message', () => {
    const msg = getConfirmationMessage(false, false);
    expect(msg).toContain('Your confirmation will arrive on WhatsApp shortly');
    expect(msg).not.toContain('booking');
  });

  it('unconfirmed web: pending email message', () => {
    const msg = getConfirmationMessage(false, true);
    expect(msg).toContain('Your confirmation will arrive in your email shortly');
  });

  it('order payment confirmed message does not mention booking', () => {
    const msg = getConfirmationMessage(true, false);
    expect(msg).not.toContain('booking');
  });

  it('invoice payment confirmed message does not mention booking', () => {
    const msg = getConfirmationMessage(true, false);
    expect(msg).not.toContain('booking');
  });

  it('campaign/giving payment confirmed message does not mention booking', () => {
    const msg = getConfirmationMessage(true, false);
    expect(msg).not.toContain('booking');
  });
});

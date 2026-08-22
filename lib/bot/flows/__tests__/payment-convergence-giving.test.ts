/**
 * Payment / Direct Giving — "I've Paid" convergence + cancel-race tests.
 *
 * Proves:
 * - Generic Payment and Direct Giving "I've Paid" converge through
 *   verifyAndReconcilePayment (canonical Payment Authority).
 * - No legacy financial/business-effect writers remain.
 * - Cancel-vs-payment race is CAS-guarded (pending-only cancel).
 * - Outcome routing: completed→end, processing→stay, not_verified→retry.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Source-level convergence tests ──

function readPaymentFlow(): string {
  const fs = require('fs');
  return fs.readFileSync('lib/bot/flows/payment.flow.ts', 'utf-8');
}

function getIvePaidSection(): string {
  const src = readPaymentFlow();
  return src.split("text === 'i_paid'")[1]?.split("Payment not yet received")[0] || '';
}

function getCancelSection(): string {
  const src = readPaymentFlow();
  return src.split("text === 'cancel'")[1]?.split("Bank transfer proof")[0] || '';
}

describe('Payment/Giving: I\'ve Paid converges through Payment Authority', () => {
  it('uses verifyAndReconcilePayment (not legacy verifyPayment)', () => {
    const section = getIvePaidSection();
    expect(section).toContain('verifyAndReconcilePayment');
    expect(section).not.toContain('verifyPayment(ctx');
  });

  it('handles completed outcome with brief acknowledgment', () => {
    const section = getIvePaidSection();
    expect(section).toContain("recovery.outcome === 'completed'");
    expect(section).toContain("recovery.outcome === 'not_deliverable'");
    expect(section).toContain("_action: 'already_confirmed'");
  });

  it('handles processing/retryable with recoverable UX', () => {
    const section = getIvePaidSection();
    expect(section).toContain("recovery.outcome === 'processing'");
    expect(section).toContain("recovery.outcome === 'retryable'");
    expect(section).toContain("_action: 'payment_processing'");
  });

  it('does not contain legacy financial/business-effect writers', () => {
    const section = getIvePaidSection();
    expect(section).not.toContain('total_spent');
    expect(section).not.toContain('recordPlatformFee');
    expect(section).not.toContain('handlePostCompletion');
    expect(section).not.toContain('notifyOwnerNewPayment');
    expect(section).not.toContain('createNotification');
    expect(section).not.toContain('calculateLtvTier');
  });

  it('does not import removed legacy dependencies', () => {
    const src = readPaymentFlow();
    // These should not appear in any import line
    const importSection = src.split('export const')[0];
    expect(importSection).not.toContain('verifyPayment');
    expect(importSection).not.toContain('recordPlatformFee');
    expect(importSection).not.toContain('handlePostCompletion');
    expect(importSection).not.toContain('getPaymentReceiptMessage');
    expect(importSection).not.toContain('calculateLtvTier');
    expect(importSection).not.toContain('SubscriptionTier');
    expect(importSection).not.toContain('createServiceClient');
    expect(importSection).not.toContain('getPlatformFees');
  });

  it('gives Giving-specific tips for completed outcome', () => {
    const section = getIvePaidSection();
    expect(section).toContain("active_capability === 'giving'");
    expect(section).toContain('my giving');
  });
});

describe('Payment/Giving: cancel-vs-payment CAS guard', () => {
  it('cancels booking only while status is pending', () => {
    const section = getCancelSection();
    expect(section).toContain(".in('status', ['pending'])");
    expect(section).toContain('.select(');
  });

  it('re-reads booking on zero-row cancel and recovers if paid', () => {
    const section = getCancelSection();
    expect(section).toContain('cancelResult?.length');
    expect(section).toContain("deposit_status === 'paid'");
    expect(section).toContain("status === 'confirmed'");
    expect(section).toContain("_action: 'already_confirmed'");
  });

  it('fails closed on cancel DB error', () => {
    const section = getCancelSection();
    expect(section).toContain('cancelErr');
    expect(section).toContain('Something went wrong');
  });

  it('fails closed on re-read error', () => {
    const section = getCancelSection();
    expect(section).toContain('readErr');
  });

  it('only cancels pending_transfer after booking cancel is known safe', () => {
    const section = getCancelSection();
    // pending_transfers cancel must appear AFTER the cancelResult check
    const cancelResultIdx = section.indexOf('cancelResult?.length');
    const pendingTransferIdx = section.indexOf('pending_transfers');
    expect(cancelResultIdx).toBeGreaterThan(-1);
    expect(pendingTransferIdx).toBeGreaterThan(cancelResultIdx);
  });
});

describe('Payment/Giving: next() routing', () => {
  it('processing stays at await_payment', () => {
    const src = readPaymentFlow();
    // next() routing: payment_processing → return 'await_payment'
    // The second occurrence of payment_processing is in next(), not validate()
    const occurrences = src.split('payment_processing');
    expect(occurrences.length).toBeGreaterThanOrEqual(3); // import + validate + next = 3 splits
    const nextBlock = occurrences[2]; // after 2nd occurrence (in next())
    expect(nextBlock).toBeDefined();
    expect(nextBlock!.substring(0, 100)).toContain("return 'await_payment'");
  });

  it('dead payment_confirmed→recurring routing is removed', () => {
    const src = readPaymentFlow();
    // The old payment_confirmed→offer_recurring routing should no longer exist
    // Search between 'await_payment' step's next() and 'Offer Recurring' comment
    const awaitPaymentNext = src.split("'retry_payment'")[1]?.split('Offer Recurring')[0] || '';
    expect(awaitPaymentNext).not.toContain("'payment_confirmed'");
    expect(awaitPaymentNext).not.toContain('offer_recurring');
  });
});

describe('Payment/Giving: bank transfer handling unchanged', () => {
  it('bank transfer proof OCR handling still present', () => {
    const src = readPaymentFlow();
    expect(src).toContain('analyzeReceipt');
    expect(src).toContain('receiptMatchesExpected');
    expect(src).toContain('transfer_proof_sent');
  });

  it('bank transfer proof still notifies owner', () => {
    const src = readPaymentFlow();
    // Bank transfer proof notification uses notifyOwnerNewPayment (not removed)
    const btSection = src.split('Bank transfer proof')[1]?.split('I\'ve Sent Transfer')[0] || '';
    expect(btSection).toContain('notifyOwnerNewPayment');
    expect(btSection).toContain('createNotification');
  });
});

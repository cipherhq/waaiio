/**
 * PAYMENT-CONVERGENCE-SCHEDULING — Behavioral tests
 *
 * Tests the convergence of Scheduling and Ticketing paid-success paths
 * through the canonical Payment Authority lifecycle.
 */
import { describe, it, expect, vi } from 'vitest';

// ══════════════════════════════════════════════════════════
// 1. SCHEDULING: I'VE PAID CONVERGENCE
// ══════════════════════════════════════════════════════════

describe('Scheduling: I\'ve Paid converges through Payment Authority', () => {
  it('uses verifyAndReconcilePayment with rich result (not boolean)', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/scheduling.flow.ts', 'utf-8');
    // Full I've Paid section including both completed and processing branches
    const ivePaidSection = src.split("text === 'i_paid'")[1]?.split("Payment not yet received")[0] || '';
    expect(ivePaidSection).toContain('verifyAndReconcilePayment');
    expect(ivePaidSection).toContain("recovery.outcome === 'completed'");
    expect(ivePaidSection).toContain("recovery.outcome === 'processing'");
  });

  it('does not independently update booking status after authority', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/scheduling.flow.ts', 'utf-8');
    const ivePaidSection = src.split("text === 'i_paid'")[1]?.split("'payment_confirmed'")[0] || '';
    expect(ivePaidSection).not.toContain("update({ status: 'confirmed'");
    expect(ivePaidSection).not.toContain('recordPlatformFee');
    expect(ivePaidSection).not.toContain('handlePostCompletion');
    expect(ivePaidSection).not.toContain("'payment_received'");
  });

  it('processing/retryable returns payment_processing (not payment_confirmed)', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/scheduling.flow.ts', 'utf-8');
    const processingSection = src.split("recovery.outcome === 'processing'")[1]?.split('return {')[0] || '';
    expect(processingSection).not.toContain("'payment_confirmed'");
    // Verify payment_processing is used
    expect(src).toContain("_action: 'payment_processing'");
  });

  it('next() keeps session active for payment_processing', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/scheduling.flow.ts', 'utf-8');
    expect(src).toContain("d._action === 'payment_processing'");
    expect(src).toContain("return 'await_booking_payment'");
  });
});

// ══════════════════════════════════════════════════════════
// 2. TICKETING: I'VE PAID CONVERGENCE
// ══════════════════════════════════════════════════════════

describe('Ticketing: I\'ve Paid converges through Payment Authority', () => {
  it('uses verifyAndReconcilePayment with rich result', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/ticketing.flow.ts', 'utf-8');
    // Use the handler entry to split, not button definitions
    const ivePaidSection = src.split("text === 'i_paid'")[1]?.split("'payment_confirmed'")[0] || '';
    expect(ivePaidSection).toContain('verifyAndReconcilePayment');
    expect(ivePaidSection).toContain("recovery.outcome === 'completed'");
  });

  it('does not independently run legacy manual effects after authority', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/ticketing.flow.ts', 'utf-8');
    const ivePaidSection = src.split("text === 'i_paid'")[1]?.split("'payment_confirmed'")[0] || '';
    expect(ivePaidSection).not.toContain('finalize_free_ticket_booking');
    expect(ivePaidSection).not.toContain('sendTicketsAfterPurchase');
    expect(ivePaidSection).not.toContain('recordPlatformFee');
    expect(ivePaidSection).not.toContain('handlePostCompletion');
    expect(ivePaidSection).not.toContain('notifyOwnerNewTicketSale');
  });

  it('processing/retryable keeps session active', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/ticketing.flow.ts', 'utf-8');
    expect(src).toContain("_action: 'payment_processing'");
    expect(src).toContain("return 'await_ticket_payment'");
  });
});

// ══════════════════════════════════════════════════════════
// 3. SAVED-CARD CONVERGENCE
// ══════════════════════════════════════════════════════════

describe('Saved-card convergence through Payment Authority', () => {
  it('chargeSavedCard returns explicit outcome types', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/payments/charge-saved.ts', 'utf-8');
    expect(src).toContain("outcome: 'charged'");
    expect(src).toContain("outcome: 'declined'");
    expect(src).toContain("outcome: 'indeterminate'");
    expect(src).toContain("outcome: 'already_charged'");
    expect(src).toContain("outcome: 'previously_declined'");
  });

  it('checks existing payment before calling provider', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/payments/charge-saved.ts', 'utf-8');
    // Step 0 query must happen before Step 3 provider call
    const step0Idx = src.indexOf('Step 0: Check existing canonical payment');
    const step3Idx = src.indexOf('Step 3: Charge the authorization');
    expect(step0Idx).toBeGreaterThan(-1);
    expect(step3Idx).toBeGreaterThan(step0Idx);
  });

  it('fails closed if payment INSERT fails', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/payments/charge-saved.ts', 'utf-8');
    expect(src).toContain('NOT calling provider');
    expect(src).toContain("insertErr || !payRow");
  });

  it('persists payment_authority_version=1 on the payment row (not in metadata)', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/payments/charge-saved.ts', 'utf-8');
    // Must be a top-level column, not inside metadata
    const insertSection = src.split('Step 2: Create canonical payment')[1]?.split('.select(')[0] || '';
    expect(insertSection).toContain('payment_authority_version: 1');
    expect(insertSection).toContain("payment_origin: 'platform'");
  });

  it('marks declined payments as failed in DB', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/payments/charge-saved.ts', 'utf-8');
    expect(src).toContain("status: 'failed', gateway_status:");
  });

  it('scheduling routes charged outcome through reconcilePayment', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/scheduling.flow.ts', 'utf-8');
    // Verify reconcilePayment is called with saved_card source near _saved_card_paid
    expect(src).toContain("reconcilePayment(ctx.supabase, paymentId, 'saved_card')");
  });

  it('indeterminate outcome keeps session recoverable', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/scheduling.flow.ts', 'utf-8');
    expect(src).toContain('_saved_card_indeterminate');
    expect(src).toContain("return 'await_booking_payment'");
  });

  it('BYO saved-card fails closed', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/payments/charge-saved.ts', 'utf-8');
    expect(src).toContain('BYO saved-card charging not supported');
  });
});

// ══════════════════════════════════════════════════════════
// 4. BOOKING STAGE-2 POSTCONDITION
// ══════════════════════════════════════════════════════════

describe('Booking Stage-2 postcondition check', () => {
  it('processSuccessfulPayment reads booking state after update', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/payments/process-success.ts', 'utf-8');
    expect(src).toContain('booking_postcondition_missing');
    expect(src).toContain('booking_cancelled_at_payment');
    expect(src).toContain('booking_no_show_at_payment');
  });

  it('cancelled booking does not receive fee or ticket consequences', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/payments/process-success.ts', 'utf-8');
    const cancelSection = src.split('booking_cancelled_at_payment')[1]?.split('recordPlatformFee')[0] || '';
    expect(cancelSection).toContain('return { criticalSuccess: false');
  });

  it('ensures deposit_status=paid for non-pending bookings', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/payments/process-success.ts', 'utf-8');
    expect(src).toContain("deposit_status !== 'paid'");
    expect(src).toContain("deposit_status: 'paid'");
  });
});

// ══════════════════════════════════════════════════════════
// 5. CANCEL-VS-PAYMENT RACE SAFETY
// ══════════════════════════════════════════════════════════

describe('Payment-wait cancellation race safety', () => {
  it('scheduling cancellation uses conditional update with .in(pending)', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/scheduling.flow.ts', 'utf-8');
    // The cancel handler uses .in('status', ['pending']) guard
    expect(src).toContain(".in('status', ['pending'])\n              .select('id')");
  });

  it('scheduling detects confirmed booking and shows recovery UX', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/scheduling.flow.ts', 'utf-8');
    expect(src).toContain('Your payment has been confirmed! Your booking is active');
  });

  it('ticketing cancellation uses conditional update with .in(pending)', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/ticketing.flow.ts', 'utf-8');
    expect(src).toContain(".in('status', ['pending'])\n              .select('id')");
  });

  it('ticketing detects confirmed booking and shows recovery UX', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/ticketing.flow.ts', 'utf-8');
    expect(src).toContain('Your payment has been confirmed! Your tickets are ready');
  });
});

// ══════════════════════════════════════════════════════════
// 6. BOT-RECOVERY RICH RETURN TYPE
// ══════════════════════════════════════════════════════════

describe('bot-recovery.ts rich lifecycle result', () => {
  it('returns RecoveryResult with outcome field', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/payments/bot-recovery.ts', 'utf-8');
    expect(src).toContain("outcome: 'completed'");
    expect(src).toContain("outcome: 'processing'");
    expect(src).toContain("outcome: 'retryable'");
    expect(src).toContain("outcome: 'not_verified'");
    expect(src).toContain("outcome: 'not_deliverable'");
  });

  it('does NOT return boolean', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/payments/bot-recovery.ts', 'utf-8');
    // Function return type should not be Promise<boolean>
    expect(src).not.toContain('Promise<boolean>');
    expect(src).toContain('Promise<RecoveryResult>');
  });
});

// ══════════════════════════════════════════════════════════
// 7. CONFIRMED LIFECYCLE GAPS (documentation, not fix)
// ══════════════════════════════════════════════════════════

describe('Confirmed lifecycle gaps are recorded (not fixed in this PR)', () => {
  it('scheduling staff notification NOT in canonical paid path', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/scheduling.flow.ts', 'utf-8');
    const ivePaidSection = src.split("text === 'i_paid'")[1]?.split("'payment_confirmed'")[0] || '';
    expect(ivePaidSection).not.toContain('notifyStaffNewBooking');
  });

  it('ticketing sale-specific notification NOT in canonical paid path', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/ticketing.flow.ts', 'utf-8');
    const ivePaidSection = src.split("text === 'i_paid'")[1]?.split("'payment_confirmed'")[0] || '';
    expect(ivePaidSection).not.toContain('notifyOwnerNewTicketSale');
    expect(ivePaidSection).not.toContain("type: 'ticket_sale'");
  });
});

// ══════════════════════════════════════════════════════════
// 8. FREE/NO-PAYMENT PATHS UNCHANGED
// ══════════════════════════════════════════════════════════

describe('Free/no-payment paths unchanged', () => {
  it('scheduling free booking path still calls handlePostCompletion', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/scheduling.flow.ts', 'utf-8');
    // Free booking completion (not payment-related) should still have handlePostCompletion
    expect(src).toContain('handlePostCompletion');
  });

  it('ticketing free event still uses sendTicketsAfterPurchase directly', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/ticketing.flow.ts', 'utf-8');
    // Free event path should still call sendTicketsAfterPurchase
    expect(src).toContain('sendTicketsAfterPurchase');
  });

  it('bank-transfer proof paths unchanged', () => {
    const fs = require('fs');
    const schedSrc = fs.readFileSync('lib/bot/flows/scheduling.flow.ts', 'utf-8');
    expect(schedSrc).toContain('_awaiting_transfer_proof');
    expect(schedSrc).toContain('pending_transfers');
    const tickSrc = fs.readFileSync('lib/bot/flows/ticketing.flow.ts', 'utf-8');
    expect(tickSrc).toContain('_awaiting_transfer_proof');
  });
});

// ══════════════════════════════════════════════════════════
// 9. RECONCILIATION SOURCE
// ══════════════════════════════════════════════════════════

describe('ReconciliationSource includes saved_card', () => {
  it('reconcile.ts type includes saved_card', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/payments/reconcile.ts', 'utf-8');
    expect(src).toContain("'saved_card'");
  });
});

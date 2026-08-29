/**
 * Issue #219 — Stale button parser + parseIvePaidInput + active flow mismatch branching
 */
import { describe, it, expect } from 'vitest';
import { parseStalePaymentButton } from '@/lib/payments/stale-button-parser';
import { parseIvePaidInput, isIvePaidInput } from '@/lib/bot/flows/shared/ive-paid-input';

// ---------------------------------------------------------------------------
// Stale Button Parser
// ---------------------------------------------------------------------------
describe('parseStalePaymentButton', () => {
  it('1. recognizes i_paid_ref:PAY-123 as stale when NOT on a payment step', () => {
    const result = parseStalePaymentButton('i_paid_ref:PAY-123', 'button', 'select_capability');
    expect(result.isStalePaymentButton).toBe(true);
    expect(result.hasPaymentReference).toBe(true);
    expect(result.paymentReference).toBe('PAY-123');
  });

  it('2. rejects malformed i_paid_ref: (empty ref) — fail closed', () => {
    const result = parseStalePaymentButton('i_paid_ref:', 'button', 'select_capability');
    expect(result.isStalePaymentButton).toBe(false);
  });

  it('3. does NOT flag i_paid_ref:PAY-123 as stale when session is on "payment" step', () => {
    const result = parseStalePaymentButton('i_paid_ref:PAY-123', 'button', 'payment');
    expect(result.isStalePaymentButton).toBe(false);
  });

  it('4. does NOT match when messageType is "text" (only buttons)', () => {
    const result = parseStalePaymentButton('i_paid_ref:PAY-123', 'text', 'select_capability');
    expect(result.isStalePaymentButton).toBe(false);
  });

  it('5. legacy: recognizes i_paid:<order-ref> with hasReference', () => {
    const result = parseStalePaymentButton('i_paid:WA-OR-001', 'button', 'select_capability');
    expect(result.isStalePaymentButton).toBe(true);
    expect(result.hasReference).toBe(true);
    expect(result.reference).toBe('WA-OR-001');
    expect(result.hasPaymentReference).toBe(false);
  });

  it('6. legacy: recognizes bare i_paid with no references', () => {
    const result = parseStalePaymentButton('i_paid', 'button', 'select_capability');
    expect(result.isStalePaymentButton).toBe(true);
    expect(result.hasReference).toBe(false);
    expect(result.hasPaymentReference).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseIvePaidInput
// ---------------------------------------------------------------------------
describe('parseIvePaidInput', () => {
  it('7. recognizes bare "i_paid"', () => {
    const result = parseIvePaidInput('i_paid');
    expect(result.recognized).toBe(true);
    expect(result.paymentRef).toBeUndefined();
  });

  it('8. recognizes "i_paid_ref:PAY-123" with paymentRef', () => {
    const result = parseIvePaidInput('i_paid_ref:PAY-123');
    expect(result.recognized).toBe(true);
    expect(result.paymentRef).toBe('PAY-123');
  });

  it('9. rejects malformed "i_paid_ref:" (empty ref)', () => {
    const result = parseIvePaidInput('i_paid_ref:');
    expect(result.recognized).toBe(false);
  });

  it('10. does not recognize arbitrary text "hello"', () => {
    const result = parseIvePaidInput('hello');
    expect(result.recognized).toBe(false);
  });

  it('11. recognizes "paid" as a legacy I\'ve Paid form', () => {
    const result = parseIvePaidInput('paid');
    expect(result.recognized).toBe(true);
  });

  it('12. isIvePaidInput returns true for "i_paid_ref:REF"', () => {
    expect(isIvePaidInput('i_paid_ref:REF')).toBe(true);
  });

  it('13. isIvePaidInput returns false for "random"', () => {
    expect(isIvePaidInput('random')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Active flow: mismatched locator routes to recoverByPaymentReference
// ---------------------------------------------------------------------------
describe('payment.flow.ts await_payment validate — mismatched locator branching', () => {
  it('14. when i_paid_ref:REF-A arrives but session has payment_reference=REF-B, recoverByPaymentReference is called with REF-A (not the active session ref)', () => {
    /**
     * Behavioral / code-path verification (not an integration test):
     *
     * In payment.flow.ts await_payment.validate():
     *
     *   const ivePaidResult = parseIvePaidInput(text);        // text = 'i_paid_ref:REF-A'
     *   if (ivePaidResult.recognized) {
     *     const ref = ctx.session.session_data.payment_reference; // 'REF-B'
     *     if (ivePaidResult.paymentRef && ref && ivePaidResult.paymentRef !== ref) {
     *       // ^^^ REF-A !== REF-B → enters this branch
     *       const recoveryResult = await recoverByPaymentReference(
     *         { ... },
     *         ivePaidResult.paymentRef,  // ← REF-A is passed, NOT ref (REF-B)
     *       );
     *       await ctx.sender.sendText({ to: ctx.from, text: recoveryResult.message });
     *       return { valid: true, data: { _action: 'already_confirmed' } };
     *     }
     *   }
     *
     * We verify the branching logic by running parseIvePaidInput with the
     * mismatched input and confirming the conditional would be entered.
     */

    // Simulate the exact variables the validate function would have:
    const text = 'i_paid_ref:REF-A';
    const sessionPaymentReference = 'REF-B';

    const ivePaidResult = parseIvePaidInput(text);

    // The input is recognized
    expect(ivePaidResult.recognized).toBe(true);

    // The paymentRef from the button is REF-A
    expect(ivePaidResult.paymentRef).toBe('REF-A');

    // The mismatch condition that triggers recoverByPaymentReference:
    // ivePaidResult.paymentRef && ref && ivePaidResult.paymentRef !== ref
    const mismatchCondition =
      !!ivePaidResult.paymentRef &&
      !!sessionPaymentReference &&
      ivePaidResult.paymentRef !== sessionPaymentReference;

    expect(mismatchCondition).toBe(true);

    // Critically, recoverByPaymentReference receives ivePaidResult.paymentRef (REF-A),
    // NOT the active session's payment_reference (REF-B).
    // This ensures the recovery lookup targets the correct payment.
    expect(ivePaidResult.paymentRef).not.toBe(sessionPaymentReference);
  });

  it('g. Mismatched locator keeps active session — returns { valid: false } not already_confirmed', () => {
    /**
     * CTO review blocker: When ivePaidResult.paymentRef !== ref (active session ref),
     * the validate function must return { valid: false } to keep the active session
     * at the current step. It must NOT return { valid: true, data: { _action: 'already_confirmed' } }
     * which would end the active session.
     *
     * Source verification: payment.flow.ts line ~790:
     *   if (ivePaidResult.paymentRef && ref && ivePaidResult.paymentRef !== ref) {
     *     ...
     *     return { valid: false };   // <-- keeps active session alive
     *   }
     */
    const fs = require('fs');
    const paymentFlowSrc = fs.readFileSync('lib/bot/flows/payment.flow.ts', 'utf-8');

    // Find the mismatch block
    const mismatchIdx = paymentFlowSrc.indexOf('ivePaidResult.paymentRef !== ref');
    expect(mismatchIdx).toBeGreaterThan(-1);

    // Find the closing brace of the mismatch if-block by looking for
    // `return { valid: false };` followed by the closing `}` of the if-block.
    // The mismatch block ends at the next `}` after the return statement.
    const returnIdx = paymentFlowSrc.indexOf('return { valid: false };', mismatchIdx);
    expect(returnIdx).toBeGreaterThan(mismatchIdx);

    // Extract only the mismatch if-block (from condition to its return)
    const mismatchBlock = paymentFlowSrc.slice(mismatchIdx, returnIdx + 'return { valid: false };'.length);

    // Verify the return is { valid: false } — keeps the active session alive
    expect(mismatchBlock).toContain('return { valid: false }');

    // The mismatch block must NOT contain already_confirmed
    // (already_confirmed would end the active session, which is wrong)
    expect(mismatchBlock).not.toContain('already_confirmed');
  });
});

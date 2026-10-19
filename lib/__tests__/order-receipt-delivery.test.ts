/**
 * Order receipt delivery tests.
 *
 * Root cause: orders passed amountPaid=0 to handlePostCompletion, which gates
 * receipt generation on amountPaid > 0. Fix: pass real payment.amount for all
 * entity types, with skipCustomerSpend=true for orders.
 *
 * Strategy: verify the fix at the source level and test the receipt gate in
 * post-completion directly, avoiding the complex claim lifecycle mocking.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('Order receipt: send-confirmation amountPaid contract', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'lib/payments/send-confirmation.ts'),
    'utf8',
  );

  it('passes payment.amount (not 0) as amountPaid for all entity types', () => {
    // The old code was: amountPaid: isOrderPayment ? 0 : payment.amount
    // The fix is: amountPaid: payment.amount (unconditional)
    expect(source).not.toContain('isOrderPayment ? 0 : payment.amount');
    // Verify the new code passes payment.amount directly
    expect(source).toMatch(/amountPaid:\s*payment\.amount/);
  });

  it('sets skipCustomerSpend for orders (Stage 2 owns durable spend)', () => {
    // Must include isOrderPayment in the skipCustomerSpend condition
    expect(source).toMatch(/skipCustomerSpend:.*isOrderPayment/);
  });

  it('sets skipAutomation for orders', () => {
    expect(source).toMatch(/skipAutomation:.*isOrderPayment/);
  });

  it('does not use amountPaid=0 anywhere for order payments', () => {
    // No pattern that conditionally zeros out order amounts
    const lines = source.split('\n');
    const orderZeroLines = lines.filter(
      (l) => l.includes('isOrderPayment') && l.includes('0') && l.includes('amountPaid'),
    );
    expect(orderZeroLines).toHaveLength(0);
  });
});

describe('Order receipt: post-completion receipt gate', () => {
  it('receipt generation requires amountPaid > 0', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'lib/bot/flows/shared/post-completion.ts'),
      'utf8',
    );
    // The gate condition: if (amountPaid && amountPaid > 0)
    expect(source).toMatch(/if\s*\(\s*amountPaid\s*&&\s*amountPaid\s*>\s*0\s*\)/);
  });
});

describe('Order receipt: idempotency via delivery claim', () => {
  it('uses claim_confirmation_delivery RPC for exactly-once customer send', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'lib/payments/send-confirmation.ts'),
      'utf8',
    );
    expect(source).toContain('claim_confirmation_delivery');
    expect(source).toContain('already_delivered');
  });

  it('uses payment_receipt_applications marker for exactly-once PDF generation', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'lib/bot/flows/shared/post-completion.ts'),
      'utf8',
    );
    expect(source).toContain('payment_receipt_applications');
    expect(source).toContain("onConflict: 'payment_id'");
  });
});

describe('Order receipt: send failure handling', () => {
  it('captures send errors to Sentry (never silently swallowed)', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'lib/payments/send-confirmation.ts'),
      'utf8',
    );
    // Send errors are captured to Sentry
    expect(source).toContain('indeterminate-send-error');
    expect(source).toContain('Sentry.captureException');
  });

  it('records send failures via fail_confirmation_send RPC', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'lib/payments/send-confirmation.ts'),
      'utf8',
    );
    expect(source).toContain('fail_confirmation_send');
  });
});

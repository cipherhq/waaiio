/**
 * extractSubscriptionLinePeriod — 10 unit tests
 *
 * Tests the dual-shape (legacy + modern Basil 2025-03-31+) line-item
 * period extraction for Stripe subscription invoices.
 */
import { describe, it, expect } from 'vitest';
import { extractSubscriptionLinePeriod } from '../stripe-invoice-extractors';

const SUB_ID = 'sub_test123';

function makeInvoice(lines: Record<string, unknown>[]): Record<string, unknown> {
  return { lines: { data: lines } };
}

describe('extractSubscriptionLinePeriod', () => {
  it('1. legacy line.subscription match → returns period', () => {
    const invoice = makeInvoice([
      { subscription: SUB_ID, period: { start: 1700000000, end: 1702592000 } },
    ]);
    const result = extractSubscriptionLinePeriod(invoice, SUB_ID);
    expect('error' in result).toBe(false);
    expect((result as { periodStart: number }).periodStart).toBe(1700000000);
    expect((result as { periodEnd: number }).periodEnd).toBe(1702592000);
  });

  it('2. modern parent.subscription_item_details.subscription match → returns period', () => {
    const invoice = makeInvoice([
      {
        parent: {
          type: 'subscription_item_details',
          subscription_item_details: { subscription: SUB_ID },
        },
        period: { start: 1700000000, end: 1702592000 },
      },
    ]);
    const result = extractSubscriptionLinePeriod(invoice, SUB_ID);
    expect('error' in result).toBe(false);
    expect((result as { periodStart: number }).periodStart).toBe(1700000000);
  });

  it('3. both legacy and modern agree → returns period', () => {
    const invoice = makeInvoice([
      {
        subscription: SUB_ID,
        parent: {
          type: 'subscription_item_details',
          subscription_item_details: { subscription: SUB_ID },
        },
        period: { start: 1700000000, end: 1702592000 },
      },
    ]);
    const result = extractSubscriptionLinePeriod(invoice, SUB_ID);
    expect('error' in result).toBe(false);
    expect((result as { periodStart: number }).periodStart).toBe(1700000000);
  });

  it('4. legacy and modern conflict → fail closed', () => {
    const invoice = makeInvoice([
      {
        subscription: SUB_ID,
        parent: {
          type: 'subscription_item_details',
          subscription_item_details: { subscription: 'sub_different999' },
        },
        period: { start: 1700000000, end: 1702592000 },
      },
    ]);
    const result = extractSubscriptionLinePeriod(invoice, SUB_ID);
    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toBe('line_subscription_conflict');
  });

  it('5. one-time items (no subscription ref) are skipped', () => {
    const invoice = makeInvoice([
      { amount: 500, period: { start: 1700000000, end: 1702592000 } }, // one-time, no sub ref
      { subscription: SUB_ID, period: { start: 1700000000, end: 1702592000 } },
    ]);
    const result = extractSubscriptionLinePeriod(invoice, SUB_ID);
    expect('error' in result).toBe(false);
    expect((result as { periodStart: number }).periodStart).toBe(1700000000);
  });

  it('6. no matching lines → fail closed', () => {
    const invoice = makeInvoice([
      { subscription: 'sub_other456', period: { start: 1700000000, end: 1702592000 } },
    ]);
    const result = extractSubscriptionLinePeriod(invoice, SUB_ID);
    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toBe('no_matching_line');
  });

  it('7. multiple matching lines → fail closed', () => {
    const invoice = makeInvoice([
      { subscription: SUB_ID, period: { start: 1700000000, end: 1702592000 } },
      { subscription: SUB_ID, period: { start: 1702592000, end: 1705184000 } },
    ]);
    const result = extractSubscriptionLinePeriod(invoice, SUB_ID);
    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toBe('multiple_matching_lines');
  });

  it('8. missing period on matching line → fail closed', () => {
    const invoice = makeInvoice([
      { subscription: SUB_ID }, // no period property
    ]);
    const result = extractSubscriptionLinePeriod(invoice, SUB_ID);
    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toBe('missing_line_period');
  });

  it('9. no lines.data array → fail closed', () => {
    const invoice = { lines: {} };
    const result = extractSubscriptionLinePeriod(invoice, SUB_ID);
    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toBe('no_lines');
  });

  it('10. invalid period values (non-number) → fail closed', () => {
    const invoice = makeInvoice([
      { subscription: SUB_ID, period: { start: 'not-a-number', end: 1702592000 } },
    ]);
    const result = extractSubscriptionLinePeriod(invoice, SUB_ID);
    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toBe('invalid_line_period');
  });

  it('11. equal periods (start === end) → malformed_period', () => {
    const invoice = makeInvoice([
      { subscription: SUB_ID, period: { start: 1700000000, end: 1700000000 } },
    ]);
    const result = extractSubscriptionLinePeriod(invoice, SUB_ID);
    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toBe('malformed_period');
  });

  it('12. reversed periods (start > end) → malformed_period', () => {
    const invoice = makeInvoice([
      { subscription: SUB_ID, period: { start: 1702592000, end: 1700000000 } },
    ]);
    const result = extractSubscriptionLinePeriod(invoice, SUB_ID);
    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toBe('malformed_period');
  });
});

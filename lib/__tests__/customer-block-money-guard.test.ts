/**
 * #1166 S5 / S12 / B6 guard: payment, fee, refund, payout, settlement and
 * confirmation code never reads the customer block. A source scan (a guard,
 * not acceptance on its own; the handler proof is in
 * customer-block-web-routes.test.ts "S10 / S5"). It fails if any of these
 * modules imports the block helpers or names the block tables.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MONEY_ROOTS = [
  'lib/payments',
  'lib/bot/flows/shared/payment.ts',
  'lib/bot/flows/shared/send-tickets.ts',
  'lib/bot/flows/shared/notify-owner.ts',
  'app/api/webhook/paystack',
  'app/api/webhook/stripe',
  'app/api/webhook/flutterwave',
  'app/api/webhook/square',
  'app/api/payments',
  'app/api/admin/payouts',
  'app/api/admin/refunds',
  'app/api/invoices/pay',
  'app/api/cron/expire-transfers',
];
const FORBIDDEN = /customer-block|customer-email-proof|customer_email_blocks|customer_suspensions|customer-suspension/;
/**
 * The after-payment follow-up message (not money) skips a blocked number by
 * #1103's rule; the payment and its confirmation are untouched.
 */
const ALLOWED = new Set(['lib/payments/transaction-followup.ts']);

function files(root: string): string[] {
  try {
    const st = statSync(root);
    if (st.isFile()) return /\.(ts|tsx)$/.test(root) ? [root] : [];
    return readdirSync(root).flatMap(name => (name === '__tests__' ? [] : files(join(root, name))));
  } catch {
    return [];
  }
}

describe('money code does not read the customer block', () => {
  const scanned = MONEY_ROOTS.flatMap(files);

  it('scans real files', () => {
    expect(scanned.length).toBeGreaterThan(20);
    expect(scanned).toContain('lib/payments/process-success.ts');
    expect(scanned).toContain('lib/payments/send-confirmation.ts');
  });

  it('no payment, fee, refund, payout or confirmation module names the block', () => {
    const offenders = scanned.filter(f => !ALLOWED.has(f) && FORBIDDEN.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});

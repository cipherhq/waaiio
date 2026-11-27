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
  // Provider webhooks and callbacks (payment success, transfers, settlement).
  'app/api/webhooks',
  'app/api/payments',
  // Refunds, payouts, settlement and bank-transfer approval.
  'app/api/admin/payments',
  'app/api/admin/payouts',
  'app/api/admin/reseller-payouts',
  'app/api/payouts',
  'app/api/dashboard/pending-transfers',
  'app/api/invoices/pay',
  'app/api/cron/expire-transfers',
  'app/api/cron/payment-reconciliation',
  'app/api/cron/auto-payout',
  'app/api/cron/retry-failed-charges',
  // Admin panel money pages.
  'admin/src/pages/Payouts.tsx',
  'admin/src/pages/Payments.tsx',
  'admin/src/pages/Finance.tsx',
  'admin/src/pages/ResellerPayouts.tsx',
];
const FORBIDDEN = /customer-block|customer-email-proof|customer_email_blocks|customer_suspensions|customer-suspension/;
/**
 * The after-payment follow-up message (not money) skips a blocked number by
 * #1103's rule; the payment and its confirmation are untouched.
 */
const ALLOWED_FILE = 'lib/payments/transaction-followup.ts';
const ALLOWED_LINE = "import { proactiveSuspensionStatus } from '@/lib/customer-suspension';";

function files(root: string): string[] {
  const st = statSync(root); // throws if a root is missing, so a wrong path fails the test
  if (st.isFile()) return /\.(ts|tsx)$/.test(root) ? [root] : [];
  return readdirSync(root).flatMap(name => (name === '__tests__' ? [] : files(join(root, name))));
}

describe('money code does not read the customer block', () => {
  const scanned = MONEY_ROOTS.flatMap(files);

  it('every root exists and real files are scanned', () => {
    for (const root of MONEY_ROOTS) expect(() => statSync(root), root).not.toThrow();
    expect(scanned.length).toBeGreaterThan(40);
    expect(scanned).toContain('app/api/webhooks/flutterwave/route.ts');
    expect(scanned).toContain('app/api/admin/payments/refund/route.ts');
    expect(scanned).toContain('lib/payments/process-success.ts');
    expect(scanned).toContain('lib/payments/send-confirmation.ts');
  });

  it('no payment, fee, refund, payout or confirmation module names the block', () => {
    const offenders = scanned.filter(f => {
      let text = readFileSync(f, 'utf8');
      // Only the #1103 follow-up's own suspension import is allowed, nothing else.
      if (f === ALLOWED_FILE) text = text.replace(ALLOWED_LINE, '').replace(/proactiveSuspensionStatus/g, '');
      return FORBIDDEN.test(text);
    });
    expect(offenders).toEqual([]);
  });
});

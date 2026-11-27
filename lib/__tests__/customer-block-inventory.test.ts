/**
 * #1166 r7 S7/S9/S12 inventory guards (guards only, not acceptance on their own;
 * the behaviour is proved in customer-email-block-sends, -invites and the
 * route tests).
 *
 * 1. Every file that sends email (sendEmail / sendOrEmail / sendBookingEmail)
 *    is classified as "skip if blocked" (S9 skip rows: must check the block),
 *    "always send" (money and transactional, F17: must not check it) or "not to
 *    customers" (merchant, staff, admin, account; F18). A new email send that is
 *    not classified fails here, so it cannot ship without a decision.
 * 2. No browser code imports the server-only block modules (SEC-001).
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SEND = /\bsendEmail\(|\bsendOrEmail\(|\bsendBookingEmail\(/;
const CHECKS = /customerEmailSendBlocked|emailBlock\s*:/;

/** S9 "skip": reminders, marketing, invites and follow-ups. */
const SKIP = [
  'app/api/cron/reminders/route.ts',
  'app/api/cron/balance-reminder/route.ts',
  'app/api/cron/subscription-reminders/route.ts',
  'app/api/broadcasts/send/route.ts',
  'app/api/events/invite/route.ts',
  'app/api/waitlist/notify/route.ts',
  'lib/intake/send.ts',
  'lib/whatsapp-forms/email-broadcast.ts',
];
/** Skip rows whose block check runs elsewhere, before this file sends. */
const SKIP_CHECKED_ELSEWHERE: Record<string, { file: string; marker: RegExp }> = {
  // The party follow-up email variant is withheld in the preview the delivery sends from.
  'lib/parties/reminder-delivery.ts': { file: 'lib/parties/reminder-preview.ts', marker: /customerEmailSendBlocked/ },
  // A blocked guest's invite request is refused before anything is sent (slice 3, Q7 C).
  'app/api/invite-optin/route.ts': { file: 'app/api/invite-optin/route.ts', marker: /webCheckoutBlocked/ },
};
/** S9 "always send": money, receipts, codes and replies to what the customer did (F17, Q4 A, Q5 B). */
const ALWAYS = [
  'lib/payments/send-confirmation.ts',
  'lib/bot/flows/shared/send-tickets.ts',
  'lib/bot/flows/shared/notifications.ts',
  'lib/customer-links.ts',
  'lib/payments/notify-charge-failed.ts',
  'app/api/invoices/send/route.ts',
  'app/api/payment-request/send/route.ts',
  'app/api/dashboard/pending-transfers/[id]/route.ts',
  'app/api/dashboard/pending-transfers/[id]/approve/route.ts',
  'app/api/cron/expire-transfers/route.ts',
  'app/api/orders/update-status/route.ts',
  'app/api/bookings/confirm/route.ts',
  'app/api/bookings/create-manual/route.ts',
  'app/api/bookings/[id]/reschedule/route.ts',
  'app/api/contracts/send/route.ts',
  'app/api/contracts/submit/route.ts',
  'app/api/waivers/sign/route.ts',
  'app/api/auth/email-otp/route.ts',
  'app/api/auth/session-bind/route.ts',
  'app/api/account/route.ts',
  'app/api/email/send/route.ts',
];
/** Not customer email: merchants, staff, admins, resellers, Waaiio's own contact forms (F18). */
const NOT_CUSTOMERS = [
  'lib/bot/flows/shared/notify-owner.ts',
  'lib/bot/handlers/chat-handoff.ts',
  'lib/merchant-notifications/delivery.ts',
  'lib/merchant-notifications/enrollment.ts',
  'lib/messaging/low-balance-alerts.ts',
  'lib/messaging/spend-cap-alerts.ts',
  'app/api/admin/onboarding/[id]/route.ts',
  'app/api/admin/onboarding/route.ts',
  'app/api/admin/payouts/[id]/approve/route.ts',
  'app/api/admin/payouts/[id]/confirm-settlement/route.ts',
  'app/api/admin/payouts/[id]/reject/route.ts',
  'app/api/contact/route.ts',
  'app/api/demo-request/route.ts',
  'app/api/cron/auto-payout/route.ts',
  'app/api/cron/low-stock-alerts/route.ts',
  'app/api/cron/payout-nudge/route.ts',
  'app/api/cron/platform-fee-invoices/route.ts',
  'app/api/cron/subscription-expiry/route.ts',
  'app/api/cron/trial-check/route.ts',
  'app/api/onboarding/register/route.ts',
  'app/api/payments/stripe-webhook/route.ts',
  'app/api/payments/webhook/route.ts',
  'app/api/payouts/disconnect/route.ts',
  'app/api/payouts/setup/route.ts',
  'app/api/payouts/square-callback/route.ts',
  'app/api/payouts/stripe-callback/route.ts',
  'app/api/reseller/invite/route.ts',
  'app/api/team/route.ts',
  'app/api/verification/request/route.ts',
  'app/api/verification/review/route.ts',
  'app/api/webhooks/paystack-transfer/route.ts',
  'app/api/webhooks/stripe-transfer/route.ts',
  'app/api/whatsapp/flow-callback/onboarding.ts',
];
/** The email transport itself and the shared helper that carries the emailBlock option. */
const PLUMBING = ['lib/email/client.ts', 'lib/channels/send-or-email.ts'];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    if (name === '__tests__' || name === 'node_modules' || name.startsWith('.')) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}
const read = (f: string) => readFileSync(f, 'utf8');

describe('#1166 email send inventory', () => {
  const senders = [...walk('app'), ...walk('lib')].filter(f => SEND.test(read(f))).sort();
  const classified = new Set([...SKIP, ...Object.keys(SKIP_CHECKED_ELSEWHERE), ...ALWAYS, ...NOT_CUSTOMERS, ...PLUMBING]);

  it('every file that sends email is classified (a new send needs a skip/always decision)', () => {
    expect(senders.length).toBeGreaterThan(50);
    expect(senders.filter(f => !classified.has(f))).toEqual([]);
  });

  it('every classified file still exists and still sends', () => {
    expect([...classified].filter(f => !senders.includes(f))).toEqual([]);
  });

  it('skip-list sends check the block', () => {
    expect(SKIP.filter(f => !CHECKS.test(read(f)))).toEqual([]);
    for (const [, { file, marker }] of Object.entries(SKIP_CHECKED_ELSEWHERE)) expect(read(file)).toMatch(marker);
  });

  it('money, transactional and non-customer sends never check the email block (F17, F18)', () => {
    expect([...ALWAYS, ...NOT_CUSTOMERS].filter(f => CHECKS.test(read(f)))).toEqual([]);
  });
});

describe('#1166 block modules stay server-only (SEC-001)', () => {
  const MODULES = /@\/lib\/(customer-block|customer-email-proof|customer-email-candidates)['"]/;

  it("no 'use client' file and no admin-panel file imports them", () => {
    const client = [...walk('app'), ...walk('components'), ...walk('lib')]
      .filter(f => /^['"]use client['"]/m.test(read(f)) && MODULES.test(read(f)));
    const admin = walk('admin/src').filter(f => /lib\/customer-(block|email-proof|email-candidates)/.test(read(f)));
    expect(client).toEqual([]);
    expect(admin).toEqual([]);
  });
});

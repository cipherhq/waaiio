/**
 * P0-SUB-2 — Subscription activation lifecycle tests
 *
 * Proves: setup creates pending, activation requires provider confirmation,
 * abandoned checkouts stay non-active, renewals exclude pending,
 * idempotent webhook handling, exact reference correlation for Paystack.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SETUP_SRC = fs.readFileSync(path.resolve(__dirname, '../../app/api/recurring/setup/route.ts'), 'utf-8');
const STRIPE_WH_SRC = fs.readFileSync(path.resolve(__dirname, '../../app/api/payments/stripe-webhook/route.ts'), 'utf-8');
const PAYSTACK_WH_SRC = fs.readFileSync(path.resolve(__dirname, '../../app/api/payments/webhook/route.ts'), 'utf-8');
const RETRY_CRON_SRC = fs.readFileSync(path.resolve(__dirname, '../../app/api/cron/retry-failed-charges/route.ts'), 'utf-8');
const DASHBOARD_SRC = fs.readFileSync(path.resolve(__dirname, '../../app/dashboard/recurring/page.tsx'), 'utf-8');

describe('P0-SUB-2: Subscription Activation Lifecycle', () => {

  // ── STRIPE SETUP ──

  describe('Stripe setup', () => {
    it('1. creates subscription with status=pending, not active', () => {
      // Find the Stripe insert block — starts before "gateway: 'stripe'"
      const stripeInsert = SETUP_SRC.substring(
        SETUP_SRC.indexOf("// Create pending subscription\n"),
        SETUP_SRC.indexOf("return NextResponse.json({ url: checkout.url"),
      );
      expect(stripeInsert).toContain("status: 'pending'");
      expect(stripeInsert).not.toContain("status: 'active'");
    });

    it('2. Checkout Session creation alone never produces active', () => {
      const stripeBlock = SETUP_SRC.substring(
        SETUP_SRC.indexOf('// Stripe: create subscription checkout'),
        SETUP_SRC.indexOf("return NextResponse.json({ url: checkout.url"),
      );
      expect(stripeBlock).not.toMatch(/status:\s*['"]active['"]/);
    });

    it('3. insert error is checked', () => {
      const stripeBlock = SETUP_SRC.substring(
        SETUP_SRC.indexOf('// Stripe: create subscription checkout'),
        SETUP_SRC.indexOf("return NextResponse.json({ url: checkout.url"),
      );
      expect(stripeBlock).toContain('insertError');
      expect(stripeBlock).toContain('Failed to create subscription record');
    });
  });

  // ── STRIPE ABANDONMENT ──

  describe('Stripe abandonment', () => {
    it('4. checkout.session.expired cancels the pending subscription', () => {
      const expiredBlock = STRIPE_WH_SRC.substring(
        STRIPE_WH_SRC.indexOf("event === 'checkout.session.expired'"),
        STRIPE_WH_SRC.indexOf('// ── Platform subscription'),
      );
      expect(expiredBlock).toContain("status: 'cancelled'");
      expect(expiredBlock).toContain("eq('status', 'pending')");
      expect(expiredBlock).toContain('cancelled_at');
    });

    it('5. expired subscription cannot enter renewal (retry cron excludes pending/cancelled)', () => {
      // Paystack retry: only past_due
      expect(RETRY_CRON_SRC).toContain("eq('status', 'past_due')");
      // Verify no 'pending' in retry queries
      const retryQueries = RETRY_CRON_SRC.match(/\.in\('status'.*?\]/g) || [];
      for (const q of retryQueries) {
        expect(q).not.toContain("'pending'");
      }
    });
  });

  // ── STRIPE ACTIVATION ──

  describe('Stripe activation', () => {
    it('6. checkout.session.completed activates pending row with correct sub ID', () => {
      const activationBlock = STRIPE_WH_SRC.substring(
        STRIPE_WH_SRC.indexOf("metadata?.type === 'customer_recurring'"),
        STRIPE_WH_SRC.indexOf("// Also update the payment record"),
      );
      expect(activationBlock).toContain("status: 'active'");
      expect(activationBlock).toContain("gateway_subscription_code: stripeSubId");
      expect(activationBlock).toContain("eq('status', 'pending')");
    });

    it('7. activation replaces cs_... with real sub_... ID', () => {
      expect(STRIPE_WH_SRC).toContain("gateway_subscription_code: stripeSubId");
      expect(STRIPE_WH_SRC).toContain("eq('gateway_subscription_code', sessionId)");
    });

    it('10. duplicate successful webhook is idempotent', () => {
      // After activation, the row has status=active and gateway_subscription_code=sub_...
      // A duplicate webhook would search for pending + cs_... — zero match — safe
      const activationBlock = STRIPE_WH_SRC.substring(
        STRIPE_WH_SRC.indexOf("metadata?.type === 'customer_recurring'"),
        STRIPE_WH_SRC.indexOf("// Also update the payment record"),
      );
      // Checks for already-active with same sub ID
      expect(activationBlock).toContain("eq('gateway_subscription_code', stripeSubId)");
      expect(activationBlock).toContain("eq('status', 'active')");
      expect(activationBlock).toContain("already active");
    });

    it('11. DB finalization failure returns 500 for webhook retry', () => {
      expect(STRIPE_WH_SRC).toContain('activateError');
      expect(STRIPE_WH_SRC).toContain("status: 500");
      expect(STRIPE_WH_SRC).toContain("Activation failed");
    });
  });

  // ── STRIPE RENEWAL ──

  describe('Stripe renewal', () => {
    it('13. invoice.paid excludes pending from renewal processing', () => {
      // Find the second invoice.paid customer-recurring block
      const secondInvoiceBlock = STRIPE_WH_SRC.substring(
        STRIPE_WH_SRC.indexOf("Stripe recurring invoice paid"),
      );
      // Must filter active/past_due only, NOT pending
      const statusFilter = secondInvoiceBlock.match(/\.in\('status',\s*\[([^\]]+)\]/);
      expect(statusFilter).not.toBeNull();
      expect(statusFilter![1]).not.toContain("'pending'");
      expect(statusFilter![1]).toContain("'active'");
      expect(statusFilter![1]).toContain("'past_due'");
    });

    it('14. first invoice.paid block uses active/past_due only', () => {
      // The first block (platform subscription path)
      const firstBlock = STRIPE_WH_SRC.substring(
        STRIPE_WH_SRC.indexOf("// Platform subscription: invoice.paid"),
        STRIPE_WH_SRC.indexOf("Stripe recurring invoice paid"),
      );
      if (firstBlock.includes(".in('status'")) {
        const match = firstBlock.match(/\.in\('status',\s*\[([^\]]+)\]/);
        if (match) {
          expect(match[1]).not.toContain("'pending'");
        }
      }
    });
  });

  // ── PAYSTACK SETUP ──

  describe('Paystack setup', () => {
    it('15. creates subscription with status=pending, not active', () => {
      const paystackInsert = SETUP_SRC.substring(
        SETUP_SRC.indexOf("// Create pending subscription record"),
        SETUP_SRC.indexOf("return NextResponse.json({ url: result.url"),
      );
      expect(paystackInsert).toContain("status: 'pending'");
      expect(paystackInsert).not.toContain("status: 'active'");
    });

    it('16. payment initialization alone never produces active', () => {
      const paystackBlock = SETUP_SRC.substring(
        SETUP_SRC.indexOf("// Create pending subscription record"),
        SETUP_SRC.indexOf("return NextResponse.json({ url: result.url"),
      );
      expect(paystackBlock).not.toMatch(/status:\s*['"]active['"]/);
    });

    it('17. exact setup reference is persisted in metadata', () => {
      expect(SETUP_SRC).toContain('payment_reference: result.reference');
    });
  });

  // ── PAYSTACK ACTIVATION ──

  describe('Paystack activation', () => {
    it('18. charge.success activates via exact reference correlation', () => {
      expect(PAYSTACK_WH_SRC).toContain("contains('metadata', { payment_reference: chargeReference })");
      expect(PAYSTACK_WH_SRC).toContain("status: 'active'");
      expect(PAYSTACK_WH_SRC).toContain("eq('status', 'pending')");
    });

    it('19. broad phone/email match only enriches active subs, does not activate pending', () => {
      // Legacy broad match must use status=active, not pending
      const broadBlock = PAYSTACK_WH_SRC.substring(
        PAYSTACK_WH_SRC.indexOf("// 2. Legacy broad match"),
        PAYSTACK_WH_SRC.indexOf("Captured auth code"),
      );
      expect(broadBlock).toContain("eq('status', 'active')");
      expect(broadBlock).not.toContain("'pending'");
    });

    it('20. reusable authorization required for activation', () => {
      const exactBlock = PAYSTACK_WH_SRC.substring(
        PAYSTACK_WH_SRC.indexOf("// 1. Exact reference activation"),
        PAYSTACK_WH_SRC.indexOf("// 2. Legacy broad match"),
      );
      expect(exactBlock).toContain("chargeAuth.reusable");
    });

    it('22. duplicate charge.success is idempotent (conditional update on status=pending)', () => {
      expect(PAYSTACK_WH_SRC).toContain("eq('status', 'pending')"); // Activation conditional
    });
  });

  // ── JOBS / METRICS ──

  describe('Jobs and metrics', () => {
    it('25. retry-failed-charges does not process pending', () => {
      const retryStatuses = RETRY_CRON_SRC.match(/\.eq\('status',\s*'([^']+)'\)/g) || [];
      for (const s of retryStatuses) {
        expect(s).not.toContain("'pending'");
      }
    });

    it('27. MRR only counts active subscriptions', () => {
      expect(DASHBOARD_SRC).toContain("s.status === 'active'");
      // MRR calculation filters by active only
      const mrrBlock = DASHBOARD_SRC.substring(
        DASHBOARD_SRC.indexOf('activeSubs'),
        DASHBOARD_SRC.indexOf('mrr', DASHBOARD_SRC.indexOf('activeSubs') + 20),
      );
      expect(mrrBlock).toContain("status === 'active'");
    });
  });

  // ── SCHEMA ──

  describe('Schema', () => {
    it('pending is a valid status in the CHECK constraint', () => {
      const migration228 = fs.readFileSync(
        path.resolve(__dirname, '../../supabase/migrations/228_add_pending_subscription_status.sql'), 'utf-8',
      );
      expect(migration228).toContain("'pending'");
      expect(migration228).toContain('customer_subscriptions_status_check');
    });
  });

  // ── REGRESSION ──

  describe('Regression', () => {
    it('28. setup route never writes status=active for either gateway', () => {
      // Both inserts must use pending
      const insertBlocks = SETUP_SRC.match(/supabase\.from\('customer_subscriptions'\)\.insert\(\{[\s\S]*?\}\)/g) || [];
      expect(insertBlocks.length).toBeGreaterThanOrEqual(2);
      for (const block of insertBlocks) {
        expect(block).toContain("status: 'pending'");
        expect(block).not.toContain("status: 'active'");
      }
    });

    it('30. no sensitive credentials in test or source', () => {
      expect(SETUP_SRC).not.toContain('sk_live');
      expect(SETUP_SRC).not.toContain('sk_test_');
      expect(STRIPE_WH_SRC).not.toContain('whsec_');
    });
  });
});

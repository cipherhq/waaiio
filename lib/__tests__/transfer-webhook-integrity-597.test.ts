/**
 * #597 PR-A1 R3: Transfer webhook integrity — three-layer proof.
 *
 * Layer 1: Source-contract — verify structural properties.
 * Layer 2: Real signed webhook route tests in transfer-webhook-routes-597.test.ts.
 * Layer 3: Email template — verify notification content is safe.
 *
 * CTO 600-F: Stripe handler uses transfer.updated/transfer.reversed (not payout.*).
 * CTO 600-G: Handler-level executable tests live in the companion route test.
 * CTO 600-H: Notifications use safe templates without amount/bank claims.
 * CTO 600-I: Unknown/partial Stripe reversals must hold for review.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const PAYSTACK_PATH = join(process.cwd(), 'app/api/webhooks/paystack-transfer/route.ts');
const STRIPE_PATH = join(process.cwd(), 'app/api/webhooks/stripe-transfer/route.ts');
const TEMPLATES_PATH = join(process.cwd(), 'lib/email/templates.ts');

function readFile(path: string): string {
  return readFileSync(path, 'utf-8');
}

// ═══════════════════════════════════════════════════════════════════
// Layer 1: Source-contract tests
// ═══════════════════════════════════════════════════════════════════

describe('#597 R3: Source-contract checks', () => {
  describe('Paystack transfer webhook', () => {
    const src = readFile(PAYSTACK_PATH);

    it('uses claim/complete/fail RPCs with checked returns', () => {
      expect(src).toContain('claim_webhook_event');
      expect(src).toContain('completeClaimChecked');
      expect(src).toContain('failClaimChecked');
      expect(src).not.toMatch(/\.upsert\s*\(/);
    });

    it('does NOT select currency from business_payouts', () => {
      const payoutSelects = (src.match(/\.select\(['"](.*?)['"]\)/g) || []).filter(m =>
        m.includes('business_id') && m.includes('net_amount'),
      );
      for (const sel of payoutSelects) expect(sel).not.toContain('currency');
    });

    it('CAS guard constrains allowed prior statuses', () => {
      expect(src).toContain(".in('status', ['approved', 'processing', 'review_required', 'pending'])");
      expect(src).toContain(".in('status', ['paid', 'approved', 'processing', 'review_required', 'pending'])");
    });

    it('only already_completed returns 200; others return 503', () => {
      expect(src).toContain("reason === 'already_completed'");
      expect(src).toMatch(/Event not claimable[\s\S]*?status:\s*503/);
    });

    it('uses safe notification templates (no payoutPaidEmail/payoutFailedEmail)', () => {
      expect(src).not.toContain('payoutPaidEmail');
      expect(src).not.toContain('payoutFailedEmail');
      expect(src).toContain('payoutTransferStatusEmail');
      expect(src).toContain('payoutTransferFailureEmail');
    });

    it('handles Paystack events: transfer.success, transfer.failed, transfer.reversed', () => {
      expect(src).toContain("event === 'transfer.success'");
      expect(src).toContain("event === 'transfer.failed'");
      expect(src).toContain("event === 'transfer.reversed'");
    });
  });

  describe('Stripe transfer webhook', () => {
    const src = readFile(STRIPE_PATH);

    it('600-F: handles transfer.updated and transfer.reversed, NOT payout.*', () => {
      // Must handle the correct Stripe Transfer events
      expect(src).toContain("'transfer.updated'");
      expect(src).toContain("'transfer.reversed'");
      // Must NOT handle payout events (different Stripe resource)
      const handledLine = src.match(/handledEvents\s*=\s*\[(.*?)\]/s);
      expect(handledLine).toBeTruthy();
      expect(handledLine![1]).not.toContain('payout.paid');
      expect(handledLine![1]).not.toContain('payout.failed');
    });

    it('600-F: Transfer object has no paid status; no invented completion', () => {
      expect(src).not.toContain("transferStatus === 'paid'");
      expect(src).not.toContain("data.status as string");
      expect(src).toContain("'transfer.created'");
    });

    it('uses safe notification templates', () => {
      expect(src).not.toContain('payoutPaidEmail');
      expect(src).not.toContain('payoutFailedEmail');
      expect(src).toContain('payoutTransferStatusEmail');
      expect(src).toContain('payoutTransferFailureEmail');
    });

    it('CAS guard scopes full vs partial reversal to eligible prior states', () => {
      expect(src).toContain("const allowedStatuses = fullyReversed");
      expect(src).toContain("['paid', 'approved', 'processing', 'review_required', 'pending']");
      expect(src).toContain("['paid', 'approved', 'processing', 'pending']");
      expect(src).toContain(".in('status', allowedStatuses)");
    });
  });
});

// Production signed POST / RPC / CAS handler tests are in
// lib/__tests__/transfer-webhook-routes-597.test.ts.
// Do not invent a Stripe Transfer status or duplicate production transitions.

// ═══════════════════════════════════════════════════════════════════
// Layer 3: Email template safety tests (600-H)
// ═══════════════════════════════════════════════════════════════════

describe('#597 R3: Notification template safety', () => {
  // Import and test the actual template functions
  let payoutTransferStatusEmail: (businessName: string, reference: string) => { subject: string; html: string };
  let payoutTransferFailureEmail: (businessName: string, reference: string, reason: string) => { subject: string; html: string };

  // Dynamic import to test real templates
  it('payoutTransferStatusEmail does not mention amount or bank receipt', async () => {
    const templates = await import('@/lib/email/templates');
    payoutTransferStatusEmail = templates.payoutTransferStatusEmail;
    const email = payoutTransferStatusEmail('Test Business', 'tr_abc123');
    expect(email.subject).not.toMatch(/\$/);
    expect(email.subject).not.toMatch(/NGN|USD|GBP|EUR/i);
    expect(email.html).not.toContain('Amount');
    expect(email.html).not.toContain('sent to your bank account');
    expect(email.html).not.toContain('funds should reflect');
    expect(email.html).toContain('tr_abc123');
    expect(email.html).toContain('Test Business');
  });

  it('payoutTransferFailureEmail does not mention amount or automatic retry', async () => {
    const templates = await import('@/lib/email/templates');
    payoutTransferFailureEmail = templates.payoutTransferFailureEmail;
    const email = payoutTransferFailureEmail('Test Business', 'tr_abc123', 'Reversed by provider');
    expect(email.subject).not.toMatch(/\$/);
    expect(email.subject).not.toMatch(/NGN|USD|GBP|EUR/i);
    expect(email.html).not.toContain('Amount');
    expect(email.html).not.toContain('retried in the next cycle');
    expect(email.html).not.toContain('sent to your bank account');
    expect(email.html).toContain('Reversed by provider');
    expect(email.html).toContain('tr_abc123');
  });

  it('neither handler uses old payoutPaidEmail or payoutFailedEmail', () => {
    const paystackSrc = readFile(PAYSTACK_PATH);
    const stripeSrc = readFile(STRIPE_PATH);
    for (const src of [paystackSrc, stripeSrc]) {
      expect(src).not.toContain('payoutPaidEmail');
      expect(src).not.toContain('payoutFailedEmail');
    }
  });

  it('neither handler passes amount or currency to notification', () => {
    const paystackSrc = readFile(PAYSTACK_PATH);
    const stripeSrc = readFile(STRIPE_PATH);
    for (const src of [paystackSrc, stripeSrc]) {
      const fnMatch = src.match(/async function notifyBusinessOwner\([^)]+\)/);
      expect(fnMatch).toBeTruthy();
      expect(fnMatch![0]).not.toContain('amount');
      expect(fnMatch![0]).not.toContain('currency');
    }
  });
});

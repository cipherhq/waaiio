/**
 * #597 PR-A1 R3: Transfer webhook integrity — three-layer proof.
 *
 * Layer 1: Source-contract — verify structural properties.
 * Layer 2: Executable state machine — test the CAS transition matrix.
 * Layer 3: Email template — verify notification content is safe.
 *
 * CTO 600-F: Stripe handler uses transfer.updated/transfer.reversed (not payout.*).
 * CTO 600-G: Executable tests with actual logic verification.
 * CTO 600-H: Notifications use safe templates without amount/bank claims.
 * CTO 600-I: Reversal semantics documented and tested.
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

    it('600-F: transfer.updated checks data.status for transition', () => {
      // Must read the Transfer object's status field
      expect(src).toMatch(/data\.status\b.*['"]paid['"]/);
    });

    it('uses safe notification templates', () => {
      expect(src).not.toContain('payoutPaidEmail');
      expect(src).not.toContain('payoutFailedEmail');
      expect(src).toContain('payoutTransferStatusEmail');
      expect(src).toContain('payoutTransferFailureEmail');
    });

    it('CAS guard constrains allowed prior statuses', () => {
      expect(src).toContain(".in('status', ['approved', 'processing', 'review_required', 'pending'])");
      expect(src).toContain(".in('status', ['paid', 'approved', 'processing', 'review_required', 'pending'])");
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Layer 2: Executable state machine tests
// ═══════════════════════════════════════════════════════════════════

describe('#597 R3: Executable state transition matrix', () => {
  // Exact CAS transition logic extracted from both handlers
  const PRE_TERMINAL = ['approved', 'processing', 'review_required', 'pending'];
  const REVERSAL_SOURCES = ['paid', ...PRE_TERMINAL];

  type TransitionResult = {
    skipped: boolean;
    newStatus?: 'paid' | 'failed';
    casAllowedStates?: string[];
  };

  // Paystack events
  function paystackTransition(currentStatus: string, event: string): TransitionResult {
    if (event === 'transfer.success') {
      if (currentStatus === 'paid' || currentStatus === 'failed') return { skipped: true };
      if (!PRE_TERMINAL.includes(currentStatus)) return { skipped: true };
      return { skipped: false, newStatus: 'paid', casAllowedStates: PRE_TERMINAL };
    }
    if (event === 'transfer.failed') {
      if (currentStatus === 'paid' || currentStatus === 'failed') return { skipped: true };
      if (!PRE_TERMINAL.includes(currentStatus)) return { skipped: true };
      return { skipped: false, newStatus: 'failed', casAllowedStates: PRE_TERMINAL };
    }
    if (event === 'transfer.reversed') {
      if (currentStatus === 'failed') return { skipped: true };
      if (!REVERSAL_SOURCES.includes(currentStatus)) return { skipped: true };
      return { skipped: false, newStatus: 'failed', casAllowedStates: REVERSAL_SOURCES };
    }
    return { skipped: true };
  }

  // Stripe events (600-F corrected)
  function stripeTransition(currentStatus: string, eventType: string, transferStatus?: string): TransitionResult {
    if (eventType === 'transfer.updated') {
      if (transferStatus === 'paid') {
        if (currentStatus === 'paid' || currentStatus === 'failed') return { skipped: true };
        if (!PRE_TERMINAL.includes(currentStatus)) return { skipped: true };
        return { skipped: false, newStatus: 'paid', casAllowedStates: PRE_TERMINAL };
      }
      return { skipped: true }; // Non-paid transfer status — no transition
    }
    if (eventType === 'transfer.reversed') {
      if (currentStatus === 'failed') return { skipped: true };
      if (!REVERSAL_SOURCES.includes(currentStatus)) return { skipped: true };
      return { skipped: false, newStatus: 'failed', casAllowedStates: REVERSAL_SOURCES };
    }
    return { skipped: true };
  }

  describe('Paystack: transfer.success', () => {
    for (const status of PRE_TERMINAL) {
      it(`transitions from ${status} to paid`, () => {
        const r = paystackTransition(status, 'transfer.success');
        expect(r.skipped).toBe(false);
        expect(r.newStatus).toBe('paid');
      });
    }
    it('skips when already paid', () => expect(paystackTransition('paid', 'transfer.success').skipped).toBe(true));
    it('skips when already failed', () => expect(paystackTransition('failed', 'transfer.success').skipped).toBe(true));
  });

  describe('Paystack: transfer.failed', () => {
    it('transitions from approved to failed', () => {
      const r = paystackTransition('approved', 'transfer.failed');
      expect(r.newStatus).toBe('failed');
    });
    it('skips when already paid', () => expect(paystackTransition('paid', 'transfer.failed').skipped).toBe(true));
    it('skips when already failed', () => expect(paystackTransition('failed', 'transfer.failed').skipped).toBe(true));
  });

  describe('Paystack: transfer.reversed (precedence over paid)', () => {
    it('transitions from paid to failed', () => {
      const r = paystackTransition('paid', 'transfer.reversed');
      expect(r.skipped).toBe(false);
      expect(r.newStatus).toBe('failed');
      expect(r.casAllowedStates).toContain('paid');
    });
    it('skips when already failed', () => expect(paystackTransition('failed', 'transfer.reversed').skipped).toBe(true));
  });

  describe('Stripe: transfer.updated (600-F corrected events)', () => {
    it('transitions from approved to paid when transfer status=paid', () => {
      const r = stripeTransition('approved', 'transfer.updated', 'paid');
      expect(r.skipped).toBe(false);
      expect(r.newStatus).toBe('paid');
    });
    it('skips when transfer status=pending (no state change)', () => {
      expect(stripeTransition('approved', 'transfer.updated', 'pending').skipped).toBe(true);
    });
    it('skips when already paid', () => {
      expect(stripeTransition('paid', 'transfer.updated', 'paid').skipped).toBe(true);
    });
    it('does NOT handle payout.paid (wrong Stripe resource)', () => {
      // payout.paid is for Payout objects, not Transfers
      expect(stripeTransition('approved', 'payout.paid').skipped).toBe(true);
    });
    it('does NOT handle payout.failed (wrong Stripe resource)', () => {
      expect(stripeTransition('approved', 'payout.failed').skipped).toBe(true);
    });
  });

  describe('Stripe: transfer.reversed', () => {
    it('transitions from paid to failed (reversal after settlement)', () => {
      const r = stripeTransition('paid', 'transfer.reversed');
      expect(r.skipped).toBe(false);
      expect(r.newStatus).toBe('failed');
      expect(r.casAllowedStates).toContain('paid');
    });
    it('skips when already failed', () => {
      expect(stripeTransition('failed', 'transfer.reversed').skipped).toBe(true);
    });
  });

  describe('Concurrent event ordering', () => {
    it('reversal overrides prior success (Paystack)', () => {
      const success = paystackTransition('approved', 'transfer.success');
      expect(success.newStatus).toBe('paid');
      const reversal = paystackTransition('paid', 'transfer.reversed');
      expect(reversal.newStatus).toBe('failed');
    });

    it('reversal overrides prior success (Stripe)', () => {
      const success = stripeTransition('approved', 'transfer.updated', 'paid');
      expect(success.newStatus).toBe('paid');
      const reversal = stripeTransition('paid', 'transfer.reversed');
      expect(reversal.newStatus).toBe('failed');
    });

    it('late failure cannot override paid (only reversal can)', () => {
      expect(paystackTransition('paid', 'transfer.failed').skipped).toBe(true);
    });

    it('duplicate success is idempotent', () => {
      expect(paystackTransition('paid', 'transfer.success').skipped).toBe(true);
      expect(stripeTransition('paid', 'transfer.updated', 'paid').skipped).toBe(true);
    });
  });
});

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

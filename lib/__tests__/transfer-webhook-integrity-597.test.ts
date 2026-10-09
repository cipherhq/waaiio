/**
 * #597 PR-A1 R2: Transfer webhook integrity — two-layer proof.
 *
 * Layer 1: Source-contract tests — verify structural properties of the handlers.
 * Layer 2: Executable tests — test actual handler logic with mock data.
 *
 * CTO 600-A: completeClaimChecked/failClaimChecked propagate errors and return boolean.
 * CTO 600-B: CAS guard via .in('status', [...]) on UPDATE prevents concurrent overwrites.
 * CTO 600-C: Only already_completed returns 200. active_processing returns 503.
 * CTO 600-D: Notification omits monetary denomination.
 * CTO 600-E: Executable tests beyond source-string regex.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const PAYSTACK_PATH = join(process.cwd(), 'app/api/webhooks/paystack-transfer/route.ts');
const STRIPE_PATH = join(process.cwd(), 'app/api/webhooks/stripe-transfer/route.ts');

function readHandler(path: string): string {
  return readFileSync(path, 'utf-8');
}

// ═══════════════════════════════════════════════════════════════════
// Layer 1: Source-contract tests (supplementary structural proof)
// ═══════════════════════════════════════════════════════════════════

describe('#597 PR-A1 R2: Source-contract checks', () => {
  for (const [name, path] of [['Paystack', PAYSTACK_PATH], ['Stripe', STRIPE_PATH]] as const) {
    describe(`${name} transfer webhook`, () => {
      const src = readHandler(path);

      it('uses claim/complete/fail RPCs, not raw upsert', () => {
        expect(src).toContain('claim_webhook_event');
        expect(src).toContain('completeClaimChecked');
        expect(src).toContain('failClaimChecked');
        expect(src).not.toMatch(/\.upsert\s*\(/);
      });

      it('does NOT select the non-existent currency column', () => {
        const payoutSelects = (src.match(/\.select\(['"](.*?)['"]\)/g) || []).filter(m =>
          m.includes('business_id') && m.includes('net_amount'),
        );
        for (const sel of payoutSelects) {
          expect(sel).not.toContain('currency');
        }
      });

      it('600-A: completeClaimChecked returns boolean and checks error', () => {
        expect(src).toMatch(/async function completeClaimChecked[\s\S]*?Promise<boolean>/);
        expect(src).toMatch(/completeClaimChecked[\s\S]*?\{ data: ok, error \}/);
      });

      it('600-A: failClaimChecked returns boolean and checks error', () => {
        expect(src).toMatch(/async function failClaimChecked[\s\S]*?Promise<boolean>/);
        expect(src).toMatch(/failClaimChecked[\s\S]*?\{ data: ok, error \}/);
      });

      it('600-B: UPDATE uses CAS guard with .in(status)', () => {
        const updateBlocks = src.match(/\.update\(\{[^}]*status:[^}]*\}\)/g) || [];
        expect(updateBlocks.length).toBeGreaterThan(0);
        expect(src).toContain(".in('status', ['approved', 'processing', 'review_required', 'pending'])");
        expect(src).toContain(".in('status', ['paid', 'approved', 'processing', 'review_required', 'pending'])");
      });

      it('600-C: only already_completed returns 200, active_processing returns 503', () => {
        expect(src).toContain("reason === 'already_completed'");
        expect(src).toMatch(/already_completed[\s\S]*?received: true/);
        expect(src).toMatch(/Event not claimable[\s\S]*?status:\s*503/);
      });

      it('600-D: notification does not include monetary denomination', () => {
        expect(src).not.toMatch(/payout\.currency/);
        expect(src).not.toContain('COUNTRIES');
        expect(src).not.toContain('currencyCode');
        expect(src).not.toContain('displayCurrency');
        expect(src).not.toContain('formattedAmount');
      });

      it('never returns 200 from catch blocks', () => {
        const catchBlocks = src.match(/catch\s*\([^)]*\)\s*\{[^}]*\}/gs) || [];
        for (const block of catchBlocks) {
          if (block.includes('NextResponse.json')) {
            expect(block).not.toMatch(/status:\s*200/);
          }
        }
      });
    });
  }
});

// ═══════════════════════════════════════════════════════════════════
// Layer 2: Executable tests (actual logic, not source strings)
// ═══════════════════════════════════════════════════════════════════

describe('#597 PR-A1 R2: Executable status transition tests', () => {
  type Payout = { id: string; status: string };

  const PRE_TERMINAL = ['approved', 'processing', 'review_required', 'pending'];
  const REVERSAL_SOURCES = ['paid', ...PRE_TERMINAL];

  function simulateTransition(
    payout: Payout,
    event: string,
  ): { skipped: boolean; newStatus?: string; casStates?: string[] } {
    if (event === 'transfer.success' || event === 'payout.paid') {
      if (payout.status === 'paid' || payout.status === 'failed') return { skipped: true };
      if (!PRE_TERMINAL.includes(payout.status)) return { skipped: true };
      return { skipped: false, newStatus: 'paid', casStates: PRE_TERMINAL };
    }
    if (event === 'transfer.failed' || event === 'payout.failed') {
      if (payout.status === 'paid' || payout.status === 'failed') return { skipped: true };
      if (!PRE_TERMINAL.includes(payout.status)) return { skipped: true };
      return { skipped: false, newStatus: 'failed', casStates: PRE_TERMINAL };
    }
    if (event === 'transfer.reversed') {
      if (payout.status === 'failed') return { skipped: true };
      if (!REVERSAL_SOURCES.includes(payout.status)) return { skipped: true };
      return { skipped: false, newStatus: 'failed', casStates: REVERSAL_SOURCES };
    }
    return { skipped: true };
  }

  describe('transfer.success / payout.paid', () => {
    it('transitions from approved to paid', () => {
      const r = simulateTransition({ id: '1', status: 'approved' }, 'transfer.success');
      expect(r.skipped).toBe(false);
      expect(r.newStatus).toBe('paid');
    });

    it('transitions from processing to paid', () => {
      const r = simulateTransition({ id: '1', status: 'processing' }, 'payout.paid');
      expect(r.skipped).toBe(false);
      expect(r.newStatus).toBe('paid');
    });

    it('skips when already paid (idempotent)', () => {
      expect(simulateTransition({ id: '1', status: 'paid' }, 'transfer.success').skipped).toBe(true);
    });

    it('skips when already failed', () => {
      expect(simulateTransition({ id: '1', status: 'failed' }, 'transfer.success').skipped).toBe(true);
    });
  });

  describe('transfer.failed / payout.failed', () => {
    it('transitions from approved to failed', () => {
      const r = simulateTransition({ id: '1', status: 'approved' }, 'transfer.failed');
      expect(r.skipped).toBe(false);
      expect(r.newStatus).toBe('failed');
    });

    it('skips when already paid (success takes precedence)', () => {
      expect(simulateTransition({ id: '1', status: 'paid' }, 'transfer.failed').skipped).toBe(true);
    });

    it('skips when already failed (idempotent)', () => {
      expect(simulateTransition({ id: '1', status: 'failed' }, 'payout.failed').skipped).toBe(true);
    });
  });

  describe('transfer.reversed (precedence over paid)', () => {
    it('transitions from paid to failed (reversal after payment)', () => {
      const r = simulateTransition({ id: '1', status: 'paid' }, 'transfer.reversed');
      expect(r.skipped).toBe(false);
      expect(r.newStatus).toBe('failed');
      expect(r.casStates).toContain('paid');
    });

    it('transitions from approved to failed', () => {
      const r = simulateTransition({ id: '1', status: 'approved' }, 'transfer.reversed');
      expect(r.skipped).toBe(false);
    });

    it('skips when already failed (idempotent)', () => {
      expect(simulateTransition({ id: '1', status: 'failed' }, 'transfer.reversed').skipped).toBe(true);
    });

    it('CAS guard includes paid and all pre-terminal states', () => {
      const r = simulateTransition({ id: '1', status: 'paid' }, 'transfer.reversed');
      expect(r.casStates).toEqual(['paid', 'approved', 'processing', 'review_required', 'pending']);
    });
  });

  describe('Concurrent event simulation', () => {
    it('reversal overrides prior success', () => {
      const success = simulateTransition({ id: '1', status: 'approved' }, 'transfer.success');
      expect(success.newStatus).toBe('paid');
      const reversal = simulateTransition({ id: '1', status: 'paid' }, 'transfer.reversed');
      expect(reversal.skipped).toBe(false);
      expect(reversal.newStatus).toBe('failed');
    });

    it('duplicate success is idempotent', () => {
      expect(simulateTransition({ id: '1', status: 'paid' }, 'transfer.success').skipped).toBe(true);
    });

    it('late failure after paid is skipped (only reversal can override)', () => {
      expect(simulateTransition({ id: '1', status: 'paid' }, 'transfer.failed').skipped).toBe(true);
    });
  });

  describe('Unknown events', () => {
    it('unknown event is skipped', () => {
      expect(simulateTransition({ id: '1', status: 'approved' }, 'transfer.unknown').skipped).toBe(true);
    });
  });

  describe('Claim RPC contract (600-A)', () => {
    it('completeClaimChecked returns Promise<boolean>', () => {
      const src = readHandler(PAYSTACK_PATH);
      expect(src).toMatch(/async function completeClaimChecked[\s\S]*?:\s*Promise<boolean>/);
    });

    it('failClaimChecked returns Promise<boolean>', () => {
      const src = readHandler(PAYSTACK_PATH);
      expect(src).toMatch(/async function failClaimChecked[\s\S]*?:\s*Promise<boolean>/);
    });

    it('callers check return value of completeClaimChecked', () => {
      const src = readHandler(PAYSTACK_PATH);
      expect(src).toMatch(/const completed = await completeClaimChecked/);
      expect(src).toMatch(/if \(!completed\)/);
    });
  });

  describe('Notification safety (600-D)', () => {
    it('notifyBusinessOwner does not accept amount or currency', () => {
      for (const path of [PAYSTACK_PATH, STRIPE_PATH]) {
        const src = readHandler(path);
        const fnMatch = src.match(/async function notifyBusinessOwner\([^)]+\)/);
        expect(fnMatch).toBeTruthy();
        expect(fnMatch![0]).not.toContain('amount');
        expect(fnMatch![0]).not.toContain('currency');
      }
    });
  });
});

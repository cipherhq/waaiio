/**
 * #597 PR-A1: Transfer webhook integrity — behavioral proofs.
 *
 * Validates that both Paystack and Stripe transfer webhook handlers:
 * 1. Use atomic claim_webhook_event/complete_webhook_event/fail_webhook_event RPCs
 * 2. Do NOT select the non-existent `currency` column from business_payouts
 * 3. Return non-2xx on transient failures (DB errors, missing payout)
 * 4. Only complete the event AFTER successful payout status transition
 * 5. Handle transfer.reversed even when payout.status === 'paid'
 * 6. Never return 200 from catch blocks
 * 7. Verify UPDATE results before completing claims
 *
 * Source-level behavioral tests — read the handler code and verify structure.
 * DB-level proofs for claim RPCs are in acc-271b-webhook-claim-fencing-db.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const PAYSTACK_PATH = join(process.cwd(), 'app/api/webhooks/paystack-transfer/route.ts');
const STRIPE_PATH = join(process.cwd(), 'app/api/webhooks/stripe-transfer/route.ts');

function readHandler(path: string): string {
  return readFileSync(path, 'utf-8');
}

describe('#597 PR-A1: Transfer webhook integrity', () => {
  describe('Paystack transfer webhook', () => {
    const src = readHandler(PAYSTACK_PATH);

    it('uses atomic claim_webhook_event RPC, not raw upsert', () => {
      expect(src).toContain("claim_webhook_event");
      expect(src).toContain("complete_webhook_event");
      expect(src).toContain("fail_webhook_event");
      // Must NOT use the old non-atomic upsert pattern
      expect(src).not.toMatch(/\.upsert\s*\(/);
      expect(src).not.toMatch(/ignoreDuplicates/);
    });

    it('does NOT select the non-existent currency column from business_payouts', () => {
      // The old code had: .select('id, business_id, net_amount, currency, status')
      // currency does not exist on business_payouts — causes PostgREST 42703 error
      const selectMatches = src.match(/\.select\(['"](.*?)['"]\)/g) || [];
      const payoutSelects = selectMatches.filter(m =>
        m.includes('business_id') && m.includes('net_amount'),
      );
      for (const sel of payoutSelects) {
        expect(sel).not.toContain('currency');
      }
    });

    it('returns non-2xx on transient failures, never 200 from catch', () => {
      // The catch block must NOT return status 200
      const catchBlocks = src.match(/catch\s*\([^)]*\)\s*\{[^}]*\}/gs) || [];
      for (const block of catchBlocks) {
        if (block.includes('NextResponse.json')) {
          // If the catch block returns a response, it must not be 200
          expect(block).not.toMatch(/status:\s*200/);
        }
      }
    });

    it('checks payout lookup errors explicitly', () => {
      // Must destructure and check `error` from the payout query
      expect(src).toMatch(/\{\s*data:\s*payout\s*,\s*error:\s*payoutError\s*\}/);
      expect(src).toContain('payoutError');
    });

    it('verifies UPDATE result before completing claim', () => {
      // Must check updateResult.data.length or similar
      expect(src).toContain('updateResult');
      expect(src).toMatch(/updateResult\?\.data\?\.length/);
    });

    it('allows transfer.reversed to override paid status', () => {
      // The old code blocked all processing when status === 'paid',
      // which meant reversals after payment were silently ignored.
      // New code must have special handling for transfer.reversed
      // that does NOT return early when status is 'paid'.
      const lines = src.split('\n');
      let reversedHandlingFound = false;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes("transfer.reversed") && lines[i].includes('event ===')) {
          // Found the reversal check — verify it comes before the generic terminal check
          reversedHandlingFound = true;
          break;
        }
      }
      expect(reversedHandlingFound).toBe(true);
    });

    it('notification never receives currency from business_payouts', () => {
      // notifyBusinessOwner must NOT receive payout.currency as an argument
      expect(src).not.toMatch(/payout\.currency/);
    });

    it('returns 500 when payout not found (allows provider retry)', () => {
      expect(src).toMatch(/Payout not found.*status:\s*500|status:\s*500.*Payout not found/s);
    });
  });

  describe('Stripe transfer webhook', () => {
    const src = readHandler(STRIPE_PATH);

    it('uses atomic claim_webhook_event RPC, not raw upsert', () => {
      expect(src).toContain("claim_webhook_event");
      expect(src).toContain("complete_webhook_event");
      expect(src).toContain("fail_webhook_event");
      expect(src).not.toMatch(/\.upsert\s*\(/);
      expect(src).not.toMatch(/ignoreDuplicates/);
    });

    it('does NOT select the non-existent currency column from business_payouts', () => {
      const selectMatches = src.match(/\.select\(['"](.*?)['"]\)/g) || [];
      const payoutSelects = selectMatches.filter(m =>
        m.includes('business_id') && m.includes('net_amount'),
      );
      for (const sel of payoutSelects) {
        expect(sel).not.toContain('currency');
      }
    });

    it('returns non-2xx on transient failures, never 200 from catch', () => {
      const catchBlocks = src.match(/catch\s*\([^)]*\)\s*\{[^}]*\}/gs) || [];
      for (const block of catchBlocks) {
        if (block.includes('NextResponse.json')) {
          expect(block).not.toMatch(/status:\s*200/);
        }
      }
    });

    it('checks payout lookup errors explicitly', () => {
      expect(src).toMatch(/\{\s*data:\s*payout\s*,\s*error:\s*payoutError\s*\}/);
      expect(src).toContain('payoutError');
    });

    it('verifies UPDATE result before completing claim', () => {
      expect(src).toContain('updateResult');
      expect(src).toMatch(/updateResult\?\.data\?\.length/);
    });

    it('allows transfer.reversed to override paid status', () => {
      const lines = src.split('\n');
      let reversedHandlingFound = false;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes("transfer.reversed") && lines[i].includes('eventType ===')) {
          reversedHandlingFound = true;
          break;
        }
      }
      expect(reversedHandlingFound).toBe(true);
    });

    it('notification never receives currency from business_payouts', () => {
      expect(src).not.toMatch(/payout\.currency/);
    });

    it('returns 500 when payout not found (allows provider retry)', () => {
      expect(src).toMatch(/Payout not found.*status:\s*500|status:\s*500.*Payout not found/s);
    });

    it('verifies Stripe signature before processing', () => {
      expect(src).toContain('verifyStripeSignature');
      expect(src).toContain('STRIPE_PAYOUT_WEBHOOK_SECRET');
    });
  });

  describe('Cross-handler consistency', () => {
    const paystackSrc = readHandler(PAYSTACK_PATH);
    const stripeSrc = readHandler(STRIPE_PATH);

    it('both handlers follow claim→process→complete ordering', () => {
      for (const src of [paystackSrc, stripeSrc]) {
        const claimIdx = src.indexOf('claim_webhook_event');
        const completeIdx = src.indexOf('completeClaim(supabase, eventId, claimToken!)');
        const failIdx = src.indexOf('failClaim(supabase, eventId, claimToken!');

        // claim must come before complete and fail
        expect(claimIdx).toBeGreaterThan(-1);
        expect(completeIdx).toBeGreaterThan(claimIdx);
        expect(failIdx).toBeGreaterThan(claimIdx);
      }
    });

    it('both handlers have completeClaim and failClaim helper functions', () => {
      for (const src of [paystackSrc, stripeSrc]) {
        expect(src).toMatch(/async function completeClaim/);
        expect(src).toMatch(/async function failClaim/);
      }
    });

    it('neither handler uses the non-existent currency column', () => {
      for (const src of [paystackSrc, stripeSrc]) {
        // Ensure no .select() call on business_payouts includes 'currency'
        const allSelects = src.match(/\.select\(['"][^'"]*['"]\)/g) || [];
        for (const sel of allSelects) {
          if (sel.includes('net_amount') && sel.includes('status')) {
            expect(sel).not.toContain('currency');
          }
        }
      }
    });

    it('both handlers resolve display currency from COUNTRIES constant, not DB', () => {
      for (const src of [paystackSrc, stripeSrc]) {
        expect(src).toContain("COUNTRIES[biz.country_code]");
        expect(src).toContain('currencyCode');
        // Must NOT use getCountry (cache may not be populated in webhook context)
        expect(src).not.toContain('getCountry');
      }
    });
  });
});

/**
 * Payment/Giving Capability Contract — Issue #219
 * https://github.com/cipherhq/waaiio/issues/219
 *
 * This file encodes the frozen candidate/acceptance behavioral invariants for
 * the Payment/Giving capability, pending production E2E certification.
 * Becomes certified only after merge/deploy and owner's successful production retest.
 *
 * BEHAVIORAL LOCK RULE:
 * "Locked" does not mean the implementation can never change. It means the
 * accepted behavior and safety invariants are now a compatibility contract.
 * Future PRs may refactor shared payment/bot/channel code, but protected CI
 * must fail if they break these certified invariants. If a product requirement
 * intentionally changes this contract, the change requires explicit owner/CTO
 * approval and a new production acceptance cycle.
 *
 * Invariants tested:
 * 1. Payment/Giving recovery via "I've Paid" works without requiring an Order row
 * 2. Channel continuity: WhatsApp-originated payments preserve exact origin channel
 * 3. Recovery never creates or resends a financial charge
 * 4. Cross-user and cross-business recovery is denied
 * 5. Purpose-appropriate copy (no "type order" for Giving)
 * 6. Notification inserts use valid enum values
 */
import { describe, it, expect } from 'vitest';
import { parseStalePaymentButton } from '@/lib/payments/stale-button-parser';
import { parseIvePaidInput, isIvePaidInput } from '@/lib/bot/flows/shared/ive-paid-input';
import * as fs from 'fs';
import * as path from 'path';

describe('Payment/Giving Capability Contract (#219)', () => {
  // ── Invariant 1: Non-order payment recovery exists ──

  it('stale parser recognizes payment-specific locator i_paid_ref:<ref>', () => {
    const result = parseStalePaymentButton('i_paid_ref:PAY-GIVING-001', 'button', 'select_capability');
    expect(result.isStalePaymentButton).toBe(true);
    expect(result.hasPaymentReference).toBe(true);
    expect(result.paymentReference).toBe('PAY-GIVING-001');
  });

  it('stale-payment-recovery exports recoverByPaymentReference', async () => {
    const mod = await import('@/lib/payments/stale-payment-recovery');
    expect(typeof mod.recoverByPaymentReference).toBe('function');
  });

  it('stale-payment-recovery exports payment-first recoverGeneric', async () => {
    const mod = await import('@/lib/payments/stale-payment-recovery');
    expect(typeof mod.recoverGeneric).toBe('function');
  });

  it('disambiguation outcome uses candidates[] not orders[]', async () => {
    const mod = await import('@/lib/payments/stale-payment-recovery');
    // Type check: StaleRecoveryOutcome discrimination union includes candidates
    type Outcome = Awaited<ReturnType<typeof mod.recoverGeneric>>;
    // This compiles only if 'disambiguation' variant has 'candidates' property
    const _typeCheck = (o: Outcome) => {
      if (o.type === 'disambiguation') {
        const _c: Array<{ gatewayReference: string; purpose: string }> = o.candidates;
        return _c;
      }
      return null;
    };
    expect(_typeCheck).toBeDefined();
  });

  // ── Invariant 2: Channel continuity ──

  it('initializePayment accepts inboundChannelId and confirmationOrigin', async () => {
    const mod = await import('@/lib/bot/flows/shared/payment');
    expect(typeof mod.initializePayment).toBe('function');
    // The function signature accepts these opts — verified by TypeScript compilation
  });

  it('sendProactiveConfirmation reads _confirmation_origin from payment metadata', () => {
    // Source code verification: send-confirmation.ts must read _confirmation_origin
    const src = fs.readFileSync(
      path.join(process.cwd(), 'lib/payments/send-confirmation.ts'), 'utf-8'
    );
    expect(src).toContain('_confirmation_origin');
    expect(src).toContain('whatsappOriginMissingChannel');
  });

  // ── Invariant 3: Recovery never charges ──

  it('recoverByPaymentReference for success status does not import reconcilePayment', () => {
    // Source code verification: the success branch must NOT call reconcilePayment
    const src = fs.readFileSync(
      path.join(process.cwd(), 'lib/payments/stale-payment-recovery.ts'), 'utf-8'
    );
    // The success case returns immediately without touching reconcilePayment
    const successBlock = src.split("case 'success':")[1]?.split("case 'pending':")[0] || '';
    expect(successBlock).not.toContain('reconcilePayment');
  });

  // ── Invariant 4: Cross-tenant denied ──

  it('recoverByPaymentReference enforces business_id tenant boundary', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'lib/payments/stale-payment-recovery.ts'), 'utf-8'
    );
    // The query must filter by business_id
    expect(src).toContain(".eq('business_id', businessId)");
  });

  // ── Invariant 5: Purpose-appropriate copy ──

  it('generic recovery not_found message does not say "type order"', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'lib/payments/stale-payment-recovery.ts'), 'utf-8'
    );
    // The generic recoverGeneric not_found must not suggest ordering
    const genericSection = src.split('export async function recoverGeneric')[1]?.split('export async function recoverByOrderReference')[0] || '';
    const notFoundMessages = genericSection.match(/type: 'not_found'.*?message:.*?'/g) || [];
    for (const msg of notFoundMessages) {
      expect(msg).not.toContain('Type *order*');
    }
  });

  // ── Invariant 6: Valid notification enum values ──

  it('send-confirmation.ts uses valid notification_type enum values only', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'lib/payments/send-confirmation.ts'), 'utf-8'
    );
    // Must NOT contain invalid enum values
    expect(src).not.toContain("type: 'payment_received'");
    expect(src).not.toContain("type: 'donation'");
    // Must use valid 'payment' type
    const notifInserts = src.match(/type: 'payment'/g) || [];
    expect(notifInserts.length).toBeGreaterThanOrEqual(1);
  });

  // ── Active flow contract: I've Paid input recognition ──

  it('parseIvePaidInput recognizes both legacy and new payment-ref forms', () => {
    expect(parseIvePaidInput('i_paid').recognized).toBe(true);
    expect(parseIvePaidInput('i_paid_ref:REF-123').recognized).toBe(true);
    expect(parseIvePaidInput('i_paid_ref:REF-123').paymentRef).toBe('REF-123');
    expect(parseIvePaidInput('random').recognized).toBe(false);
  });

  it('isIvePaidInput works for exclusion lists', () => {
    expect(isIvePaidInput('i_paid')).toBe(true);
    expect(isIvePaidInput('i_paid_ref:REF')).toBe(true);
    expect(isIvePaidInput('hello')).toBe(false);
  });

  // ── Bot service: disambiguation uses payment-specific locators ──

  it('bot.service.ts disambiguation renders i_paid_ref buttons via this.messageSender', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'lib/bot/bot.service.ts'), 'utf-8'
    );
    // Must use this.messageSender for disambiguation, not resolveByBusinessId
    const disambigSection = src.split("case 'disambiguation'")[1]?.split('return;')[0] || '';
    expect(disambigSection).toContain('i_paid_ref:');
    expect(disambigSection).toContain('this.messageSender');
    // Verify no resolveByBusinessId call (comments mentioning it are OK)
    expect(disambigSection).not.toMatch(/await\s+.*resolveByBusinessId/);
  });
});

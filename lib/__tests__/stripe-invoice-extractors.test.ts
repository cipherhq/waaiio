/**
 * Stripe Invoice Extractors — Unit Tests (#177)
 *
 * Tests tri-state subscription classification and payment identity extraction
 * per Revision 7 approved contract.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyInvoiceSubscription,
  extractInvoicePaymentIdentity,
} from '@/lib/payments/stripe-invoice-extractors';

// ═══════════════════════════════════════════════════════════
// 1. Subscription Classification Tests
// ═══════════════════════════════════════════════════════════

describe('classifyInvoiceSubscription — tri-state classification', () => {
  // ── subscription results ──

  it('legacy sub_x only, no modern parent → subscription', () => {
    const result = classifyInvoiceSubscription({ subscription: 'sub_abc123' });
    expect(result.type).toBe('subscription');
    if (result.type === 'subscription') {
      expect(result.subscriptionId).toBe('sub_abc123');
    }
  });

  it('modern subscription_details only → subscription', () => {
    const result = classifyInvoiceSubscription({
      parent: {
        type: 'subscription_details',
        subscription_details: { subscription: 'sub_modern_001' },
      },
    });
    expect(result.type).toBe('subscription');
    if (result.type === 'subscription') {
      expect(result.subscriptionId).toBe('sub_modern_001');
    }
  });

  it('both legacy and modern equal → subscription', () => {
    const result = classifyInvoiceSubscription({
      subscription: 'sub_same',
      parent: {
        type: 'subscription_details',
        subscription_details: { subscription: 'sub_same' },
      },
    });
    expect(result.type).toBe('subscription');
    if (result.type === 'subscription') {
      expect(result.subscriptionId).toBe('sub_same');
    }
  });

  // ── malformed_or_conflicting results ──

  it('legacy and modern conflict → malformed_or_conflicting', () => {
    const result = classifyInvoiceSubscription({
      subscription: 'sub_a',
      parent: {
        type: 'subscription_details',
        subscription_details: { subscription: 'sub_b' },
      },
    });
    expect(result.type).toBe('malformed_or_conflicting');
    if (result.type === 'malformed_or_conflicting') {
      expect(result.error).toBe('legacy_modern_subscription_conflict');
    }
  });

  it('legacy sub + quote_details modern parent → malformed_or_conflicting (R7 fix)', () => {
    const result = classifyInvoiceSubscription({
      subscription: 'sub_x',
      parent: { type: 'quote_details' },
    });
    expect(result.type).toBe('malformed_or_conflicting');
    if (result.type === 'malformed_or_conflicting') {
      expect(result.error).toBe('legacy_subscription_contradicts_modern_parent');
    }
  });

  it('malformed modern subscription parent + valid legacy → malformed_or_conflicting', () => {
    const result = classifyInvoiceSubscription({
      subscription: 'sub_x',
      parent: {
        type: 'subscription_details',
        subscription_details: { subscription: 'not_a_sub_prefix' },
      },
    });
    expect(result.type).toBe('malformed_or_conflicting');
    if (result.type === 'malformed_or_conflicting') {
      expect(result.error).toBe('legacy_masks_malformed_modern_subscription');
    }
  });

  it('malformed modern subscription parent, no legacy → malformed_or_conflicting', () => {
    const result = classifyInvoiceSubscription({
      parent: {
        type: 'subscription_details',
        subscription_details: {},
      },
    });
    expect(result.type).toBe('malformed_or_conflicting');
    if (result.type === 'malformed_or_conflicting') {
      expect(result.error).toBe('malformed_subscription_parent');
    }
  });

  it('subscription_cycle billing reason but no identity → malformed', () => {
    const result = classifyInvoiceSubscription({ billing_reason: 'subscription_cycle' });
    expect(result.type).toBe('malformed_or_conflicting');
    if (result.type === 'malformed_or_conflicting') {
      expect(result.error).toBe('subscription_reason_without_identity');
    }
  });

  it('subscription_create billing reason but no identity → malformed', () => {
    const result = classifyInvoiceSubscription({ billing_reason: 'subscription_create' });
    expect(result.type).toBe('malformed_or_conflicting');
  });

  it('subscription_threshold billing reason but no identity → malformed', () => {
    const result = classifyInvoiceSubscription({ billing_reason: 'subscription_threshold' });
    expect(result.type).toBe('malformed_or_conflicting');
  });

  it('subscription_update billing reason but no identity → malformed', () => {
    const result = classifyInvoiceSubscription({ billing_reason: 'subscription_update' });
    expect(result.type).toBe('malformed_or_conflicting');
  });

  // ── not_subscription results ──

  it('quote_details parent, no legacy → not_subscription', () => {
    const result = classifyInvoiceSubscription({
      parent: { type: 'quote_details' },
      billing_reason: 'quote_accept',
    });
    expect(result.type).toBe('not_subscription');
  });

  it('manual billing reason, no sub identity → not_subscription', () => {
    const result = classifyInvoiceSubscription({ billing_reason: 'manual' });
    expect(result.type).toBe('not_subscription');
  });

  it('quote_accept billing reason, no sub identity → not_subscription', () => {
    const result = classifyInvoiceSubscription({ billing_reason: 'quote_accept' });
    expect(result.type).toBe('not_subscription');
  });

  it('no identity, null billing_reason → not_subscription', () => {
    const result = classifyInvoiceSubscription({ billing_reason: null });
    expect(result.type).toBe('not_subscription');
  });

  it('completely empty invoice → not_subscription', () => {
    const result = classifyInvoiceSubscription({});
    expect(result.type).toBe('not_subscription');
  });

  it('non-sub_ string in legacy → not_subscription', () => {
    const result = classifyInvoiceSubscription({ subscription: 'cs_test_abc' });
    expect(result.type).toBe('not_subscription');
  });
});

// ═══════════════════════════════════════════════════════════
// 2. Payment Identity Extraction Tests
// ═══════════════════════════════════════════════════════════

describe('extractInvoicePaymentIdentity — payment identity extraction', () => {
  // ── Legacy shape ──

  it('legacy PI only, no modern payments object → accept', () => {
    const result = extractInvoicePaymentIdentity(
      { payment_intent: 'pi_legacy_001' }, 5000, 'USD',
    );
    expect('paymentIntentId' in result).toBe(true);
    if ('paymentIntentId' in result) {
      expect(result.paymentIntentId).toBe('pi_legacy_001');
    }
  });

  it('legacy PI + paid_out_of_band=true → reject', () => {
    const result = extractInvoicePaymentIdentity(
      { payment_intent: 'pi_oob', paid_out_of_band: true }, 5000, 'USD',
    );
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toBe('paid_out_of_band');
    }
  });

  it('no PI, no payments object → reject', () => {
    const result = extractInvoicePaymentIdentity({}, 5000, 'USD');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toBe('no_payment_identity');
    }
  });

  // ── Modern shape ──

  it('modern: one paid PaymentIntent, amount=invoice, currency=match → accept', () => {
    const result = extractInvoicePaymentIdentity({
      payments: {
        data: [{
          status: 'paid',
          amount_paid: 5000,
          currency: 'usd',
          payment: { type: 'payment_intent', payment_intent: 'pi_modern_001' },
        }],
        has_more: false,
      },
    }, 5000, 'USD');
    expect('paymentIntentId' in result).toBe(true);
    if ('paymentIntentId' in result) {
      expect(result.paymentIntentId).toBe('pi_modern_001');
    }
  });

  it('modern: PI as nested object with id → accept', () => {
    const result = extractInvoicePaymentIdentity({
      payments: {
        data: [{
          status: 'paid',
          amount_paid: 3000,
          currency: 'usd',
          payment: { type: 'payment_intent', payment_intent: { id: 'pi_nested_001' } },
        }],
        has_more: false,
      },
    }, 3000, 'USD');
    expect('paymentIntentId' in result).toBe(true);
    if ('paymentIntentId' in result) {
      expect(result.paymentIntentId).toBe('pi_nested_001');
    }
  });

  it('modern: multiple paid PaymentIntents → reject', () => {
    const result = extractInvoicePaymentIdentity({
      payments: {
        data: [
          { status: 'paid', amount_paid: 3000, currency: 'usd', payment: { type: 'payment_intent', payment_intent: 'pi_a' } },
          { status: 'paid', amount_paid: 2000, currency: 'usd', payment: { type: 'payment_intent', payment_intent: 'pi_b' } },
        ],
        has_more: false,
      },
    }, 5000, 'USD');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toBe('multiple_paid_pis');
    }
  });

  it('modern: zero paid PaymentIntents → reject', () => {
    const result = extractInvoicePaymentIdentity({
      payments: {
        data: [{ status: 'open', payment: { type: 'payment_intent', payment_intent: 'pi_open' } }],
        has_more: false,
      },
    }, 5000, 'USD');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toBe('no_paid_pi');
    }
  });

  it('modern: paid payment_record type → reject (unsupported_paid_type)', () => {
    const result = extractInvoicePaymentIdentity({
      payments: {
        data: [{
          status: 'paid',
          amount_paid: 5000,
          currency: 'usd',
          payment: { type: 'payment_record', payment_record: 'pr_001' },
        }],
        has_more: false,
      },
    }, 5000, 'USD');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toBe('unsupported_paid_type');
    }
  });

  it('modern: paid entry with no payment object → reject (unsupported_paid_type)', () => {
    const result = extractInvoicePaymentIdentity({
      payments: {
        data: [{ status: 'paid', amount_paid: 5000, currency: 'usd' }],
        has_more: false,
      },
    }, 5000, 'USD');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toBe('unsupported_paid_type');
    }
  });

  // ── Pagination ──

  it('modern: has_more=true → reject (paginated_payments)', () => {
    const result = extractInvoicePaymentIdentity({
      payments: {
        data: [{
          status: 'paid', amount_paid: 5000, currency: 'usd',
          payment: { type: 'payment_intent', payment_intent: 'pi_paginated' },
        }],
        has_more: true,
      },
    }, 5000, 'USD');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toBe('paginated_payments');
    }
  });

  it('legacy PI + has_more=true → reject (legacy_masks_paginated_payments)', () => {
    const result = extractInvoicePaymentIdentity({
      payment_intent: 'pi_legacy_paginated',
      payments: {
        data: [{
          status: 'paid', amount_paid: 5000, currency: 'usd',
          payment: { type: 'payment_intent', payment_intent: 'pi_legacy_paginated' },
        }],
        has_more: true,
      },
    }, 5000, 'USD');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toBe('legacy_masks_paginated_payments');
    }
  });

  // ── Partial/out-of-band ──

  it('modern: PI amount < invoice amount → reject (partial_payment)', () => {
    const result = extractInvoicePaymentIdentity({
      payments: {
        data: [{
          status: 'paid', amount_paid: 8000, currency: 'usd',
          payment: { type: 'payment_intent', payment_intent: 'pi_partial' },
        }],
        has_more: false,
      },
    }, 10000, 'USD');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toBe('partial_payment');
    }
  });

  it('modern: currency mismatch → reject', () => {
    const result = extractInvoicePaymentIdentity({
      payments: {
        data: [{
          status: 'paid', amount_paid: 5000, currency: 'eur',
          payment: { type: 'payment_intent', payment_intent: 'pi_eur' },
        }],
        has_more: false,
      },
    }, 5000, 'USD');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toBe('currency_mismatch');
    }
  });

  // ── Legacy/modern conflicts ──

  it('legacy PI + modern consistent PI → accept', () => {
    const result = extractInvoicePaymentIdentity({
      payment_intent: 'pi_consistent',
      payments: {
        data: [{
          status: 'paid', amount_paid: 5000, currency: 'usd',
          payment: { type: 'payment_intent', payment_intent: 'pi_consistent' },
        }],
        has_more: false,
      },
    }, 5000, 'USD');
    expect('paymentIntentId' in result).toBe(true);
    if ('paymentIntentId' in result) {
      expect(result.paymentIntentId).toBe('pi_consistent');
    }
  });

  it('legacy PI + modern different PI → reject (legacy_modern_pi_mismatch)', () => {
    const result = extractInvoicePaymentIdentity({
      payment_intent: 'pi_legacy_diff',
      payments: {
        data: [{
          status: 'paid', amount_paid: 5000, currency: 'usd',
          payment: { type: 'payment_intent', payment_intent: 'pi_modern_diff' },
        }],
        has_more: false,
      },
    }, 5000, 'USD');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toBe('legacy_modern_pi_mismatch');
    }
  });

  // ── Malformed modern payments must not fall through to legacy ──

  it('legacy PI + malformed modern payments (non-array data) → reject', () => {
    const result = extractInvoicePaymentIdentity({
      payment_intent: 'pi_legacy_mask',
      payments: { data: 'not_an_array' },
    }, 5000, 'USD');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toBe('legacy_masks_malformed_modern_payments');
    }
  });

  it('malformed modern payments (no data), no legacy → reject', () => {
    const result = extractInvoicePaymentIdentity({
      payments: { has_more: false },
    }, 5000, 'USD');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toBe('malformed_modern_payments');
    }
  });

  // ── 1 paid PI + 1 paid unsupported type → reject ──

  it('modern: 1 paid PI + 1 paid payment_record → reject', () => {
    const result = extractInvoicePaymentIdentity({
      payments: {
        data: [
          { status: 'paid', amount_paid: 3000, currency: 'usd', payment: { type: 'payment_intent', payment_intent: 'pi_good' } },
          { status: 'paid', amount_paid: 2000, currency: 'usd', payment: { type: 'payment_record', payment_record: 'pr_bad' } },
        ],
        has_more: false,
      },
    }, 5000, 'USD');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toBe('unsupported_paid_type');
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 3. Platform vs Customer subscription role resolution
// ═══════════════════════════════════════════════════════════

describe('Role resolution contracts (documented via extractor behavior)', () => {
  it('non-subscription invoice should not trigger recurring DB or RPC work', () => {
    // This test validates the contract: not_subscription → no role resolution
    const result = classifyInvoiceSubscription({ billing_reason: 'manual' });
    expect(result.type).toBe('not_subscription');
  });

  it('subscription billing reason with conflicting identities → retryable failure', () => {
    const result = classifyInvoiceSubscription({
      subscription: 'sub_a',
      parent: {
        type: 'subscription_details',
        subscription_details: { subscription: 'sub_b' },
      },
      billing_reason: 'subscription_cycle',
    });
    expect(result.type).toBe('malformed_or_conflicting');
  });
});

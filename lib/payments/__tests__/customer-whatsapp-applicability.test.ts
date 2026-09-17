/**
 * customer_whatsapp applicability lifecycle tests.
 *
 * Proves:
 * 1. Web flow + phone + no sender → no customer_whatsapp in manifest
 * 2. WhatsApp origin + missing channel → customer_whatsapp in manifest (retryable)
 * 3. Resolved sender → customer_whatsapp in manifest
 * 4. No phone at all → no customer_whatsapp
 *
 * Implementation-Agent: Claude Code
 */
import { describe, it, expect } from 'vitest';
import { computeApplicableEffects } from '@/lib/payments/terminal-effects';

const BASE_PAYMENT = {
  id: 'pay-1',
  booking_id: 'bk-1',
  reservation_id: null,
  order_id: null,
  invoice_id: null,
  campaign_id: null,
};

describe('customer_whatsapp applicability', () => {
  it('web flow + phone + no sender → no customer_whatsapp requirement', () => {
    const effects = computeApplicableEffects(BASE_PAYMENT, {
      hasCustomerPhone: true,
      hasSender: false,             // no resolved WhatsApp channel
      whatsappOriginMissingChannel: false, // not WhatsApp origin
      hasLoyalty: false,
      amountPaid: 5000,
    });
    expect(effects).not.toContain('customer_whatsapp');
    // Email-only finalization path should still be possible
    expect(effects).toContain('owner_notif_whatsapp'); // owner effects always present
    expect(effects).toContain('owner_notif_email');
  });

  it('WhatsApp origin + missing channel → customer_whatsapp IS required (retryable)', () => {
    const effects = computeApplicableEffects(BASE_PAYMENT, {
      hasCustomerPhone: true,
      hasSender: false,             // no resolved channel
      whatsappOriginMissingChannel: true, // WhatsApp origin, channel missing
      hasLoyalty: false,
      amountPaid: 5000,
    });
    // customer_whatsapp MUST be in the manifest for WhatsApp-origin payments
    // so the claim stays retryable until the channel is repaired
    expect(effects).toContain('customer_whatsapp');
  });

  it('resolved sender → customer_whatsapp in manifest', () => {
    const effects = computeApplicableEffects(BASE_PAYMENT, {
      hasCustomerPhone: true,
      hasSender: true,              // resolved WhatsApp sender
      whatsappOriginMissingChannel: false,
      hasLoyalty: false,
      amountPaid: 5000,
    });
    expect(effects).toContain('customer_whatsapp');
  });

  it('no phone at all → no customer_whatsapp', () => {
    const effects = computeApplicableEffects(BASE_PAYMENT, {
      hasCustomerPhone: false,
      hasSender: false,
      whatsappOriginMissingChannel: false,
      hasLoyalty: false,
      amountPaid: 5000,
    });
    expect(effects).not.toContain('customer_whatsapp');
  });

  it('WhatsApp origin + missing channel → retryable (manifest stays non-terminal)', () => {
    // When whatsappOriginMissingChannel is true, customer_whatsapp is in the manifest
    // but the bridge section must NOT terminalize it as failed (the claim will be
    // released for retry). This test verifies the applicability side; the bridge
    // behavior is verified by the DB test and the send-confirmation flow.
    const effects = computeApplicableEffects(BASE_PAYMENT, {
      hasCustomerPhone: true,
      hasSender: false,
      whatsappOriginMissingChannel: true,
      hasLoyalty: false,
      amountPaid: 5000,
    });
    expect(effects).toContain('customer_whatsapp');
    // The manifest effect stays pending/claimed — never bridged to failed
    // before the claim is released. Verified by the bridge guard in
    // send-confirmation.ts: `if (manifestInitialized && !whatsappOriginMissingChannel)`
  });

  it('campaign donation email-only flow (no phone) → no customer_whatsapp, donation_receipt_email present', () => {
    const campaignPayment = { ...BASE_PAYMENT, booking_id: null, campaign_id: 'camp-1' };
    const effects = computeApplicableEffects(campaignPayment, {
      hasCustomerPhone: false,
      hasSender: false,
      hasDonationEmail: true,
      whatsappOriginMissingChannel: false,
      hasLoyalty: false,
      amountPaid: 10000,
    });
    expect(effects).not.toContain('customer_whatsapp');
    expect(effects).toContain('donation_receipt_email');
    expect(effects).toContain('owner_notif_email');
  });
});

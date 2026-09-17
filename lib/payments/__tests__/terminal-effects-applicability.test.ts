import { describe, expect, it } from 'vitest';
import { computeApplicableEffects } from '../terminal-effects';

const payment = { id: 'payment-1', booking_id: 'booking-1' };

describe('Phase A sender-dependent optional effects', () => {
  it('does not derive WhatsApp optional effects from phone presence on a web flow', () => {
    const effects = computeApplicableEffects(payment, {
      hasCustomerPhone: true,
      hasGuestEmail: true,
      hasSender: false,
      hasLoyalty: true,
      isTicketing: true,
      amountPaid: 5000,
    });

    expect(effects).toContain('receipt_pdf_generation');
    expect(effects).toContain('ticket_delivery_email');
    expect(effects).not.toContain('receipt_pdf_delivery');
    expect(effects).not.toContain('customer_loyalty_whatsapp');
    expect(effects).not.toContain('ticket_delivery_whatsapp');
  });

  it('keeps loyalty award independent from the optional WhatsApp notification', () => {
    const effects = computeApplicableEffects(payment, {
      hasCustomerPhone: true,
      hasSender: false,
      hasLoyalty: true,
    });

    expect(effects).toContain('loyalty_award');
    expect(effects).not.toContain('customer_loyalty_whatsapp');
  });

  it('does not require a WhatsApp effect to finalize ticketing when email is available', () => {
    const effects = computeApplicableEffects(payment, {
      hasCustomerPhone: true,
      hasGuestEmail: true,
      hasSender: false,
      isTicketing: true,
    });

    expect(effects).toEqual(expect.arrayContaining([
      'ticket_inventory_finalization', 'ticket_row_creation', 'ticket_delivery_email',
    ]));
    expect(effects).not.toContain('ticket_delivery_whatsapp');
  });
});

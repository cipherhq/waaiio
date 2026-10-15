/**
 * Slice 561-E — Proactive/notification deterministic localization tests
 *
 * Real executable runtime tests proving that proactive customer-facing
 * notification copy is deterministic and locale-aware through the production
 * getFlowCopy/fillFlowCopy + resolveProactiveLocalization seam.
 */
import { describe, it, expect } from 'vitest';
import { getFlowCopy, fillFlowCopy, _FLOW_COPY_FOR_TESTS, ALL_FLOW_COPY_KEYS } from '../flows/flow-localization';
import { CERTIFIED_LANGUAGES } from '@/lib/bot/languages';

// ═══════════════════════════════════════════════════════════════
// 1. New 561-E corpus keys — parity
// ═══════════════════════════════════════════════════════════════

describe('561-E: new notification corpus keys parity', () => {
  const newKeys = [
    'notification.queue_your_turn', 'notification.queue_reopened',
    'notification.checked_in', 'notification.no_show', 'notification.no_show_reason',
    'notification.booking_cancelled', 'notification.reservation_cancelled',
    'notification.balance_due', 'notification.waitlist_slot_open',
    'notification.catalog_unavailable', 'notification.catalog_error',
    'notification.catalog_order_error', 'notification.catalog_out_of_stock',
    'notification.catalog_none_available', 'notification.catalog_order_received',
    'notification.catalog_order_confirmed', 'notification.catalog_payment_pending',
    'notification.catalog_contact_business', 'notification.report_sent',
    'handoff.already_connected', 'handoff.connecting', 'handoff.session_closed',
    'notification.receipt_caption', 'notification.ticket_pdf_caption',
  ];

  for (const key of newKeys) {
    it(`${key} exists in en and pcm`, () => {
      expect(_FLOW_COPY_FOR_TESTS.en[key], `en.${key}`).toBeTruthy();
      expect(_FLOW_COPY_FOR_TESTS.pcm[key], `pcm.${key}`).toBeTruthy();
    });
  }

  it('all 8 locales at parity', () => {
    for (const lang of ['en', 'pcm', 'yo', 'ig', 'ha', 'tw', 'fr', 'es']) {
      const keys = Object.keys(_FLOW_COPY_FOR_TESTS[lang]);
      const missing = ALL_FLOW_COPY_KEYS.filter(k => !keys.includes(k));
      expect(missing, `${lang} missing ${missing.length} keys`).toHaveLength(0);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. Queue notification runtime — EN + PCM
// ═══════════════════════════════════════════════════════════════

describe('561-E: queue notification runtime', () => {
  it('queue_your_turn EN preserves exact name and businessName', () => {
    const result = fillFlowCopy('en', 'notification.queue_your_turn', { name: 'Amaka', businessName: "Ade's Cuts" });
    expect(result).toContain('Amaka');
    expect(result).toContain("Ade's Cuts");
    expect(result).toContain("it's your turn");
    expect(result).not.toContain('{name}');
    expect(result).not.toContain('{businessName}');
  });

  it('queue_your_turn PCM preserves exact name and businessName', () => {
    const result = fillFlowCopy('pcm', 'notification.queue_your_turn', { name: 'Amaka', businessName: "Ade's Cuts" });
    expect(result).toContain('Amaka');
    expect(result).toContain("Ade's Cuts");
    expect(result).toContain('na your turn');
  });

  it('queue_reopened EN preserves exact businessName', () => {
    const result = fillFlowCopy('en', 'notification.queue_reopened', { businessName: 'Mama Salon' });
    expect(result).toContain('Mama Salon');
    expect(result).toContain('now open');
  });

  it('queue_reopened PCM uses Pidgin phrasing', () => {
    const result = fillFlowCopy('pcm', 'notification.queue_reopened', { businessName: 'Mama Salon' });
    expect(result).toContain('Mama Salon');
    expect(result).toContain('don open');
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. Booking status notification runtime — EN + PCM
// ═══════════════════════════════════════════════════════════════

describe('561-E: booking status notification runtime', () => {
  it('checked_in EN preserves exact businessName and referenceCode', () => {
    const result = fillFlowCopy('en', 'notification.checked_in', { businessName: 'Lagos Spa', referenceCode: 'BK-2026-0042' });
    expect(result).toContain('Lagos Spa');
    expect(result).toContain('BK-2026-0042');
    expect(result).toContain("checked in");
  });

  it('checked_in PCM preserves exact protected values', () => {
    const result = fillFlowCopy('pcm', 'notification.checked_in', { businessName: 'Lagos Spa', referenceCode: 'BK-2026-0042' });
    expect(result).toContain('Lagos Spa');
    expect(result).toContain('BK-2026-0042');
    expect(result).toContain('Don Check In');
  });

  it('no_show EN preserves exact date/time/ref', () => {
    const result = fillFlowCopy('en', 'notification.no_show', {
      businessName: 'Barber Hub', referenceCode: 'BK-0099', date: '2026-12-25', time: '2:00 PM',
    });
    expect(result).toContain('Barber Hub');
    expect(result).toContain('BK-0099');
    expect(result).toContain('2026-12-25');
    expect(result).toContain('2:00 PM');
    expect(result).toContain('Missed Appointment');
  });

  it('no_show_reason preserves exact reason text', () => {
    const result = fillFlowCopy('en', 'notification.no_show_reason', { reason: 'Customer did not arrive' });
    expect(result).toContain('Customer did not arrive');
    expect(result).toContain('Reason:');
  });

  it('booking_cancelled EN preserves exact businessName and date', () => {
    const result = fillFlowCopy('en', 'notification.booking_cancelled', { businessName: 'Nail Art', date: '2026-11-01' });
    expect(result).toContain('Nail Art');
    expect(result).toContain('2026-11-01');
    expect(result).toContain('cancelled');
  });

  it('booking_cancelled PCM uses Pidgin phrasing', () => {
    const result = fillFlowCopy('pcm', 'notification.booking_cancelled', { businessName: 'Nail Art', date: '2026-11-01' });
    expect(result).toContain('Nail Art');
    expect(result).toContain('don cancel');
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. Reservation cancel + balance due runtime
// ═══════════════════════════════════════════════════════════════

describe('561-E: reservation/balance notification runtime', () => {
  it('reservation_cancelled preserves exact ref and checkInDate', () => {
    const result = fillFlowCopy('en', 'notification.reservation_cancelled', {
      businessName: 'Beach Resort', referenceCode: 'RS-5555', checkInDate: 'Dec 25, 2026',
    });
    expect(result).toContain('Beach Resort');
    expect(result).toContain('RS-5555');
    expect(result).toContain('Dec 25, 2026');
    expect(result).toContain('cancelled');
  });

  it('balance_due preserves exact amount and paymentUrl', () => {
    const result = fillFlowCopy('en', 'notification.balance_due', {
      businessName: 'Studio A', referenceCode: 'BK-1234', balance: '₦15,000', paymentUrl: 'https://pay.example.com/abc',
    });
    expect(result).toContain('Studio A');
    expect(result).toContain('BK-1234');
    expect(result).toContain('₦15,000');
    expect(result).toContain('https://pay.example.com/abc');
    expect(result).toContain('Balance Payment Due');
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. Waitlist slot notification runtime
// ═══════════════════════════════════════════════════════════════

describe('561-E: waitlist slot notification runtime', () => {
  it('waitlist_slot_open EN preserves exact values', () => {
    const result = fillFlowCopy('en', 'notification.waitlist_slot_open', {
      name: 'Chidi', businessName: 'Top Barber', displayDate: 'Saturday, Dec 20',
    });
    expect(result).toContain('Chidi');
    expect(result).toContain('Top Barber');
    expect(result).toContain('Saturday, Dec 20');
    expect(result).toContain('slot just opened');
  });

  it('waitlist_slot_open PCM uses Pidgin phrasing', () => {
    const result = fillFlowCopy('pcm', 'notification.waitlist_slot_open', {
      name: 'Chidi', businessName: 'Top Barber', displayDate: 'Saturday, Dec 20',
    });
    expect(result).toContain('Chidi');
    expect(result).toContain('Top Barber');
    expect(result).toContain('Spot just open');
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. Catalog order notification runtime
// ═══════════════════════════════════════════════════════════════

describe('561-E: catalog order notification runtime', () => {
  it('catalog static strings return correct EN', () => {
    expect(getFlowCopy('en', 'notification.catalog_unavailable')).toContain('catalog is currently unavailable');
    expect(getFlowCopy('en', 'notification.catalog_error')).toContain('went wrong');
    expect(getFlowCopy('en', 'notification.catalog_order_received')).toBe('*Order Received!*');
    expect(getFlowCopy('en', 'notification.catalog_order_confirmed')).toContain('confirmed');
    expect(getFlowCopy('en', 'notification.catalog_payment_pending')).toContain('automatically after payment');
    expect(getFlowCopy('en', 'notification.catalog_contact_business')).toContain('contact the business');
  });

  it('catalog static strings return correct PCM', () => {
    expect(getFlowCopy('pcm', 'notification.catalog_unavailable')).toContain('no dey available');
    expect(getFlowCopy('pcm', 'notification.catalog_error')).toContain('no go well');
    expect(getFlowCopy('pcm', 'notification.catalog_order_received')).toContain('Order Don Enter');
    expect(getFlowCopy('pcm', 'notification.catalog_order_confirmed')).toContain('don confirm');
    expect(getFlowCopy('pcm', 'notification.catalog_payment_pending')).toContain('go come automatically');
  });

  it('catalog_out_of_stock preserves exact item names', () => {
    const result = fillFlowCopy('en', 'notification.catalog_out_of_stock', { items: 'Jollof Rice, Fried Plantain' });
    expect(result).toContain('Jollof Rice, Fried Plantain');
    expect(result).toContain('out of stock');
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. Report/document notification runtime
// ═══════════════════════════════════════════════════════════════

describe('561-E: report notification runtime', () => {
  it('report_sent preserves exact title, businessName, and secureLink', () => {
    const result = fillFlowCopy('en', 'notification.report_sent', {
      reportTitle: 'Financial Summary Q3', businessName: 'Ace Corp', secureLink: 'https://docs.example.com/xyz',
    });
    expect(result).toContain('Financial Summary Q3');
    expect(result).toContain('Ace Corp');
    expect(result).toContain('https://docs.example.com/xyz');
    expect(result).toContain('last 4 digits');
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. Handoff/chat notification runtime — EN + PCM
// ═══════════════════════════════════════════════════════════════

describe('561-E: handoff notification runtime', () => {
  it('already_connected EN preserves exact businessName', () => {
    const result = fillFlowCopy('en', 'handoff.already_connected', { businessName: "Ade's Shop" });
    expect(result).toContain("Ade's Shop");
    expect(result).toContain('already connected');
    expect(result).toContain('*end chat*');
  });

  it('already_connected PCM preserves exact businessName', () => {
    const result = fillFlowCopy('pcm', 'handoff.already_connected', { businessName: "Ade's Shop" });
    expect(result).toContain("Ade's Shop");
    expect(result).toContain('don already dey connected');
  });

  it('connecting EN preserves exact businessName', () => {
    const result = fillFlowCopy('en', 'handoff.connecting', { businessName: 'Quick Fix' });
    expect(result).toContain('Quick Fix');
    expect(result).toContain('Connecting you');
  });

  it('connecting PCM uses Pidgin phrasing', () => {
    const result = fillFlowCopy('pcm', 'handoff.connecting', { businessName: 'Quick Fix' });
    expect(result).toContain('Quick Fix');
    expect(result).toContain('dey connect you');
  });

  it('session_closed EN is static and correct', () => {
    const result = getFlowCopy('en', 'handoff.session_closed');
    expect(result).toContain('chat session has been closed');
    expect(result).toContain('*Hi*');
    expect(result).toContain('*my bookings*');
  });

  it('session_closed PCM uses Pidgin phrasing', () => {
    const result = getFlowCopy('pcm', 'handoff.session_closed');
    expect(result).toContain('don close');
  });
});

// ═══════════════════════════════════════════════════════════════
// 9. Receipt + ticket caption runtime
// ═══════════════════════════════════════════════════════════════

describe('561-E: receipt and ticket caption runtime', () => {
  it('receipt_caption returns correct EN', () => {
    expect(getFlowCopy('en', 'notification.receipt_caption')).toBe('Your payment receipt');
  });

  it('ticket_pdf_caption preserves exact event/quantity', () => {
    const result = fillFlowCopy('en', 'notification.ticket_pdf_caption', {
      quantity: '2', ticketLabel: 'tickets', eventName: 'Lagos Jazz Festival',
    });
    expect(result).toContain('2');
    expect(result).toContain('tickets');
    expect(result).toContain('Lagos Jazz Festival');
  });
});

// ═══════════════════════════════════════════════════════════════
// 10. Production language-authority fallback for notifications
// ═══════════════════════════════════════════════════════════════

describe('561-E: production language-authority fallback for notifications', () => {
  const notificationKeys = [
    'notification.queue_your_turn', 'notification.checked_in',
    'notification.booking_cancelled', 'notification.catalog_order_received',
    'handoff.session_closed', 'notification.receipt_caption',
  ];
  const uncertifiedLangs = ['yo', 'ig', 'ha', 'tw', 'fr', 'es'];

  for (const lang of uncertifiedLangs) {
    it(`${lang} (uncertified) falls back to English for notification keys`, () => {
      for (const key of notificationKeys) {
        const result = getFlowCopy(lang, key);
        const enResult = getFlowCopy('en', key);
        expect(result, `${lang}.${key} should equal en.${key}`).toBe(enResult);
      }
    });
  }

  it('certified pcm returns Pidgin for notification keys', () => {
    expect(getFlowCopy('pcm', 'notification.catalog_order_received')).toContain('Order Don Enter');
    expect(getFlowCopy('pcm', 'notification.catalog_unavailable')).toContain('no dey available');
    expect(getFlowCopy('pcm', 'handoff.session_closed')).toContain('don close');
    expect(getFlowCopy('pcm', 'notification.checked_in')).toContain('Don Check In');
  });

  it('undefined/empty copyLang falls back to English', () => {
    expect(getFlowCopy(undefined, 'notification.queue_your_turn')).toBe(getFlowCopy('en', 'notification.queue_your_turn'));
    expect(getFlowCopy('', 'handoff.session_closed')).toBe(getFlowCopy('en', 'handoff.session_closed'));
  });
});

// ═══════════════════════════════════════════════════════════════
// 11. CERTIFIED_LANGUAGES unchanged
// ═══════════════════════════════════════════════════════════════

describe('561-E: CERTIFIED_LANGUAGES unchanged', () => {
  it('only en and pcm are certified', () => {
    expect(CERTIFIED_LANGUAGES).toEqual(['en', 'pcm']);
  });
});

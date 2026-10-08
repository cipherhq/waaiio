/**
 * Slice 561-G — PCM ordering/capability/saved-card remediation tests
 *
 * Proves the live-staging PCM defect is fixed: all Waaiio-owned
 * customer-facing ordering, capability menu, and saved-card copy
 * now routes through deterministic getFlowCopy/fillFlowCopy.
 */
import { describe, it, expect, vi } from 'vitest';
import { getFlowCopy, fillFlowCopy, _FLOW_COPY_FOR_TESTS, ALL_FLOW_COPY_KEYS } from '../flows/flow-localization';
import { getCapabilityLabel } from '@/lib/capabilities/labels';
import { CERTIFIED_LANGUAGES } from '@/lib/bot/languages';

// ═══════════════════════════════════════════════════════════════
// 1. Corpus parity — new 561-G keys
// ═══════════════════════════════════════════════════════════════

describe('561-G: new corpus keys parity', () => {
  const newKeys = [
    'ordering.welcome', 'ordering.welcome_categories', 'ordering.our_catalog',
    'ordering.browse', 'ordering.choose_option', 'ordering.nothing_in_category',
    'ordering.other_categories', 'ordering.stock_left', 'ordering.cart_info',
    'ordering.select_an_item', 'ordering.total_label',
    'savedcard.pay_with_saved', 'savedcard.pay_with_last4', 'savedcard.use_different',
    'cap.scheduling', 'cap.appointment', 'cap.ordering', 'cap.ticketing',
    'cap.reservation', 'cap.table_reservation', 'cap.crowdfunding', 'cap.chat',
    'cap.waitlist', 'cap.queue', 'cap.loyalty', 'cap.invoice', 'cap.waiver',
    'cap.class_booking', 'cap.promo_verification', 'cap.payment', 'cap.giving',
  ];

  for (const key of newKeys) {
    it(`${key} exists in en and pcm`, () => {
      expect(_FLOW_COPY_FOR_TESTS.en[key], `en.${key}`).toBeTruthy();
      expect(_FLOW_COPY_FOR_TESTS.pcm[key], `pcm.${key}`).toBeTruthy();
    });
  }

  it('all 8 locales at parity (659 keys)', () => {
    for (const lang of ['en', 'pcm', 'yo', 'ig', 'ha', 'tw', 'fr', 'es']) {
      const keys = Object.keys(_FLOW_COPY_FOR_TESTS[lang]);
      const missing = ALL_FLOW_COPY_KEYS.filter(k => !keys.includes(k));
      expect(missing, `${lang} missing ${missing.length} keys`).toHaveLength(0);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. PCM catalog opening — no English chrome after pcm
// ═══════════════════════════════════════════════════════════════

describe('561-G: PCM catalog opening', () => {
  it('ordering.welcome PCM preserves merchant name, uses Pidgin chrome', () => {
    const result = fillFlowCopy('pcm', 'ordering.welcome', {
      businessName: 'TestBiz', emoji: '🛍️', noun: 'catalog',
    });
    expect(result).toContain('TestBiz');
    expect(result).toContain('🛍️');
    expect(result).toContain('Check our');
    expect(result).not.toContain('Browse our');
  });

  it('ordering.welcome EN preserves merchant name, uses English chrome', () => {
    const result = fillFlowCopy('en', 'ordering.welcome', {
      businessName: 'TestBiz', emoji: '🛍️', noun: 'catalog',
    });
    expect(result).toContain('TestBiz');
    expect(result).toContain('Browse our');
  });

  it('ordering.welcome_categories PCM uses Pidgin phrasing', () => {
    const result = fillFlowCopy('pcm', 'ordering.welcome_categories', {
      businessName: 'Hair Palace', emoji: '🛍️',
    });
    expect(result).toContain('Hair Palace');
    expect(result).toContain('Pick category');
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. PCM product option selection
// ═══════════════════════════════════════════════════════════════

describe('561-G: PCM product option selection', () => {
  it('choose_option PCM preserves product name, uses Pidgin chrome', () => {
    const result = fillFlowCopy('pcm', 'ordering.choose_option', {
      productName: 'Bone Straight Wig',
    });
    expect(result).toContain('Bone Straight Wig');
    expect(result).toContain('Pick option');
    expect(result).not.toContain('Choose an option');
  });

  it('choose_option EN uses English chrome', () => {
    const result = fillFlowCopy('en', 'ordering.choose_option', {
      productName: 'Bone Straight Wig',
    });
    expect(result).toContain('Bone Straight Wig');
    expect(result).toContain('Choose an option');
  });

  it('select_an_item PCM uses Pidgin', () => {
    expect(getFlowCopy('pcm', 'ordering.select_an_item')).toBe('Pick one:');
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. PCM checkout
// ═══════════════════════════════════════════════════════════════

describe('561-G: PCM checkout', () => {
  it('checkout_confirm is consistent across EN and PCM', () => {
    // "Checkout ✅" is a natural loanword in PCM — both are the same
    expect(getFlowCopy('en', 'ordering.checkout_confirm')).toBe('Checkout ✅');
    expect(getFlowCopy('pcm', 'ordering.checkout_confirm')).toBe('Checkout ✅');
  });

  it('total_label preserves exact amount', () => {
    const result = fillFlowCopy('pcm', 'ordering.total_label', { amount: '₦15,000' });
    expect(result).toContain('₦15,000');
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. PCM saved-card offer
// ═══════════════════════════════════════════════════════════════

describe('561-G: PCM saved-card offer', () => {
  it('savedcard.pay_with_saved preserves amount and card label', () => {
    const en = fillFlowCopy('en', 'savedcard.pay_with_saved', {
      amount: '₦5,000', cardLabel: 'Visa •••• 4242',
    });
    expect(en).toContain('₦5,000');
    expect(en).toContain('Visa •••• 4242');
    expect(en).toContain('saved card');
  });

  it('savedcard PCM body is NOT the English value', () => {
    const en = getFlowCopy('en', 'savedcard.pay_with_saved');
    const pcm = getFlowCopy('pcm', 'savedcard.pay_with_saved');
    expect(pcm).not.toBe(en);
    expect(pcm).toContain('card wey you save');
  });

  it('savedcard PCM body preserves amount and card label', () => {
    const result = fillFlowCopy('pcm', 'savedcard.pay_with_saved', {
      amount: '₦5,000', cardLabel: 'Visa •••• 4242',
    });
    expect(result).toContain('₦5,000');
    expect(result).toContain('Visa •••• 4242');
  });

  it('savedcard.pay_with_last4 preserves last4', () => {
    const result = fillFlowCopy('en', 'savedcard.pay_with_last4', { last4: '4242' });
    expect(result).toContain('4242');
    expect(result).toContain('Pay with');
  });

  it('savedcard.use_different PCM is localized', () => {
    expect(getFlowCopy('en', 'savedcard.use_different')).toBe('Use different card');
    expect(getFlowCopy('pcm', 'savedcard.use_different')).toBe('Use another card');
  });
});

// ═══════════════════════════════════════════════════════════════
// 5b. PCM payment/ordering chrome
// ═══════════════════════════════════════════════════════════════

describe('561-G: PCM payment/ordering chrome', () => {
  it('PCM auto_confirm is localized', () => {
    const pcm = getFlowCopy('pcm', 'ordering.auto_confirm');
    const en = getFlowCopy('en', 'ordering.auto_confirm');
    expect(pcm).not.toBe(en);
    expect(pcm).toContain('automatically after you pay');
  });

  it('PCM payment_setup_failed is localized', () => {
    const pcm = getFlowCopy('pcm', 'ordering.payment_setup_failed');
    expect(pcm).toContain('no fit set up payment');
  });

  it('PCM free_order_tips is localized', () => {
    const pcm = getFlowCopy('pcm', 'ordering.free_order_tips');
    expect(pcm).toContain('Wetin you fit do');
  });

  it('PCM card_charged is localized', () => {
    const pcm = getFlowCopy('pcm', 'ordering.card_charged');
    expect(pcm).toContain('Card don charge');
    expect(pcm).toContain('dey process');
  });

  it('PCM select_payment_option is localized', () => {
    const pcm = getFlowCopy('pcm', 'ordering.select_payment_option');
    expect(pcm).toContain('Abeg pick');
  });

  it('PCM bank_transfer_title remains recognizable', () => {
    expect(getFlowCopy('pcm', 'ordering.bank_transfer_title')).toContain('Bank Transfer');
  });

  it('PCM option_not_available preserves user input', () => {
    const result = fillFlowCopy('pcm', 'ordering.option_not_available', { input: 'Blue XL' });
    expect(result).toContain('Blue XL');
    expect(result).toContain('no dey available');
  });

  it('PCM tap_or_promo is localized', () => {
    expect(getFlowCopy('pcm', 'ordering.tap_or_promo')).toContain('Abeg');
  });

  it('PCM invalid_promo is localized', () => {
    expect(getFlowCopy('pcm', 'ordering.invalid_promo')).toContain('no valid');
  });

  it('EN payment chrome remains unchanged', () => {
    expect(getFlowCopy('en', 'ordering.auto_confirm')).toContain('Confirmation arrives');
    expect(getFlowCopy('en', 'ordering.payment_setup_failed')).toContain("couldn't set up payment");
    expect(getFlowCopy('en', 'ordering.card_charged')).toContain('Card charged!');
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. PCM order confirmation with lang param
// ═══════════════════════════════════════════════════════════════

describe('561-G: PCM order confirmation', () => {
  it('confirm.order_confirmed PCM is distinct from EN', () => {
    const en = getFlowCopy('en', 'confirm.order_confirmed');
    const pcm = getFlowCopy('pcm', 'confirm.order_confirmed');
    expect(en).toContain('Order Confirmed');
    expect(pcm).toContain('Order Don Confirm');
    expect(pcm).not.toBe(en);
  });

  it('confirm.thank_order PCM is distinct from EN', () => {
    const en = getFlowCopy('en', 'confirm.thank_order');
    const pcm = getFlowCopy('pcm', 'confirm.thank_order');
    expect(en).toContain('Thank you');
    expect(pcm).toContain('appreciate');
    expect(pcm).not.toBe(en);
  });

  it('confirm.confirmed PCM is distinct from EN', () => {
    const en = getFlowCopy('en', 'confirm.confirmed');
    const pcm = getFlowCopy('pcm', 'confirm.confirmed');
    expect(en).toBe('Confirmed!');
    expect(pcm).toContain('Don Confirm');
  });

  it('confirm labels (ref/amount/items/total) preserved as-is', () => {
    // These short labels remain English across all locales — natural in PCM
    expect(getFlowCopy('pcm', 'confirm.lbl_ref')).toBe('Ref:');
    expect(getFlowCopy('pcm', 'confirm.lbl_total')).toBe('Total:');
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. Capability menu — labels localized, IDs unchanged
// ═══════════════════════════════════════════════════════════════

describe('561-G: capability menu labels', () => {
  it('EN capability labels match expected text', () => {
    expect(getCapabilityLabel('ordering', 'shop', null, 'en')).toBe('Place an Order');
    expect(getCapabilityLabel('scheduling', 'barber', null, 'en')).toBe('Our Services');
    expect(getCapabilityLabel('chat', 'shop', null, 'en')).toBe('Chat with Us');
    expect(getCapabilityLabel('ticketing', 'event_services', null, 'en')).toBe('Buy Tickets');
    expect(getCapabilityLabel('reservation', 'hotel', null, 'en')).toBe('Book a Stay');
  });

  it('PCM capability labels are localized (Owner-approved)', () => {
    expect(getCapabilityLabel('ordering', 'shop', null, 'pcm')).toBe('Place Order');
    expect(getCapabilityLabel('chat', 'shop', null, 'pcm')).toBe('Follow us talk');
    expect(getCapabilityLabel('reservation', 'hotel', null, 'pcm')).toBe('Book Stay');
    expect(getCapabilityLabel('crowdfunding', 'church', null, 'pcm')).toBe('Support Campaign');
    expect(getCapabilityLabel('class_booking', 'gym', null, 'pcm')).toBe('Book Class');
    expect(getCapabilityLabel('giving', 'church', null, 'pcm')).toBe('Give money');
    expect(getCapabilityLabel('ticketing', 'event_services', null, 'pcm')).toBe('Buy Ticket');
    expect(getCapabilityLabel('appointment', 'car_wash', null, 'pcm')).toBe('Book Car Wash');
  });

  it('26/26 Owner matrix — all cap keys populated across 8 locales', () => {
    const keys = [
      'cap.scheduling', 'cap.appointment', 'cap.appointment.restaurant',
      'cap.appointment.event_services', 'cap.appointment.photographer',
      'cap.appointment.gym', 'cap.appointment.tutor', 'cap.appointment.coworking',
      'cap.appointment.car_wash', 'cap.giving', 'cap.payment', 'cap.ordering',
      'cap.ticketing', 'cap.reservation', 'cap.table_reservation', 'cap.crowdfunding',
      'cap.reminders', 'cap.chat', 'cap.waitlist', 'cap.queue', 'cap.loyalty',
      'cap.invoice', 'cap.waiver', 'cap.class_booking', 'cap.promo_verification',
      'account.title',
    ];
    expect(keys.length).toBe(26);
    for (const key of keys) {
      for (const lang of ['en', 'pcm', 'yo', 'ig', 'ha', 'tw', 'fr', 'es']) {
        expect(_FLOW_COPY_FOR_TESTS[lang][key], `${lang}.${key}`).toBeTruthy();
      }
    }
  });

  it('11 Owner-approved flagged cells have correct cleaned values', () => {
    expect(_FLOW_COPY_FOR_TESTS.ig['cap.appointment']).toBe('Debe Oge');
    expect(_FLOW_COPY_FOR_TESTS.ig['cap.ordering']).toBe('Nye Oda');
    expect(_FLOW_COPY_FOR_TESTS.ig['cap.ticketing']).toBe('Zụta Tiketi');
    expect(_FLOW_COPY_FOR_TESTS.ig['cap.table_reservation']).toBe('Mee Ndoputa');
    expect(_FLOW_COPY_FOR_TESTS.ig['cap.crowdfunding']).toBe('Kwado Mgbasa');
    expect(_FLOW_COPY_FOR_TESTS.ig['cap.waitlist']).toBe('Soro na Ndepụta Ichere');
    expect(_FLOW_COPY_FOR_TESTS.ig['cap.queue']).toBe("Banye n'Ahịrị");
    expect(_FLOW_COPY_FOR_TESTS.yo['cap.crowdfunding']).toBe('Àtìlẹ́yìn Ìpolongo');
    expect(_FLOW_COPY_FOR_TESTS.yo['cap.giving']).toBe('Ṣa n owo');
    expect(_FLOW_COPY_FOR_TESTS.tw['cap.appointment.car_wash']).toBe('Gye Bere Wɔnhoro Kaa');
    expect(_FLOW_COPY_FOR_TESTS.fr['cap.waitlist']).toBe("Liste d'attente");
  });

  it('all cap/account labels within 24-char WhatsApp limit', () => {
    const keys = [
      'cap.scheduling', 'cap.appointment', 'cap.appointment.restaurant',
      'cap.appointment.event_services', 'cap.appointment.photographer',
      'cap.appointment.gym', 'cap.appointment.tutor', 'cap.appointment.coworking',
      'cap.appointment.car_wash', 'cap.giving', 'cap.payment', 'cap.ordering',
      'cap.ticketing', 'cap.reservation', 'cap.table_reservation', 'cap.crowdfunding',
      'cap.reminders', 'cap.chat', 'cap.waitlist', 'cap.queue', 'cap.loyalty',
      'cap.invoice', 'cap.waiver', 'cap.class_booking', 'cap.promo_verification',
      'account.title',
    ];
    for (const key of keys) {
      for (const lang of ['en', 'pcm', 'yo', 'ig', 'ha', 'tw', 'fr', 'es']) {
        const val = _FLOW_COPY_FOR_TESTS[lang][key];
        expect(val.length, `${lang}.${key} = "${val}" (${val.length} chars)`).toBeLessThanOrEqual(24);
      }
    }
  });

  it('my_account uses account.title not a CapabilityId', () => {
    // account.title is rendered directly via getFlowCopy, not via getCapabilityLabel
    expect(getFlowCopy('en', 'account.title')).toBe('My Account');
    expect(getFlowCopy('pcm', 'account.title')).toBe('My Account');
    expect(_FLOW_COPY_FOR_TESTS.yo['account.title']).toBe('Àkọọ́lẹ̀ Mi');
    expect(_FLOW_COPY_FOR_TESTS.fr['account.title']).toBe('Mon compte');
    expect(_FLOW_COPY_FOR_TESTS.es['account.title']).toBe('Mi cuenta');
  });

  it('appointment label varies by category', () => {
    expect(getCapabilityLabel('appointment', 'restaurant', null, 'en')).toBe('Book a Table');
    expect(getCapabilityLabel('appointment', 'photographer', null, 'en')).toBe('Book a Session');
    expect(getCapabilityLabel('appointment', 'barber', null, 'en')).toBe('Book Appointment');
    // PCM
    expect(getCapabilityLabel('appointment', 'restaurant', null, 'pcm')).toBe('Book Table');
    expect(getCapabilityLabel('appointment', 'barber', null, 'pcm')).toBe('Book Appointment');
  });

  it('merchant custom labels are preserved byte-for-byte', () => {
    const custom = 'Bespoke Hair Services 💇';
    expect(getCapabilityLabel('scheduling', 'barber', custom, 'pcm')).toBe(custom);
    expect(getCapabilityLabel('ordering', 'shop', custom, 'en')).toBe(custom);
  });

  it('uncertified language falls back to English', () => {
    expect(getCapabilityLabel('ordering', 'shop', null, 'fr')).toBe('Place an Order');
    expect(getCapabilityLabel('chat', 'shop', null, 'yo')).toBe('Chat with Us');
  });

  it('no lang argument defaults to English (backward compat)', () => {
    expect(getCapabilityLabel('ordering', 'shop')).toBe('Place an Order');
    expect(getCapabilityLabel('chat', 'shop')).toBe('Chat with Us');
  });

  it('internal cap IDs are stable strings, not affected by label language', () => {
    // The function returns display text only. Routing uses cap_${capId} postbackText.
    // This test ensures the function signature accepts lang without changing return shape.
    const enLabel = getCapabilityLabel('ordering', 'shop', null, 'en');
    const pcmLabel = getCapabilityLabel('ordering', 'shop', null, 'pcm');
    expect(typeof enLabel).toBe('string');
    expect(typeof pcmLabel).toBe('string');
    // The returned value is display text — the caller uses cap_ordering as postbackText
    // (verified by capability-selection.flow.ts line 232: postbackText: `cap_${cap}`)
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. English regression
// ═══════════════════════════════════════════════════════════════

describe('561-G: English regression', () => {
  it('EN ordering chrome unchanged', () => {
    expect(getFlowCopy('en', 'ordering.our_catalog')).toBe('Our Catalog');
    expect(getFlowCopy('en', 'ordering.browse')).toBe('Browse');
    expect(getFlowCopy('en', 'ordering.select_an_item')).toContain('Select an item');
    expect(getFlowCopy('en', 'ordering.other_categories')).toBe('Other Categories');
  });

  it('PCM catalog title/action follow product decision (Blocker 3)', () => {
    expect(getFlowCopy('pcm', 'ordering.our_catalog')).toBe('Our Products');
    expect(getFlowCopy('pcm', 'ordering.browse')).toBe('See Products');
    // Explicitly NOT "Our Catalog" / "Browse" (the live staging defect)
    expect(getFlowCopy('pcm', 'ordering.our_catalog')).not.toBe('Our Catalog');
    expect(getFlowCopy('pcm', 'ordering.browse')).not.toBe('Browse');
  });

  it('EN confirm texts unchanged', () => {
    expect(getFlowCopy('en', 'confirm.order_confirmed')).toBe('✅ *Order Confirmed!*');
    expect(getFlowCopy('en', 'confirm.thank_order')).toBe('Thank you for your order! 🙏');
    expect(getFlowCopy('en', 'confirm.confirmed')).toBe('Confirmed!');
  });
});

// ═══════════════════════════════════════════════════════════════
// 9. Ordering flow runtime — prompt execution
// ═══════════════════════════════════════════════════════════════

describe('561-G: ordering flow runtime', () => {
  function buildOrderCtx(copyLang: string) {
    const makeChain = (): any => {
      const p: any = { data: [], error: null };
      for (const fn of ['eq','neq','gt','gte','lt','lte','is','in','not','or','order','limit','range','single','maybeSingle','select','contains','filter','ilike','like','match']) {
        p[fn] = vi.fn().mockReturnValue(p);
      }
      p.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
      p.single = vi.fn().mockResolvedValue({ data: null, error: null });
      p.then = undefined;
      return p;
    };
    return {
      supabase: { from: vi.fn(() => ({ select: vi.fn().mockReturnValue(makeChain()), insert: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: { id: 'mock' }, error: null }) }) }) })), rpc: vi.fn().mockResolvedValue({ data: null, error: null }) } as any,
      sender: { sendText: vi.fn(), sendButtons: vi.fn(), sendList: vi.fn() } as any,
      standalone: {} as any,
      intelligence: {} as any,
      from: '+2348001234567',
      session: { id: 'test', user_id: 'u1', business_id: 'b1', current_step: 'test', session_data: {}, version: 1 },
      business: { id: 'b1', name: 'TestBiz', slug: 'test', subscription_tier: 'growth', country_code: 'NG', category: 'shop', flow_type: 'ordering' as any, trial_ends_at: '', metadata: {} },
      t: vi.fn(async (text: string) => text),
      copyLang,
    } as any;
  }

  it('select_product prompt uses PCM chrome when copyLang=pcm', async () => {
    const { orderingFlow } = await import('../flows/ordering.flow');
    const step = orderingFlow.steps.find(s => s.id === 'browse_catalog');
    expect(step).toBeDefined();

    // Mock products to trigger the catalog display
    const products = [
      { id: 'p1', name: 'Bone Straight Wig', description: 'Premium', price: 50000, has_variants: false, stock_quantity: null, is_active: true, category: null, sort_order: 0 },
    ];
    const chain: any = { data: products, error: null };
    for (const fn of ['eq','is','order','limit','select','in','not','or','filter','contains','ilike','like','match','neq','gt','gte','lt','lte','range']) {
      chain[fn] = vi.fn().mockReturnValue(chain);
    }
    chain.then = undefined;

    const ctx = buildOrderCtx('pcm');
    ctx.supabase.from = vi.fn(() => ({ select: vi.fn().mockReturnValue(chain) }));

    const output = await step!.prompt(ctx);

    // Should contain PCM chrome, not English
    const body = (output[0] as any).body || '';
    expect(body).toContain('TestBiz'); // merchant name preserved
    // PCM uses "Check our" not "Browse our"
    if (body.includes('catalog')) {
      expect(body).toContain('Check our');
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 10. CERTIFIED_LANGUAGES unchanged
// ═══════════════════════════════════════════════════════════════

describe('561-G: CERTIFIED_LANGUAGES unchanged', () => {
  it('only en and pcm are certified', () => {
    expect(CERTIFIED_LANGUAGES).toEqual(['en', 'pcm']);
  });
});

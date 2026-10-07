/**
 * Slice 561-B — Core interactive runtime wiring tests
 *
 * Proves:
 * - NAV_FOOTER uses deterministic getFlowCopy (not hardcoded English)
 * - Executor error/recovery messages use deterministic copy
 * - Language switch messages use deterministic copy
 * - English remains unchanged where expected
 * - Pidgin receives deterministic Pidgin copy on wired surfaces
 * - Uncertified languages still return English at runtime
 * - Placeholders preserve authoritative values exactly
 * - #559 reroute behavior preserved
 * - Shared/dedicated paths not diverged
 */
import { describe, it, expect } from 'vitest';
import {
  getFlowCopy,
  fillFlowCopy,
  _FLOW_COPY_FOR_TESTS,
  ALL_FLOW_COPY_KEYS,
} from '../flows/flow-localization';
import { CERTIFIED_LANGUAGES } from '@/lib/bot/languages';

// ═══════════════════════════════════════════════════════════════
// NAV_FOOTER deterministic localization
// ═══════════════════════════════════════════════════════════════

describe('561-B: NAV_FOOTER deterministic localization', () => {
  it('English footer matches expected string', () => {
    expect(getFlowCopy('en', 'nav.footer')).toBe('Type: back, menu (restart), or exit (leave)');
  });

  it('Pidgin footer uses pcm copy', () => {
    const footer = getFlowCopy('pcm', 'nav.footer');
    expect(footer).toContain('comot');
    expect(footer).not.toBe(getFlowCopy('en', 'nav.footer'));
  });

  it('footer is within WhatsApp 60-char limit for all certified languages', () => {
    for (const lang of CERTIFIED_LANGUAGES) {
      const footer = getFlowCopy(lang, 'nav.footer');
      expect(footer.length, `${lang} footer is ${footer.length} chars`).toBeLessThanOrEqual(60);
    }
  });

  it('uncertified language footer falls back to English', () => {
    expect(getFlowCopy('fr', 'nav.footer')).toBe(getFlowCopy('en', 'nav.footer'));
    expect(getFlowCopy('yo', 'nav.footer')).toBe(getFlowCopy('en', 'nav.footer'));
  });
});

// ═══════════════════════════════════════════════════════════════
// Executor error/recovery deterministic copy
// ═══════════════════════════════════════════════════════════════

describe('561-B: executor error/recovery deterministic copy', () => {
  const errorKeys = [
    'error.generic',
    'error.escalation_failed',
    'error.media_unsupported',
  ];

  for (const key of errorKeys) {
    it(`English ${key} is non-empty`, () => {
      expect(getFlowCopy('en', key).length).toBeGreaterThan(0);
    });

    it(`Pidgin ${key} differs from English`, () => {
      const en = getFlowCopy('en', key);
      const pcm = getFlowCopy('pcm', key);
      expect(pcm).not.toBe(en);
      expect(pcm.length).toBeGreaterThan(0);
    });

    it(`uncertified ${key} falls back to English`, () => {
      expect(getFlowCopy('fr', key)).toBe(getFlowCopy('en', key));
    });
  }
});

// ═══════════════════════════════════════════════════════════════
// Navigation deterministic copy
// ═══════════════════════════════════════════════════════════════

describe('561-B: navigation deterministic copy', () => {
  const navKeys = [
    'nav.cancelled',
    'nav.no_problem',
    'nav.at_beginning',
    'cancelHint',
  ];

  for (const key of navKeys) {
    it(`English ${key} contains bot commands`, () => {
      const en = getFlowCopy('en', key);
      // All nav strings contain at least one of: *Hi*, *menu*, *back*, *exit*
      expect(
        en.includes('*Hi*') || en.includes('*menu*') || en.includes('*back*') || en.includes('*exit*'),
        `${key} should contain bot commands`,
      ).toBe(true);
    });

    it(`Pidgin ${key} preserves bot commands`, () => {
      const en = getFlowCopy('en', key);
      const pcm = getFlowCopy('pcm', key);
      // Bot commands must be preserved exactly
      if (en.includes('*Hi*')) expect(pcm).toContain('*Hi*');
      if (en.includes('*menu*')) expect(pcm).toContain('*menu*');
      if (en.includes('*back*')) expect(pcm).toContain('*back*');
      if (en.includes('*exit*')) expect(pcm).toContain('*exit*');
    });
  }
});

// ═══════════════════════════════════════════════════════════════
// Language switch deterministic copy
// ═══════════════════════════════════════════════════════════════

describe('561-B: language switch deterministic copy', () => {
  it('lang.switched_english is deterministic', () => {
    expect(getFlowCopy('en', 'lang.switched_english')).toBe('Switched to English. ✅');
  });

  it('lang.switched preserves {langName} placeholder', () => {
    const en = getFlowCopy('en', 'lang.switched');
    expect(en).toContain('{langName}');
  });

  it('fillFlowCopy interpolates langName correctly', () => {
    const result = fillFlowCopy('en', 'lang.switched', { langName: 'Pidgin' });
    expect(result).toBe('Switched to Pidgin. ✅');
    expect(result).not.toContain('{langName}');
  });

  it('Pidgin lang.switched has different wording', () => {
    const pcm = getFlowCopy('pcm', 'lang.switched');
    expect(pcm).toContain('{langName}');
    expect(pcm).not.toBe(getFlowCopy('en', 'lang.switched'));
  });

  it('lang.not_available preserves {langName} placeholder', () => {
    const en = getFlowCopy('en', 'lang.not_available');
    expect(en).toContain('{langName}');
    const result = fillFlowCopy('en', 'lang.not_available', { langName: 'French' });
    expect(result).toContain('French');
    expect(result).not.toContain('{langName}');
  });
});

// ═══════════════════════════════════════════════════════════════
// Chat unavailable with protected businessName
// ═══════════════════════════════════════════════════════════════

describe('561-B: chat.unavailable with protected businessName', () => {
  it('preserves {businessName} placeholder', () => {
    const en = getFlowCopy('en', 'chat.unavailable');
    expect(en).toContain('{businessName}');
  });

  it('interpolates businessName without altering it', () => {
    const result = fillFlowCopy('en', 'chat.unavailable', { businessName: 'Bukka Hut' });
    expect(result).toContain('Bukka Hut');
    expect(result).not.toContain('{businessName}');
    expect(result).toContain('*menu*'); // bot command preserved
  });

  it('Pidgin variant preserves businessName exactly', () => {
    const result = fillFlowCopy('pcm', 'chat.unavailable', { businessName: 'Mama Put' });
    expect(result).toContain('Mama Put');
    expect(result).toContain('*menu*');
  });
});

// ═══════════════════════════════════════════════════════════════
// Booking chrome deterministic copy
// ═══════════════════════════════════════════════════════════════

describe('561-B: booking chrome deterministic copy', () => {
  const bookingKeys = [
    'booking.locations_title', 'booking.locations_body', 'booking.choose_location',
    'booking.no_locations', 'booking.location_not_found', 'booking.no_services',
    'booking.service_title', 'booking.service_not_found',
    'booking.session_title', 'booking.session_not_found',
    'booking.session_unavailable', 'booking.session_full',
    'booking.staff_title', 'booking.any_available', 'booking.no_staff',
    'booking.select_date', 'booking.choose_date', 'booking.no_dates',
    'booking.select_time', 'booking.choose_time', 'booking.time_hint',
    'booking.time_taken', 'booking.addons_title', 'booking.addons_body',
    'booking.promo_ask', 'booking.promo_invalid', 'booking.promo_expired',
    'booking.special_requests', 'booking.no_requests',
    'booking.confirm_btn', 'booking.confirm_hint', 'booking.cancelled',
    'booking.collect_name', 'booking.myself', 'booking.someone_else',
  ];

  it('all booking keys exist in English', () => {
    for (const key of bookingKeys) {
      expect(getFlowCopy('en', key), `en.${key} missing`).toBeTruthy();
    }
  });

  it('Pidgin booking keys differ from English for body text', () => {
    const bodyKeys = ['booking.locations_body', 'booking.no_locations', 'booking.no_services'];
    for (const key of bodyKeys) {
      expect(getFlowCopy('pcm', key), `pcm.${key}`).not.toBe(getFlowCopy('en', key));
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// Payment chrome deterministic copy
// ═══════════════════════════════════════════════════════════════

describe('561-B: payment chrome deterministic copy', () => {
  const paymentKeys = [
    'payment.ive_paid', 'payment.ive_paid_online', 'payment.ive_sent_transfer',
    'payment.get_new_link', 'payment.cancelled', 'payment.enter_name',
    'payment.invalid_name', 'payment.invalid_amount', 'payment.setup_failed',
    'payment.options_title', 'payment.pay_online', 'payment.bank_transfer_title',
    'payment.bank_transfer_header', 'payment.transfer_to', 'payment.tap_after_transfer',
    'payment.card_hint', 'payment.auto_confirm',
    'payment.complete_payment', 'payment.not_received', 'payment.verify_failed',
    'payment.still_verifying', 'payment.no_bank_ref',
  ];

  it('all payment keys exist in English', () => {
    for (const key of paymentKeys) {
      expect(getFlowCopy('en', key), `en.${key} missing`).toBeTruthy();
    }
  });

  it('Pidgin payment buttons differ from English', () => {
    expect(getFlowCopy('pcm', 'payment.ive_paid')).not.toBe(getFlowCopy('en', 'payment.ive_paid'));
  });

  it('payment.wrong_pin preserves {remaining} placeholder', () => {
    const result = fillFlowCopy('en', 'payment.wrong_pin', { remaining: 2 });
    expect(result).toContain('2');
    expect(result).not.toContain('{remaining}');
  });
});

// ═══════════════════════════════════════════════════════════════
// Ticketing chrome deterministic copy
// ═══════════════════════════════════════════════════════════════

describe('561-B: ticketing chrome deterministic copy', () => {
  const ticketingKeys = [
    'ticketing.no_events', 'ticketing.events_title', 'ticketing.view_events',
    'ticketing.event_not_found', 'ticketing.all_sold_out',
    'ticketing.types_title', 'ticketing.select_type', 'ticketing.type_not_found',
    'ticketing.checked_in', 'ticketing.other_events',
  ];

  it('all ticketing keys exist in English', () => {
    for (const key of ticketingKeys) {
      expect(getFlowCopy('en', key), `en.${key} missing`).toBeTruthy();
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// Ordering chrome deterministic copy
// ═══════════════════════════════════════════════════════════════

describe('561-B: ordering chrome deterministic copy', () => {
  const orderingKeys = [
    'ordering.categories_title', 'ordering.view_categories',
    'ordering.nothing_available', 'ordering.multiple_options',
    'ordering.back_to_categories', 'ordering.browse_other',
    'ordering.view_items', 'ordering.item_not_found',
    'ordering.browse_menu', 'ordering.checkout', 'ordering.checkout_confirm',
    'ordering.your_order', 'ordering.your_cart', 'ordering.add_more_items',
    'ordering.order_summary', 'ordering.confirm_order',
  ];

  it('all ordering keys exist in English', () => {
    for (const key of orderingKeys) {
      expect(getFlowCopy('en', key), `en.${key} missing`).toBeTruthy();
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// Capability selection / account menu chrome
// ═══════════════════════════════════════════════════════════════

describe('561-B: capability selection / account chrome', () => {
  const accountKeys = [
    'account.title', 'account.body',
    'account.my_bookings', 'account.my_bookings_desc',
    'account.my_orders', 'account.my_orders_desc',
    'account.my_giving', 'account.my_giving_desc',
    'account.my_invoices', 'account.my_invoices_desc',
    'account.my_contracts', 'account.my_contracts_desc',
    'account.my_quotes', 'account.my_quotes_desc',
    'account.my_points', 'account.my_points_desc',
    'account.subscriptions', 'account.subscriptions_desc',
    'account.get_receipt', 'account.get_receipt_desc',
    'menu.what_to_do', 'menu.title',
  ];

  it('all account/menu keys exist in English', () => {
    for (const key of accountKeys) {
      expect(getFlowCopy('en', key), `en.${key} missing`).toBeTruthy();
    }
  });

  it('Pidgin account menu titles differ where appropriate', () => {
    // Some titles may be kept as English for recognizability — that's OK
    // But body text should differ
    expect(getFlowCopy('pcm', 'menu.what_to_do')).not.toBe(getFlowCopy('en', 'menu.what_to_do'));
  });
});

// ═══════════════════════════════════════════════════════════════
// New 561-B keys exist in all locales
// ═══════════════════════════════════════════════════════════════

describe('561-B: new keys have full locale coverage', () => {
  const newKeys = [
    'booking.single_day_only', 'booking.end_date_title', 'booking.end_date_body',
    'booking.choose_end_date', 'booking.package_failed',
    'payment.pay_here', 'payment.setup_failed_saved', 'payment.link_title',
    'chat.unavailable', 'account.switch_instructions',
    'booking.address_prompt', 'booking.invalid_address',
    'booking.delivery_title', 'booking.delivery_body', 'booking.delivery_choose',
    'booking.delivery_select_hint', 'booking.end_date_invalid', 'booking.end_date_before_start',
  ];

  for (const key of newKeys) {
    it(`${key} exists in en and pcm`, () => {
      expect(_FLOW_COPY_FOR_TESTS.en[key], `en.${key}`).toBeTruthy();
      expect(_FLOW_COPY_FOR_TESTS.pcm[key], `pcm.${key}`).toBeTruthy();
    });
  }
});

// ═══════════════════════════════════════════════════════════════
// CERTIFIED_LANGUAGES unchanged
// ═══════════════════════════════════════════════════════════════

describe('561-B: CERTIFIED_LANGUAGES unchanged', () => {
  it('only en and pcm are certified', () => {
    expect(CERTIFIED_LANGUAGES).toEqual(['en', 'pcm']);
  });

  it('uncertified languages all fall back to English', () => {
    for (const lang of ['yo', 'ig', 'ha', 'tw', 'fr', 'es']) {
      expect(getFlowCopy(lang, 'nav.footer')).toBe(getFlowCopy('en', 'nav.footer'));
      expect(getFlowCopy(lang, 'error.generic')).toBe(getFlowCopy('en', 'error.generic'));
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// #559 backward compatibility preserved
// ═══════════════════════════════════════════════════════════════

describe('561-B: #559 backward compatibility', () => {
  it('getRerouteKey still works', async () => {
    const { getRerouteKey } = await import('../flows/flow-localization');
    expect(getRerouteKey('booking')).toBe('rerouteBooking');
    expect(getRerouteKey('ordering')).toBe('rerouteOrdering');
    expect(getRerouteKey('ticketing')).toBe('rerouteTicketing');
    expect(getRerouteKey('payment')).toBe('reroutePayment');
    expect(getRerouteKey(null)).toBe('rerouteGeneric');
  });

  it('legacy keys preserved in all certified locales', () => {
    const legacyKeys = ['invalidSelection', 'cancelHint', 'rerouteBooking',
      'rerouteOrdering', 'rerouteTicketing', 'reroutePayment', 'rerouteGeneric',
      'yes', 'stayHere'];
    for (const lang of CERTIFIED_LANGUAGES) {
      for (const key of legacyKeys) {
        expect(_FLOW_COPY_FOR_TESTS[lang][key], `${lang}.${key}`).toBeTruthy();
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// ENTITLEMENT BOUNDARY — canonical language authority
// ═══════════════════════════════════════════════════════════════

describe('561-B: entitlement boundary — resolveCopyLang equivalent', () => {
  // Simulates the resolveCopyLang helper logic: detected + entitled + certified = locale copy
  function resolveCopyLangSimulated(
    detected: string | undefined,
    allowedLanguages: readonly string[],
  ): string {
    if (!detected || detected === 'en') return 'en';
    if (!allowedLanguages.includes(detected)) return 'en';
    return detected;
  }

  it('detected pcm + NOT entitled => English', () => {
    // Free tier, English-only business
    const lang = resolveCopyLangSimulated('pcm', ['en']);
    expect(lang).toBe('en');
    expect(getFlowCopy(lang, 'nav.footer')).toBe(getFlowCopy('en', 'nav.footer'));
    expect(getFlowCopy(lang, 'error.generic')).toBe(getFlowCopy('en', 'error.generic'));
    expect(getFlowCopy(lang, 'nav.cancelled')).toBe(getFlowCopy('en', 'nav.cancelled'));
    expect(getFlowCopy(lang, 'booking.no_locations')).toBe(getFlowCopy('en', 'booking.no_locations'));
    expect(getFlowCopy(lang, 'payment.ive_paid')).toBe(getFlowCopy('en', 'payment.ive_paid'));
  });

  it('detected pcm + entitled => Pidgin copy', () => {
    // Growth tier, pcm configured
    const lang = resolveCopyLangSimulated('pcm', ['en', 'pcm']);
    expect(lang).toBe('pcm');
    // Footer should be Pidgin
    expect(getFlowCopy(lang, 'nav.footer')).toContain('comot');
    expect(getFlowCopy(lang, 'nav.footer')).not.toBe(getFlowCopy('en', 'nav.footer'));
    // Error messages should be Pidgin
    expect(getFlowCopy(lang, 'error.generic')).toContain('no go well');
    // Navigation should be Pidgin
    expect(getFlowCopy(lang, 'nav.cancelled')).toContain('Don cancel');
    // Booking chrome should be Pidgin
    expect(getFlowCopy(lang, 'booking.no_locations')).toContain('Abeg');
    // Payment buttons should be Pidgin
    expect(getFlowCopy(lang, 'payment.ive_paid')).toBe('I Don Pay');
  });

  it('detected yo (uncertified) + entitled => English fallback', () => {
    // Even if business entitled to yo, it is NOT certified
    const lang = resolveCopyLangSimulated('yo', ['en', 'yo']);
    expect(lang).toBe('yo');
    // getFlowCopy gates on certification — yo is NOT certified, falls back to English
    expect(getFlowCopy(lang, 'nav.footer')).toBe(getFlowCopy('en', 'nav.footer'));
    expect(getFlowCopy(lang, 'error.generic')).toBe(getFlowCopy('en', 'error.generic'));
  });

  it('no detected language => English', () => {
    const lang = resolveCopyLangSimulated(undefined, ['en', 'pcm']);
    expect(lang).toBe('en');
    expect(getFlowCopy(lang, 'nav.footer')).toBe(getFlowCopy('en', 'nav.footer'));
  });

  it('detected en => English', () => {
    const lang = resolveCopyLangSimulated('en', ['en', 'pcm']);
    expect(lang).toBe('en');
  });
});

// ═══════════════════════════════════════════════════════════════
// EXECUTABLE FLOW RUNTIME — scheduling prompt output
// ═══════════════════════════════════════════════════════════════

describe('561-B: scheduling flow uses getFlowCopy for static chrome', () => {
  it('scheduling.flow.ts imports getFlowCopy', async () => {
    // Verify the file exports functions that use getFlowCopy
    const flowModule = await import('../flows/scheduling.flow');
    expect(flowModule).toBeDefined();
    // The flow definition should exist
    expect(flowModule.default || flowModule.schedulingFlow).toBeDefined();
  });

  it('scheduling flow source contains getFlowCopy calls', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('lib/bot/flows/scheduling.flow.ts', 'utf-8');
    // Must contain getFlowCopy imports and calls for booking chrome
    expect(source).toContain("getFlowCopy");
    expect(source).toContain("ctx.copyLang");
    // Static booking chrome should use corpus keys, not hardcoded strings
    expect(source).toContain("'booking.locations_title'");
    expect(source).toContain("'booking.service_title'");
    expect(source).toContain("'booking.select_date'");
    expect(source).toContain("'booking.select_time'");
    expect(source).toContain("'booking.confirm_btn'");
    expect(source).toContain("'nav.cancel'");
  });
});

// ═══════════════════════════════════════════════════════════════
// EXECUTABLE FLOW RUNTIME — capability-selection uses getFlowCopy
// ═══════════════════════════════════════════════════════════════

describe('561-B: capability-selection uses getFlowCopy for account/menu chrome', () => {
  it('capability-selection source contains getFlowCopy calls', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('lib/bot/flows/capability-selection.flow.ts', 'utf-8');
    expect(source).toContain("getFlowCopy");
    expect(source).toContain("ctx.copyLang");
    expect(source).toContain("'account.title'");
    expect(source).toContain("'account.my_bookings'");
    expect(source).toContain("'account.my_orders'");
    expect(source).toContain("'menu.what_to_do'");
    expect(source).toContain("'menu.title'");
    expect(source).toContain("'nav.back'");
    expect(source).toContain("'nav.view_options'");
  });
});

// ═══════════════════════════════════════════════════════════════
// EXECUTABLE FLOW RUNTIME — payment/ordering/ticketing use getFlowCopy
// ═══════════════════════════════════════════════════════════════

describe('561-B: payment flow uses getFlowCopy', () => {
  it('payment.flow.ts source contains getFlowCopy calls', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('lib/bot/flows/payment.flow.ts', 'utf-8');
    expect(source).toContain("getFlowCopy");
    expect(source).toContain("ctx.copyLang");
    expect(source).toContain("'payment.ive_paid'");
    expect(source).toContain("'payment.cancelled'");
    expect(source).toContain("'nav.cancel'");
  });
});

describe('561-B: ordering flow uses getFlowCopy', () => {
  it('ordering.flow.ts source contains getFlowCopy calls', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
    expect(source).toContain("getFlowCopy");
    expect(source).toContain("ctx.copyLang");
    expect(source).toContain("'ordering.categories_title'");
    expect(source).toContain("'ordering.checkout'");
    expect(source).toContain("'nav.cancel'");
  });
});

describe('561-B: ticketing flow uses getFlowCopy', () => {
  it('ticketing.flow.ts source contains getFlowCopy calls', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('lib/bot/flows/ticketing.flow.ts', 'utf-8');
    expect(source).toContain("getFlowCopy");
    expect(source).toContain("ctx.copyLang");
    expect(source).toContain("'ticketing.events_title'");
    expect(source).toContain("'ticketing.view_events'");
    expect(source).toContain("'payment.ive_paid'");
  });
});

// ═══════════════════════════════════════════════════════════════
// CANONICAL VALUES UNCHANGED — protected authoritative data
// ═══════════════════════════════════════════════════════════════

describe('561-B: canonical authoritative values unchanged', () => {
  it('fillFlowCopy preserves businessName exactly', () => {
    const result = fillFlowCopy('pcm', 'chat.unavailable', { businessName: 'Bukka Hut ₦5,000' });
    expect(result).toContain('Bukka Hut ₦5,000');
  });

  it('fillFlowCopy preserves langName exactly', () => {
    const result = fillFlowCopy('pcm', 'lang.switched', { langName: 'Nigerian Pidgin' });
    expect(result).toContain('Nigerian Pidgin');
  });

  it('fillFlowCopy preserves remaining count exactly', () => {
    const result = fillFlowCopy('pcm', 'payment.wrong_pin', { remaining: 2 });
    expect(result).toContain('2');
  });

  it('getFlowCopy never alters key values', () => {
    // Verify no value contains unexpected interpolation
    for (const key of ALL_FLOW_COPY_KEYS) {
      const en = getFlowCopy('en', key);
      const pcm = getFlowCopy('pcm', key);
      // Neither should contain unresolved {placeholder} unless the key has registered placeholders
      if (!en.includes('{')) {
        expect(pcm, `pcm.${key} should not have unexpected placeholders`).not.toMatch(/\{[a-zA-Z]+\}/);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// RAW _detected_language NOT used for copy selection in executor
// ═══════════════════════════════════════════════════════════════

describe('561-B: executor does not use raw _detected_language for copy selection', () => {
  it('executor source uses resolveCopyLang, not raw _detected_language for getFlowCopy', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('lib/bot/flows/executor.ts', 'utf-8');
    // Should NOT have the pattern: (session.session_data._detected_language as string) || 'en'
    // followed by getFlowCopy on the next line
    const rawPattern = /const \w+Lang = \(session\.session_data\._detected_language as string\) \|\| 'en'/g;
    const rawMatches = source.match(rawPattern) || [];
    expect(rawMatches.length, 'Should not have raw _detected_language || en patterns for copy selection').toBe(0);
    // Should have resolveCopyLang calls
    expect(source).toContain('resolveCopyLang');
    expect(source).toContain('this.resolveCopyLang(session, entitlement)');
  });
});

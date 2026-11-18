/**
 * Yoruba (yo) and Igbo (ig) certification (Owner decision 2026-11-18: "Fix, test, then turn on").
 *
 * Certified means the deterministic phrase book is served as written, so the
 * bar here is the same as the corpus governance tests plus:
 * - every key has its own yo/ig wording (no English left in the phrase book),
 * - every button / list title fits WhatsApp limits, counted as the app slices
 *   titles (UTF-16 `.length` of the NFC string, so tone marks count),
 * - every menu label fits a button (a menu of 3 or fewer options uses buttons),
 * - hints that say "tap" quote the button the customer actually sees,
 * - no yo/ig item is left open in OWNER_REVIEW_ITEMS,
 * - each customer journey renders in yo/ig through the runtime resolver.
 */
import { describe, it, expect } from 'vitest';
import {
  getFlowCopy,
  fillFlowCopy,
  isPhraseBookText,
  ALL_FLOW_COPY_KEYS,
  BUTTON_TITLE_KEYS,
  LIST_TITLE_KEYS,
  PLACEHOLDER_SCHEMA,
  OWNER_REVIEW_ITEMS,
  _FLOW_COPY_FOR_TESTS as COPY,
} from '../flows/flow-localization';
import { CERTIFIED_LANGUAGES, CERTIFIED_LANGUAGE_OPTIONS } from '@/lib/bot/languages';
import { getEffectiveLanguages, detectLanguageDeterministic } from '@/lib/bot/language-policy';
import { resolveEffectiveResponseLanguage } from '@/lib/bot/language-preference';
import { getCapabilityLabel } from '@/lib/capabilities/labels';
import { formatBankTransferBlock, getBankOnlyButtons, getDualOptionButtons } from '../flows/shared/bank-transfer';

const LANGS = ['yo', 'ig'] as const;

/**
 * Keys whose wording is legitimately the same as English in a language
 * (no translatable words). Kept explicit so a new English leftover fails.
 */
const SAME_AS_ENGLISH_ALLOWED: Record<(typeof LANGS)[number], readonly string[]> = {
  yo: [],
  ig: [],
};

/** Keys rendered by each customer journey named in the certification brief. */
const JOURNEYS: Record<string, readonly string[]> = {
  menu: ['menu.title', 'menu.what_to_do', 'nav.footer', 'nav.back', 'nav.back_to_menu', 'nav.more_options', 'greeting.welcome_default', 'greeting.cancel_hint', 'greeting.welcome_back_named', 'cap.scheduling', 'cap.appointment', 'cap.ordering', 'cap.payment', 'cap.ticketing', 'cap.table_reservation', 'cap.my_account'],
  booking: ['booking.select_date', 'booking.type_date_hint', 'booking.later_dates', 'booking.earlier_dates', 'booking.select_time', 'booking.confirm_question', 'booking.confirm_btn', 'booking.collect_name', 'booking.cancelled', 'post.book_again', 'post.my_bookings'],
  ordering: ['ordering.welcome', 'ordering.welcome_categories', 'ordering.browse', 'ordering.choose_option', 'ordering.cart_info', 'ordering.total_label', 'ordering.checkout', 'ordering.confirm_order', 'ordering.edit_body', 'ordering.edit_change_name', 'ordering.delivery', 'ordering.pickup', 'ordering.pay_online_option', 'ordering.bank_transfer_option', 'ordering.pay_here', 'ordering.auto_confirm', 'ordering.after_paying', 'ordering.order_received', 'ordering.order_confirmed', 'ordering.order_cancelled', 'post.order_again'],
  payment: ['payment.options_title', 'payment.pay_online', 'payment.bank_transfer_title', 'payment.bank_label', 'payment.account_label', 'payment.name_label', 'payment.amount_label', 'payment.ref_label', 'payment.ref_warning', 'payment.transfer_hint', 'payment.ive_paid', 'payment.ive_paid_online', 'payment.paid_online_btn', 'payment.ive_sent_transfer', 'payment.ive_paid_hint', 'payment.received_processing', 'payment.verifying', 'payment.not_received', 'payment.get_new_link', 'payment.cancelled', 'savedcard.pay_with_saved', 'savedcard.pay_with_last4', 'savedcard.use_different'],
  tickets: ['ticketing.view_events', 'ticketing.events_title', 'ticketing.types_title', 'ticketing.one_ticket', 'ticketing.two_tickets', 'post.buy_more_tickets', 'post.my_tickets', 'notification.ticket_pdf_caption'],
  account: ['account.title', 'account.body', 'account.my_bookings', 'account.my_orders', 'account.bookings_title', 'account.no_bookings', 'nav.back_to_account', 'updates.account_title', 'updates.confirm', 'updates.confirm_yes', 'updates.confirm_no', 'savedcard.btn_main_menu', 'savedcard.btn_done', 'docs.continue_hint'],
  cancel: ['nav.cancel', 'nav.cancelled', 'cancelHint', 'payment.cancel_booking', 'ordering.cancel_order', 'recurring.yes_cancel', 'recurring.keep_it', 'recurring.cancel_hint', 'recurring.cancelled_ok'],
};

const sampleValues = (key: string): Record<string, string> =>
  Object.fromEntries((PLACEHOLDER_SCHEMA.get(key) ?? []).map(p => [p, `<${p}>`]));

describe('yo/ig are certified; other languages unchanged', () => {
  it('certifies exactly en, pcm, yo and ig', () => {
    expect(CERTIFIED_LANGUAGES).toEqual(['en', 'pcm', 'yo', 'ig']);
    for (const lang of ['ha', 'tw', 'fr', 'es']) expect(CERTIFIED_LANGUAGES).not.toContain(lang);
  });

  it('merchants can select Yorùbá and Igbo', () => {
    const names = CERTIFIED_LANGUAGE_OPTIONS.map(l => l.nativeName);
    expect(names).toContain('Yorùbá');
    expect(names).toContain('Igbo');
  });

  it('Business tier entitles yo and ig; Growth can configure them', () => {
    expect(getEffectiveLanguages('business', []).allowedLanguages).toEqual(expect.arrayContaining(['yo', 'ig']));
    expect(getEffectiveLanguages('growth', ['en', 'yo', 'ig']).allowedLanguages).toEqual(expect.arrayContaining(['yo', 'ig']));
  });
});

for (const lang of LANGS) {
  describe(`${lang}: phrase book complete`, () => {
    it('has its own wording for every key (no English left)', () => {
      const leftovers = ALL_FLOW_COPY_KEYS.filter(
        k => COPY[lang][k] === COPY.en[k] && !SAME_AS_ENGLISH_ALLOWED[lang].includes(k),
      );
      expect(leftovers).toEqual([]);
    });

    it('has every English key', () => {
      expect(ALL_FLOW_COPY_KEYS.filter(k => !COPY[lang][k])).toEqual([]);
    });

    it('is stored NFC-normalised', () => {
      const notNfc = Object.entries(COPY[lang]).filter(([, v]) => v !== v.normalize('NFC')).map(([k]) => k);
      expect(notNfc).toEqual([]);
    });

    it('keeps every placeholder used in English', () => {
      const broken: string[] = [];
      for (const k of ALL_FLOW_COPY_KEYS) {
        for (const ph of COPY.en[k].match(/\{\w+\}/g) ?? []) {
          if (!COPY[lang][k].includes(ph)) broken.push(`${k} ${ph}`);
        }
      }
      expect(broken).toEqual([]);
    });

    it('keeps STOP/START and the typed words *updates* / *directory* in English', () => {
      for (const k of ALL_FLOW_COPY_KEYS.filter(key => key.startsWith('updates.'))) {
        for (const word of ['STOP', 'START', '*updates*', '*directory*', 'Waaiio', '{businessName}']) {
          if (COPY.en[k].includes(word)) expect(COPY[lang][k], `${lang}.${k} ${word}`).toContain(word);
        }
      }
    });
  });

  describe(`${lang}: WhatsApp limits (UTF-16 length of NFC text)`, () => {
    const fits = (keys: readonly string[], max: number) =>
      keys.filter(k => COPY[lang][k] && COPY[lang][k].normalize('NFC').length > max)
        .map(k => `${k} = "${COPY[lang][k]}" (${COPY[lang][k].length})`);

    it('button titles are 20 or fewer', () => expect(fits(BUTTON_TITLE_KEYS, 20)).toEqual([]));
    it('list titles are 24 or fewer', () => expect(fits(LIST_TITLE_KEYS, 24)).toEqual([]));
    it('menu labels (cap.*) fit a button: 20 or fewer', () => {
      expect(fits(ALL_FLOW_COPY_KEYS.filter(k => k.startsWith('cap.')), 20)).toEqual([]);
    });
  });

  describe(`${lang}: hints quote the buttons the customer sees`, () => {
    const t = (k: string) => COPY[lang][k];
    it('"I\'ve Paid" hints quote the localized button', () => {
      for (const k of ['payment.received_processing', 'payment.ive_paid_hint', 'payment.already_paid_hint', 'payment.still_verifying', 'payment.verify_failed']) {
        expect(t(k), `${lang}.${k}`).toContain(`*${t('payment.ive_paid')}*`);
        expect(t(k), `${lang}.${k}`).not.toContain("I've Paid");
      }
    });
    it('"Get New Link" hint quotes the localized button', () => {
      expect(t('payment.not_received')).toContain(`*${t('payment.get_new_link')}*`);
    });
    it('bank transfer hint quotes the localized "sent transfer" button', () => {
      expect(t('payment.transfer_hint')).toContain(t('payment.ive_sent_transfer'));
      expect(t('payment.transfer_hint')).not.toContain("I've Sent");
    });
    it('typed-word hints keep the English words the parser accepts', () => {
      // scheduling.flow.ts book_for validate() accepts only myself / someone else (or the buttons).
      expect(t('booking.book_for_hint')).toContain('*myself*');
      expect(t('booking.book_for_hint')).toContain('*someone else*');
    });
    it('recurring hints quote the localized buttons', () => {
      expect(t('recurring.cancel_hint')).toContain(`*${t('recurring.yes_cancel')}*`);
      expect(t('recurring.cancel_hint')).toContain(`*${t('recurring.keep_it')}*`);
      expect(t('recurring.pause_hint')).toContain(`*${t('recurring.yes_pause')}*`);
      expect(t('recurring.pause_hint')).toContain(`*${t('recurring.no_keep_active')}*`);
    });
  });

  describe(`${lang}: customer journeys render through the runtime resolver`, () => {
    for (const [journey, keys] of Object.entries(JOURNEYS)) {
      it(`${journey}: every message is ${lang} copy, filled, with no English fallback`, () => {
        for (const key of keys) {
          expect(COPY.en[key], `unknown key ${key}`).toBeDefined();
          const text = fillFlowCopy(lang, key, sampleValues(key));
          expect(getFlowCopy(lang, key), `${lang}.${key} served`).toBe(COPY[lang][key]);
          expect(getFlowCopy(lang, key), `${lang}.${key} is English`).not.toBe(COPY.en[key]);
          for (const ph of PLACEHOLDER_SCHEMA.get(key) ?? []) expect(text).not.toContain(`{${ph}}`);
        }
      });
    }

    it('menu labels resolve to the language for every capability', () => {
      for (const cap of ['scheduling', 'appointment', 'ordering', 'payment', 'ticketing', 'table_reservation'] as const) {
        expect(getCapabilityLabel(cap, 'salon', null, lang)).not.toBe(getCapabilityLabel(cap, 'salon', null, 'en'));
      }
    });

    it('bank transfer block and "I\'ve Paid" buttons render in the language', () => {
      const block = formatBankTransferBlock({ bank_name: 'First Bank', account_number: '0123456789', account_name: 'Bukka Hut Ltd' }, '₦5,000', 'WA-A1B2', lang);
      for (const value of ['First Bank', '0123456789', 'Bukka Hut Ltd', '₦5,000', '*WA-A1B2*']) expect(block).toContain(value);
      for (const english of ['Bank:', 'Account:', 'Name:', 'Amount:', 'Use reference', 'After transferring']) expect(block).not.toContain(english);
      for (const btn of [...getDualOptionButtons(lang), ...getBankOnlyButtons(lang)]) {
        expect(btn.title.length).toBeLessThanOrEqual(20);
      }
      expect(getDualOptionButtons(lang)[0].title).toBe(COPY[lang]['payment.paid_online_btn']);
    });

    it('phrase-book text is sent as written (no AI rewording)', () => {
      expect(isPhraseBookText(lang, COPY[lang]['nav.cancelled'])).toBe(true);
      expect(isPhraseBookText(lang, COPY.en['nav.cancelled'])).toBe(false);
    });
  });
}

describe('yo/ig: language detection and response authority', () => {
  it.each([
    ['Bawo ni, mo fe book', 'yo'],
    ['E jowo, mo nilo appointment', 'yo'],
    ['Kedu, biko achoro m order', 'ig'],
    ['Ndewo, daalu', 'ig'],
  ])('"%s" → %s', (text, lang) => {
    expect(detectLanguageDeterministic(text)).toBe(lang);
  });

  it.each(LANGS)('remembered %s is served on a Business tier', lang => {
    expect(resolveEffectiveResponseLanguage({
      rememberedLanguage: lang,
      entitlement: getEffectiveLanguages('business', []),
      certifiedLanguages: CERTIFIED_LANGUAGES,
    }).language).toBe(lang);
  });
});

describe('Owner review list', () => {
  it('has no open yo or ig item', () => {
    expect(OWNER_REVIEW_ITEMS.filter(i => i.locale === 'yo' || i.locale === 'ig')).toEqual([]);
  });
});

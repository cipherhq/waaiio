/**
 * Slice 6 Gate 1 — Nigerian Pidgin (pcm) certification corpus (#524)
 *
 * 55 realistic WhatsApp utterances across 12 categories.
 * Each utterance specifies both inbound detection expectations and
 * response-language authority under a concrete entitlement scenario.
 *
 * Default scenario: Growth tier with pcm configured + pcm certified.
 * Negative/fallback tests override the scenario per-utterance.
 */
import type { LanguageCorpus, EntitlementScenario } from './certification-harness';

/** Growth tier with Pidgin configured and (hypothetically) certified. */
const GROWTH_PCM: EntitlementScenario = {
  tier: 'growth',
  configuredLanguages: ['en', 'pcm'],
};

/** Business tier — all certified languages available. */
const BUSINESS: EntitlementScenario = { tier: 'business' };

/** Free tier — English only, no translation. */
const FREE: EntitlementScenario = { tier: 'free' };

/** Growth tier WITHOUT pcm configured. */
const GROWTH_NO_PCM: EntitlementScenario = {
  tier: 'growth',
  configuredLanguages: ['en'],
};

export const PIDGIN_CORPUS: LanguageCorpus = {
  language: 'pcm',
  displayName: 'Nigerian Pidgin',
  nativeName: 'Naija',
  utterances: [
    // ═══════════════════════════════════════════════════════════════
    // 1. Greetings (5)
    // ═══════════════════════════════════════════════════════════════
    {
      text: 'How far', category: 'greeting',
      expectedInboundLanguage: null, // too short/ambiguous for deterministic detector
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'en',
      shouldActivateLanguage: false,
      notes: 'Common Pidgin greeting but "how far" is also English slang',
    },
    {
      text: 'Wetin dey happen', category: 'greeting',
      expectedInboundLanguage: 'pcm',
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'pcm',
      shouldActivateLanguage: true,
      notes: '"wetin" + "dey" are strong Pidgin markers',
    },
    {
      text: 'Bros how you dey', category: 'greeting',
      expectedInboundLanguage: 'pcm',
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'pcm',
      shouldActivateLanguage: true,
      notes: '"bros" + "dey" trigger Pidgin detection',
    },
    {
      text: 'Oga good morning o', category: 'greeting',
      expectedInboundLanguage: 'pcm',
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'pcm',
      shouldActivateLanguage: true,
      notes: '"oga" is a strong Pidgin marker',
    },
    {
      text: 'Abeg how body', category: 'greeting',
      expectedInboundLanguage: 'pcm',
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'pcm',
      shouldActivateLanguage: true,
    },

    // ═══════════════════════════════════════════════════════════════
    // 2. Native orthography intent (6)
    // ═══════════════════════════════════════════════════════════════
    {
      text: 'Abeg I wan book haircut for 3pm', category: 'native-intent',
      expectedInboundLanguage: 'pcm', expectedIntent: 'booking',
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'pcm',
      shouldActivateLanguage: true,
    },
    {
      text: 'I wan chop jollof rice and chicken', category: 'native-intent',
      expectedInboundLanguage: 'pcm', expectedIntent: 'ordering',
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'pcm',
      shouldActivateLanguage: true,
      notes: '"I wan" + "chop" = Pidgin ordering pattern',
    },
    {
      text: 'Make I pay for the service wey I book', category: 'native-intent',
      expectedInboundLanguage: 'pcm', expectedIntent: 'payment',
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'pcm',
      shouldActivateLanguage: true,
    },
    {
      text: 'Abeg give me two ticket for the show', category: 'native-intent',
      expectedInboundLanguage: 'pcm', expectedIntent: 'ticketing',
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'pcm',
      shouldActivateLanguage: true,
    },
    {
      text: 'I wan reserve one room for two nights abeg', category: 'native-intent',
      expectedInboundLanguage: 'pcm', expectedIntent: 'booking',
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'pcm',
      shouldActivateLanguage: true,
    },
    {
      text: 'Wetin be the price for this service', category: 'native-intent',
      expectedInboundLanguage: 'pcm',
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'pcm',
      shouldActivateLanguage: true,
    },

    // ═══════════════════════════════════════════════════════════════
    // 3. ASCII / unaccented forms (5)
    // ═══════════════════════════════════════════════════════════════
    {
      text: 'abeg i wan bk appointment', category: 'ascii',
      expectedInboundLanguage: 'pcm', expectedIntent: 'booking',
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'pcm',
      shouldActivateLanguage: true,
      notes: 'Informal abbreviation "bk" for "book"',
    },
    {
      text: 'bros help me oda food', category: 'ascii',
      expectedInboundLanguage: 'pcm', expectedIntent: 'ordering',
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'pcm',
      shouldActivateLanguage: true,
    },
    {
      text: 'oga help me pay dis money sharp sharp', category: 'ascii',
      expectedInboundLanguage: 'pcm', expectedIntent: 'payment',
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'pcm',
      shouldActivateLanguage: true,
    },
    {
      text: 'i wan buy tikket for d concert', category: 'ascii',
      expectedInboundLanguage: 'pcm', expectedIntent: 'ticketing',
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'pcm',
      shouldActivateLanguage: true,
      notes: '"tikket" is common WhatsApp misspelling of "ticket"',
    },
    {
      text: 'wetin dey d menu sef', category: 'ascii',
      expectedInboundLanguage: 'pcm',
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'pcm',
      shouldActivateLanguage: true,
    },

    // ═══════════════════════════════════════════════════════════════
    // 4. Code-switching (5)
    // ═══════════════════════════════════════════════════════════════
    {
      text: 'Please I wan book for tomorrow abeg', category: 'code-switch',
      expectedInboundLanguage: 'pcm', expectedIntent: 'booking',
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'pcm',
      shouldActivateLanguage: true,
      notes: 'English "please" + Pidgin "I wan" + "abeg"',
    },
    {
      text: 'Can you help me order? I dey hungry sha', category: 'code-switch',
      expectedInboundLanguage: 'pcm', expectedIntent: 'ordering',
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'pcm',
      shouldActivateLanguage: true,
    },
    {
      text: 'I want to pay, how much I go pay sha?', category: 'code-switch',
      expectedInboundLanguage: 'pcm', expectedIntent: 'payment',
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'pcm',
      shouldActivateLanguage: true,
    },
    {
      text: 'Get me a ticket for Saturday abeg', category: 'code-switch',
      expectedInboundLanguage: 'pcm', expectedIntent: 'ticketing',
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'pcm',
      shouldActivateLanguage: true,
    },
    {
      text: 'Help me check my booking, the one wey I book yesterday', category: 'code-switch',
      expectedInboundLanguage: null, // "wey" is not in deterministic detector markers
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'en',
      shouldActivateLanguage: false,
      notes: 'Code-switch with "wey" — not detected by deterministic detector (would need LLM)',
    },

    // ═══════════════════════════════════════════════════════════════
    // 5. Typos / slang (4)
    // ═══════════════════════════════════════════════════════════════
    {
      text: 'Abg I wan bk for 2moro', category: 'typo-slang',
      expectedInboundLanguage: 'pcm', expectedIntent: 'booking',
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'pcm',
      shouldActivateLanguage: true,
      notes: '"Abg" = "Abeg", "bk" = "book", "2moro" = "tomorrow"',
    },
    {
      text: 'watin dey ur menu bros', category: 'typo-slang',
      expectedInboundLanguage: 'pcm',
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'pcm',
      shouldActivateLanguage: true,
      notes: '"watin" = "wetin" variant',
    },
    {
      text: 'hw mch for haircut sef', category: 'typo-slang',
      expectedInboundLanguage: 'pcm',
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'pcm',
      shouldActivateLanguage: true,
    },
    {
      text: 'I don pay o check am na', category: 'typo-slang',
      expectedInboundLanguage: null, // "don", "am" not in deterministic markers; "na" removed from tight set
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'en',
      shouldActivateLanguage: false,
      notes: 'Pidgin structure but lacks strong markers for deterministic detection',
    },

    // ═══════════════════════════════════════════════════════════════
    // 6. Create intent (4)
    // ═══════════════════════════════════════════════════════════════
    {
      text: 'I wan book appointment for next week', category: 'create',
      expectedInboundLanguage: 'pcm', expectedIntent: 'booking',
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'pcm',
      shouldActivateLanguage: true,
    },
    {
      text: 'I wan order food come my house', category: 'create',
      expectedInboundLanguage: 'pcm', expectedIntent: 'ordering',
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'pcm',
      shouldActivateLanguage: true,
    },
    {
      text: 'Make I pay offering for church', category: 'create',
      expectedInboundLanguage: 'pcm', expectedIntent: 'payment',
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'pcm',
      shouldActivateLanguage: true,
    },
    {
      text: 'I wan buy three ticket for the party', category: 'create',
      expectedInboundLanguage: 'pcm', expectedIntent: 'ticketing',
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'pcm',
      shouldActivateLanguage: true,
    },

    // ═══════════════════════════════════════════════════════════════
    // 7. Manage intent (3)
    // ═══════════════════════════════════════════════════════════════
    {
      text: 'Check my booking for me abeg', category: 'manage',
      expectedInboundLanguage: 'pcm',
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'pcm',
      shouldActivateLanguage: true,
    },
    {
      text: 'I wan cancel the thing wey I book', category: 'manage',
      expectedInboundLanguage: 'pcm',
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'pcm',
      shouldActivateLanguage: true,
    },
    {
      text: 'Where my order dey sef', category: 'manage',
      expectedInboundLanguage: 'pcm',
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'pcm',
      shouldActivateLanguage: true,
    },

    // ═══════════════════════════════════════════════════════════════
    // 8. History / info intent (3)
    // ═══════════════════════════════════════════════════════════════
    {
      text: 'Show me my receipt abeg', category: 'history-info',
      expectedInboundLanguage: 'pcm',
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'pcm',
      shouldActivateLanguage: true,
    },
    {
      text: 'How much I don pay altogether for dis business', category: 'history-info',
      expectedInboundLanguage: 'pcm',
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'pcm',
      shouldActivateLanguage: true,
    },
    {
      text: 'My transaction history dey where', category: 'history-info',
      expectedInboundLanguage: 'pcm',
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'pcm',
      shouldActivateLanguage: true,
    },

    // ═══════════════════════════════════════════════════════════════
    // 9. Navigation / recovery (4)
    // ═══════════════════════════════════════════════════════════════
    {
      text: 'Go back abeg', category: 'navigation',
      expectedInboundLanguage: 'pcm',
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'pcm',
      shouldActivateLanguage: false,
      notes: 'Navigation command — does not activate language, uses existing session language',
    },
    {
      text: 'I wan start over', category: 'navigation',
      expectedInboundLanguage: 'pcm',
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'pcm',
      shouldActivateLanguage: false,
    },
    {
      text: 'No be this one, cancel am', category: 'navigation',
      expectedInboundLanguage: null, // "no be" is not "no vex", lacks strong markers
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'en',
      shouldActivateLanguage: false,
    },
    {
      text: 'Abeg help me, I no sabi wetin to do', category: 'navigation',
      expectedInboundLanguage: 'pcm',
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'pcm',
      shouldActivateLanguage: false,
    },

    // ═══════════════════════════════════════════════════════════════
    // 10. Language switching (3)
    // ═══════════════════════════════════════════════════════════════
    {
      text: 'Speak Pidgin for me', category: 'lang-switch',
      expectedInboundLanguage: null, // English sentence requesting Pidgin
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'pcm',
      shouldActivateLanguage: true,
      notes: 'English request to switch to Pidgin — parseLanguagePreferenceIntent handles this',
    },
    {
      text: 'Abeg reply me for Naija', category: 'lang-switch',
      expectedInboundLanguage: 'pcm',
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'pcm',
      shouldActivateLanguage: true,
    },
    {
      text: 'Use Pidgin from now on always', category: 'lang-switch',
      expectedInboundLanguage: null,
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'pcm',
      shouldActivateLanguage: true,
      notes: '"from now on always" triggers persistent preference write',
    },

    // ═══════════════════════════════════════════════════════════════
    // 11. Corrections (3)
    // ═══════════════════════════════════════════════════════════════
    {
      text: 'No be this one, the other one', category: 'correction',
      expectedInboundLanguage: null, // "no be" lacks deterministic markers
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'en',
      shouldActivateLanguage: false,
    },
    {
      text: 'I no mean that, I mean the 5000 naira one', category: 'correction',
      expectedInboundLanguage: null, // "no" ≠ "nor", lacks markers
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'en',
      shouldActivateLanguage: false,
    },
    {
      text: 'Wrong service abeg, na the other one I wan', category: 'correction',
      expectedInboundLanguage: 'pcm',
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'pcm',
      shouldActivateLanguage: false,
    },

    // ═══════════════════════════════════════════════════════════════
    // 12. Negative examples (5) — other languages, must NOT match pcm
    // ═══════════════════════════════════════════════════════════════
    {
      text: 'Buenos días, quiero reservar una cita', category: 'negative',
      expectedInboundLanguage: 'es',
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'en',
      shouldActivateLanguage: false,
      notes: 'Spanish — should detect es, not pcm. es is not certified → English fallback.',
    },
    {
      text: 'Bonjour, je veux réserver un rendez-vous', category: 'negative',
      expectedInboundLanguage: 'fr',
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'en',
      shouldActivateLanguage: false,
      notes: 'French — should detect fr, not pcm',
    },
    {
      text: 'Kedu, achọrọ m ịzụta tiketi', category: 'negative',
      expectedInboundLanguage: 'ig',
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'en',
      shouldActivateLanguage: false,
      notes: 'Igbo — should detect ig, not pcm',
    },
    {
      text: 'Sannu, ina son yin booking', category: 'negative',
      expectedInboundLanguage: 'ha',
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'en',
      shouldActivateLanguage: false,
      notes: 'Hausa — should detect ha, not pcm',
    },
    {
      text: 'Mo fẹ́ book appointment kan', category: 'negative',
      expectedInboundLanguage: 'yo',
      scenario: GROWTH_PCM, expectedEffectiveResponseLanguage: 'en',
      shouldActivateLanguage: false,
      notes: 'Yoruba — should detect yo, not pcm',
    },

    // ═══════════════════════════════════════════════════════════════
    // Additional: Entitlement boundary tests (5 extra, reusing utterances)
    // ═══════════════════════════════════════════════════════════════
    {
      text: 'Abeg I wan book haircut', category: 'native-intent',
      expectedInboundLanguage: 'pcm', expectedIntent: 'booking',
      scenario: FREE, expectedEffectiveResponseLanguage: 'en',
      shouldActivateLanguage: false,
      notes: 'FREE TIER: Pidgin detected but free tier → English, zero translation',
    },
    {
      text: 'I wan order food sharp sharp', category: 'native-intent',
      expectedInboundLanguage: 'pcm', expectedIntent: 'ordering',
      scenario: GROWTH_NO_PCM, expectedEffectiveResponseLanguage: 'en',
      shouldActivateLanguage: false,
      notes: 'GROWTH without pcm configured: detected but not in allowedLanguages → English',
    },
    {
      text: 'Wetin dey happen oga', category: 'greeting',
      expectedInboundLanguage: 'pcm',
      scenario: BUSINESS, expectedEffectiveResponseLanguage: 'pcm',
      shouldActivateLanguage: true,
      notes: 'BUSINESS TIER: all certified languages available automatically',
    },
    {
      text: 'Make I pay the money', category: 'native-intent',
      expectedInboundLanguage: 'pcm', expectedIntent: 'payment',
      scenario: { tier: 'growth', configuredLanguages: ['en', 'pcm'], sessionLanguage: 'pcm' },
      expectedEffectiveResponseLanguage: 'pcm',
      shouldActivateLanguage: false,
      notes: 'Session already has Pidgin active — no new activation needed',
    },
    {
      text: 'Abeg book for me tomorrow', category: 'native-intent',
      expectedInboundLanguage: 'pcm', expectedIntent: 'booking',
      scenario: { tier: 'growth', configuredLanguages: ['en', 'pcm'], rememberedLanguage: 'pcm' },
      expectedEffectiveResponseLanguage: 'pcm',
      shouldActivateLanguage: false,
      notes: 'Remembered preference restores Pidgin from profile',
    },
  ],
};

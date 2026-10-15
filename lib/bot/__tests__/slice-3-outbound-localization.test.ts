/**
 * Slice 3 — Outbound Localization Boundary tests (#524)
 *
 * Proves:
 * 1. localizeMessage preserves action IDs/postback IDs byte-for-byte
 * 2. Protected dynamic values survive translation exactly
 * 3. Merchant-entered item titles remain unchanged by default
 * 4. Waaiio-owned list chrome (title, buttonLabel, section titles) localizes
 * 5. Button footers and list footers localize
 * 6. Document captions localize
 * 7. Entitlement/certification fail-closed: free tier = zero LLM calls
 * 8. English baseline: lang=en means zero LLM calls, original text returned
 * 9. translateBotResponse protectedValues option preserves arbitrary strings
 *
 * CTO correction tests (Blockers 1-3):
 * 10. Auth/payment URLs survive translation at runtime call path
 * 11. Business name survives session-expiry / capability-list translation
 * 12. Merchant custom capability labels remain exact even with waaiioOwnedItemTitles
 * 13. _localization metadata on PromptMessage controls ownership at runtime
 * 14. Cross-business cache: no protected-value leakage between tenants
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock external boundaries ──

const { mockCreate } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = { create: mockCreate };
  }
  return { default: MockAnthropic };
});

vi.mock('@/lib/posthog/flags', () => ({
  isFeatureEnabledServer: vi.fn().mockResolvedValue(true),
  FLAGS: { BOT_TRANSLATION_ENABLED: 'bot-translation-enabled' },
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn().mockReturnValue({ allowed: true, remaining: 49 }),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/bot/ai-tier-guard', () => ({
  incrementAIUsage: vi.fn().mockResolvedValue(undefined),
}));

// ── Imports (after mocks) ──

import { translateBotResponse, _clearTranslationCache, type TranslationContext } from '../translate';
import { localizeMessage, localizeText } from '../outbound-localizer';
import type { PromptMessage, PromptList, PromptButtons, PromptDocument, LocalizationMeta } from '../flows/types';

// ── Helpers ──

function mockTranslation(translated: string) {
  mockCreate.mockResolvedValueOnce({
    content: [{ type: 'text', text: translated }],
    usage: { input_tokens: 10, output_tokens: 10 },
  });
}

function growthCtx(businessId = 'biz-001'): TranslationContext {
  return {
    entitlement: {
      allowedLanguages: ['en', 'fr', 'pcm'],
      llmAllowed: true,
      translationAllowed: true,
    },
    businessId,
    supabase: {},
  };
}

function freeCtx(businessId = 'biz-free'): TranslationContext {
  return {
    entitlement: {
      allowedLanguages: ['en'],
      llmAllowed: false,
      translationAllowed: false,
    },
    businessId,
    supabase: {},
  };
}

beforeEach(() => {
  // Reset only the LLM mock (clears mockResolvedValueOnce queue + call history)
  // while preserving other mock implementations (PostHog, rate limit, etc.)
  mockCreate.mockReset();
  _clearTranslationCache();
});

// ═══════════════════════════════════════════════════════════════
// Part 1: translateBotResponse protectedValues
// ═══════════════════════════════════════════════════════════════

describe('translateBotResponse — protectedValues', () => {
  it('preserves explicit protected values through translation', async () => {
    const ctx = growthCtx();
    // Simulating the LLM translating "Your booking at __V1__ is confirmed for __V2__"
    // into French while preserving placeholders
    mockTranslation('Votre r\u00e9servation \u00e0 __V1__ est confirm\u00e9e pour __V2__');

    const result = await translateBotResponse(
      'Your booking at Mama\'s Kitchen is confirmed for ₦5,000',
      'fr',
      ctx,
      { protectedValues: ["Mama's Kitchen"] },
    );

    // Merchant name must survive exactly
    expect(result).toContain("Mama's Kitchen");
    // Currency must survive via regex protection
    expect(result).toContain('₦5,000');
  });

  it('preserves URLs as protected values', async () => {
    const ctx = growthCtx();
    mockTranslation('Veuillez v\u00e9rifier ici __V1__');

    const result = await translateBotResponse(
      'Please verify here https://pay.waaiio.com/verify/abc123',
      'fr',
      ctx,
      { protectedValues: ['https://pay.waaiio.com/verify/abc123'] },
    );

    expect(result).toContain('https://pay.waaiio.com/verify/abc123');
  });

  it('handles multiple protected values without cross-contamination', async () => {
    const ctx = growthCtx();
    mockTranslation('R\u00e9servation __V1__ chez __V2__ pour __V3__');

    const result = await translateBotResponse(
      'Booking REF-12345 at FacesByKoph for ₦3,500',
      'fr',
      ctx,
      { protectedValues: ['FacesByKoph'] },
    );

    expect(result).toContain('FacesByKoph');
    expect(result).toContain('REF-12345'); // regex-protected reference
    expect(result).toContain('₦3,500'); // regex-protected currency
  });

  it('returns original text when no protectedValues match the text', async () => {
    const ctx = growthCtx();
    mockTranslation('Bonjour le monde');

    const result = await translateBotResponse(
      'Hello world',
      'fr',
      ctx,
      { protectedValues: ['not-in-text'] },
    );

    expect(result).toBe('Bonjour le monde');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// Part 2: localizeMessage — ID preservation
// ═══════════════════════════════════════════════════════════════

describe('localizeMessage — action IDs remain stable', () => {
  it('button IDs unchanged when titles localize', async () => {
    const ctx = growthCtx();
    mockTranslation('R\u00e9server maintenant');
    mockTranslation('Voir l\'historique');
    // body
    mockTranslation('Que voulez-vous faire?');

    const msg: PromptButtons = {
      type: 'buttons',
      body: 'What would you like to do?',
      buttons: [
        { id: 'booking_start', title: 'Book Now' },
        { id: 'view_history', title: 'View History' },
      ],
    };

    const result = await localizeMessage(msg, 'fr', ctx);
    expect(result.type).toBe('buttons');
    if (result.type === 'buttons') {
      // IDs MUST be unchanged
      expect(result.buttons[0].id).toBe('booking_start');
      expect(result.buttons[1].id).toBe('view_history');
      // Titles should be translated
      expect(result.buttons[0].title).not.toBe('Book Now');
      expect(result.buttons[1].title).not.toBe('View History');
    }
  });

  it('list postbackText unchanged when descriptions localize', async () => {
    const ctx = growthCtx();
    // body
    mockTranslation('Choisissez un service');
    // item descriptions
    mockTranslation('30 minutes - pour d\u00e9tente');
    mockTranslation('60 minutes - th\u00e9rapeutique');
    // title
    mockTranslation('Nos services');
    // buttonLabel
    mockTranslation('Voir les options');

    const msg: PromptList = {
      type: 'list',
      title: 'Our Services',
      body: 'Choose a service',
      buttonLabel: 'View Options',
      items: [
        { title: 'Full Body Massage', description: '30 minutes - for relaxation', postbackText: 'svc_massage_full' },
        { title: 'Deep Tissue', description: '60 minutes - therapeutic', postbackText: 'svc_deep_tissue' },
      ],
    };

    const result = await localizeMessage(msg, 'fr', ctx);
    expect(result.type).toBe('list');
    if (result.type === 'list') {
      // postbackText MUST be unchanged (machine authority)
      expect(result.items[0].postbackText).toBe('svc_massage_full');
      expect(result.items[1].postbackText).toBe('svc_deep_tissue');
      // Merchant item titles MUST be unchanged (merchant-entered)
      expect(result.items[0].title).toBe('Full Body Massage');
      expect(result.items[1].title).toBe('Deep Tissue');
      // Descriptions SHOULD be translated (Waaiio-owned)
      expect(result.items[0].description).not.toBe('30 minutes - for relaxation');
      // List chrome SHOULD be translated
      expect(result.title).not.toBe('Our Services');
      expect(result.buttonLabel).not.toBe('View Options');
    }
  });

  it('list section titles localize while item postbacks stay stable', async () => {
    const ctx = growthCtx();
    // body
    mockTranslation('Choisissez une option');
    // section title
    mockTranslation('Section principale');
    // item description
    mockTranslation('Option standard');
    // list title
    mockTranslation('Menu');
    // buttonLabel
    mockTranslation('Voir');

    const msg: PromptList = {
      type: 'list',
      title: 'Menu',
      body: 'Choose an option',
      buttonLabel: 'View',
      items: [],
      sections: [{
        title: 'Main Section',
        items: [
          { title: 'Product A', description: 'Standard option', postbackText: 'prod_a' },
        ],
      }],
    };

    const result = await localizeMessage(msg, 'fr', ctx);
    if (result.type === 'list' && result.sections) {
      expect(result.sections[0].title).not.toBe('Main Section');
      // postbackText stable
      expect(result.sections[0].items[0].postbackText).toBe('prod_a');
      // merchant title preserved
      expect(result.sections[0].items[0].title).toBe('Product A');
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// Part 3: localizeMessage — Waaiio-owned item titles
// ═══════════════════════════════════════════════════════════════

describe('localizeMessage — waaiioOwnedItemTitles', () => {
  it('translates item titles when waaiioOwnedItemTitles is true', async () => {
    const ctx = growthCtx();
    // body
    mockTranslation('Que souhaitez-vous faire?');
    // item title (Waaiio-owned menu)
    mockTranslation('Prendre rendez-vous');
    // item description
    mockTranslation('R\u00e9server un cr\u00e9neau');
    // list title
    mockTranslation('Options');
    // buttonLabel
    mockTranslation('Choisir');

    const msg: PromptList = {
      type: 'list',
      title: 'Options',
      body: 'What would you like to do?',
      buttonLabel: 'Choose',
      items: [
        { title: 'Book Appointment', description: 'Reserve a slot', postbackText: 'cap_appointment' },
      ],
    };

    const result = await localizeMessage(msg, 'fr', ctx, { waaiioOwnedItemTitles: true });
    if (result.type === 'list') {
      // Item title should be translated (Waaiio-owned capability menu)
      expect(result.items[0].title).not.toBe('Book Appointment');
      // postbackText MUST stay stable
      expect(result.items[0].postbackText).toBe('cap_appointment');
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// Part 4: Document caption localization
// ═══════════════════════════════════════════════════════════════

describe('localizeMessage — document captions', () => {
  it('localizes document captions', async () => {
    const ctx = growthCtx();
    mockTranslation('Votre re\u00e7u est pr\u00eat');

    const msg: PromptDocument = {
      type: 'document',
      url: 'https://waaiio.com/receipts/abc.pdf',
      filename: 'receipt.pdf',
      caption: 'Your receipt is ready',
    };

    const result = await localizeMessage(msg, 'fr', ctx);
    if (result.type === 'document') {
      // Caption should be translated
      expect(result.caption).not.toBe('Your receipt is ready');
      // URL must be preserved
      expect(result.url).toBe('https://waaiio.com/receipts/abc.pdf');
      // Filename must be preserved
      expect(result.filename).toBe('receipt.pdf');
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// Part 5: Footer localization
// ═══════════════════════════════════════════════════════════════

describe('localizeMessage — footer localization', () => {
  it('localizes button footer text', async () => {
    const ctx = growthCtx();
    // body
    mockTranslation('Choisir une action');
    // footer
    mockTranslation('Tapez: retour, menu, ou quitter');
    // button title
    mockTranslation('Continuer');

    const msg: PromptButtons = {
      type: 'buttons',
      body: 'Choose an action',
      footer: 'Type: back, menu, or exit',
      buttons: [{ id: 'continue', title: 'Continue' }],
    };

    const result = await localizeMessage(msg, 'fr', ctx);
    if (result.type === 'buttons') {
      expect(result.footer).not.toBe('Type: back, menu, or exit');
      // ID unchanged
      expect(result.buttons[0].id).toBe('continue');
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// Part 6: Entitlement fail-closed — zero LLM calls
// ═══════════════════════════════════════════════════════════════

describe('entitlement fail-closed', () => {
  it('free tier returns original text with zero LLM calls', async () => {
    const ctx = freeCtx();
    const msg: PromptButtons = {
      type: 'buttons',
      body: 'What would you like to do?',
      buttons: [{ id: 'book', title: 'Book' }],
    };

    const result = await localizeMessage(msg, 'fr', ctx);
    expect(mockCreate).not.toHaveBeenCalled();
    if (result.type === 'buttons') {
      expect(result.body).toBe('What would you like to do?');
      expect(result.buttons[0].title).toBe('Book');
      expect(result.buttons[0].id).toBe('book');
    }
  });

  it('language not in allowedLanguages returns original text', async () => {
    const ctx = growthCtx();
    // ctx allows en, fr, pcm — NOT 'es'
    const result = await localizeText('Hello', 'es', ctx);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(result).toBe('Hello');
  });

  it('translationAllowed=false returns original text', async () => {
    const ctx: TranslationContext = {
      entitlement: {
        allowedLanguages: ['en', 'fr'],
        llmAllowed: true,
        translationAllowed: false,
      },
      businessId: 'biz-x',
      supabase: {},
    };
    const result = await localizeText('Hello', 'fr', ctx);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(result).toBe('Hello');
  });
});

// ═══════════════════════════════════════════════════════════════
// Part 7: English baseline — zero LLM calls
// ═══════════════════════════════════════════════════════════════

describe('English baseline', () => {
  it('lang=en returns original text with zero LLM calls', async () => {
    const ctx = growthCtx();
    const msg: PromptButtons = {
      type: 'buttons',
      body: 'What would you like to do?',
      buttons: [
        { id: 'book', title: 'Book Now' },
        { id: 'view', title: 'View History' },
      ],
    };

    const result = await localizeMessage(msg, 'en', ctx);
    expect(mockCreate).not.toHaveBeenCalled();
    if (result.type === 'buttons') {
      expect(result.body).toBe('What would you like to do?');
      expect(result.buttons[0].title).toBe('Book Now');
      expect(result.buttons[0].id).toBe('book');
    }
  });

  it('empty lang returns original text', async () => {
    const ctx = growthCtx();
    const result = await localizeText('Hello world', '', ctx);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(result).toBe('Hello world');
  });
});

// ═══════════════════════════════════════════════════════════════
// Part 8: localizeText convenience wrapper
// ═══════════════════════════════════════════════════════════════

describe('localizeText', () => {
  it('translates plain text through the canonical boundary', async () => {
    const ctx = growthCtx();
    mockTranslation('Bienvenue sur la plateforme unique !');

    const result = await localizeText('Welcome to the unique platform!', 'fr', ctx);
    expect(result).toBe('Bienvenue sur la plateforme unique !');
    expect(mockCreate).toHaveBeenCalled();
  });

  it('passes protectedValues through to translateBotResponse', async () => {
    const ctx = growthCtx();
    mockTranslation('Bienvenue chez __V1__ pour votre visite !');

    const result = await localizeText(
      'Welcome to Bukka Hut for your visit!',
      'fr',
      ctx,
      { protectedValues: ['Bukka Hut'] },
    );

    expect(result).toContain('Bukka Hut');
  });
});

// ═══════════════════════════════════════════════════════════════
// Part 9: Image localization
// ═══════════════════════════════════════════════════════════════

describe('localizeMessage — image', () => {
  it('localizes caption but preserves imageUrl', async () => {
    const ctx = growthCtx();
    mockTranslation('Votre code QR');

    const msg: PromptMessage = {
      type: 'image',
      imageUrl: 'https://cdn.waaiio.com/qr/abc.png',
      caption: 'Your QR code',
    };

    const result = await localizeMessage(msg, 'fr', ctx);
    if (result.type === 'image') {
      expect(result.caption).not.toBe('Your QR code');
      expect(result.imageUrl).toBe('https://cdn.waaiio.com/qr/abc.png');
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// Part 10: Routing/capability invariant — language never affects routing
// ═══════════════════════════════════════════════════════════════

describe('localization does not affect routing authority', () => {
  it('button IDs are identical for fr and pcm localization of same message', async () => {
    const ctx = growthCtx();
    const msg: PromptButtons = {
      type: 'buttons',
      body: 'Choose an option',
      buttons: [
        { id: 'cap_scheduling', title: 'Booking' },
        { id: 'cap_payment', title: 'Payment' },
      ],
    };

    // French
    mockTranslation('Choisir une option');
    mockTranslation('R\u00e9servation');
    mockTranslation('Paiement');
    const frResult = await localizeMessage(msg, 'fr', ctx);

    // Pidgin
    mockTranslation('Pick wetin you want');
    mockTranslation('Book');
    mockTranslation('Pay');
    const pcmResult = await localizeMessage(msg, 'pcm', ctx);

    if (frResult.type === 'buttons' && pcmResult.type === 'buttons') {
      // IDs must be identical regardless of language
      expect(frResult.buttons[0].id).toBe(pcmResult.buttons[0].id);
      expect(frResult.buttons[1].id).toBe(pcmResult.buttons[1].id);
      expect(frResult.buttons[0].id).toBe('cap_scheduling');
      expect(frResult.buttons[1].id).toBe('cap_payment');
    }
  });

  it('list postbackText identical across languages', async () => {
    const ctx = growthCtx();
    const msg: PromptList = {
      type: 'list',
      title: 'Services',
      body: 'Pick a service',
      buttonLabel: 'View',
      items: [
        { title: 'Haircut', postbackText: 'svc_haircut', description: 'Quick trim' },
      ],
    };

    // French
    mockTranslation('Choisir un service');
    mockTranslation('Coupe rapide');
    mockTranslation('Services');
    mockTranslation('Voir');
    const frResult = await localizeMessage(msg, 'fr', ctx);

    // Pidgin
    mockTranslation('Pick one service');
    mockTranslation('Quick barb');
    mockTranslation('Services dem');
    mockTranslation('Look');
    const pcmResult = await localizeMessage(msg, 'pcm', ctx);

    if (frResult.type === 'list' && pcmResult.type === 'list') {
      expect(frResult.items[0].postbackText).toBe('svc_haircut');
      expect(pcmResult.items[0].postbackText).toBe('svc_haircut');
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// Part 11: CTO Blocker 1 — payment/auth URLs survive at runtime path
// ═══════════════════════════════════════════════════════════════

describe('Blocker 1 — auth URL survives translation at runtime path', () => {
  it('auth URL is byte-for-byte preserved when passed as protectedValue', async () => {
    const ctx = growthCtx();
    const authUrl = 'https://checkout.paystack.com/3dsecure/verify/abc123xyz';
    // LLM receives placeholder, translates surrounding text
    mockTranslation('🔒 Votre banque exige une vérification.\n\nVeuillez compléter ici 👇\n__V1__\n\n⚠️ Retournez sur WhatsApp après vérification.');

    const result = await translateBotResponse(
      `🔒 Your bank requires verification.\n\nPlease complete here 👇\n${authUrl}\n\n⚠️ Return to WhatsApp after verifying.`,
      'fr',
      ctx,
      { protectedValues: [authUrl] },
    );

    // The auth URL must survive byte-for-byte
    expect(result).toContain(authUrl);
    // Verify LLM received a placeholder, not the raw URL
    const llmCall = mockCreate.mock.calls[0][0];
    expect(llmCall.messages[0].content).toContain('__V1__');
    expect(llmCall.messages[0].content).not.toContain(authUrl);
  });

  it('terminal_decline message with provider reason is preserved', async () => {
    const ctx = growthCtx();
    const providerMsg = 'Insufficient funds on card ending 4242';
    mockTranslation('❌ Paiement non complété: __V1__.\n\nVeuillez réessayer avec un autre moyen de paiement en tapant *Hi*.');

    const result = await translateBotResponse(
      `❌ Payment could not be completed: ${providerMsg}.\n\nPlease try again with a different payment method by typing *Hi*.`,
      'fr',
      ctx,
      { protectedValues: [providerMsg] },
    );

    expect(result).toContain(providerMsg);
  });

  it('English auth path makes zero LLM calls and preserves URL exactly', async () => {
    const ctx = growthCtx();
    const authUrl = 'https://checkout.paystack.com/3dsecure/verify/xyz789';
    const text = `🔒 Your bank requires verification.\n\nPlease complete here 👇\n${authUrl}\n\n⚠️ Return to WhatsApp after verifying.`;

    const result = await translateBotResponse(text, 'en', ctx, { protectedValues: [authUrl] });

    expect(mockCreate).not.toHaveBeenCalled();
    expect(result).toBe(text);
    expect(result).toContain(authUrl);
  });

  it('free tier auth path makes zero LLM calls', async () => {
    const ctx = freeCtx();
    const authUrl = 'https://checkout.paystack.com/3dsecure/verify/free123';
    const text = `🔒 Your bank requires verification.\n\nPlease complete here 👇\n${authUrl}\n\n⚠️ Return to WhatsApp after verifying.`;

    const result = await translateBotResponse(text, 'fr', ctx, { protectedValues: [authUrl] });

    expect(mockCreate).not.toHaveBeenCalled();
    expect(result).toBe(text);
  });
});

// ═══════════════════════════════════════════════════════════════
// Part 12: CTO Blocker 2 — business name survives session-expiry
// ═══════════════════════════════════════════════════════════════

describe('Blocker 2 — merchant/business names survive translation', () => {
  it('business name survives session-expiry translation exactly', async () => {
    const ctx = growthCtx();
    const bizName = "Mama's Kitchen & Grill";
    mockTranslation("Votre session avec *__V1__* a expiré. Envoyez *Hi* pour recommencer. 🙏");

    const result = await translateBotResponse(
      `Your session with *${bizName}* has expired. Send *Hi* to start over. 🙏`,
      'fr',
      ctx,
      { protectedValues: [bizName] },
    );

    // Merchant name must survive byte-for-byte
    expect(result).toContain(bizName);
    // LLM never sees the raw business name
    const llmCall = mockCreate.mock.calls[0][0];
    expect(llmCall.messages[0].content).not.toContain(bizName);
    expect(llmCall.messages[0].content).toContain('__V1__');
  });

  it('capability-list business title remains exact via _localization metadata', async () => {
    const ctx = growthCtx();
    const bizName = 'FacesByKoph Beauty Lounge';
    // Execution order in localizeList: items first (Promise.all), then title, body, buttonLabel
    // item titles (Waaiio-owned, translated because waaiioOwnedItemTitles=true)
    mockTranslation('Nos Services');
    mockTranslation('Mon Compte');
    // list title — bizName is protected, LLM sees placeholder, restored exactly
    mockTranslation('__V1__');
    // body
    mockTranslation('Que souhaitez-vous faire? 👇');
    // buttonLabel
    mockTranslation('Voir les options');

    const msg: PromptMessage = {
      type: 'list',
      title: bizName,
      body: 'What would you like to do? 👇',
      buttonLabel: 'View Options',
      items: [
        { title: 'Our Services', postbackText: 'cap_scheduling' },
        { title: 'My Account', postbackText: 'cap_my_account' },
      ],
      _localization: {
        waaiioOwnedItemTitles: true,
        protectedValues: [bizName],
      },
    };

    const result = await localizeMessage(msg, 'fr', ctx);
    if (result.type === 'list') {
      // Business name in list title must survive exactly
      expect(result.title).toBe(bizName);
      // Waaiio-owned item titles should be translated
      expect(result.items[0].title).not.toBe('Our Services');
      expect(result.items[1].title).not.toBe('My Account');
      // postbackText must be stable
      expect(result.items[0].postbackText).toBe('cap_scheduling');
      expect(result.items[1].postbackText).toBe('cap_my_account');
    }
  });

  it('merchant custom capability label remains exact even with waaiioOwnedItemTitles', async () => {
    const ctx = growthCtx();
    const customLabel = 'Braids & Locs';
    // Execution order: items first, then title, body, buttonLabel
    // item title — custom label is protected, LLM sees placeholder, restored exactly
    mockTranslation('__V1__');
    // list title
    mockTranslation('Menu');
    // body
    mockTranslation('Que souhaitez-vous faire? 👇');
    // buttonLabel
    mockTranslation('Voir');

    const msg: PromptMessage = {
      type: 'list',
      title: 'Menu',
      body: 'What would you like to do? 👇',
      buttonLabel: 'View',
      items: [
        { title: customLabel, postbackText: 'cap_scheduling' },
      ],
      _localization: {
        waaiioOwnedItemTitles: true,
        protectedValues: [customLabel],
      },
    };

    const result = await localizeMessage(msg, 'fr', ctx);
    if (result.type === 'list') {
      // Custom label must survive byte-for-byte even though waaiioOwnedItemTitles=true
      expect(result.items[0].title).toBe(customLabel);
      expect(result.items[0].postbackText).toBe('cap_scheduling');
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// Part 13: CTO Blocker 3 — _localization metadata wired through
// ═══════════════════════════════════════════════════════════════

describe('Blocker 3 — _localization metadata consumed by localizeMessage', () => {
  it('message-level _localization.waaiioOwnedItemTitles controls item translation', async () => {
    const ctx = growthCtx();
    // body
    mockTranslation('Choisissez');
    // item title (Waaiio-owned, should translate)
    mockTranslation('Mon Compte');
    // list title
    mockTranslation('Menu');
    // buttonLabel
    mockTranslation('Voir');

    const msg: PromptMessage = {
      type: 'list',
      title: 'Menu',
      body: 'Choose',
      buttonLabel: 'View',
      items: [
        { title: 'My Account', postbackText: 'cap_my_account' },
      ],
      _localization: { waaiioOwnedItemTitles: true },
    };

    const result = await localizeMessage(msg, 'fr', ctx);
    if (result.type === 'list') {
      // Item title should be translated because _localization declares it Waaiio-owned
      expect(result.items[0].title).not.toBe('My Account');
      expect(result.items[0].postbackText).toBe('cap_my_account');
    }
  });

  it('message without _localization keeps item titles unchanged (merchant default)', async () => {
    const ctx = growthCtx();
    // body
    mockTranslation('Choisissez un service');
    // list title
    mockTranslation('Services');
    // buttonLabel
    mockTranslation('Voir');

    const msg: PromptMessage = {
      type: 'list',
      title: 'Services',
      body: 'Choose a service',
      buttonLabel: 'View',
      items: [
        { title: 'Full Body Massage', postbackText: 'svc_full_body' },
      ],
      // No _localization — merchant default
    };

    const result = await localizeMessage(msg, 'fr', ctx);
    if (result.type === 'list') {
      // Merchant item title MUST remain unchanged
      expect(result.items[0].title).toBe('Full Body Massage');
      expect(result.items[0].postbackText).toBe('svc_full_body');
    }
  });

  it('message-level protectedValues merge with caller-supplied protectedValues', async () => {
    const ctx = growthCtx();
    // Both "Bukka Hut" (message-level) and "VIP-REF-999" (caller-level) should be protected
    mockTranslation('Bienvenue chez __V1__ — référence __V2__');

    const msg: PromptMessage = {
      type: 'text',
      text: 'Welcome to Bukka Hut — reference VIP-REF-999',
      _localization: { protectedValues: ['Bukka Hut'] },
    };

    const result = await localizeMessage(msg, 'fr', ctx, { protectedValues: ['VIP-REF-999'] });
    if (result.type === 'text') {
      expect(result.text).toContain('Bukka Hut');
      expect(result.text).toContain('VIP-REF-999');
    }
  });

  it('buttons with _localization — body translates, IDs unchanged', async () => {
    const ctx = growthCtx();
    // body
    mockTranslation('Que souhaitez-vous faire? 👇');
    // button titles (Waaiio-owned)
    mockTranslation('Nos Services');
    mockTranslation('Mon Compte');

    const msg: PromptMessage = {
      type: 'buttons',
      body: 'What would you like to do? 👇',
      buttons: [
        { id: 'cap_scheduling', title: 'Our Services' },
        { id: 'cap_my_account', title: 'My Account' },
      ],
      _localization: { waaiioOwnedItemTitles: true },
    };

    const result = await localizeMessage(msg, 'fr', ctx);
    if (result.type === 'buttons') {
      expect(result.buttons[0].id).toBe('cap_scheduling');
      expect(result.buttons[1].id).toBe('cap_my_account');
      expect(result.buttons[0].title).not.toBe('Our Services');
      expect(result.buttons[1].title).not.toBe('My Account');
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// Part 14: Cache invariant — no cross-tenant protected-value leakage
// ═══════════════════════════════════════════════════════════════

describe('cache invariant — no cross-business protected-value leakage', () => {
  it('same template with different businesses restores each business own value', async () => {
    const ctxA = growthCtx('biz-A');
    const ctxB = growthCtx('biz-B');

    // Business A: "Your session with *Bukka Hut* has expired."
    mockTranslation('Votre session avec *__V1__* a expiré.');
    const resultA = await translateBotResponse(
      'Your session with *Bukka Hut* has expired.',
      'fr',
      ctxA,
      { protectedValues: ['Bukka Hut'] },
    );

    // Business B: same template pattern, different business name
    // Cache should hit on the placeholdered template — no new LLM call
    const resultB = await translateBotResponse(
      'Your session with *FacesByKoph* has expired.',
      'fr',
      ctxB,
      { protectedValues: ['FacesByKoph'] },
    );

    // Business A gets their name
    expect(resultA).toContain('Bukka Hut');
    expect(resultA).not.toContain('FacesByKoph');

    // Business B gets their name
    expect(resultB).toContain('FacesByKoph');
    expect(resultB).not.toContain('Bukka Hut');

    // Cache hit: only 1 LLM call for 2 translations (same template)
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// Part 15: Placeholder integrity — fail closed on LLM corruption
// ═══════════════════════════════════════════════════════════════

describe('placeholder integrity — fail closed on LLM corruption', () => {
  it('dropped placeholder: returns original text with auth URL intact', async () => {
    const ctx = growthCtx();
    const authUrl = 'https://checkout.paystack.com/3dsecure/verify/abc123';
    // LLM drops the __V1__ placeholder entirely
    mockTranslation('🔒 Votre banque exige une vérification.\n\nVeuillez compléter ici 👇\n\n⚠️ Retournez sur WhatsApp après vérification.');

    const original = `🔒 Your bank requires verification.\n\nPlease complete here 👇\n${authUrl}\n\n⚠️ Return to WhatsApp after verifying.`;
    const result = await translateBotResponse(original, 'fr', ctx, { protectedValues: [authUrl] });

    // Must fail closed to original text — auth URL intact
    expect(result).toBe(original);
    expect(result).toContain(authUrl);
  });

  it('mutated placeholder: returns original text', async () => {
    const ctx = growthCtx();
    const bizName = "Mama's Kitchen";
    // LLM mutates __V1__ to __v1__ (lowercase) — invalid
    mockTranslation('Votre session avec *__v1__* a expiré.');

    const original = `Your session with *${bizName}* has expired.`;
    const result = await translateBotResponse(original, 'fr', ctx, { protectedValues: [bizName] });

    // Must fail closed — mutated placeholder is not valid
    expect(result).toBe(original);
    expect(result).toContain(bizName);
  });

  it('duplicated placeholder: returns original text', async () => {
    const ctx = growthCtx();
    const bizName = 'FacesByKoph';
    // LLM duplicates __V1__ — appears twice
    mockTranslation('Bienvenue chez __V1__. Merci __V1__ pour votre visite.');

    const original = `Welcome to ${bizName}. Thank you for visiting.`;
    const result = await translateBotResponse(original, 'fr', ctx, { protectedValues: [bizName] });

    // Must fail closed — duplicated placeholder means ambiguous restoration
    expect(result).toBe(original);
    expect(result).toContain(bizName);
  });

  it('spurious extra placeholder: returns original text', async () => {
    const ctx = growthCtx();
    const bizName = 'Bukka Hut';
    // LLM invents an extra __V2__ that was never in the input
    mockTranslation('Bienvenue chez __V1__ — promotion __V2__');

    const original = `Welcome to ${bizName} — enjoy your visit`;
    const result = await translateBotResponse(original, 'fr', ctx, { protectedValues: [bizName] });

    // Must fail closed — extra placeholder is unexpected
    expect(result).toBe(original);
    expect(result).toContain(bizName);
  });

  it('valid translation is cached; corrupted one is not', async () => {
    const ctx = growthCtx();

    // First call: valid translation with intact placeholder
    mockTranslation('Bienvenue chez __V1__ pour la première fois.');
    const result1 = await translateBotResponse(
      'Welcome to Bukka Hut for the first time.',
      'fr', ctx, { protectedValues: ['Bukka Hut'] },
    );
    expect(result1).toContain('Bukka Hut');

    // Clear cache to test a corrupted response for a DIFFERENT template
    _clearTranslationCache();

    // Second call with different text: LLM drops placeholder
    mockTranslation('Merci pour votre visite.');
    const result2 = await translateBotResponse(
      'Thank you for visiting FacesByKoph.',
      'fr', ctx, { protectedValues: ['FacesByKoph'] },
    );
    // Must fail closed — original returned
    expect(result2).toBe('Thank you for visiting FacesByKoph.');

    // Third call: same text again — should NOT hit cache (corrupted was not cached),
    // so it makes a new LLM call
    mockTranslation('Merci pour votre visite chez __V1__.');
    const result3 = await translateBotResponse(
      'Thank you for visiting FacesByKoph.',
      'fr', ctx, { protectedValues: ['FacesByKoph'] },
    );
    // This time LLM returns valid response — should work
    expect(result3).toContain('FacesByKoph');

    // Total LLM calls: 3 (valid, corrupted, retry)
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });

  it('no placeholders: LLM response is accepted without integrity check', async () => {
    const ctx = growthCtx();
    // Text with no protected values or regex-matched patterns — no placeholders generated
    mockTranslation('Bonjour le monde');

    const result = await translateBotResponse('Hello world', 'fr', ctx);
    // Should translate normally — no integrity check needed when no placeholders
    expect(result).toBe('Bonjour le monde');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('regex-protected values also trigger integrity check', async () => {
    const ctx = growthCtx();
    // Input has a currency amount (regex-protected) — LLM drops the placeholder
    mockTranslation('Le total est de seulement.');

    const original = 'The total is only ₦5,000.';
    const result = await translateBotResponse(original, 'fr', ctx);

    // Must fail closed — regex-protected currency placeholder was dropped
    expect(result).toBe(original);
    expect(result).toContain('₦5,000');
  });
});

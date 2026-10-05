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
import type { PromptMessage, PromptList, PromptButtons, PromptDocument } from '../flows/types';

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

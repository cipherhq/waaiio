/**
 * Slice 561-B — Executable runtime tests
 *
 * Calls actual flow prompt()/validate() functions with controlled FlowContext
 * to prove customer-visible copy is deterministic and locale-aware.
 *
 * Proves:
 * - resolveCopyLang delegates to resolveEffectiveResponseLanguage
 * - Entitlement boundary: detected pcm + English-only => English
 * - Entitled + certified pcm => Pidgin deterministic copy
 * - Uncertified languages => English fallback
 * - translationAllowed/llmAllowed policy respected
 * - Real flow prompt() returns localized PromptMessage content
 */
import { describe, it, expect, vi } from 'vitest';
import { resolveEffectiveResponseLanguage } from '@/lib/bot/language-preference';
import { getFlowCopy } from '../flows/flow-localization';
import { CERTIFIED_LANGUAGES } from '@/lib/bot/languages';
import type { LanguageEntitlement } from '@/lib/bot/language-policy';

// ═══════════════════════════════════════════════════════════════
// 1. Canonical language authority via resolveEffectiveResponseLanguage
// ═══════════════════════════════════════════════════════════════

describe('561-B: canonical response-language authority', () => {
  const enOnlyEntitlement: LanguageEntitlement = {
    allowedLanguages: ['en'],
    llmAllowed: false,
    translationAllowed: false,
  };
  const growthPcmEntitlement: LanguageEntitlement = {
    allowedLanguages: ['en', 'pcm'],
    llmAllowed: true,
    translationAllowed: true,
  };
  const growthNoTranslation: LanguageEntitlement = {
    allowedLanguages: ['en', 'pcm'],
    llmAllowed: false,
    translationAllowed: false,
  };

  it('detected pcm + English-only entitlement => English', () => {
    const result = resolveEffectiveResponseLanguage({
      explicitLanguage: null,
      sessionLanguage: 'pcm',
      rememberedLanguage: null,
      entitlement: enOnlyEntitlement,
      certifiedLanguages: CERTIFIED_LANGUAGES,
    });
    expect(result.language).toBe('en');
    expect(result.source).toBe('fallback');
  });

  it('detected pcm + entitled but translationAllowed=false => English', () => {
    const result = resolveEffectiveResponseLanguage({
      explicitLanguage: null,
      sessionLanguage: 'pcm',
      rememberedLanguage: null,
      entitlement: growthNoTranslation,
      certifiedLanguages: CERTIFIED_LANGUAGES,
    });
    expect(result.language).toBe('en');
    expect(result.source).toBe('fallback');
  });

  it('detected pcm + entitled + certified + translationAllowed => Pidgin', () => {
    const result = resolveEffectiveResponseLanguage({
      explicitLanguage: null,
      sessionLanguage: 'pcm',
      rememberedLanguage: null,
      entitlement: growthPcmEntitlement,
      certifiedLanguages: CERTIFIED_LANGUAGES,
    });
    expect(result.language).toBe('pcm');
    expect(result.source).toBe('session');
  });

  it('explicit pcm overrides session English when entitled', () => {
    const result = resolveEffectiveResponseLanguage({
      explicitLanguage: 'pcm',
      sessionLanguage: 'en',
      rememberedLanguage: null,
      entitlement: growthPcmEntitlement,
      certifiedLanguages: CERTIFIED_LANGUAGES,
    });
    expect(result.language).toBe('pcm');
    expect(result.source).toBe('explicit');
  });

  it('session pcm + effective response is English (explicit en) => English', () => {
    const result = resolveEffectiveResponseLanguage({
      explicitLanguage: 'en',
      sessionLanguage: 'pcm',
      rememberedLanguage: null,
      entitlement: growthPcmEntitlement,
      certifiedLanguages: CERTIFIED_LANGUAGES,
    });
    expect(result.language).toBe('en');
    expect(result.source).toBe('explicit');
  });

  it('remembered pcm activates when entitled + certified', () => {
    const result = resolveEffectiveResponseLanguage({
      explicitLanguage: null,
      sessionLanguage: null,
      rememberedLanguage: 'pcm',
      entitlement: growthPcmEntitlement,
      certifiedLanguages: CERTIFIED_LANGUAGES,
    });
    expect(result.language).toBe('pcm');
    expect(result.source).toBe('remembered');
    expect(result.shouldOfferRemembered).toBe(true);
  });

  it('remembered pcm does NOT activate when not entitled', () => {
    const result = resolveEffectiveResponseLanguage({
      explicitLanguage: null,
      sessionLanguage: null,
      rememberedLanguage: 'pcm',
      entitlement: enOnlyEntitlement,
      certifiedLanguages: CERTIFIED_LANGUAGES,
    });
    expect(result.language).toBe('en');
    expect(result.source).toBe('fallback');
  });

  it('uncertified yo => English even when entitled', () => {
    const yoEntitlement: LanguageEntitlement = {
      allowedLanguages: ['en', 'yo'],
      llmAllowed: true,
      translationAllowed: true,
    };
    const result = resolveEffectiveResponseLanguage({
      explicitLanguage: null,
      sessionLanguage: 'yo',
      rememberedLanguage: null,
      entitlement: yoEntitlement,
      certifiedLanguages: CERTIFIED_LANGUAGES,
    });
    expect(result.language).toBe('en');
    expect(result.source).toBe('fallback');
  });

  for (const lang of ['ig', 'ha', 'tw', 'fr', 'es'] as const) {
    it(`uncertified ${lang} => English`, () => {
      const result = resolveEffectiveResponseLanguage({
        explicitLanguage: null,
        sessionLanguage: lang,
        rememberedLanguage: null,
        entitlement: { allowedLanguages: ['en', lang], llmAllowed: true, translationAllowed: true },
        certifiedLanguages: CERTIFIED_LANGUAGES,
      });
      expect(result.language).toBe('en');
    });
  }
});

// ═══════════════════════════════════════════════════════════════
// 2. Deterministic copy follows canonical authority
// ═══════════════════════════════════════════════════════════════

describe('561-B: deterministic copy follows canonical authority', () => {
  function getCopyLang(sessionLang: string | null, entitlement: LanguageEntitlement): string {
    return resolveEffectiveResponseLanguage({
      explicitLanguage: null,
      sessionLanguage: sessionLang,
      rememberedLanguage: null,
      entitlement,
      certifiedLanguages: CERTIFIED_LANGUAGES,
    }).language;
  }

  const enOnly: LanguageEntitlement = { allowedLanguages: ['en'], llmAllowed: false, translationAllowed: false };
  const pcmEntitled: LanguageEntitlement = { allowedLanguages: ['en', 'pcm'], llmAllowed: true, translationAllowed: true };

  it('English-only business: footer is English', () => {
    const lang = getCopyLang('pcm', enOnly);
    expect(getFlowCopy(lang, 'nav.footer')).toBe('Type: back, menu (restart), or exit (leave)');
  });

  it('English-only business: error.generic is English', () => {
    const lang = getCopyLang('pcm', enOnly);
    expect(getFlowCopy(lang, 'error.generic')).toContain('Something went wrong');
  });

  it('English-only business: booking chrome is English', () => {
    const lang = getCopyLang('pcm', enOnly);
    expect(getFlowCopy(lang, 'booking.no_locations')).toContain('No locations');
    expect(getFlowCopy(lang, 'booking.confirm_btn')).toBe('Confirm ✓');
  });

  it('English-only business: payment chrome is English', () => {
    const lang = getCopyLang('pcm', enOnly);
    expect(getFlowCopy(lang, 'payment.ive_paid')).toBe("I've Paid");
    expect(getFlowCopy(lang, 'payment.cancelled')).toContain('No charges were made');
  });

  it('Pidgin-entitled: footer is Pidgin', () => {
    const lang = getCopyLang('pcm', pcmEntitled);
    expect(getFlowCopy(lang, 'nav.footer')).toContain('comot');
  });

  it('Pidgin-entitled: error.generic is Pidgin', () => {
    const lang = getCopyLang('pcm', pcmEntitled);
    expect(getFlowCopy(lang, 'error.generic')).toContain('no go well');
  });

  it('Pidgin-entitled: booking chrome is Pidgin', () => {
    const lang = getCopyLang('pcm', pcmEntitled);
    expect(getFlowCopy(lang, 'booking.no_locations')).toContain('Abeg');
    expect(getFlowCopy(lang, 'booking.confirm_btn')).toBe('Confirm ✓');
  });

  it('Pidgin-entitled: payment buttons are Pidgin', () => {
    const lang = getCopyLang('pcm', pcmEntitled);
    expect(getFlowCopy(lang, 'payment.ive_paid')).toBe('I Don Pay');
  });

  it('Pidgin-entitled: account menu chrome is Pidgin', () => {
    const lang = getCopyLang('pcm', pcmEntitled);
    expect(getFlowCopy(lang, 'menu.what_to_do')).toContain('Wetin');
    expect(getFlowCopy(lang, 'account.body')).toContain('comot');
  });

  it('Pidgin-entitled: ordering chrome is Pidgin', () => {
    const lang = getCopyLang('pcm', pcmEntitled);
    expect(getFlowCopy(lang, 'ordering.nothing_available')).toContain('dey available');
  });

  it('Pidgin-entitled: ticketing chrome is Pidgin', () => {
    const lang = getCopyLang('pcm', pcmEntitled);
    expect(getFlowCopy(lang, 'ticketing.no_events')).toContain('No event dey');
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. Executable flow runtime — real prompt() calls
// ═══════════════════════════════════════════════════════════════

// Minimal mock FlowContext builder
function buildMockCtx(overrides: {
  copyLang?: string;
  businessName?: string;
  businessCategory?: string;
  sessionData?: Record<string, unknown>;
  supabaseData?: Record<string, unknown[]>;
}) {
  const {
    copyLang = 'en',
    businessName = 'Test Biz',
    businessCategory = 'barber',
    sessionData = {},
    supabaseData = {},
  } = overrides;

  const mockSupabase = {
    from: vi.fn((table: string) => {
      const data = supabaseData[table] || [];
      // Build a deeply chainable mock that returns { data, error: null } at any terminus
      const terminal = { data, error: null };
      const chainable: Record<string, any> = {};
      const makeChain = (): Record<string, any> => {
        const proxy: Record<string, any> = { ...terminal };
        for (const method of ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is', 'in', 'not', 'or',
          'order', 'limit', 'range', 'single', 'maybeSingle', 'select', 'contains', 'filter',
          'ilike', 'like', 'match', 'textSearch', 'overlaps']) {
          proxy[method] = vi.fn().mockReturnValue(proxy);
        }
        proxy.maybeSingle = vi.fn().mockResolvedValue({ data: data[0] || null, error: null });
        proxy.single = vi.fn().mockResolvedValue({ data: data[0] || null, error: null });
        proxy.then = undefined; // Prevent auto-await on the chain
        return proxy;
      };
      return {
        select: vi.fn().mockReturnValue(makeChain()),
        insert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: { id: 'mock-id' }, error: null }),
          }),
        }),
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ error: null }),
        }),
      };
    }),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  };

  return {
    supabase: mockSupabase as never,
    sender: { sendText: vi.fn(), sendButtons: vi.fn(), sendList: vi.fn() } as never,
    standalone: {} as never,
    intelligence: {} as never,
    from: '+2348001234567',
    session: {
      id: 'test-session',
      user_id: 'test-user',
      business_id: 'test-biz',
      current_step: 'select_location',
      session_data: { ...sessionData },
      version: 1,
    },
    business: {
      id: 'test-biz',
      name: businessName,
      slug: 'test-biz',
      subscription_tier: 'growth' as const,
      country: 'NG',
      timezone: 'Africa/Lagos',
      category: businessCategory,
      business_category: businessCategory,
    },
    t: vi.fn(async (text: string) => text),
    copyLang,
    mediaUrl: undefined,
    mediaType: undefined,
  };
}

describe('561-B: scheduling flow prompt() returns localized copy', () => {
  it('select_location with no locations returns localized error', async () => {
    const { schedulingFlow } = await import('../flows/scheduling.flow');
    const locationStep = schedulingFlow.steps.find(s => s.id === 'select_location');
    expect(locationStep).toBeDefined();

    // English
    const enCtx = buildMockCtx({ copyLang: 'en', supabaseData: { locations: [] } });
    const enMsgs = await locationStep!.prompt(enCtx as never);
    expect(enMsgs.length).toBeGreaterThan(0);
    const enBody = enMsgs[0].type === 'text' ? enMsgs[0].text : (enMsgs[0] as any).body;
    expect(enBody).toContain('No locations');

    // Pidgin
    const pcmCtx = buildMockCtx({ copyLang: 'pcm', supabaseData: { locations: [] } });
    const pcmMsgs = await locationStep!.prompt(pcmCtx as never);
    const pcmBody = pcmMsgs[0].type === 'text' ? pcmMsgs[0].text : (pcmMsgs[0] as any).body;
    expect(pcmBody).toContain('Abeg');
  });

  it('select_location validate returns localized error', async () => {
    const { schedulingFlow } = await import('../flows/scheduling.flow');
    const locationStep = schedulingFlow.steps.find(s => s.id === 'select_location');
    expect(locationStep).toBeDefined();

    const enCtx = buildMockCtx({ copyLang: 'en' });
    const result = await locationStep!.validate('nonexistent', enCtx as never);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain('didn\'t find that location');

    const pcmCtx = buildMockCtx({ copyLang: 'pcm' });
    const pcmResult = await locationStep!.validate('nonexistent', pcmCtx as never);
    expect(pcmResult.valid).toBe(false);
    expect(pcmResult.errorMessage).toContain('no see that location');
  });
});

describe('561-B: payment flow returns localized deterministic chrome', () => {
  it('confirm_amount step exists', async () => {
    const { paymentFlow } = await import('../flows/payment.flow');
    const step = paymentFlow.steps.find(s => s.id === 'confirm_amount');
    expect(step).toBeDefined();
  });

  it('confirm_amount validate returns English hint on invalid input', async () => {
    const { paymentFlow } = await import('../flows/payment.flow');
    const step = paymentFlow.steps.find(s => s.id === 'confirm_amount')!;
    const ctx = buildMockCtx({ copyLang: 'en', sessionData: { amount: 5000, service_name: 'Test' } });
    const result = await step.validate('invalid_input', ctx as never);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toBe('Please tap *Confirm* or *Cancel*.');
  });

  it('confirm_amount validate returns Pidgin hint on invalid input', async () => {
    const { paymentFlow } = await import('../flows/payment.flow');
    const step = paymentFlow.steps.find(s => s.id === 'confirm_amount')!;
    const ctx = buildMockCtx({ copyLang: 'pcm', sessionData: { amount: 5000, service_name: 'Test' } });
    const result = await step.validate('invalid_input', ctx as never);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain('Abeg tap *Confirm* or *Cancel*');
  });

  it('collect_name validate returns English error', async () => {
    const { paymentFlow } = await import('../flows/payment.flow');
    const step = paymentFlow.steps.find(s => s.id === 'collect_name')!;
    expect(step).toBeDefined();
    const ctx = buildMockCtx({ copyLang: 'en' });
    const result = await step.validate('X', ctx as never);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toBe('Please enter a valid name.');
  });

  it('collect_name validate returns Pidgin error', async () => {
    const { paymentFlow } = await import('../flows/payment.flow');
    const step = paymentFlow.steps.find(s => s.id === 'collect_name')!;
    const ctx = buildMockCtx({ copyLang: 'pcm' });
    const result = await step.validate('X', ctx as never);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain('Abeg enter valid name');
  });
});

describe('561-B: capability-selection returns localized account menu', () => {
  it('my_account_menu step exists', async () => {
    const { capabilitySelectionFlow } = await import('../flows/capability-selection.flow');
    const step = capabilitySelectionFlow.steps.find(s => s.id === 'my_account_menu');
    expect(step).toBeDefined();
  });

  it('English account menu returns list with correct title and items', async () => {
    vi.doMock('@/lib/promotions/history', () => ({ hasPromoHistory: vi.fn().mockResolvedValue(false) }));
    const { capabilitySelectionFlow } = await import('../flows/capability-selection.flow');
    const step = capabilitySelectionFlow.steps.find(s => s.id === 'my_account_menu')!;

    const ctx = buildMockCtx({
      copyLang: 'en',
      sessionData: { capabilities: ['scheduling', 'ordering', 'giving'] },
    });
    const msgs = await step.prompt(ctx as never);
    expect(msgs).toHaveLength(1);

    const msg = msgs[0] as any;
    expect(msg.type).toBe('list');
    expect(msg.title).toBe('My Account');
    expect(msg.body).toContain('Manage your bookings');
    expect(msg.buttonLabel).toBe('My Account');

    const titles = msg.items.map((i: any) => i.title);
    expect(titles).toContain('My Bookings');
    expect(titles).toContain('My Orders');
    expect(titles).toContain('My Giving');
    expect(titles).toContain('Get Receipt');
    expect(titles).toContain('Switch Business');
    expect(titles).toContain('← Back');
  });

  it('Pidgin account menu returns list with Pidgin body', async () => {
    vi.doMock('@/lib/promotions/history', () => ({ hasPromoHistory: vi.fn().mockResolvedValue(false) }));
    const { capabilitySelectionFlow } = await import('../flows/capability-selection.flow');
    const step = capabilitySelectionFlow.steps.find(s => s.id === 'my_account_menu')!;

    const ctx = buildMockCtx({
      copyLang: 'pcm',
      sessionData: { capabilities: ['scheduling'] },
    });
    const msgs = await step.prompt(ctx as never);
    expect(msgs).toHaveLength(1);

    const msg = msgs[0] as any;
    expect(msg.type).toBe('list');
    expect(msg.body).toContain('comot'); // Pidgin cancel hint
    expect(msg.buttonLabel).toBe('My Account'); // Kept for recognizability

    const descriptions = msg.items.map((i: any) => i.description);
    // Pidgin descriptions should differ from English
    expect(descriptions).toContain('Go back to main menu'); // pcm nav.back_desc
  });

  it('account menu validate returns localized error for invalid input', async () => {
    const { capabilitySelectionFlow } = await import('../flows/capability-selection.flow');
    const step = capabilitySelectionFlow.steps.find(s => s.id === 'my_account_menu')!;

    const enCtx = buildMockCtx({ copyLang: 'en' });
    const enResult = await step.validate('garbage_input', enCtx as never);
    expect(enResult.valid).toBe(false);
    expect(enResult.errorMessage).toBe('Please pick an option from the list.');

    const pcmCtx = buildMockCtx({ copyLang: 'pcm' });
    const pcmResult = await step.validate('garbage_input', pcmCtx as never);
    expect(pcmResult.valid).toBe(false);
    expect(pcmResult.errorMessage).toContain('Abeg pick one option');
  });
});

describe('561-B: ticketing flow returns localized chrome', () => {
  it('select_event with no events returns localized empty state', async () => {
    const { ticketingFlow } = await import('../flows/ticketing.flow');
    const eventStep = ticketingFlow.steps.find(s => s.id === 'select_event');
    expect(eventStep).toBeDefined();

    const enCtx = buildMockCtx({
      copyLang: 'en',
      supabaseData: { events: [] },
    });
    const enMsgs = await eventStep!.prompt(enCtx as never);
    expect(enMsgs.length).toBeGreaterThan(0);
    const body = enMsgs[0].type === 'text' ? enMsgs[0].text : (enMsgs[0] as any).body;
    expect(body).toContain('No upcoming events');

    const pcmCtx = buildMockCtx({
      copyLang: 'pcm',
      supabaseData: { events: [] },
    });
    const pcmMsgs = await eventStep!.prompt(pcmCtx as never);
    const pcmBody = pcmMsgs[0].type === 'text' ? pcmMsgs[0].text : (pcmMsgs[0] as any).body;
    expect(pcmBody).toContain('No event dey');
  });
});

describe('561-B: ordering flow returns localized chrome', () => {
  it('select_variant_error step exists', async () => {
    const { orderingFlow } = await import('../flows/ordering.flow');
    const step = orderingFlow.steps.find(s => s.id === 'select_variant_error');
    expect(step).toBeDefined();
  });

  it('select_variant_error prompt returns English deterministic copy', async () => {
    const { orderingFlow } = await import('../flows/ordering.flow');
    const step = orderingFlow.steps.find(s => s.id === 'select_variant_error')!;

    const ctx = buildMockCtx({ copyLang: 'en' });
    const msgs = await step.prompt(ctx as never);
    expect(msgs).toHaveLength(1);

    const msg = msgs[0] as any;
    expect(msg.type).toBe('buttons');
    expect(msg.body).toBe('Sorry, that combination is not available.');
    expect(msg.buttons).toHaveLength(2);
    expect(msg.buttons[0].title).toBe('Try Another');
    expect(msg.buttons[1].title).toBe('Cancel');
  });

  it('select_variant_error prompt returns Pidgin deterministic copy', async () => {
    const { orderingFlow } = await import('../flows/ordering.flow');
    const step = orderingFlow.steps.find(s => s.id === 'select_variant_error')!;

    const ctx = buildMockCtx({ copyLang: 'pcm' });
    const msgs = await step.prompt(ctx as never);
    expect(msgs).toHaveLength(1);

    const msg = msgs[0] as any;
    expect(msg.type).toBe('buttons');
    expect(msg.body).toContain('combination no dey available');
    expect(msg.buttons[0].title).toBe('Try Another');
    expect(msg.buttons[1].title).toBe('Cancel'); // pcm nav.cancel is 'Cancel'
  });

  it('browse_catalog validate returns localized item-not-found error', async () => {
    const { orderingFlow } = await import('../flows/ordering.flow');
    const step = orderingFlow.steps.find(s => s.id === 'browse_category_items');
    expect(step).toBeDefined();

    const enCtx = buildMockCtx({ copyLang: 'en', sessionData: { _selected_category: 'Food' } });
    const result = await step!.validate('nonexistent_product_id', enCtx as never);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain("didn't find that item");

    const pcmCtx = buildMockCtx({ copyLang: 'pcm', sessionData: { _selected_category: 'Food' } });
    const pcmResult = await step!.validate('nonexistent_product_id', pcmCtx as never);
    expect(pcmResult.valid).toBe(false);
    expect(pcmResult.errorMessage).toContain('no see that item');
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. Executor source verification (secondary guard)
// ═══════════════════════════════════════════════════════════════

describe('561-B: executor uses canonical resolveEffectiveResponseLanguage', () => {
  it('executor imports resolveEffectiveResponseLanguage', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('lib/bot/flows/executor.ts', 'utf-8');
    expect(source).toContain('resolveEffectiveResponseLanguage');
    expect(source).toContain('CERTIFIED_LANGUAGES');
  });

  it('resolveCopyLang delegates to resolveEffectiveResponseLanguage', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('lib/bot/flows/executor.ts', 'utf-8');
    // Find the resolveCopyLang method
    const methodStart = source.indexOf('private resolveCopyLang');
    expect(methodStart).toBeGreaterThan(0);
    const methodBody = source.slice(methodStart, source.indexOf('}', methodStart + 200) + 1);
    expect(methodBody).toContain('resolveEffectiveResponseLanguage');
    expect(methodBody).toContain('certifiedLanguages');
    expect(methodBody).toContain('entitlement');
    // Must NOT have raw detected-language as direct return
    expect(methodBody).not.toContain("return detected;");
  });
});

/**
 * Phrase-book text skips AI translation (bot reply speed, Fix A).
 *
 * Certified phrase-book copy is already in the customer's language, so the
 * translator sends it as written instead of asking the AI to "translate" it.
 * Text with nothing left to translate (only protected names/amounts) skips
 * the AI too. Everything else — English text, merchant text, uncertified
 * languages — still goes to the AI exactly as before.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const aiCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class { messages = { create: (...args: unknown[]) => aiCreate(...args) }; },
}));
vi.mock('@/lib/posthog/flags', () => ({
  isFeatureEnabledServer: vi.fn().mockResolvedValue(true),
  FLAGS: { BOT_TRANSLATION_ENABLED: 'bot-translation-enabled', LLM_INTENT_ENABLED: 'llm-intent-enabled' },
}));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn(() => ({ allowed: true, remaining: 49 })) }));

import { translateBotResponse, _clearTranslationCache, type TranslationContext } from '../translate';
import { localizeMessage } from '../outbound-localizer';
import {
  getFlowCopy, fillFlowCopy, isPhraseBookText, _FLOW_COPY_FOR_TESTS as COPY,
} from '../flows/flow-localization';
import { capabilitySelectionFlow } from '../flows/capability-selection.flow';

const tCtx = (lang: string): TranslationContext => ({
  entitlement: { translationAllowed: true, allowedLanguages: [lang], llmAllowed: true } as any,
  businessId: 'biz-1',
  supabase: null,
});

beforeEach(() => {
  aiCreate.mockReset();
  aiCreate.mockResolvedValue({ content: [{ type: 'text', text: 'AI TRANSLATION' }], usage: { input_tokens: 1, output_tokens: 1 } });
  _clearTranslationCache();
});

describe('isPhraseBookText', () => {
  it('recognises distinctly-Pidgin certified copy and combinations of it', () => {
    expect(isPhraseBookText('pcm', getFlowCopy('pcm', 'menu.what_to_do'))).toBe(true);
    expect(isPhraseBookText('pcm', `${getFlowCopy('pcm', 'nav.cancel_retry')}\n\n${getFlowCopy('pcm', 'menu.what_to_do')}`)).toBe(true);
  });

  it('never treats a filled-in template or English-identical copy as Pidgin', () => {
    // Templates are not matched at all (reviewers' P1: "Welcome to {businessName}! {emoji}"
    // would otherwise accept any "Welcome to X! ..." merchant greeting).
    expect(isPhraseBookText('pcm', fillFlowCopy('pcm', 'ordering.welcome', { businessName: 'Mama Put', emoji: '🍲' }))).toBe(false);
    // Copy that is identical in English could equally be an English sentence.
    expect(COPY.pcm['menu.title']).toBe(COPY.en['menu.title']);
    expect(isPhraseBookText('pcm', COPY.pcm['menu.title'])).toBe(false);
  });

  it.each([
    'Welcome to Mama Put! How can I help you today?',
    "Welcome to Mama Put! 🙏 We're glad you're here. How can we serve you today?",
    'Welcome to our shop! We are open 9am to 5pm daily.',
    'Your appointment is confirmed for Monday',
    'Your order is ready for pickup',
    'Your table for two is reserved for tonight',
    'Your Monthly payment of *₦5,000* for *Tithe* is now active.',
    'Your booking payment for *BK-1234* was refunded.',
    'Pay with cash when you arrive',
    'Pay with bank transfer to the account below',
    'Amount: please pay the full balance before arrival',
    'Your choice of soft drink for lunch, served chilled',
  ])('English or merchant text shaped like a Pidgin template still needs the AI: %s', (text) => {
    expect(isPhraseBookText('pcm', text)).toBe(false);
  });

  it('rejects merchant or English text, mixed messages, English and uncertified languages', () => {
    expect(isPhraseBookText('pcm', 'Welcome to our lovely salon, we open at nine.')).toBe(false);
    expect(isPhraseBookText('pcm', `Our merchant greeting here\n\n${getFlowCopy('pcm', 'menu.what_to_do')}`)).toBe(false);
    expect(isPhraseBookText('en', getFlowCopy('en', 'menu.what_to_do'))).toBe(false);
    // Yoruba is not certified: its copy falls back to English, which still needs the AI.
    expect(isPhraseBookText('yo', COPY.yo['menu.what_to_do'])).toBe(false);
    expect(isPhraseBookText('pcm', '')).toBe(false);
  });
});

describe('translateBotResponse', () => {
  it('sends certified Pidgin phrase-book text as written, without an AI call', async () => {
    const text = getFlowCopy('pcm', 'menu.what_to_do');
    expect(await translateBotResponse(text, 'pcm', tCtx('pcm'))).toBe(text);
    expect(aiCreate).not.toHaveBeenCalled();
  });

  it('skips the AI when only protected values are left (business name)', async () => {
    expect(await translateBotResponse('Test Biz', 'pcm', tCtx('pcm'), { protectedValues: ['Test Biz'] })).toBe('Test Biz');
    expect(aiCreate).not.toHaveBeenCalled();
  });

  it('a welcome menu body with the merchant greeting still goes to the AI', async () => {
    const body = `Welcome to Mama Put! How can I help you today?\n\n${getFlowCopy('pcm', 'menu.what_to_do')}`;
    await translateBotResponse(body, 'pcm', tCtx('pcm'));
    expect(aiCreate).toHaveBeenCalledTimes(1);
  });

  it('still translates English and merchant text with the AI (unchanged)', async () => {
    expect(await translateBotResponse('Please type your full name to continue.', 'pcm', tCtx('pcm'))).toBe('AI TRANSLATION');
    expect(aiCreate).toHaveBeenCalledTimes(1);
  });

  it('still translates for uncertified languages, even phrase-book wording (unchanged)', async () => {
    await translateBotResponse(getFlowCopy('yo', 'menu.what_to_do'), 'yo', tCtx('yo'));
    expect(aiCreate).toHaveBeenCalledTimes(1);
  });
});

describe('Pidgin capability menu', () => {
  function db() {
    const from = vi.fn(() => {
      const c: Record<string, any> = {};
      for (const m of ['eq', 'neq', 'or', 'is', 'not', 'in', 'gte', 'lte', 'order', 'limit']) c[m] = vi.fn(() => c);
      c.single = vi.fn().mockResolvedValue({ data: null, error: null });
      c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
      c.then = (f: any) => f({ data: [], error: null });
      c.select = vi.fn((...a: any[]) => {
        if (a[1]?.count === 'exact') {
          const cc: Record<string, any> = {};
          for (const m of ['eq', 'neq', 'or', 'is', 'not', 'limit', 'in', 'gte']) cc[m] = vi.fn(() => cc);
          cc.then = (f: any) => f({ count: 3, data: [], error: null });
          return cc;
        }
        return c;
      });
      return c;
    });
    return { from, rpc: vi.fn().mockResolvedValue({ data: null, error: null }) } as any;
  }

  it('a Waaiio-worded menu only asks the AI about English-identical labels', async () => {
    const step = capabilitySelectionFlow.steps.find(s => s.id === 'select_capability')!;
    const ctx: any = {
      supabase: db(), sender: {}, standalone: {}, intelligence: {}, t: async (x: string) => x,
      from: '+2348000000000', copyLang: 'pcm',
      session: { id: 's', user_id: null, business_id: 'b', current_step: 'select_capability', session_data: { capabilities: ['scheduling', 'ordering', 'ticketing', 'chat'], _detected_language: 'pcm' }, version: 0 },
      business: { id: 'b', name: 'Test Biz', slug: 't', category: 'salon', flow_type: 'scheduling', subscription_tier: 'growth', metadata: {} },
    };
    const [menu] = await step.prompt!(ctx);
    Object.assign(menu, { footer: getFlowCopy('pcm', 'nav.footer') });
    const sent = await localizeMessage(menu, 'pcm', tCtx('pcm'));
    // Before this change: 8 AI calls (every label, the business name, the body, the footer).
    // Now only labels whose Pidgin copy is identical to English still go to the AI.
    const asked = aiCreate.mock.calls.map((c: any) => c[0].messages[0].content as string);
    expect(asked.length).toBeLessThan(8);
    const englishCopy = new Set(Object.values(COPY.en));
    for (const text of asked) expect(englishCopy.has(text)).toBe(true);
    expect(sent.type).toBe('list');
  });
});

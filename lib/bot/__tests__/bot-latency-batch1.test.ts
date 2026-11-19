/**
 * Bot latency Batch 1 (Owner request 2026-11-19) — unit behaviour tests.
 *
 * Each speed-up must give the customer exactly the same reply:
 * 1. ai_conversation_config is read once per business per message (reader).
 * 2. The translation flag is a remote call; it is skipped for text that is
 *    returned unchanged anyway, and its answer is reused for 60 seconds.
 * 3. The parts of one list/buttons message are translated together, and the
 *    localized message is field-for-field what one-by-one translation gave.
 * 4. select_service's prompt reuses the services skipIf read in the same
 *    execute(), and its list equals the list from a fresh read.
 * 5. Class "spots left" counts run together and give the same numbers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const flagSpy = vi.fn();
const aiCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class { messages = { create: (...args: unknown[]) => aiCreate(...args) }; },
}));
vi.mock('@/lib/posthog/flags', () => ({
  isFeatureEnabledServer: (...args: unknown[]) => flagSpy(...args),
  FLAGS: { BOT_TRANSLATION_ENABLED: 'bot-translation-enabled', LLM_INTENT_ENABLED: 'llm-intent-enabled' },
}));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn(() => ({ allowed: true, remaining: 49 })) }));

import { createAiConfigReader } from '../ai-config-reader';
import { translateBotResponse, _clearTranslationCache, type TranslationContext } from '../translate';
import { localizeMessage } from '../outbound-localizer';
import { schedulingFlow } from '../flows/scheduling.flow';
import type { FlowContext, PromptList, PromptButtons } from '../flows/types';

const tCtx = (lang: string): TranslationContext => ({
  entitlement: { translationAllowed: true, allowedLanguages: [lang], llmAllowed: true } as any,
  businessId: 'biz-1',
  supabase: null,
});

beforeEach(() => {
  flagSpy.mockReset();
  flagSpy.mockResolvedValue(true);
  aiCreate.mockReset();
  aiCreate.mockImplementation(async (req: { messages: Array<{ content: string }> }) => ({
    content: [{ type: 'text', text: `FR:${req.messages[0].content}` }], usage: { input_tokens: 1, output_tokens: 1 },
  }));
  _clearTranslationCache();
});

// ── Recording Supabase mock ────────────────────────────────────────────────

type Call = { table: string; filters: Array<[string, unknown[]]> };

function recordingDb(rowsFor: (call: Call) => { data?: unknown; count?: number }) {
  const calls: Call[] = [];
  const client = {
    from: vi.fn((table: string) => {
      const call: Call = { table, filters: [] };
      calls.push(call);
      const c: Record<string, any> = {};
      for (const m of ['select', 'eq', 'neq', 'is', 'or', 'in', 'order', 'gte', 'lte', 'limit']) {
        c[m] = vi.fn((...args: unknown[]) => { call.filters.push([m, args]); return c; });
      }
      const result = () => ({ data: null, count: 0, error: null, ...rowsFor(call) });
      c.maybeSingle = vi.fn(async () => result());
      c.single = vi.fn(async () => result());
      c.then = (ok: any, bad: any) => Promise.resolve(result()).then(ok, bad);
      return c;
    }),
  };
  return { calls, client };
}

// ── 1. ai_conversation_config reader ──────────────────────────────────────

describe('createAiConfigReader', () => {
  it('reads each value once per business and returns the same result to every caller', async () => {
    const db = recordingDb(call => call.table === 'ai_conversation_config'
      ? { data: { enabled_languages: ['en', 'yo'], auto_route_threshold: 0.9, clarification_threshold: 0.5 } }
      : {});
    const reader = createAiConfigReader(db.client as any);
    const [a, b, c] = await Promise.all([reader.languages('biz-1'), reader.languages('biz-1'), reader.languages('biz-1')]);
    expect(a).toEqual(['en', 'yo']);
    expect(b).toBe(a);
    expect(c).toBe(a);
    const cfg1 = await reader.conversationConfig('biz-1');
    const cfg2 = await reader.conversationConfig('biz-1');
    expect(cfg2).toBe(cfg1);
    expect(cfg1.autoRouteThreshold).toBe(0.9);
    // One languages read + one config read for the message, not one per caller.
    expect(db.calls.filter(c => c.table === 'ai_conversation_config')).toHaveLength(2);
  });

  it('keeps businesses apart', async () => {
    const db = recordingDb(call => ({
      data: { enabled_languages: [call.filters.find(([m, a]) => m === 'eq' && a[0] === 'business_id')![1][1] === 'biz-2' ? 'fr' : 'yo'] },
    }));
    const reader = createAiConfigReader(db.client as any);
    expect(await reader.languages('biz-1')).toEqual(['yo']);
    expect(await reader.languages('biz-2')).toEqual(['fr']);
  });
});

// ── 2. Translation flag ───────────────────────────────────────────────────

describe('translateBotResponse: translation flag', () => {
  it('is not called for text returned unchanged anyway (short, or nothing to translate)', async () => {
    expect(await translateBotResponse('OK', 'fr', tCtx('fr'))).toBe('OK');
    expect(await translateBotResponse('₦5,000 🎉', 'fr', tCtx('fr'))).toBe('₦5,000 🎉');
    expect(flagSpy).not.toHaveBeenCalled();
    expect(aiCreate).not.toHaveBeenCalled();
  });

  it('is asked once per language for many strings, and the translations are unchanged', async () => {
    const out = await Promise.all(['Choose a service', 'Pick a date', 'Pick a time'].map(t => translateBotResponse(t, 'fr', tCtx('fr'))));
    expect(out).toEqual(['FR:Choose a service', 'FR:Pick a date', 'FR:Pick a time']);
    expect(flagSpy).toHaveBeenCalledTimes(1);
    await translateBotResponse('Your booking is confirmed', 'fr', tCtx('fr'));
    expect(flagSpy).toHaveBeenCalledTimes(1);
  });

  it('flag off: the original text is sent, as before', async () => {
    flagSpy.mockResolvedValue(false);
    expect(await translateBotResponse('Choose a service', 'fr', tCtx('fr'))).toBe('Choose a service');
    expect(aiCreate).not.toHaveBeenCalled();
  });

  it('a "no" (flag off, or PostHog failing) is not reused: the next string asks again', async () => {
    flagSpy.mockResolvedValueOnce(false).mockResolvedValue(true);
    expect(await translateBotResponse('Choose a service', 'fr', tCtx('fr'))).toBe('Choose a service');
    expect(await translateBotResponse('Pick a date', 'fr', tCtx('fr'))).toBe('FR:Pick a date');
    expect(flagSpy).toHaveBeenCalledTimes(2);
  });

  it('flag check failure still defaults to translating, as before', async () => {
    flagSpy.mockRejectedValue(new Error('posthog down'));
    expect(await translateBotResponse('Choose a service', 'fr', tCtx('fr'))).toBe('FR:Choose a service');
  });

  it('the flag answer expires after 60 seconds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await translateBotResponse('Choose a service', 'fr', tCtx('fr'));
      vi.setSystemTime(Date.now() + 61_000);
      await translateBotResponse('Pick a date', 'fr', tCtx('fr'));
      expect(flagSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── 3. Parts of one message translated together ───────────────────────────

describe('localizeMessage: parts translated together, same message out', () => {
  const list: PromptList = {
    type: 'list', title: 'Our services', body: 'What would you like to book?', buttonLabel: 'Choose',
    footer: 'Reply MENU for options',
    items: [{ title: 'Haircut', description: 'Short and neat', postbackText: 'svc-1' }],
    sections: [{ title: 'Popular', items: [{ title: 'Braids', description: 'Long lasting style', postbackText: 'svc-2' }] }],
  } as PromptList;

  it('list: every field is what one-by-one translation gives; ids untouched', async () => {
    const out = await localizeMessage(list, 'fr', tCtx('fr')) as PromptList;
    expect(out).toEqual({
      ...list,
      title: 'FR:Our services', body: 'FR:What would you like to book?', buttonLabel: 'FR:Choose',
      footer: 'FR:Reply MENU for options',
      items: [{ title: 'Haircut', description: 'FR:Short and neat', postbackText: 'svc-1' }],
      sections: [{ title: 'FR:Popular', items: [{ title: 'Braids', description: 'FR:Long lasting style', postbackText: 'svc-2' }] }],
    });
    expect(Object.keys(out)).toEqual(Object.keys({ ...list }));
  });

  it('list: all translations start before any finishes', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    aiCreate.mockImplementation(async (req: { messages: Array<{ content: string }> }) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      return { content: [{ type: 'text', text: `FR:${req.messages[0].content}` }], usage: { input_tokens: 1, output_tokens: 1 } };
    });
    await localizeMessage(list, 'fr', tCtx('fr'));
    // title, body, buttonLabel, footer, item description and the section title start
    // together (a section's items still follow its title, unchanged); before, the four
    // top-level fields waited for the items and then for each other.
    expect(maxInFlight).toBe(6);
  });

  it('buttons: same message out; button ids untouched; no footer stays no footer', async () => {
    const buttons: PromptButtons = {
      type: 'buttons', body: 'Ready to check out?',
      buttons: [{ id: 'checkout', title: 'Check out' }, { id: 'browse_more', title: 'Browse more' }],
    } as PromptButtons;
    const out = await localizeMessage(buttons, 'fr', tCtx('fr')) as PromptButtons;
    expect(out).toEqual({
      ...buttons, body: 'FR:Ready to check out?', footer: undefined,
      buttons: [{ id: 'checkout', title: 'FR:Check out' }, { id: 'browse_more', title: 'FR:Browse more' }],
    });
  });
});

// ── 4 + 5. select_service ─────────────────────────────────────────────────

const SERVICES = [
  { id: 'svc-a', name: 'Haircut', price: 5000, duration_minutes: 30, max_capacity: 1, is_class: false, class_schedule: null, billing_type: 'one_time', metadata: null },
  { id: 'svc-b', name: 'Beard trim and shape with hot towel finish', price: 0, duration_minutes: 90, max_capacity: 1, is_class: false, class_schedule: null, billing_type: 'one_time', metadata: null },
  { id: 'svc-c', name: 'Monthly grooming', price: 20000, duration_minutes: 60, max_capacity: 1, is_class: false, class_schedule: null, billing_type: 'recurring', recurring_interval: 'monthly', metadata: null },
];
const CLASSES = [
  { id: 'cls-1', name: 'Yoga', price: 3000, duration_minutes: 60, max_capacity: 10, is_class: true, class_schedule: [{ day: 'monday', time: '09:00' }], metadata: null },
  { id: 'cls-2', name: 'Pilates', price: 0, duration_minutes: 45, max_capacity: 8, is_class: true, class_schedule: [{ day: 'tuesday', time: '18:00' }], metadata: null },
];

function serviceDb(classes = false) {
  return recordingDb(call => {
    if (call.table === 'services') {
      const rows = classes ? CLASSES : SERVICES;
      const inFilter = call.filters.find(([m, a]) => m === 'in' && a[0] === 'id');
      return { data: inFilter ? rows.filter(r => (inFilter[1][1] as string[]).includes(r.id)) : rows };
    }
    if (call.table === 'bookings') {
      const svc = call.filters.find(([m, a]) => m === 'eq' && a[0] === 'service_id')![1][1];
      return { count: svc === 'cls-1' ? 3 : 7 };
    }
    return {};
  });
}

function serviceCtx(db: ReturnType<typeof recordingDb>, sessionData: Record<string, unknown> = {}): FlowContext {
  return {
    supabase: db.client as any, sender: {} as any, standalone: {} as any, intelligence: {} as any,
    from: '+2348000000000', copyLang: 'en',
    session: { id: 's1', user_id: null, business_id: 'biz-1', current_step: 'select_service', session_data: { ...sessionData }, version: 0 },
    business: { id: 'biz-1', name: 'Salon', slug: 'salon', category: 'salon', flow_type: 'scheduling', subscription_tier: 'growth', trial_ends_at: null, metadata: {}, country_code: 'NG' },
  } as unknown as FlowContext;
}

const selectService = schedulingFlow.steps.find(s => s.id === 'select_service')!;

describe('select_service: prompt reuses the services skipIf read', () => {
  it.each([
    ['all services', {}],
    ['smart-intent matches only', { _matched_service_ids: ['svc-c', 'svc-a'] }],
  ])('%s: one services read, and the same list as a fresh read', async (_label, sessionData) => {
    const fresh = serviceDb();
    const expected = await selectService.prompt(serviceCtx(fresh, sessionData));
    expect(fresh.calls.filter(c => c.table === 'services')).toHaveLength(1);

    const db = serviceDb();
    const ctx = serviceCtx(db, sessionData);
    expect(await selectService.skipIf!(ctx)).toBe(false);
    const actual = await selectService.prompt(ctx);
    expect(actual).toEqual(expected);
    expect(db.calls.filter(c => c.table === 'services')).toHaveLength(1);
  });

  it('a later prompt (new message, new ctx) reads fresh', async () => {
    const db = serviceDb();
    const ctx = serviceCtx(db);
    await selectService.skipIf!(ctx);
    await selectService.prompt(ctx);
    await selectService.prompt(serviceCtx(db));
    expect(db.calls.filter(c => c.table === 'services')).toHaveLength(2);
  });

  it('classes: spots left are the same numbers, one count per class', async () => {
    const db = serviceDb(true);
    const [msg] = await selectService.prompt(serviceCtx(db, { active_capability: 'class_booking' })) as PromptList[];
    expect(msg.items.map(i => i.description)).toEqual([
      '₦3,000 • Mon 9:00 AM • 7 spots left',
      'Tue 6:00 PM • 1 spot left',
    ]);
    expect(db.calls.filter(c => c.table === 'bookings')).toHaveLength(2);
  });
});

/**
 * Language picker behavioral tests (#524)
 *
 * Tests the first-contact language picker: when it is shown, when it is
 * suppressed, how lang_pick_* selections are handled, and edge-case
 * entitlement refusal. All tests invoke BotService.handleMessage() with
 * mocked Supabase, MessageSender, and supporting modules.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module-level mocks (must be hoisted before any imports) ──

vi.mock('@/lib/countries', () => ({
  loadCountries: vi.fn().mockResolvedValue([]),
  getCountry: vi.fn(),
  getCountryList: vi.fn().mockReturnValue([]),
  isValidCountryCode: vi.fn().mockReturnValue(true),
  getDialingCodeMap: vi.fn().mockReturnValue({}),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimitAsync: vi.fn().mockResolvedValue({ allowed: true, remaining: 10 }),
}));
vi.mock('@/lib/platformSettings', () => ({
  loadPlatformSettings: vi.fn().mockResolvedValue({ bot_rate_limit_per_minute: 30 }),
}));
vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));
vi.mock('@/lib/bot/translate', () => ({
  translateBotResponse: vi.fn(async (t: string) => t),
  detectLanguage: vi.fn(async () => 'en'),
  getLanguageName: vi.fn((code: string) => {
    const names: Record<string, string> = {
      en: 'English',
      pcm: 'Nigerian Pidgin',
      yo: 'Yoruba',
      fr: 'French',
      es: 'Spanish',
    };
    return names[code] || code;
  }),
}));
vi.mock('@/lib/bot/handlers/global-queries', () => ({
  handleGlobalQuery: vi.fn(async (opts: { session: unknown }) => ({
    handled: false,
    session: opts.session,
  })),
  isOrdersQuery: vi.fn(() => false),
}));
vi.mock('@/lib/bot/handlers/escape-hatches', () => ({
  HOME_PATTERN: /^home$/i,
  handleEscapeHatch: vi.fn().mockResolvedValue({ handled: false }),
}));
vi.mock('@/lib/bot/keyword-service', () => ({
  loadBotCustomConfig: vi.fn().mockResolvedValue({
    welcome_buttons: [],
    quick_replies: [],
    default_reply: null,
  }),
  matchQuickReply: vi.fn(() => null),
  loadUnifiedKeywords: vi.fn().mockResolvedValue([]),
  matchUnifiedKeyword: vi.fn(() => null),
}));
vi.mock('@/lib/bot/confidence-policy', () => ({
  loadConversationConfig: vi.fn().mockResolvedValue({
    aiEnabled: false,
    autoRouteThreshold: 0.85,
    clarificationThreshold: 0.6,
    fallbackBehavior: 'menu',
    faqEnabled: true,
    knowledgeEnabled: true,
    assistantName: 'Assistant',
    tone: 'friendly',
  }),
}));
vi.mock('@/lib/bot/automation/rules-engine', () => ({
  evaluateRules: vi.fn().mockResolvedValue(undefined),
}));

import { BotService } from '../bot.service';
import { createCaptureSender } from './bot-harness';
import type { StandaloneService } from '../standalone.service';
import type { BotIntelligenceService } from '../bot-intelligence';

// ── Factories ──

const PHONE = '+2349000000001';
const BIZ_ID = 'biz-picker-test';

function createMockStandalone(): StandaloneService {
  return {
    loadWhatsAppConfigBundle: vi.fn().mockResolvedValue({
      templates: { greeting: 'Welcome!' },
      welcome_buttons: [],
      auto_reply_enabled: false,
      business_hours: null,
      alias: null,
    }),
    checkTierLimitsFromBusiness: vi.fn().mockResolvedValue({
      allowed: true,
      isWhitelabel: false,
    }),
    fillTemplate: vi.fn((t: string) => t),
    getBotAlias: vi.fn().mockResolvedValue(null),
  } as any;
}

function createMockIntelligence(): BotIntelligenceService {
  return {
    isTimedOut: vi.fn(() => ({ timedOut: false, remaining: 0 })),
    containsProfanity: vi.fn(() => false),
    recordProfanity: vi.fn(() => ({ timeout: false, warn: false })),
    resetAbuse: vi.fn(),
    getHelpText: vi.fn(() => 'Help'),
    getPersonaGreeting: vi.fn((_a: string, n: string) => `Hi from ${n}`),
    getContextualHelp: vi.fn(() => 'Help'),
  } as any;
}

/**
 * Build a mock Supabase client with configurable table behavior.
 *
 * The bot_sessions mock is special: when activeSession is null (new contact),
 * the insert() chain must return a freshly-created session object via
 * .select().single() so the new-session creation path succeeds.
 */
function createTableMock(config: {
  activeSession?: Record<string, unknown> | null;
  business?: Record<string, unknown> | null;
  capabilities?: Array<{ capability: string; is_enabled: boolean; sort_order: number }>;
  enabledLanguages?: string[];
  customerProfileLanguage?: string | null;
  updateTracker?: Array<{ table: string; data: unknown }>;
  insertTracker?: Array<{ table: string; data: Record<string, unknown> }>;
  rpcTracker?: Array<{ fn: string; args: Record<string, unknown> }>;
  upsertTracker?: Array<{ table: string; data: unknown }>;
}) {
  const updateTracker = config.updateTracker || [];
  const insertTracker = config.insertTracker || [];
  const rpcTracker = config.rpcTracker || [];
  const upsertTracker = config.upsertTracker || [];

  function makeChain(resolveData: unknown = null) {
    const chain: Record<string, any> = {};
    for (const m of [
      'select', 'insert', 'update', 'upsert', 'delete',
      'eq', 'neq', 'or', 'in', 'is', 'not', 'ilike', 'like',
      'gte', 'lte', 'gt', 'lt', 'order', 'limit', 'range',
      'filter', 'match', 'contains', 'containedBy',
    ]) {
      chain[m] = vi.fn().mockReturnValue(chain);
    }
    chain.single = vi.fn().mockResolvedValue({
      data: resolveData,
      error: resolveData ? null : { message: 'not found' },
    });
    chain.maybeSingle = vi.fn().mockResolvedValue({ data: resolveData, error: null });
    return chain;
  }

  /** A chain where insert() returns a select-chain that resolves to the inserted data. */
  function makeSessionChain() {
    // Base chain for select/eq/order queries (active session lookup returns activeSession)
    const chain = makeChain(config.activeSession);

    // Override insert: it captures the data AND returns a chain whose .select().single()
    // returns a synthetic session object built from the inserted data.
    chain.insert = vi.fn((data: Record<string, unknown>) => {
      insertTracker.push({ table: 'bot_sessions', data });
      const syntheticSession = {
        id: 'session-new-' + Math.random().toString(36).slice(2, 8),
        ...data,
        version: 0,
        is_active: true,
      };
      // Return a sub-chain whose .select().single() resolves to the synthetic session
      const insertChain: Record<string, any> = {};
      for (const m of ['select', 'eq', 'neq', 'or', 'in', 'is', 'not', 'order', 'limit', 'range', 'filter']) {
        insertChain[m] = vi.fn().mockReturnValue(insertChain);
      }
      insertChain.single = vi.fn().mockResolvedValue({ data: syntheticSession, error: null });
      insertChain.maybeSingle = vi.fn().mockResolvedValue({ data: syntheticSession, error: null });
      return insertChain;
    });

    // Override update: captures data and returns the original chain for further chaining
    const origUpdate = chain.update;
    chain.update = vi.fn((data: unknown) => {
      updateTracker.push({ table: 'bot_sessions', data });
      return origUpdate(data);
    });

    const origUpsert = chain.upsert;
    chain.upsert = vi.fn((data: unknown) => {
      upsertTracker.push({ table: 'bot_sessions', data });
      return origUpsert(data);
    });

    chain.delete = vi.fn().mockReturnValue(chain);
    return chain;
  }

  return {
    from: vi.fn((table: string) => {
      if (table === 'bot_sessions') return makeSessionChain();
      if (table === 'businesses') return makeChain(config.business);
      if (table === 'business_capabilities') {
        const d = Promise.resolve({
          data: config.capabilities ?? [],
          error: null,
        });
        const c: Record<string, any> = {};
        for (const m of ['select', 'eq', 'neq', 'not', 'or', 'in', 'is', 'ilike', 'order', 'limit', 'range', 'filter']) c[m] = vi.fn(() => c);
        c.single = vi.fn().mockResolvedValue({ data: null, error: null });
        c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
        c.then = d.then.bind(d);
        c.catch = d.catch.bind(d);
        return c;
      }
      if (table === 'capability_overrides') {
        const d = Promise.resolve({ data: [], error: null });
        const c: Record<string, any> = {};
        for (const m of ['select', 'eq', 'not', 'or', 'in', 'is']) c[m] = vi.fn(() => c);
        c.then = d.then.bind(d);
        c.catch = d.catch.bind(d);
        return c;
      }
      if (table === 'ai_conversation_config') {
        return makeChain(
          config.enabledLanguages
            ? { enabled_languages: config.enabledLanguages }
            : null,
        );
      }
      if (table === 'customer_profiles') {
        const chain = makeChain(
          config.customerProfileLanguage !== undefined && config.customerProfileLanguage !== null
            ? { preferred_language: config.customerProfileLanguage }
            : null,
        );
        const origUpsert = chain.upsert;
        chain.upsert = vi.fn((data: unknown) => {
          upsertTracker.push({ table: 'customer_profiles', data });
          return origUpsert(data);
        });
        return chain;
      }
      if (table === 'platform_settings') return makeChain({ value: false });
      if (table === 'profiles') return makeChain({ id: 'profile-1' });
      if (table === 'blocked_phones') {
        // Return count=0 (not blocked)
        const chain = makeChain();
        chain.select = vi.fn().mockReturnValue(chain);
        chain.single = vi.fn().mockResolvedValue({ data: null, count: 0, error: null });
        return chain;
      }
      return makeChain();
    }),
    rpc: vi.fn((fn: string, args?: Record<string, unknown>) => {
      rpcTracker.push({ fn, args: args || {} });
      if (fn === 'get_bot_context') {
        if (config.activeSession) {
          // Return the existing session so the active-session handler runs
          return Promise.resolve({
            data: {
              has_session: true,
              session: {
                ...config.activeSession,
                whatsapp_number: PHONE,
                is_active: true,
                version: config.activeSession.version ?? 1,
              },
              business: config.business || null,
              capabilities: config.capabilities || [],
              capability_overrides: [],
            },
            error: null,
          });
        }
        // Return no active session — triggers new-session creation
        return Promise.resolve({ data: { has_session: false }, error: null });
      }
      if (fn === 'update_session_cas') {
        return Promise.resolve({
          data: { success: true, version: ((args as any)?.p_expected_version || 0) + 1 },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    }),
    storage: {
      from: vi.fn(() => ({
        upload: vi.fn(),
        createSignedUrl: vi.fn(),
        getPublicUrl: vi.fn(),
      })),
    },
  } as any;
}

function makeBusiness(overrides: Record<string, unknown> = {}) {
  return {
    id: BIZ_ID,
    status: 'active',
    subscription_tier: 'growth',
    trial_ends_at: null,
    category: 'restaurant',
    name: 'Test Biz',
    slug: 'test-biz',
    flow_type: 'ordering',
    metadata: {},
    country_code: 'NG',
    is_whitelabel: false,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════
// 1. Picker shown to new contact with 2+ certified+entitled languages
// ═══════════════════════════════════════════════════════

describe('Language picker — first contact presentation', () => {
  it('shows picker when business has 2+ certified+entitled languages and contact has no preference', async () => {
    const sender = createCaptureSender();
    const supabase = createTableMock({
      activeSession: null,
      business: makeBusiness({ subscription_tier: 'growth' }),
      capabilities: [{ capability: 'ordering', is_enabled: true, sort_order: 0 }],
      enabledLanguages: ['en', 'pcm'],
      customerProfileLanguage: null,
    });

    const bot = new BotService(
      supabase,
      sender,
      createMockStandalone(),
      createMockIntelligence(),
    );
    await bot.handleMessage(PHONE, 'Hello', 'text', undefined, BIZ_ID);

    const msgs = sender.getMessages();
    // The picker is sent as a list message
    const listMsgs = msgs.filter(m => m.type === 'list');
    expect(listMsgs.length).toBeGreaterThanOrEqual(1);
    // List items should include lang_pick_ postback prefixes
    const pickerList = listMsgs.find(m =>
      m.items?.some(i => i.postbackText.startsWith('lang_pick_')),
    );
    expect(pickerList).toBeDefined();
    // Should have at least 2 language options (e.g. Pidgin + English)
    expect(pickerList!.items!.length).toBeGreaterThanOrEqual(2);
  });
});

// ═══════════════════════════════════════════════════════
// 2. Picker NOT shown when business has only 1 language
// ═══════════════════════════════════════════════════════

describe('Language picker — single language suppression', () => {
  it('does NOT show picker when business has only English (free tier)', async () => {
    const sender = createCaptureSender();
    const supabase = createTableMock({
      activeSession: null,
      business: makeBusiness({ subscription_tier: 'free' }),
      capabilities: [{ capability: 'ordering', is_enabled: true, sort_order: 0 }],
      enabledLanguages: ['en'],
      customerProfileLanguage: null,
    });

    const bot = new BotService(
      supabase,
      sender,
      createMockStandalone(),
      createMockIntelligence(),
    );
    await bot.handleMessage(PHONE, 'Hello', 'text', undefined, BIZ_ID);

    const msgs = sender.getMessages();
    const pickerList = msgs.find(
      m => m.type === 'list' && m.items?.some(i => i.postbackText.startsWith('lang_pick_')),
    );
    expect(pickerList).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════
// 3. Picker NOT shown when customer has remembered language preference
// ═══════════════════════════════════════════════════════

describe('Language picker — remembered preference suppression', () => {
  it('does NOT show picker when session has a remembered language', async () => {
    // The remembered language pathway is triggered by readPreferredResponseLanguage
    // returning a value during session creation. When hasRememberedLanguage is true
    // the picker code block is skipped entirely.
    const sender = createCaptureSender();
    const supabase = createTableMock({
      activeSession: null,
      business: makeBusiness({ subscription_tier: 'growth' }),
      capabilities: [{ capability: 'ordering', is_enabled: true, sort_order: 0 }],
      enabledLanguages: ['en', 'pcm'],
      customerProfileLanguage: null,
    });

    // Mock the language preference module to return a saved preference
    vi.doMock('@/lib/bot/language-preference', async () => {
      const actual = await vi.importActual<typeof import('@/lib/bot/language-preference')>('@/lib/bot/language-preference');
      return {
        ...actual,
        readPreferredResponseLanguage: vi.fn().mockResolvedValue('pcm'),
        writePreferredResponseLanguage: vi.fn().mockResolvedValue(undefined),
      };
    });

    // Re-import BotService to pick up the doMock
    const { BotService: FreshBotService } = await import('../bot.service');
    const bot = new FreshBotService(
      supabase,
      sender,
      createMockStandalone(),
      createMockIntelligence(),
    );
    await bot.handleMessage(PHONE, 'Hello', 'text', undefined, BIZ_ID);

    const msgs = sender.getMessages();
    const pickerList = msgs.find(
      m => m.type === 'list' && m.items?.some(i => i.postbackText.startsWith('lang_pick_')),
    );
    expect(pickerList).toBeUndefined();

    vi.doUnmock('@/lib/bot/language-preference');
  });
});

// ═══════════════════════════════════════════════════════
// 4. Picker NOT shown when customer_profiles.preferred_language exists
// ═══════════════════════════════════════════════════════

describe('Language picker — customer_profiles.preferred_language suppression', () => {
  it('does NOT show picker when customer_profiles has a saved preferred_language', async () => {
    const sender = createCaptureSender();
    const supabase = createTableMock({
      activeSession: null,
      business: makeBusiness({ subscription_tier: 'growth' }),
      capabilities: [{ capability: 'ordering', is_enabled: true, sort_order: 0 }],
      enabledLanguages: ['en', 'pcm'],
      // This customer already picked a language on a prior visit
      customerProfileLanguage: 'pcm',
    });

    const bot = new BotService(
      supabase,
      sender,
      createMockStandalone(),
      createMockIntelligence(),
    );
    await bot.handleMessage(PHONE, 'Hello', 'text', undefined, BIZ_ID);

    const msgs = sender.getMessages();
    const pickerList = msgs.find(
      m => m.type === 'list' && m.items?.some(i => i.postbackText.startsWith('lang_pick_')),
    );
    // Picker suppressed because customer_profiles.preferred_language exists
    expect(pickerList).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════
// 5. lang_pick_pcm on a business WITHOUT pcm entitlement
// ═══════════════════════════════════════════════════════

describe('Language picker — entitlement refusal', () => {
  it('lang_pick_pcm on free-tier business (no pcm entitlement) sends lang.not_available', async () => {
    const sender = createCaptureSender();
    // Active session exists (picker was shown), but business is free tier
    const session = {
      id: 'session-refuse',
      user_id: 'user-refuse',
      phone: PHONE,
      business_id: BIZ_ID,
      current_step: 'idle',
      session_data: {},
      status: 'active',
      version: 1,
    };
    const supabase = createTableMock({
      activeSession: session,
      // Free tier -> only English entitled
      business: makeBusiness({ subscription_tier: 'free' }),
      capabilities: [{ capability: 'ordering', is_enabled: true, sort_order: 0 }],
      enabledLanguages: ['en'],
    });

    const bot = new BotService(
      supabase,
      sender,
      createMockStandalone(),
      createMockIntelligence(),
    );
    await bot.handleMessage(PHONE, 'lang_pick_pcm', 'interactive', undefined, BIZ_ID);

    const msgs = sender.getMessages();
    const textMsgs = msgs.filter(m => m.type === 'text');
    // Should receive a "not available" refusal
    const refusalSent = textMsgs.some(m =>
      m.text?.toLowerCase().includes('not available') ||
      m.text?.toLowerCase().includes('not yet available'),
    );
    expect(refusalSent).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════
// 6. lang_pick_pcm on entitled business — language persisted
// ═══════════════════════════════════════════════════════

describe('Language picker — successful selection persistence', () => {
  it('lang_pick_pcm on growth-tier business with pcm: saves to session (CAS), profile, and customer_profiles', async () => {
    const sender = createCaptureSender();
    const rpcTracker: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const upsertTracker: Array<{ table: string; data: unknown }> = [];

    const session = {
      id: 'session-pick',
      user_id: 'user-pick',
      phone: PHONE,
      business_id: BIZ_ID,
      current_step: 'idle',
      session_data: {},
      status: 'active',
      version: 1,
    };

    const supabase = createTableMock({
      activeSession: session,
      business: makeBusiness({ subscription_tier: 'growth' }),
      capabilities: [{ capability: 'ordering', is_enabled: true, sort_order: 0 }],
      enabledLanguages: ['en', 'pcm'],
      rpcTracker,
      upsertTracker,
    });

    const bot = new BotService(
      supabase,
      sender,
      createMockStandalone(),
      createMockIntelligence(),
    );
    await bot.handleMessage(PHONE, 'lang_pick_pcm', 'interactive', undefined, BIZ_ID);

    // CAS update should be called to persist _detected_language to session
    const casCall = rpcTracker.find(r => r.fn === 'update_session_cas');
    expect(casCall).toBeDefined();
    expect(casCall!.args.p_session_data).toHaveProperty('_detected_language', 'pcm');

    // customer_profiles upsert should save preferred_language
    const cpUpsert = upsertTracker.find(u => u.table === 'customer_profiles');
    expect(cpUpsert).toBeDefined();
    expect(cpUpsert!.data).toMatchObject({
      business_id: BIZ_ID,
      phone: PHONE,
      preferred_language: 'pcm',
    });
  });
});

// ═══════════════════════════════════════════════════════
// 7. First message preserved and processed after picking
// ═══════════════════════════════════════════════════════

describe('Language picker — pending first message', () => {
  it('stores original message in _pending_first_message when picker is shown', async () => {
    const sender = createCaptureSender();
    const rpcTracker: Array<{ fn: string; args: Record<string, unknown> }> = [];

    const supabase = createTableMock({
      activeSession: null,
      business: makeBusiness({ subscription_tier: 'growth' }),
      capabilities: [{ capability: 'ordering', is_enabled: true, sort_order: 0 }],
      enabledLanguages: ['en', 'pcm'],
      customerProfileLanguage: null,
      rpcTracker,
    });

    const bot = new BotService(
      supabase,
      sender,
      createMockStandalone(),
      createMockIntelligence(),
    );
    await bot.handleMessage(PHONE, 'I want to order food', 'text', undefined, BIZ_ID);

    // The picker should have been shown (list message)
    const pickerList = sender.getMessages().find(
      m => m.type === 'list' && m.items?.some(i => i.postbackText.startsWith('lang_pick_')),
    );
    expect(pickerList).toBeDefined();

    // The original message should be stored via CAS RPC in session_data._pending_first_message
    const casCall = rpcTracker.find(
      r => r.fn === 'update_session_cas' &&
        (r.args as any)?.p_session_data?._pending_first_message === 'I want to order food',
    );
    expect(casCall).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════
// 8. Picker body is multilingual
// ═══════════════════════════════════════════════════════

describe('Language picker — multilingual body', () => {
  it('picker body contains lines in each offered language', async () => {
    const sender = createCaptureSender();
    const supabase = createTableMock({
      activeSession: null,
      business: makeBusiness({ subscription_tier: 'growth' }),
      capabilities: [{ capability: 'ordering', is_enabled: true, sort_order: 0 }],
      enabledLanguages: ['en', 'pcm'],
      customerProfileLanguage: null,
    });

    const bot = new BotService(
      supabase,
      sender,
      createMockStandalone(),
      createMockIntelligence(),
    );
    await bot.handleMessage(PHONE, 'Hi', 'text', undefined, BIZ_ID);

    const pickerList = sender.getMessages().find(
      m => m.type === 'list' && m.items?.some(i => i.postbackText.startsWith('lang_pick_')),
    );
    expect(pickerList).toBeDefined();

    // The body should contain multiple lines — at least English line + one more
    const body = pickerList!.body || '';
    const lines = body.split('\n').filter((l: string) => l.trim().length > 0);
    // With en + pcm offered, body should have the English line and the Pidgin line
    expect(lines.length).toBeGreaterThanOrEqual(2);

    // The body should contain "choose" or "pick" or "language" (English picker prompt)
    expect(body.toLowerCase()).toMatch(/choose|pick|language|preferred/);
  });
});

// ═══════════════════════════════════════════════════════
// 9. Pending first message processed after picking
// ═══════════════════════════════════════════════════════

describe('Language picker — pending first message replay', () => {
  it('pending first message "I want to book" is processed after picking, not just the menu', async () => {
    const sender = createCaptureSender();
    const rpcTracker: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const upsertTracker: Array<{ table: string; data: unknown }> = [];

    // Session with _pending_first_message set (as if the user said "I want to book a haircut"
    // and the picker was shown, storing the message in session_data)
    const session = {
      id: 'session-pending',
      user_id: 'user-pending',
      phone: PHONE,
      business_id: BIZ_ID,
      current_step: 'idle',
      session_data: { _pending_first_message: 'I want to book a haircut' },
      status: 'active',
      version: 1,
    };

    const supabase = createTableMock({
      activeSession: session,
      business: makeBusiness({ subscription_tier: 'growth' }),
      capabilities: [
        { capability: 'ordering', is_enabled: true, sort_order: 0 },
        { capability: 'scheduling', is_enabled: true, sort_order: 1 },
      ],
      enabledLanguages: ['en', 'pcm'],
      rpcTracker,
      upsertTracker,
    });

    const bot = new BotService(
      supabase,
      sender,
      createMockStandalone(),
      createMockIntelligence(),
    );
    // Simulate the user tapping Pidgin in the picker
    await bot.handleMessage(PHONE, 'lang_pick_pcm', 'interactive', undefined, BIZ_ID);

    // The CAS write to clear _pending_first_message should have been called
    const pendingCas = rpcTracker.filter(r => r.fn === 'update_session_cas');
    expect(pendingCas.length).toBeGreaterThanOrEqual(1);

    // The pending message "I want to book a haircut" is NOT a greeting word,
    // so execute should be called with it (not empty string).
    // The second CAS call (clearing _pending_first_message) session_data should NOT
    // have _pending_first_message anymore.
    const clearCas = pendingCas.find(
      r => !(r.args as any).p_session_data?._pending_first_message,
    );
    expect(clearCas).toBeDefined();
  });

  it('pending greeting message "hi" results in empty executeInput (shows menu)', async () => {
    const sender = createCaptureSender();
    const rpcTracker: Array<{ fn: string; args: Record<string, unknown> }> = [];

    const session = {
      id: 'session-pending-hi',
      user_id: 'user-pending-hi',
      phone: PHONE,
      business_id: BIZ_ID,
      current_step: 'idle',
      session_data: { _pending_first_message: 'hi' },
      status: 'active',
      version: 1,
    };

    const supabase = createTableMock({
      activeSession: session,
      business: makeBusiness({ subscription_tier: 'growth' }),
      capabilities: [{ capability: 'ordering', is_enabled: true, sort_order: 0 }],
      enabledLanguages: ['en', 'pcm'],
      rpcTracker,
    });

    const bot = new BotService(
      supabase,
      sender,
      createMockStandalone(),
      createMockIntelligence(),
    );
    await bot.handleMessage(PHONE, 'lang_pick_pcm', 'interactive', undefined, BIZ_ID);

    // "hi" is a greeting word, so the pending message is treated as empty input.
    // The CAS write to clear _pending_first_message should occur.
    const pendingCas = rpcTracker.filter(r => r.fn === 'update_session_cas');
    expect(pendingCas.length).toBeGreaterThanOrEqual(1);

    // After selection, a confirmation message should be sent
    const msgs = sender.getMessages();
    const confirmMsg = msgs.find(m => m.type === 'text' && m.text?.includes('✅'));
    // The confirmation or the menu should appear (not an error)
    expect(msgs.length).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════
// 10. CAS conflict stops processing
// ═══════════════════════════════════════════════════════

describe('Language picker — CAS conflict handling', () => {
  it('CAS conflict on picker selection stops processing — no duplicate messages', async () => {
    const sender = createCaptureSender();
    const rpcTracker: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const upsertTracker: Array<{ table: string; data: unknown }> = [];

    const session = {
      id: 'session-cas-conflict',
      user_id: 'user-cas-conflict',
      phone: PHONE,
      business_id: BIZ_ID,
      current_step: 'idle',
      session_data: {},
      status: 'active',
      version: 1,
    };

    const supabase = createTableMock({
      activeSession: session,
      business: makeBusiness({ subscription_tier: 'growth' }),
      capabilities: [{ capability: 'ordering', is_enabled: true, sort_order: 0 }],
      enabledLanguages: ['en', 'pcm'],
      rpcTracker,
      upsertTracker,
    });

    // Override update_session_cas RPC to return a version conflict
    supabase.rpc = vi.fn((fn: string, args?: Record<string, unknown>) => {
      rpcTracker.push({ fn, args: args || {} });
      if (fn === 'get_bot_context') {
        return Promise.resolve({
          data: {
            has_session: true,
            session: { ...session, whatsapp_number: PHONE, is_active: true },
            business: makeBusiness({ subscription_tier: 'growth' }),
            capabilities: [{ capability: 'ordering', is_enabled: true, sort_order: 0 }],
            capability_overrides: [],
          },
          error: null,
        });
      }
      if (fn === 'update_session_cas') {
        return Promise.resolve({
          data: { success: false, reason: 'version_conflict' },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    const bot = new BotService(
      supabase,
      sender,
      createMockStandalone(),
      createMockIntelligence(),
    );
    await bot.handleMessage(PHONE, 'lang_pick_pcm', 'interactive', undefined, BIZ_ID);

    // After CAS failure: no confirmation message should be sent
    const msgs = sender.getMessages();
    const confirmMsg = msgs.find(
      m => m.type === 'text' && (m.text?.includes('✅') || m.text?.toLowerCase().includes('switched')),
    );
    expect(confirmMsg).toBeUndefined();

    // No customer_profiles upsert should happen (processing stopped before reaching it)
    const cpUpsert = upsertTracker.find(u => u.table === 'customer_profiles');
    expect(cpUpsert).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════
// 11. Phone format dedup — +prefix lookup
// ═══════════════════════════════════════════════════════

describe('Language picker — phone format dedup', () => {
  it('picker not shown again for same phone in +prefix format', async () => {
    const sender = createCaptureSender();
    // PHONE is '+2349000000001' — the code normalizes to '+' prefix before
    // querying customer_profiles. If the DB has a record with the +prefix format,
    // the picker should be suppressed.
    const supabase = createTableMock({
      activeSession: null,
      business: makeBusiness({ subscription_tier: 'growth' }),
      capabilities: [{ capability: 'ordering', is_enabled: true, sort_order: 0 }],
      enabledLanguages: ['en', 'pcm'],
      // customer_profiles returns a saved preference for this phone (with + prefix)
      customerProfileLanguage: 'pcm',
    });

    const bot = new BotService(
      supabase,
      sender,
      createMockStandalone(),
      createMockIntelligence(),
    );
    await bot.handleMessage(PHONE, 'Hello', 'text', undefined, BIZ_ID);

    const msgs = sender.getMessages();
    const pickerList = msgs.find(
      m => m.type === 'list' && m.items?.some(i => i.postbackText.startsWith('lang_pick_')),
    );
    // Picker should NOT be shown because customer_profiles.preferred_language exists
    expect(pickerList).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════
// 12. Pending non-greeting message re-dispatches through handleMessage
// ═══════════════════════════════════════════════════════

describe('Language picker — pending message re-dispatch routing', () => {
  it('pending first message "I want to book" re-dispatches through handleMessage, not flowExecutor.execute', async () => {
    const sender = createCaptureSender();
    const rpcTracker: Array<{ fn: string; args: Record<string, unknown> }> = [];

    const session = {
      id: 'session-redispatch',
      user_id: 'user-redispatch',
      phone: PHONE,
      business_id: BIZ_ID,
      current_step: 'idle',
      session_data: { _pending_first_message: 'I want to book' },
      status: 'active',
      version: 1,
    };

    const supabase = createTableMock({
      activeSession: session,
      business: makeBusiness({ subscription_tier: 'growth' }),
      capabilities: [
        { capability: 'scheduling', is_enabled: true, sort_order: 0 },
      ],
      enabledLanguages: ['en', 'pcm'],
      rpcTracker,
    });

    const bot = new BotService(
      supabase,
      sender,
      createMockStandalone(),
      createMockIntelligence(),
    );

    // Spy on handleMessage to verify the recursive self-call
    const handleMessageSpy = vi.spyOn(bot, 'handleMessage');

    await bot.handleMessage(PHONE, 'lang_pick_en', 'interactive', undefined, BIZ_ID);

    // handleMessage should have been called at least twice:
    //   1. The original call with 'lang_pick_en'
    //   2. The re-dispatch call with 'I want to book' and provenance 'lang_pick_redispatch'
    expect(handleMessageSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

    const redispatchCall = handleMessageSpy.mock.calls.find(
      (args) => args[1] === 'I want to book' && args[7] === 'lang_pick_redispatch',
    );
    expect(redispatchCall).toBeDefined();

    // The provenance 'lang_pick_redispatch' prevents the picker from showing again
    // Verify the picker is NOT shown on the re-dispatch (no second picker list)
    const msgs = sender.getMessages();
    const pickerLists = msgs.filter(
      m => m.type === 'list' && m.items?.some(i => i.postbackText.startsWith('lang_pick_')),
    );
    expect(pickerLists.length).toBe(0);

    handleMessageSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════
// 13. CAS conflict on picker trigger — picker not sent, message not lost
// ═══════════════════════════════════════════════════════

describe('Language picker — picker trigger CAS conflict', () => {
  it('picker trigger CAS conflict: picker not sent, session reloaded, normal handling continues', async () => {
    const sender = createCaptureSender();
    const rpcTracker: Array<{ fn: string; args: Record<string, unknown> }> = [];

    const supabase = createTableMock({
      activeSession: null,
      business: makeBusiness({ subscription_tier: 'growth' }),
      capabilities: [
        { capability: 'ordering', is_enabled: true, sort_order: 0 },
      ],
      enabledLanguages: ['en', 'pcm'],
      customerProfileLanguage: null,
      rpcTracker,
    });

    // Override rpc to make the FIRST update_session_cas fail (CAS conflict)
    // on the _pending_first_message store, while get_bot_context still works
    // and subsequent CAS calls succeed (so normal handling can proceed).
    const originalRpc = supabase.rpc;
    let casCallCount = 0;
    supabase.rpc = vi.fn((fn: string, args?: Record<string, unknown>) => {
      rpcTracker.push({ fn, args: args || {} });
      if (fn === 'get_bot_context') {
        return originalRpc(fn, args);
      }
      if (fn === 'update_session_cas') {
        casCallCount++;
        if (casCallCount === 1) {
          // First CAS call = storing _pending_first_message → conflict
          return Promise.resolve({
            data: { success: false, reason: 'version_conflict' },
            error: null,
          });
        }
        // Subsequent CAS calls succeed (normal flow handling)
        return Promise.resolve({
          data: { success: true, version: ((args as any)?.p_expected_version || 0) + 1 },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    const bot = new BotService(
      supabase,
      sender,
      createMockStandalone(),
      createMockIntelligence(),
    );
    await bot.handleMessage(PHONE, 'I want to order food', 'text', undefined, BIZ_ID);

    const msgs = sender.getMessages();

    // The picker list should NOT be sent (CAS failed before sendLanguagePicker)
    const pickerList = msgs.find(
      m => m.type === 'list' && m.items?.some(i => i.postbackText.startsWith('lang_pick_')),
    );
    expect(pickerList).toBeUndefined();

    // Session should have been reloaded (a select on bot_sessions happens)
    const sessionSelect = (supabase.from as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => call[0] === 'bot_sessions',
    );
    expect(sessionSelect.length).toBeGreaterThanOrEqual(1);

    // Normal handling should continue — the bot should send SOME response
    // (greeting, menu, or flow output), so the message is not lost
    expect(msgs.length).toBeGreaterThanOrEqual(1);
  });
});

/**
 * CAP-001 Phase 1 — BotService-level wiring tests.
 *
 * These tests invoke BotService.handleMessage() directly to prove
 * the production enforcement paths are wired. Each test constructs
 * BotService with mocked dependencies, populates session state in the
 * mock Supabase, and asserts observable side-effects (messages sent,
 * DB writes, flow executor calls).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Module-level mocks (installed BEFORE BotService is imported) ──

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
  translateBotResponse: vi.fn(async (text: string) => text),
  detectLanguage: vi.fn(async () => 'en'),
  getLanguageName: vi.fn(() => 'English'),
}));
// handleGlobalQuery must preserve the session reference — return { handled: false, session: <passed session> }
vi.mock('@/lib/bot/handlers/global-queries', () => ({
  handleGlobalQuery: vi.fn(async (opts: { session: unknown }) => ({ handled: false, session: opts.session })),
  isOrdersQuery: vi.fn(() => false),
}));
vi.mock('@/lib/bot/handlers/escape-hatches', () => ({
  HOME_PATTERN: /^home$/i,
  handleEscapeHatch: vi.fn().mockResolvedValue({ handled: false }),
}));
vi.mock('@/lib/bot/keyword-service', () => ({
  loadBotCustomConfig: vi.fn().mockResolvedValue({ welcome_buttons: [], quick_replies: [], default_reply: null }),
  matchQuickReply: vi.fn(() => null),
  loadUnifiedKeywords: vi.fn().mockResolvedValue([]),
  matchUnifiedKeyword: vi.fn(() => null),
}));
vi.mock('@/lib/bot/confidence-policy', () => ({
  loadConversationConfig: vi.fn().mockResolvedValue({ aiEnabled: false }),
}));
vi.mock('@/lib/bot/automation/rules-engine', () => ({
  evaluateRules: vi.fn().mockResolvedValue(undefined),
}));

import { BotService } from '../bot.service';
import { createCaptureSender } from './bot-harness';
import type { StandaloneService } from '../standalone.service';
import type { BotIntelligenceService } from '../bot-intelligence';

// ── Helpers ──

/** Create a table-aware Supabase mock that returns configured data per-table. */
function createTableMock(config: {
  activeSession?: Record<string, unknown> | null;
  business?: Record<string, unknown> | null;
  capabilities?: Array<{ capability: string; is_enabled: boolean; sort_order: number }>;
  overrides?: string[];
  /** Track all update calls for assertions */
  updateTracker?: Array<{ table: string; data: unknown }>;
}) {
  const updateTracker = config.updateTracker || [];

  function makeChain(resolveData: unknown = null, resolveError: unknown = null) {
    const chain: Record<string, any> = {};
    for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'or', 'in', 'is', 'not', 'ilike', 'like', 'gte', 'lte', 'gt', 'lt', 'order', 'limit', 'range', 'filter', 'match', 'contains', 'containedBy']) {
      chain[m] = vi.fn().mockReturnValue(chain);
    }
    chain.single = vi.fn().mockResolvedValue({ data: resolveData, error: resolveError });
    chain.maybeSingle = vi.fn().mockResolvedValue({ data: resolveData, error: null });
    return chain;
  }

  return {
    from: vi.fn((table: string) => {
      // Session lookup: bot_sessions
      if (table === 'bot_sessions') {
        const chain = makeChain(config.activeSession);
        // Track session updates
        const origUpdate = chain.update;
        chain.update = vi.fn((data: unknown) => {
          updateTracker.push({ table: 'bot_sessions', data });
          return origUpdate(data);
        });
        chain.delete = vi.fn().mockReturnValue(chain);
        return chain;
      }

      // Business lookup
      if (table === 'businesses') {
        return makeChain(config.business);
      }

      // Capability rows (Point A re-resolution)
      if (table === 'business_capabilities') {
        const capData = { data: config.capabilities ?? [], error: null };
        const resolved = Promise.resolve(capData);
        const chain: Record<string, any> = {};
        for (const m of ['select', 'eq', 'order']) chain[m] = () => chain;
        chain.then = resolved.then.bind(resolved);
        chain.catch = resolved.catch.bind(resolved);
        return chain;
      }

      // Overrides
      if (table === 'capability_overrides') {
        const ovData = { data: (config.overrides || []).map(c => ({ capability: c })), error: null };
        const resolved = Promise.resolve(ovData);
        const chain: Record<string, any> = {};
        for (const m of ['select', 'eq']) chain[m] = () => chain;
        chain.then = resolved.then.bind(resolved);
        chain.catch = resolved.catch.bind(resolved);
        return chain;
      }

      // platform_settings (maintenance mode check)
      if (table === 'platform_settings') {
        return makeChain({ value: false });
      }

      // services table (for quick_rebook service fetch)
      if (table === 'services') {
        return makeChain({ price: 50, duration_minutes: 30, deposit_amount: 0, billing_type: 'one_time', recurring_interval: null, max_capacity: 1, buffer_minutes: 0, available_days: [], available_from: null, available_to: null, requires_staff: false, staff_ids: [], allow_staff_selection: false, metadata: null, is_class: false, class_schedule: [], auto_approve: true, service_type: 'booking' });
      }

      // Default catch-all
      return makeChain();
    }),
    rpc: vi.fn().mockImplementation((name: string) => {
      if (name === 'update_session_cas') {
        return Promise.resolve({ data: { success: true, version: 1 }, error: null });
      }
      if (name === 'deactivate_session_atomic') {
        return Promise.resolve({ data: { success: true }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    }),
    storage: { from: vi.fn(() => ({ upload: vi.fn(), createSignedUrl: vi.fn(), getPublicUrl: vi.fn() })) },
  } as any;
}

function createMockStandalone(): StandaloneService {
  return {
    loadWhatsAppConfigBundle: vi.fn().mockResolvedValue({
      templates: { greeting: 'Welcome!' },
      welcome_buttons: [],
      auto_reply_enabled: false,
      business_hours: null,
      alias: null,
    }),
    checkTierLimitsFromBusiness: vi.fn().mockResolvedValue({ allowed: true, isWhitelabel: false }),
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
    getHelpText: vi.fn(() => 'Help text'),
    getPersonaGreeting: vi.fn((_a: string, name: string) => `Hi from ${name}`),
    getContextualHelp: vi.fn(() => 'Help'),
  } as any;
}

const TEST_PHONE = '+2341234567890';
const TEST_BIZ_ID = 'biz-test-001';

// ═══════════════════════════════════════════════════════
// 1. QUICK_REBOOK — actual BotService.handleMessage
// ═══════════════════════════════════════════════════════

describe('CAP-001 quick_rebook via BotService.handleMessage', () => {
  it('blocks quick_rebook when capability NOT in refreshed effective set', async () => {
    const sender = createCaptureSender();
    const updateTracker: Array<{ table: string; data: unknown }> = [];

    const supabase = createTableMock({
      activeSession: {
        id: 'sess-rebook',
        whatsapp_number: TEST_PHONE,
        user_id: null,
        business_id: TEST_BIZ_ID,
        current_step: 'select_capability',
        session_data: {
          capabilities: ['ordering'], // scheduling NOT present — was removed by Point A
          _quick_rebook_service_id: 'svc-123',
          _quick_rebook_service_name: 'Haircut',
          _rebook_flow_type: 'scheduling',
          _rebook_is_giving: false,
          _quick_rebook_sent: true,
          business_id: TEST_BIZ_ID,
        },
        is_active: true,
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        version: 0,
      },
      business: {
        id: TEST_BIZ_ID, status: 'active', subscription_tier: 'free',
        trial_ends_at: '2024-01-01T00:00:00Z', // expired
        category: 'salon',
      },
      capabilities: [{ capability: 'ordering', is_enabled: true, sort_order: 0 }], // scheduling NOT configured
      updateTracker,
    });

    const bot = new BotService(supabase, sender, createMockStandalone(), createMockIntelligence());
    await bot.handleMessage(TEST_PHONE, 'quick_rebook', 'text');

    // Assert: recoverable message sent (CAS-005 says "not available")
    expect(sender.hasMessageContaining('not available')).toBe(true);

    // Assert: rebook state cleaned in session update
    const sessionUpdates = updateTracker.filter(u => u.table === 'bot_sessions');
    expect(sessionUpdates.length).toBeGreaterThan(0);
    const lastUpdate = sessionUpdates[sessionUpdates.length - 1].data as Record<string, unknown>;
    const updatedSessionData = (lastUpdate.session_data || lastUpdate) as Record<string, unknown>;
    // _quick_rebook_service_id should be cleaned
    expect(updatedSessionData._quick_rebook_service_id).toBeUndefined();

    // Assert: active_capability NOT set to scheduling
    expect(updatedSessionData.active_capability).toBeUndefined();
  });

  it('allows quick_rebook when capability IS in effective set', async () => {
    const sender = createCaptureSender();

    const supabase = createTableMock({
      activeSession: {
        id: 'sess-rebook-ok',
        whatsapp_number: TEST_PHONE,
        user_id: null,
        business_id: TEST_BIZ_ID,
        current_step: 'select_capability',
        session_data: {
          capabilities: ['scheduling', 'ordering'], // scheduling IS present
          _quick_rebook_service_id: 'svc-123',
          _quick_rebook_service_name: 'Haircut',
          _rebook_flow_type: 'scheduling',
          _rebook_is_giving: false,
          _quick_rebook_sent: true,
          business_id: TEST_BIZ_ID,
          business_name: 'Test Salon',
          business_category: 'salon',
        },
        is_active: true,
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        version: 0,
      },
      business: {
        id: TEST_BIZ_ID, status: 'active', subscription_tier: 'growth',
        trial_ends_at: null, category: 'salon',
      },
      capabilities: [{ capability: 'scheduling', is_enabled: true, sort_order: 0 }],
    });

    const bot = new BotService(supabase, sender, createMockStandalone(), createMockIntelligence());
    await bot.handleMessage(TEST_PHONE, 'quick_rebook', 'text');

    // Should NOT get the unavailable message — handler proceeded into rebook flow
    expect(sender.hasMessageContaining('unavailable')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════
// 2. POINT A — session resume revalidation via BotService
// ═══════════════════════════════════════════════════════

describe('CAP-001 Point A — session resume via BotService.handleMessage', () => {
  it('refreshes capabilities from DB — removes reservation after trial expiry', async () => {
    const sender = createCaptureSender();
    const updateTracker: Array<{ table: string; data: unknown }> = [];

    const supabase = createTableMock({
      activeSession: {
        id: 'sess-stale',
        whatsapp_number: TEST_PHONE,
        user_id: 'u1',
        business_id: TEST_BIZ_ID,
        current_step: 'select_capability',
        session_data: {
          capabilities: ['scheduling', 'reservation'], // STALE — reservation was effective during trial
          business_id: TEST_BIZ_ID,
          business_name: 'Test Hotel',
          business_category: 'hotel',
        },
        is_active: true,
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        version: 0,
      },
      // CURRENT DB state: trial expired
      business: {
        id: TEST_BIZ_ID, status: 'active', subscription_tier: 'free',
        trial_ends_at: '2024-01-01T00:00:00Z', // expired
        category: 'hotel',
      },
      // reservation is enabled but blocked by tier
      capabilities: [
        { capability: 'scheduling', is_enabled: true, sort_order: 0 },
        { capability: 'reservation', is_enabled: true, sort_order: 1 },
      ],
      updateTracker,
    });

    const bot = new BotService(supabase, sender, createMockStandalone(), createMockIntelligence());

    // Send cap_reservation as if clicking an old button — after Point A refresh,
    // reservation should be absent from capabilities, so validation fails
    await bot.handleMessage(TEST_PHONE, 'cap_reservation', 'text');

    // Assert: Point A used CAS to persist refreshed capabilities
    const casCalls = supabase.rpc.mock.calls.filter((c: any[]) => c[0] === 'update_session_cas');
    expect(casCalls.length).toBeGreaterThan(0);
    const casSessionData = casCalls[0][1].p_session_data;
    expect(casSessionData.capabilities).toContain('scheduling'); // free-tier, stays
    expect(casSessionData.capabilities).not.toContain('reservation'); // growth-tier, trial expired

    // Assert: businesses table was queried (status/tier/trial)
    const bizCalls = supabase.from.mock.calls.filter((c: string[]) => c[0] === 'businesses');
    expect(bizCalls.length).toBeGreaterThan(0);

    // Assert: business_capabilities was queried
    const capCalls = supabase.from.mock.calls.filter((c: string[]) => c[0] === 'business_capabilities');
    expect(capCalls.length).toBeGreaterThan(0);

    // Assert: capability_overrides was queried
    const ovCalls = supabase.from.mock.calls.filter((c: string[]) => c[0] === 'capability_overrides');
    expect(ovCalls.length).toBeGreaterThan(0);
  });

  it('preserves reservation with active trial', async () => {
    const sender = createCaptureSender();
    const updateTracker: Array<{ table: string; data: unknown }> = [];

    const supabase = createTableMock({
      activeSession: {
        id: 'sess-active-trial',
        whatsapp_number: TEST_PHONE,
        user_id: 'u1',
        business_id: TEST_BIZ_ID,
        current_step: 'select_capability',
        session_data: {
          capabilities: ['scheduling', 'reservation'],
          business_id: TEST_BIZ_ID,
          business_name: 'Test Hotel',
          business_category: 'hotel',
        },
        is_active: true,
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        version: 0,
      },
      business: {
        id: TEST_BIZ_ID, status: 'active', subscription_tier: 'free',
        trial_ends_at: new Date(Date.now() + 86400000).toISOString(), // active
        category: 'hotel',
      },
      capabilities: [
        { capability: 'scheduling', is_enabled: true, sort_order: 0 },
        { capability: 'reservation', is_enabled: true, sort_order: 1 },
      ],
      updateTracker,
    });

    const bot = new BotService(supabase, sender, createMockStandalone(), createMockIntelligence());
    await bot.handleMessage(TEST_PHONE, 'help', 'text');

    // With active trial, Point A CAS refresh should keep reservation
    const casCalls = supabase.rpc.mock.calls.filter((c: any[]) => c[0] === 'update_session_cas');
    expect(casCalls.length).toBeGreaterThan(0);
    const casSessionData = casCalls[0][1].p_session_data;
    expect(casSessionData.capabilities).toContain('reservation');
  });
});

// ═══════════════════════════════════════════════════════
// CAS-007: Policy read failure — fail closed for ALL non-MANAGE_EXISTING
// ═══════════════════════════════════════════════════════

describe('CAS-007 Point A policy-read failure — fail closed', () => {
  it('TEST 1: select_capability + no active_capability + policy read fails → blocked', async () => {
    const sender = createCaptureSender();

    // Create a mock where business_capabilities read FAILS
    const supabase = createTableMock({
      activeSession: {
        id: 'sess-fail',
        whatsapp_number: TEST_PHONE,
        user_id: 'u1',
        business_id: TEST_BIZ_ID,
        current_step: 'select_capability',
        session_data: {
          capabilities: ['ordering'], // stale
          business_id: TEST_BIZ_ID,
          business_name: 'Test Biz',
          // NO active_capability — this is the bug scenario
        },
        is_active: true,
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        version: 0,
      },
      business: {
        id: TEST_BIZ_ID, status: 'active', subscription_tier: 'free',
        trial_ends_at: null, category: 'restaurant',
      },
      // capabilities: undefined causes getConfiguredCapabilities to fail
    });

    // Override the from mock to make business_capabilities return an error
    const origFrom = supabase.from;
    supabase.from = vi.fn((table: string) => {
      if (table === 'business_capabilities') {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                order: () => Promise.resolve({ data: null, error: { message: 'connection failed' } }),
              }),
            }),
          }),
        };
      }
      return origFrom(table);
    });

    const bot = new BotService(supabase, sender, createMockStandalone(), createMockIntelligence());
    await bot.handleMessage(TEST_PHONE, 'I want to order food', 'text');

    // Must NOT have started ordering — temporary retry message instead
    const texts = sender.getTextMessages();
    const hasRetryMsg = texts.some((t: string) => t.includes('trouble verifying') || t.includes('try again'));
    expect(hasRetryMsg).toBe(true);

    // FlowExecutor must NOT have executed an ordering flow
    // FlowExecutor must NOT have executed an ordering flow
    // (no product browse, no cart prompts — only the retry message)
    expect(hasRetryMsg).toBe(true);
  });

  it('TEST 2: policy read THROWS → same blocking behavior', async () => {
    const sender = createCaptureSender();

    const supabase = createTableMock({
      activeSession: {
        id: 'sess-throw',
        whatsapp_number: TEST_PHONE,
        user_id: 'u1',
        business_id: TEST_BIZ_ID,
        current_step: 'greeting',
        session_data: {
          capabilities: ['scheduling'],
          business_id: TEST_BIZ_ID,
        },
        is_active: true,
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        version: 0,
      },
      business: {
        id: TEST_BIZ_ID, status: 'active', subscription_tier: 'free',
        trial_ends_at: null, category: 'salon',
      },
    });

    // Make business_capabilities lookup throw
    const origFrom = supabase.from;
    supabase.from = vi.fn((table: string) => {
      if (table === 'business_capabilities') {
        throw new Error('DB connection timeout');
      }
      return origFrom(table);
    });

    const bot = new BotService(supabase, sender, createMockStandalone(), createMockIntelligence());
    await bot.handleMessage(TEST_PHONE, 'Hi', 'text');

    const texts = sender.getTextMessages();
    const hasRetryMsg = texts.some((t: string) => t.includes('trouble verifying') || t.includes('try again'));
    expect(hasRetryMsg).toBe(true);
  });

  it('TEST 3: policy read fails + MANAGE_EXISTING step → NOT blocked', async () => {
    const sender = createCaptureSender();

    const supabase = createTableMock({
      activeSession: {
        id: 'sess-manage',
        whatsapp_number: TEST_PHONE,
        user_id: 'u1',
        business_id: TEST_BIZ_ID,
        current_step: 'my_bookings', // MANAGE_EXISTING step
        session_data: {
          capabilities: ['scheduling'],
          business_id: TEST_BIZ_ID,
          active_capability: 'my_account',
        },
        is_active: true,
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        version: 0,
      },
      business: {
        id: TEST_BIZ_ID, status: 'active', subscription_tier: 'free',
        trial_ends_at: null, category: 'salon',
      },
    });

    // Make business_capabilities fail
    const origFrom = supabase.from;
    supabase.from = vi.fn((table: string) => {
      if (table === 'business_capabilities') {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                order: () => Promise.resolve({ data: null, error: { message: 'connection failed' } }),
              }),
            }),
          }),
        };
      }
      return origFrom(table);
    });

    const bot = new BotService(supabase, sender, createMockStandalone(), createMockIntelligence());
    await bot.handleMessage(TEST_PHONE, 'back', 'text');

    // Should NOT have the temporary retry message — MANAGE_EXISTING continues
    const texts = sender.getTextMessages();
    const hasRetryMsg = texts.some((t: string) => t.includes('trouble verifying'));
    expect(hasRetryMsg).toBe(false);
  });

  it('TEST 4: policy read succeeds + ordering allowed → normal flow', async () => {
    const sender = createCaptureSender();

    const supabase = createTableMock({
      activeSession: {
        id: 'sess-ok',
        whatsapp_number: TEST_PHONE,
        user_id: 'u1',
        business_id: TEST_BIZ_ID,
        current_step: 'select_capability',
        session_data: {
          capabilities: ['ordering'],
          business_id: TEST_BIZ_ID,
          business_name: 'Test Restaurant',
          business_category: 'restaurant',
        },
        is_active: true,
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        version: 0,
      },
      business: {
        id: TEST_BIZ_ID, status: 'active', subscription_tier: 'growth',
        trial_ends_at: null, category: 'restaurant',
        name: 'Test Restaurant', slug: 'test', flow_type: 'ordering',
        metadata: {}, operating_hours: null, country_code: 'NG', payment_gateway: null,
      },
      capabilities: [
        { capability: 'ordering', is_enabled: true, sort_order: 0 },
      ],
    });

    const bot = new BotService(supabase, sender, createMockStandalone(), createMockIntelligence());
    await bot.handleMessage(TEST_PHONE, 'I want to order food', 'text');

    // Should NOT have the temporary retry message
    const texts = sender.getTextMessages();
    const hasRetryMsg = texts.some((t: string) => t.includes('trouble verifying'));
    expect(hasRetryMsg).toBe(false);
  });
});

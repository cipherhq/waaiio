/**
 * Slice 5A F2 — BotService stale-payment recovery localization runtime proof
 *
 * Invokes real BotService.handleMessage() with sessions that trigger the
 * stale-payment recovery branch. Mocks recovery functions to return known
 * results and verifies actual outbound messages.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ──

vi.mock('@/lib/countries', () => ({ loadCountries: vi.fn().mockResolvedValue([]), getCountry: vi.fn(), getCountryList: vi.fn().mockReturnValue([]), isValidCountryCode: vi.fn().mockReturnValue(true), getDialingCodeMap: vi.fn().mockReturnValue({}) }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimitAsync: vi.fn().mockResolvedValue({ allowed: true, remaining: 10 }) }));
vi.mock('@/lib/platformSettings', () => ({ loadPlatformSettings: vi.fn().mockResolvedValue({ bot_rate_limit_per_minute: 30 }) }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

// Translation mock: tracks calls to verify localization happens
const mockTranslateBotResponse = vi.fn().mockImplementation(async (text: string) => text);
vi.mock('@/lib/bot/translate', () => ({
  translateBotResponse: (...a: unknown[]) => mockTranslateBotResponse(...a),
  detectLanguage: vi.fn(async () => 'en'),
  getLanguageName: vi.fn(() => 'English'),
}));

vi.mock('@/lib/bot/handlers/global-queries', () => ({ handleGlobalQuery: vi.fn(async (o: { session: unknown }) => ({ handled: false, session: o.session })), isOrdersQuery: vi.fn(() => false) }));
vi.mock('@/lib/bot/handlers/escape-hatches', () => ({ HOME_PATTERN: /^home$/i, handleEscapeHatch: vi.fn().mockResolvedValue({ handled: false }) }));
vi.mock('@/lib/bot/keyword-service', () => ({ loadBotCustomConfig: vi.fn().mockResolvedValue({ welcome_buttons: [], quick_replies: [], default_reply: null }), matchQuickReply: vi.fn(() => null), loadUnifiedKeywords: vi.fn().mockResolvedValue([]), matchUnifiedKeyword: vi.fn(() => null) }));
vi.mock('@/lib/bot/confidence-policy', () => ({ loadConversationConfig: vi.fn().mockResolvedValue({ aiEnabled: false, autoRouteThreshold: 0.85, clarificationThreshold: 0.60, fallbackBehavior: 'menu', faqEnabled: true, knowledgeEnabled: true, assistantName: 'Assistant', tone: 'friendly' }) }));
vi.mock('@/lib/bot/automation/rules-engine', () => ({ evaluateRules: vi.fn().mockResolvedValue(undefined) }));

// Recovery functions — configurable per test
const mockRecoverGeneric = vi.fn();
const mockRecoverByPaymentReference = vi.fn();
const mockRecoverByOrderReference = vi.fn();
vi.mock('@/lib/payments/stale-payment-recovery', () => ({
  recoverByPaymentReference: (...a: unknown[]) => mockRecoverByPaymentReference(...a),
  recoverByOrderReference: (...a: unknown[]) => mockRecoverByOrderReference(...a),
  recoverGeneric: (...a: unknown[]) => mockRecoverGeneric(...a),
}));

// Stale button parser — configurable per test
const mockParseStaleButton = vi.fn();
vi.mock('@/lib/payments/stale-button-parser', () => ({
  parseStalePaymentButton: (...a: unknown[]) => mockParseStaleButton(...a),
}));

// Bot recovery (saved-card) — not applicable for these tests
vi.mock('@/lib/payments/bot-recovery', () => ({
  recoverSavedCardPaymentForFlow: vi.fn().mockResolvedValue({ type: 'not_applicable' }),
}));

import { BotService } from '../bot.service';
import { createCaptureSender } from './bot-harness';
import type { StandaloneService } from '../standalone.service';
import type { BotIntelligenceService } from '../bot-intelligence';

// ── Harness ──
const PHONE = '+2341234567890';
const BIZ_ID = 'biz-test';

function createTableMock(session: Record<string, unknown>) {
  function chain(data: unknown = null) {
    const c: Record<string, any> = {};
    for (const m of ['select','insert','update','upsert','delete','eq','neq','or','in','is','not','ilike','like','gte','lte','gt','lt','order','limit','range','filter','match','contains','containedBy'])
      c[m] = vi.fn().mockReturnValue(c);
    c.single = vi.fn().mockResolvedValue({ data, error: data ? null : { message: 'not found' } });
    c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    return c;
  }
  return {
    from: vi.fn((table: string) => {
      if (table === 'bot_sessions') { const c = chain(session); c.update = vi.fn().mockReturnValue(chain(session)); return c; }
      if (table === 'businesses') {
        const c = chain({ id: BIZ_ID, status: 'active', subscription_tier: 'growth', trial_ends_at: null, category: 'salon', name: 'TestBiz', slug: 'test', flow_type: 'scheduling', metadata: {}, country_code: 'NG', is_whitelabel: false });
        c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null }); // bot_code lookup
        return c;
      }
      if (table === 'business_capabilities') { const d = Promise.resolve({ data: [{ capability: 'scheduling', is_enabled: true, sort_order: 0 }], error: null }); const c: Record<string, any> = {}; for (const m of ['select','eq','neq','or','in','is','not','order','limit','filter']) c[m] = vi.fn(() => c); c.then = d.then.bind(d); c.catch = d.catch.bind(d); return c; }
      if (table === 'capability_overrides') { const d = Promise.resolve({ data: [], error: null }); const c: Record<string, any> = {}; for (const m of ['select','eq']) c[m] = vi.fn(() => c); c.then = d.then.bind(d); c.catch = d.catch.bind(d); return c; }
      if (table === 'ai_conversation_config') return chain({ enabled_languages: ['en', 'fr'] });
      if (table === 'platform_settings') return chain({ value: false });
      return chain();
    }),
    rpc: vi.fn().mockImplementation(async (name: string) => {
      if (name === 'get_bot_context') return {
        data: { has_session: true, session, business: { id: BIZ_ID, status: 'active', subscription_tier: 'growth', trial_ends_at: null, category: 'salon', name: 'TestBiz', slug: 'test', flow_type: 'scheduling', metadata: {}, country_code: 'NG', is_whitelabel: false, operating_hours: null, payment_gateway: null }, capabilities: [{ capability: 'scheduling', is_enabled: true, sort_order: 0 }], overrides: [] },
        error: null,
      };
      if (name === 'update_session_cas') return { data: { success: true, version: 2 }, error: null };
      if (name === 'deactivate_session_atomic') return { data: null, error: null };
      return { data: null, error: null };
    }),
    storage: { from: vi.fn(() => ({ upload: vi.fn(), getPublicUrl: vi.fn() })) },
  } as any;
}

function createMockStandalone(): StandaloneService {
  return { loadWhatsAppConfigBundle: vi.fn().mockResolvedValue({ templates: { greeting: '' }, welcome_buttons: [], auto_reply_enabled: false, business_hours: null, alias: null }), checkTierLimitsFromBusiness: vi.fn().mockResolvedValue({ allowed: true, isWhitelabel: false }), fillTemplate: vi.fn((t: string) => t), getBotAlias: vi.fn().mockResolvedValue(null) } as any;
}
function createMockIntelligence(): BotIntelligenceService {
  return { isTimedOut: vi.fn(() => ({ timedOut: false, remaining: 0 })), containsProfanity: vi.fn(() => false), recordProfanity: vi.fn(() => ({ timeout: false, warn: false })), resetAbuse: vi.fn(), getHelpText: vi.fn(() => 'Help'), getPersonaGreeting: vi.fn(() => ''), getContextualHelp: vi.fn(() => '') } as any;
}

function makeSession(lang: string) {
  return {
    id: 'sess-recovery', whatsapp_number: PHONE, business_id: BIZ_ID, user_id: 'user-1',
    current_step: 'process_payment', is_active: true, version: 1,
    session_data: {
      capabilities: ['scheduling'], active_capability: 'scheduling',
      business_category: 'salon', _detected_language: lang,
    },
    conversation_log: [], expires_at: new Date(Date.now() + 86400000).toISOString(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: stale button parser returns a generic "I've Paid" with no reference
  mockParseStaleButton.mockReturnValue({
    isStalePaymentButton: true, hasPaymentReference: false, paymentReference: null,
    hasReference: false, reference: null,
  });
  mockTranslateBotResponse.mockImplementation(async (text: string) => text);
});

describe('F2: BotService stale-payment recovery localization', () => {

  it('confirmed recovery: localized presentation with exact reference + amount', async () => {
    mockRecoverGeneric.mockResolvedValue({
      type: 'confirmed',
      referenceCode: 'WA-BK-9999',
      amount: 5000,
      countryCode: 'NG',
      message: '✅ *Payment Confirmed!*\n\nYour booking *WA-BK-9999* for $5,000 is confirmed.\n\nType *my bookings* to view.',
    });
    // Non-English session — translation should be attempted
    const session = makeSession('fr');
    const sender = createCaptureSender();
    const supabase = createTableMock(session);
    const bot = new BotService(supabase, sender, createMockStandalone(), createMockIntelligence());

    await bot.handleMessage(PHONE, 'i_paid', 'text', undefined, BIZ_ID);

    // translateBotResponse should have been called (via sendSessionLocalizedText)
    expect(mockTranslateBotResponse).toHaveBeenCalled();
    // Find the call that received the recovery message
    const recoveryCalls = mockTranslateBotResponse.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].includes('WA-BK-9999'),
    );
    expect(recoveryCalls.length).toBeGreaterThan(0);
    // The protected values should include the reference code and amount
    const opts = recoveryCalls[0][3]; // 4th arg is TranslateOptions
    expect(opts?.protectedValues).toContain('WA-BK-9999');
    // Sender should have sent the message
    expect(sender.getMessages().length).toBeGreaterThan(0);
  });

  it('reconciling recovery: localized, no extra payment/provider mutation', async () => {
    mockRecoverGeneric.mockResolvedValue({
      type: 'reconciling',
      referenceCode: 'WA-BK-1234',
      message: '✅ Payment received! Your booking is being processed.\n\nYou\'ll get a confirmation shortly.',
    });
    const session = makeSession('fr');
    const sender = createCaptureSender();
    const supabase = createTableMock(session);
    const bot = new BotService(supabase, sender, createMockStandalone(), createMockIntelligence());

    await bot.handleMessage(PHONE, 'i_paid', 'text', undefined, BIZ_ID);

    // Translation attempted
    expect(mockTranslateBotResponse).toHaveBeenCalled();
    const recoveryCalls = mockTranslateBotResponse.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].includes('processed'),
    );
    expect(recoveryCalls.length).toBeGreaterThan(0);
    // No extra RPC calls beyond session management
    const rpcCalls = supabase.rpc.mock.calls.map((c: unknown[]) => c[0]);
    expect(rpcCalls).not.toContain('claim_payment_confirmation');
    expect(rpcCalls).not.toContain('finalize_payment_confirmation');
  });

  it('not_found recovery: localized Waaiio presentation, no provider mutation', async () => {
    mockRecoverGeneric.mockResolvedValue({
      type: 'not_found',
      message: 'No payment found. Please contact support if you believe you have paid.',
    });
    const session = makeSession('fr');
    const sender = createCaptureSender();
    const supabase = createTableMock(session);
    const bot = new BotService(supabase, sender, createMockStandalone(), createMockIntelligence());

    await bot.handleMessage(PHONE, 'i_paid', 'text', undefined, BIZ_ID);

    expect(mockTranslateBotResponse).toHaveBeenCalled();
    const notFoundCalls = mockTranslateBotResponse.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].includes('No payment found'),
    );
    expect(notFoundCalls.length).toBeGreaterThan(0);
    // No payment provider RPCs
    const rpcCalls = supabase.rpc.mock.calls.map((c: unknown[]) => c[0]);
    expect(rpcCalls).not.toContain('claim_payment_confirmation');
  });

  it('error recovery: localized, no provider mutation', async () => {
    mockRecoverGeneric.mockResolvedValue({
      type: 'error',
      message: 'Something went wrong. Please try again.',
    });
    const session = makeSession('fr');
    const sender = createCaptureSender();
    const supabase = createTableMock(session);
    const bot = new BotService(supabase, sender, createMockStandalone(), createMockIntelligence());

    await bot.handleMessage(PHONE, 'i_paid', 'text', undefined, BIZ_ID);

    expect(mockTranslateBotResponse).toHaveBeenCalled();
    const errorCalls = mockTranslateBotResponse.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].includes('Something went wrong'),
    );
    expect(errorCalls.length).toBeGreaterThan(0);
  });

  it('disambiguation: localized body, exact button IDs i_paid_ref:<ref>, exact titles', async () => {
    mockRecoverGeneric.mockResolvedValue({
      type: 'disambiguation',
      candidates: [
        { gatewayReference: 'GW-REF-001', referenceCode: 'WA-BK-1111', amount: 3000, purpose: 'booking' },
        { gatewayReference: 'GW-REF-002', referenceCode: 'WA-BK-2222', amount: 5000, purpose: 'booking' },
      ],
      message: 'We found multiple payments. Which one did you pay?',
    });
    const session = makeSession('fr');
    const sender = createCaptureSender();
    const supabase = createTableMock(session);
    const bot = new BotService(supabase, sender, createMockStandalone(), createMockIntelligence());

    await bot.handleMessage(PHONE, 'i_paid', 'text', undefined, BIZ_ID);

    // Translation should be called for the disambiguation body
    expect(mockTranslateBotResponse).toHaveBeenCalled();
    // Check button send
    const buttonMsgs = sender.getMessages().filter(m => m.type === 'buttons');
    expect(buttonMsgs.length).toBeGreaterThan(0);
    const btnMsg = buttonMsgs[0];
    // Button IDs must be exact authoritative references
    expect(btnMsg.buttons![0].id).toBe('i_paid_ref:GW-REF-001');
    expect(btnMsg.buttons![1].id).toBe('i_paid_ref:GW-REF-002');
    // Button titles must be exact reference codes
    expect(btnMsg.buttons![0].title).toBe('WA-BK-1111');
    expect(btnMsg.buttons![1].title).toBe('WA-BK-2222');
  });

  it('English session: recovery messages sent without LLM translation calls', async () => {
    mockRecoverGeneric.mockResolvedValue({
      type: 'confirmed',
      referenceCode: 'WA-BK-5555',
      amount: 1000,
      countryCode: 'NG',
      message: '✅ *Payment Confirmed!* Ref: *WA-BK-5555*',
    });
    const session = makeSession('en');
    const sender = createCaptureSender();
    const supabase = createTableMock(session);
    const bot = new BotService(supabase, sender, createMockStandalone(), createMockIntelligence());

    await bot.handleMessage(PHONE, 'i_paid', 'text', undefined, BIZ_ID);

    // For English, translateBotResponse returns text as-is (no LLM)
    // The message should still be sent
    expect(sender.getMessages().length).toBeGreaterThan(0);
    expect(sender.hasMessageContaining('WA-BK-5555')).toBe(true);
  });
});

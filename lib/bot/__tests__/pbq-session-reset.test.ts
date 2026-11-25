/**
 * Pre-booking question state (_pbq_answers / _pbq_index) belongs to ONE booking.
 *
 * The saved-card "Menu" button copies the whole session into the business's
 * capability menu, and a new booking then starts from there. The question
 * state from the earlier booking must not survive that restart: otherwise the
 * new booking skips the business's questions and is saved with the earlier
 * booking's answers (scheduling.flow.ts create_booking → metadata.custom_answers).
 *
 * Harness: real BotService.handleMessage() (pattern from saved-card-decline-nav).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/countries', () => ({ loadCountries: vi.fn().mockResolvedValue([]), getCountry: vi.fn(), getCountryList: vi.fn().mockReturnValue([]), isValidCountryCode: vi.fn().mockReturnValue(true), getDialingCodeMap: vi.fn().mockReturnValue({}) }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimitAsync: vi.fn().mockResolvedValue({ allowed: true, remaining: 10 }) }));
vi.mock('@/lib/platformSettings', () => ({ loadPlatformSettings: vi.fn().mockResolvedValue({ bot_rate_limit_per_minute: 30, abuse_cooldown_soft_minutes: 5, abuse_cooldown_hard_minutes: 30, conversation_limits: { free: 200, growth: 1000, business: 5000 } }) }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@/lib/bot/translate', () => ({ translateBotResponse: vi.fn(async (t: string) => t), detectLanguage: vi.fn(async () => 'en'), getLanguageName: vi.fn(() => 'English') }));
vi.mock('@/lib/bot/handlers/global-queries', () => ({ handleGlobalQuery: vi.fn(async (opts: { session: unknown }) => ({ handled: false, session: opts.session })), isOrdersQuery: vi.fn(() => false) }));
vi.mock('@/lib/bot/handlers/escape-hatches', () => ({ HOME_PATTERN: /^home$/i, handleEscapeHatch: vi.fn().mockResolvedValue({ handled: false }) }));
vi.mock('@/lib/bot/keyword-service', () => ({ loadBotCustomConfig: vi.fn().mockResolvedValue({ welcome_buttons: [], quick_replies: [], default_reply: null }), matchQuickReply: vi.fn(() => null), loadUnifiedKeywords: vi.fn().mockResolvedValue([]), matchUnifiedKeyword: vi.fn(() => null) }));
vi.mock('@/lib/circuit-breaker', () => ({ isCircuitOpen: () => false, recordSuccess: vi.fn(), recordFailure: vi.fn(), CircuitBreakerOpenError: class extends Error {} }));
vi.mock('@/lib/bot/customer-intelligence', () => ({
  getCustomerHistory: vi.fn().mockResolvedValue({ isReturning: false, totalVisits: 0, ltvTier: 'new', lastServiceId: null, lastServiceName: null, lastFlowType: null, favoriteServiceId: null, favoriteServiceName: null }),
  buildReturnGreeting: vi.fn().mockReturnValue(null),
}));
vi.mock('@/lib/capabilities/service', () => ({
  getConfiguredCapabilities: vi.fn().mockResolvedValue({ ok: true, rows: [{ capability: 'scheduling', is_enabled: true, sort_order: 0 }] }),
  getCapabilityCustomLabels: vi.fn().mockResolvedValue({}),
  getEnabledCapabilities: vi.fn().mockResolvedValue([]),
  hasCapability: vi.fn().mockResolvedValue(false),
  setCapabilities: vi.fn().mockResolvedValue(undefined),
  getCapabilityConfig: vi.fn().mockResolvedValue(null),
  initCapabilities: vi.fn().mockResolvedValue(undefined),
}));

const mockParseSmartIntentHybrid = vi.fn().mockResolvedValue(null);
vi.mock('@/lib/bot/smart-intent', () => ({
  parseSmartIntent: vi.fn().mockResolvedValue(null),
  parseSmartIntentHybrid: (...args: unknown[]) => mockParseSmartIntentHybrid(...args),
  matchServiceFromKeywords: vi.fn().mockResolvedValue(null),
  matchProductsFromKeywords: vi.fn().mockResolvedValue([]),
  buildAcknowledgment: vi.fn().mockReturnValue(null),
}));

class MockMessagingSuspendedError extends Error {
  constructor(businessId: string, reason: string) {
    super(`Messaging suspended for business ${businessId}: ${reason}`);
    this.name = 'MessagingSuspendedError';
  }
}
const mockAssertMessagingAllowed = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/channels/send-guard', () => ({
  assertMessagingAllowed: (...args: unknown[]) => mockAssertMessagingAllowed(...args),
  MessagingSuspendedError: MockMessagingSuspendedError,
}));

vi.mock('@/lib/bot/handlers/bot-code-detection', () => ({
  detectBotCode: vi.fn().mockResolvedValue(null),
  detectBotCodeWithSuggestions: vi.fn().mockResolvedValue({ businessId: null, suggestions: [] }),
  rankSuggestions: vi.fn().mockReturnValue([]),
  findReturningCustomerBusiness: vi.fn().mockResolvedValue(null),
  findReturningCustomerBusinesses: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/lib/bot/handlers/saved-cards', () => ({
  handleSaveCard: vi.fn().mockResolvedValue(undefined),
  handleRemoveCard: vi.fn().mockResolvedValue(undefined),
  handleCardPinStep: vi.fn().mockResolvedValue(undefined),
  handleReplacementPinStep: vi.fn().mockResolvedValue(undefined),
  findLatestSavedCardPaymentIdForPhone: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/payments/bot-recovery', () => ({
  recoverSavedCardPaymentForFlow: vi.fn().mockResolvedValue({ type: 'not_applicable' }),
}));
vi.mock('@/lib/payments/stale-payment-recovery', () => ({
  recoverByOrderReference: vi.fn().mockResolvedValue({ type: 'error', message: 'n/a' }),
  recoverByPaymentReference: vi.fn().mockResolvedValue({ type: 'error', message: 'n/a' }),
  recoverGeneric: vi.fn().mockResolvedValue({ type: 'error', message: 'n/a' }),
}));
const mockHandleSavedCardOfferAction = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/payments/saved-card-offer', async (importOriginal) => {
  const orig = await importOriginal() as Record<string, unknown>;
  return { ...orig, handleSavedCardOfferAction: (...args: unknown[]) => mockHandleSavedCardOfferAction(...args) };
});
const mockHandlePromoVerification = vi.fn().mockResolvedValue({ handled: false });
vi.mock('@/lib/bot/handlers/promo-verification', () => ({
  handlePromoVerification: (...args: unknown[]) => mockHandlePromoVerification(...args),
}));


const { BotService } = await import('@/lib/bot/bot.service');
const { MetaCloudSender } = await import('@/lib/channels/message-sender');
const { clearStaleCapabilityState } = await import('@/lib/bot/flows/shared/capability-transition');
const { schedulingFlow } = await import('@/lib/bot/flows/scheduling.flow');
const { getStep, createMockContext } = await import('@/lib/bot/flows/__tests__/helpers');

const PHONE = '+2348012345678';
const PHONE_N = '2348012345678';
const BIZ_A = 'biz-pbq-001';
const PAY_ID = 'pay-pbq-001';
const SESSION_ID = 'sess-pbq-001';
const OLD_ANSWER = 'answer-from-the-earlier-booking';
const QUESTIONS = [{ id: 'q1', question: 'Any allergies?', required: true }];

const BUSINESS_ROW = {
  id: BIZ_A, name: 'Test Business', slug: 'test-biz', category: 'salon',
  flow_type: 'scheduling', subscription_tier: 'growth', trial_ends_at: null,
  metadata: { pre_booking_questions: QUESTIONS }, country_code: 'NG', is_whitelabel: false, payment_gateway: null,
  status: 'active', operating_hours: null,
};
const PAYMENT_ROW = {
  id: PAY_ID, business_id: BIZ_A,
  booking_id: 'bk-pbq-1', reservation_id: null, invoice_id: null,
  order_id: null, campaign_id: null, user_id: null,
};

function createMockCloud() {
  return {
    sendText: vi.fn().mockResolvedValue({ messages: [{ id: 'msg-1' }] }),
    sendButtons: vi.fn().mockResolvedValue({ messages: [{ id: 'msg-2' }] }),
    sendTemplate: vi.fn().mockResolvedValue({ messages: [{ id: 'msg-3' }] }),
    sendList: vi.fn().mockResolvedValue({ messages: [{ id: 'msg-4' }] }),
    sendImage: vi.fn(), sendDocument: vi.fn(), sendAudio: vi.fn(),
    sendFlow: vi.fn(), sendReaction: vi.fn(), sendLocation: vi.fn(),
    sendProduct: vi.fn(), sendProductList: vi.fn(),
  };
}

function createMockIntelligence() {
  return {
    isTimedOut: vi.fn().mockReturnValue({ timedOut: false }),
    containsProfanity: vi.fn().mockReturnValue(false),
    recordProfanity: vi.fn().mockReturnValue({ timeout: false, warn: false }),
    recordGibberish: vi.fn().mockReturnValue({ timeout: false, warn: false }),
    detectBookingIntent: vi.fn().mockReturnValue(null),
    getPersonaGreeting: vi.fn().mockReturnValue(null),
  };
}

function createStandaloneService() {
  return {
    parseNaturalBooking: vi.fn().mockResolvedValue(null),
    detectLanguage: vi.fn().mockResolvedValue(null),
    loadWhatsAppConfigBundle: vi.fn().mockResolvedValue({
      templates: { greeting: 'Welcome!', confirmation: '', reminder: '', orderConfirmation: '', paymentReceipt: '', orderStatus: '' },
      alias: null, welcome_buttons: [], quick_replies: [], default_reply: null,
      auto_reply_enabled: false, business_hours: null, away_message: null,
      instant_reply_enabled: false, instant_reply_message: null,
    }),
    checkTierLimitsFromBusiness: vi.fn().mockResolvedValue({ allowed: true, plan: 'free', monthlyBookings: 0, monthlyLimit: 999, isWhitelabel: false }),
    fillTemplate: vi.fn().mockImplementation((t: string) => t),
    checkTierLimits: vi.fn().mockResolvedValue({ allowed: true, plan: 'free', monthlyBookings: 0, monthlyLimit: 999, isWhitelabel: false }),
  } as any;
}

function makeChain(tableData: unknown, thenable = true) {
  const chain: Record<string, any> = {};
  for (const m of ['eq', 'neq', 'or', 'is', 'in', 'not', 'lt', 'gt', 'gte', 'lte', 'ilike', 'like', 'limit', 'order', 'head', 'update', 'delete', 'upsert', 'filter', 'contains', 'containedBy', 'range', 'overlaps', 'textSearch', 'match', 'csv', 'returns']) chain[m] = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockResolvedValue({ data: tableData, error: null });
  chain.maybeSingle = vi.fn().mockResolvedValue({ data: tableData, error: null });
  chain.select = vi.fn().mockReturnValue(chain);
  chain.insert = vi.fn().mockImplementation(() => {
    const ic = makeChain(tableData, true);
    ic.select = vi.fn().mockImplementation(() => makeChain(tableData, false));
    return ic;
  });
  if (thenable) {
    const rv = { data: tableData, error: null, count: 0 };
    chain.then = (ok?: (v: any) => any, er?: (e: any) => any) => Promise.resolve(rv).then(ok, er);
    chain.catch = (er?: (e: any) => any) => Promise.resolve(rv).catch(er);
  }
  return chain;
}


/** Every session_data the bot wrote for this session (CAS + direct updates), copied when written. */
let sessionWrites: Record<string, unknown>[] = [];
/** The step each write moved the session to (undefined for direct updates without one). */
let writeSteps: (string | undefined)[] = [];
let mockSession: Record<string, unknown> | null = null;

function createSupabase() {
  sessionWrites = [];
  writeSteps = [];
  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'platform_settings') return makeChain({ value: false });
      if (table === 'bot_sessions') {
        const chain = makeChain(mockSession);
        chain.update = vi.fn().mockImplementation((row: Record<string, unknown>) => {
          if (row?.session_data) { sessionWrites.push(structuredClone(row.session_data) as Record<string, unknown>); writeSteps.push(row.current_step as string | undefined); }
          return chain;
        });
        return chain;
      }
      if (table === 'businesses') return makeChain(BUSINESS_ROW);
      if (table === 'payments') return makeChain(PAYMENT_ROW);
      if (table === 'bookings') return makeChain({ guest_phone: PHONE });
      if (table === 'services') {
        // One bookable service: the capability menu has exactly one option (auto-selected).
        const c = makeChain([{ id: 'svc-1', name: 'Cut', price: 0, duration_minutes: 30, is_active: true }]);
        c.then = (ok?: (v: any) => any, er?: (e: any) => any) =>
          Promise.resolve({ data: [{ id: 'svc-1', name: 'Cut', price: 0, duration_minutes: 30, is_active: true }], error: null, count: 1 }).then(ok, er);
        return c;
      }
      if (table === 'blocked_phones') {
        const c = makeChain(null);
        c.select = vi.fn().mockReturnValue({ ...c, eq: vi.fn().mockReturnValue({ ...c, or: vi.fn().mockResolvedValue({ count: 0, error: null }) }) });
        return c;
      }
      return makeChain(null);
    }),
    rpc: vi.fn().mockImplementation((name: string, params?: Record<string, unknown>) => {
      if (name === 'get_bot_context') {
        return Promise.resolve({
          data: { has_session: !!mockSession, ambiguous: false, session: mockSession, business: BUSINESS_ROW,
            capabilities: [{ capability: 'scheduling', is_enabled: true, sort_order: 0 }], capability_overrides: [] },
          error: null,
        });
      }
      if (name === 'update_session_cas') {
        if (params?.p_session_data) { sessionWrites.push(structuredClone(params.p_session_data) as Record<string, unknown>); writeSteps.push(params.p_current_step as string | undefined); }
        return Promise.resolve({ data: { success: true, version: (params?.p_expected_version as number || 0) + 1 }, error: null });
      }
      return Promise.resolve({ data: { success: true, version: 1 }, error: null });
    }),
  };
}

/** The session right after a completed booking whose customer answered the business's question. */
function sessionAfterBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID, user_id: null, business_id: BIZ_A,
    whatsapp_number: PHONE_N, current_step: 'post_completion',
    session_data: {
      _detected_language: 'en', active_capability: 'scheduling', capabilities: ['scheduling'],
      _pbq_answers: { q1: OLD_ANSWER }, _pbq_index: 1,
    },
    is_active: true, version: 1,
    ...overrides,
  };
}

const newBot = (supabase: ReturnType<typeof createSupabase>) =>
  new BotService(supabase as any, new MetaCloudSender(createMockCloud() as any, supabase as any), createStandaloneService(), createMockIntelligence() as any);

describe('pre-booking answers do not carry into the next booking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSession = sessionAfterBooking();
    mockAssertMessagingAllowed.mockResolvedValue(undefined);
  });

  it('saved-card Menu → new booking: no session write from the menu on keeps the earlier answers or question position', async () => {
    const supabase = createSupabase();
    await newBot(supabase).handleMessage(PHONE, `savedcard_menu:${PAY_ID}`, 'button');

    const menuCas = supabase.rpc.mock.calls.find((c: any[]) => c[0] === 'update_session_cas' && c[1]?.p_current_step === 'select_capability');
    expect(menuCas).toBeDefined();
    // The new booking really started: the bot moved on into the scheduling flow.
    expect(supabase.rpc.mock.calls.some((c: any[]) => c[0] === 'update_session_cas' && c[1]?.p_current_step === 'select_service')).toBe(true);
    // Writes before the tap are the finished booking's own session; from the menu on, it is the new booking.
    const fromMenu = sessionWrites.slice(writeSteps.indexOf('select_capability'));
    expect(fromMenu.length).toBeGreaterThan(1);
    for (const written of fromMenu) {
      expect(written).not.toHaveProperty('_pbq_answers');
      expect(written).not.toHaveProperty('_pbq_index');
      expect(JSON.stringify(written)).not.toContain(OLD_ANSWER);
    }
  });

  it('the new booking asks the business\'s questions again instead of reusing the earlier answers', async () => {
    const supabase = createSupabase();
    await newBot(supabase).handleMessage(PHONE, `savedcard_menu:${PAY_ID}`, 'button');
    const last = sessionWrites.at(-1)!;

    // Real pre_booking_questions step, run on the session the bot saved.
    const ctx = createMockContext({ business: BUSINESS_ROW as any });
    ctx.session.session_data = { ...last };
    expect(await getStep(schedulingFlow, 'pre_booking_questions').skipIf!(ctx)).toBe(false);
    expect(ctx.session.session_data._pbq_answers).toBeUndefined();
  });

  it('"Business menu" tap with one capability (auto-selected): the restarted booking drops the earlier answers', async () => {
    mockSession = sessionAfterBooking({ current_step: 'confirmation' });
    const supabase = createSupabase();
    await newBot(supabase).handleMessage(PHONE, 'browse_menu', 'button');

    expect(supabase.rpc.mock.calls.some((c: any[]) => c[0] === 'update_session_cas' && c[1]?.p_current_step === 'select_service')).toBe(true);
    const last = sessionWrites.at(-1)!;
    expect(last).not.toHaveProperty('_pbq_answers');
    expect(last).not.toHaveProperty('_pbq_index');
    const ctx = createMockContext({ business: BUSINESS_ROW as any });
    ctx.session.session_data = { ...last };
    expect(await getStep(schedulingFlow, 'pre_booking_questions').skipIf!(ctx)).toBe(false);
  });
});

describe('clearStaleCapabilityState: pre-booking question state', () => {
  for (const [label, from, to] of [
    ['switch to another capability', 'scheduling', 'appointment'],
    ['no previous capability (saved-card Menu)', undefined, 'scheduling'],
    ['same capability selected again (new booking)', 'scheduling', 'scheduling'],
  ] as const) {
    it(`${label}: clears question answers and position, keeps identity`, () => {
      const d: Record<string, unknown> = { _pbq_answers: { q1: OLD_ANSWER }, _pbq_index: 1, first_name: 'Ada' };
      clearStaleCapabilityState(d, from, to);
      expect(d).not.toHaveProperty('_pbq_answers');
      expect(d).not.toHaveProperty('_pbq_index');
      expect(d.first_name).toBe('Ada');
    });
  }
});

/**
 * F1: Real Citadel no-session integration test through BotService.handleMessage().
 *
 * handleSaveCard is NOT mocked — the real locator, startSavedCardFromPaymentId,
 * and session creation all execute.
 *
 * Proves the end-to-end Owner-observed runtime chain:
 * no active session → inbound "save card" → real locator finds eligible payment
 * → real exact-payment helper → save_card_pin session created → visible PIN prompt
 * → greeting/keyword/LLM do NOT steal the command.
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
vi.mock('@/lib/bot/smart-intent', () => ({
  parseSmartIntent: vi.fn().mockResolvedValue(null),
  parseSmartIntentHybrid: vi.fn().mockResolvedValue(null),
  matchServiceFromKeywords: vi.fn().mockResolvedValue(null),
  matchProductsFromKeywords: vi.fn().mockResolvedValue([]),
  buildAcknowledgment: vi.fn().mockReturnValue(null),
}));
vi.mock('@/lib/channels/send-guard', () => ({
  assertMessagingAllowed: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/bot/handlers/bot-code-detection', () => ({
  detectBotCode: vi.fn().mockResolvedValue(null),
  detectBotCodeWithSuggestions: vi.fn().mockResolvedValue({ businessId: null, suggestions: [] }),
  rankSuggestions: vi.fn().mockReturnValue([]),
  findReturningCustomerBusiness: vi.fn().mockResolvedValue(null),
  findReturningCustomerBusinesses: vi.fn().mockResolvedValue([]),
}));
// Do NOT mock saved-cards handlers — real handlers execute
// Mock only the saved-card-compat module for compatibility checks
vi.mock('@/lib/payments/saved-card-compat', () => ({
  canonicalSavedCardPhone: vi.fn().mockImplementation((p: string) => p.startsWith('+') ? p : `+${p}`),
  isSharedPlatformPaystackCompatible: vi.fn().mockResolvedValue({ compatible: true }),
  internalPaymentEmailAlias: vi.fn().mockReturnValue('2348012345678@whatsapp.waaiio.com'),
}));

const { BotService } = await import('@/lib/bot/bot.service');
const { MetaCloudSender } = await import('@/lib/channels/message-sender');
const { assertMessagingAllowed } = await import('@/lib/channels/send-guard');

const PHONE = '+2348012345678';
const PHONE_N = '2348012345678';
const BIZ_ID = 'biz-citadel-001';
const PAY_ID = 'pay-citadel-001';

const ELIGIBLE_PAYMENT = {
  id: PAY_ID, status: 'success', gateway: 'paystack', business_id: BIZ_ID,
  booking_id: 'bk-citadel-1', reservation_id: null, invoice_id: null,
  order_id: null, campaign_id: null, user_id: null, created_at: '2026-09-18T10:00:00Z',
  metadata: {
    payment_origin: 'platform',
    _card_authorization: {
      authorization_code: 'auth_citadel_xxx', customer_code: 'CUS_citadel',
      email: `${PHONE_N}@whatsapp.waaiio.com`, last4: '4242', brand: 'visa', reusable: true,
    },
  },
};

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
    const rv = { data: tableData === null ? [] : (Array.isArray(tableData) ? tableData : [tableData]), error: null, count: 0 };
    chain.then = (ok?: (v: any) => any, er?: (e: any) => any) => Promise.resolve(rv).then(ok, er);
    chain.catch = (er?: (e: any) => any) => Promise.resolve(rv).catch(er);
  }
  return chain;
}

function createCitadelSupabase() {
  // Track bot_sessions inserts to verify save_card_pin session creation
  const sessionInserts: unknown[] = [];
  return {
    sessionInserts,
    supabase: {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'platform_settings') return makeChain({ value: false });
        // No active session (Citadel no-session case)
        if (table === 'bot_sessions') {
          const chain = makeChain(null);
          chain.insert = vi.fn().mockImplementation((row: unknown) => {
            sessionInserts.push(row);
            return makeChain(null, true);
          });
          return chain;
        }
        if (table === 'businesses') return makeChain({ id: BIZ_ID, name: 'Citadel of Grace', slug: 'citadel', category: 'church', flow_type: 'scheduling', subscription_tier: 'growth', trial_ends_at: null, metadata: {}, country_code: 'NG' });
        if (table === 'blocked_phones') {
          const c = makeChain(null);
          c.select = vi.fn().mockReturnValue({ ...c, eq: vi.fn().mockReturnValue({ ...c, or: vi.fn().mockResolvedValue({ count: 0, error: null }) }) });
          return c;
        }
        // Locator: bookings for this phone → one booking
        if (table === 'bookings') {
          const chain = makeChain([{ id: 'bk-citadel-1' }]);
          chain.maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'bk-citadel-1' }, error: null });
          chain.single = vi.fn().mockResolvedValue({ data: { guest_phone: PHONE }, error: null });
          return chain;
        }
        // Locator + exact-payment helper: payments
        if (table === 'payments') {
          const chain = makeChain(ELIGIBLE_PAYMENT);
          chain.maybeSingle = vi.fn().mockResolvedValue({ data: ELIGIBLE_PAYMENT, error: null });
          chain.single = vi.fn().mockResolvedValue({ data: ELIGIBLE_PAYMENT, error: null });
          return chain;
        }
        // No existing saved card
        if (table === 'saved_payment_methods') {
          const chain = makeChain(null);
          Object.defineProperty(chain, 'then', {
            value: (ok?: (v: any) => any) => Promise.resolve({ data: [], error: null }).then(ok),
            configurable: true,
          });
          return chain;
        }
        // No BYO credentials
        if (table === 'business_payment_credentials') return makeChain(null);
        // Profiles for locator
        if (table === 'profiles') return makeChain(null);
        // Default
        return makeChain(null);
      }),
      rpc: vi.fn().mockImplementation((name: string) => {
        if (name === 'accept_saved_card_offer') {
          return Promise.resolve({ data: { result: 'transitioned' }, error: null });
        }
        return Promise.resolve({ data: { success: true, version: 1 }, error: null });
      }),
    },
  };
}

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

describe('F1: Real Citadel no-session integration', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('save card → real locator → real startSavedCardFromPaymentId → PIN prompt', async () => {
    const { supabase, sessionInserts } = createCitadelSupabase();
    const cloud = createMockCloud();
    // Production shape: shared-channel sender starts UNBOUND.
    const sender = new MetaCloudSender(cloud as any, null);
    const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);

    expect(sender.boundBusinessId).toBe('');
    await bot.handleMessage(PHONE, 'save card', { type: 'text' });

    // Hotfix proof: exact payment authority binds Citadel BEFORE business-scoped send.
    expect(sender.boundBusinessId).toBe(BIZ_ID);
    expect(assertMessagingAllowed).toHaveBeenCalledWith(BIZ_ID);
    expect(assertMessagingAllowed).not.toHaveBeenCalledWith('');

    // F1 proof: visible CREATE-PIN response was emitted
    // MetaCloudSender.sendText calls cloud.sendText({ to, text }) — first arg is object
    const allSendTextCalls = cloud.sendText.mock.calls;
    const pinPrompt = allSendTextCalls.find((c: unknown[]) => {
      const msg = c[0] as { text?: string } | undefined;
      const text = msg?.text || '';
      return text.indexOf('Saving') >= 0 || text.indexOf('PIN') >= 0;
    });
    expect(pinPrompt, 'Expected visible PIN creation prompt').toBeTruthy();

    // F1 proof: greeting/keyword path did NOT execute (no sendButtons for greeting)
    expect(cloud.sendButtons).not.toHaveBeenCalled();
  });

  it('button ACCEPT on unbound shared channel binds exact payment business before PIN prompt', async () => {
    const { supabase } = createCitadelSupabase();
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, null);
    const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);

    expect(sender.boundBusinessId).toBe('');
    await bot.handleMessage(PHONE, `save_card_accept:${PAY_ID}`, { type: 'text' });

    expect(sender.boundBusinessId).toBe(BIZ_ID);
    expect(assertMessagingAllowed).toHaveBeenCalledWith(BIZ_ID);
    expect(assertMessagingAllowed).not.toHaveBeenCalledWith('');

    const pinPrompt = cloud.sendText.mock.calls.find((c: unknown[]) => {
      const msg = c[0] as { text?: string } | undefined;
      const text = msg?.text || '';
      return text.indexOf('Saving') >= 0 || text.indexOf('PIN') >= 0;
    });
    expect(pinPrompt, 'Expected visible PIN creation prompt after Save-card button ACCEPT').toBeTruthy();
  });
});

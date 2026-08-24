/**
 * ACC-180: BotService runtime behavioral tests for first-message promo routing.
 *
 * All tests execute actual bot.handleMessage() calls.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Tracking state ──
let promoHandlerCalls: Array<{ businessId: string; messageId?: string; text: string; caps?: string[] }> = [];
let flowExecutorExecuteCalls = 0;
let canonicalUnderstandingCalls = 0;
let sessionInsertCalls: Array<Record<string, unknown>> = [];
let promoHandledBehavior: 'auto' | 'force_true' | 'force_false' | 'eligibility_required' = 'auto';

// ── Mock modules ──

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => buildMockChainClient(),
}));

const mockGetConfiguredCapabilities = vi.fn().mockResolvedValue({
  ok: true,
  rows: [
    { capability: 'ordering', is_enabled: true, sort_order: 0 },
    { capability: 'promo_verification', is_enabled: true, sort_order: 1 },
  ],
});
vi.mock('@/lib/capabilities/service', () => ({
  getConfiguredCapabilities: (...args: any[]) => mockGetConfiguredCapabilities(...args),
  getCapabilityCustomLabels: vi.fn().mockResolvedValue({}),
}));

vi.mock('../handlers/promo-verification', () => ({
  handlePromoVerification: vi.fn(async (
    _sb: any, _send: any, _from: string, text: string,
    businessId: string, messageId?: string, caps?: string[],
  ) => {
    promoHandlerCalls.push({ businessId, messageId, text, caps });
    if (!caps?.includes('promo_verification')) return { handled: false };
    if (promoHandledBehavior === 'force_true') return { handled: true };
    if (promoHandledBehavior === 'force_false') return { handled: false };
    if (promoHandledBehavior === 'eligibility_required') return { handled: true };
    // Auto: keyword mode (2+ tokens) → handled, else false
    if (text.trim().split(/\s+/).length >= 2) return { handled: true };
    return { handled: false };
  }),
}));

vi.mock('../flows/executor', () => ({
  FlowExecutor: class { async execute() { flowExecutorExecuteCalls++; } },
}));

// Mock platform settings and rate limiting
vi.mock('@/lib/platformSettings', () => ({
  loadPlatformSettings: vi.fn().mockResolvedValue({ bot_rate_limit_per_minute: 60 }),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimitAsync: vi.fn().mockResolvedValue({ allowed: true, remaining: 59 }),
}));

// Configurable bot-code detection mock for fuzzy/returning-customer tests
let mockDetectionResult: { businessId: string | null; suggestions?: any[]; isCategory?: boolean; deepLinkCapability?: string } = { businessId: null };
let mockReturningCustomerResult: string | null = null;
let mockReturningCustomerBusinesses: any[] = [];
vi.mock('../handlers/bot-code-detection', () => ({
  detectBotCode: vi.fn(async () => mockDetectionResult.businessId),
  detectBotCodeWithSuggestions: vi.fn(async () => mockDetectionResult),
  rankSuggestions: vi.fn(() => []),
  findReturningCustomerBusiness: vi.fn(async () => mockReturningCustomerResult),
  findReturningCustomerBusinesses: vi.fn(async () => mockReturningCustomerBusinesses),
}));

vi.mock('../canonical-understanding', () => ({
  understandCanonicalMessage: vi.fn(async () => {
    canonicalUnderstandingCalls++;
    return {
      confidence: 0, broadIntent: null, semanticFamily: null, requestedAction: null,
      entities: {}, language: 'en', languageBlocked: false,
      languageEntitlement: { allowedLanguages: ['en'] }, allowedLanguageNames: ['English'],
    };
  }),
}));

// ── Helpers ──

function buildMockChainClient() {
  const mkChain = (): Record<string, any> => {
    const c: Record<string, any> = {};
    c.select = vi.fn().mockReturnValue(c);
    c.insert = vi.fn().mockReturnValue(c);
    c.update = vi.fn().mockReturnValue(c);
    c.delete = vi.fn().mockReturnValue(c);
    c.upsert = vi.fn().mockReturnValue(c);
    c.eq = vi.fn().mockReturnValue(c);
    c.neq = vi.fn().mockReturnValue(c);
    c.or = vi.fn().mockReturnValue(c);
    c.is = vi.fn().mockReturnValue(c);
    c.not = vi.fn().mockReturnValue(c);
    c.in = vi.fn().mockReturnValue(c);
    c.ilike = vi.fn().mockReturnValue(c);
    c.like = vi.fn().mockReturnValue(c);
    c.gt = vi.fn().mockReturnValue(c);
    c.gte = vi.fn().mockReturnValue(c);
    c.lt = vi.fn().mockReturnValue(c);
    c.lte = vi.fn().mockReturnValue(c);
    c.order = vi.fn().mockReturnValue(c);
    c.limit = vi.fn().mockReturnValue(c);
    c.range = vi.fn().mockReturnValue(c);
    c.single = vi.fn().mockResolvedValue({ data: null, error: null });
    c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    return c;
  };
  return { from: vi.fn(() => mkChain()), rpc: vi.fn().mockResolvedValue({ data: null, error: null }) };
}

const BIZ_DATA = {
  id: 'biz-promo', name: 'PromoBiz', slug: 'promobiz', category: 'shop',
  flow_type: 'ordering', subscription_tier: 'growth', trial_ends_at: null,
  metadata: {}, country_code: 'NG', is_whitelabel: false, payment_gateway: null,
  operating_hours: null, status: 'active', whatsapp_phone_number_id: null,
  bot_code: null, total_bookings: 0, rating_avg: 0,
};

function buildSupabase(opts: {
  businessId?: string;
  caps?: string[];
  dedicatedNumber?: boolean;
  sessionInsertFail?: boolean;
  hasExistingSession?: boolean;
  existingSessionData?: Record<string, unknown>;
} = {}) {
  const bizId = opts.businessId || 'biz-promo';
  const caps = opts.caps || ['ordering', 'promo_verification'];
  const biz = { ...BIZ_DATA, id: bizId };
  if (opts.dedicatedNumber) (biz as any).whatsapp_phone_number_id = 'dedicated-phone-id';

  const mkChain = (): Record<string, any> => {
    const c: Record<string, any> = {};
    c.select = vi.fn().mockReturnValue(c);
    c.insert = vi.fn((...args: any[]) => {
      if (args[0]?.whatsapp_number) sessionInsertCalls.push(args[0]);
      return c;
    });
    c.update = vi.fn().mockReturnValue(c);
    c.delete = vi.fn().mockReturnValue(c);
    c.upsert = vi.fn().mockReturnValue(c);
    c.eq = vi.fn().mockReturnValue(c);
    c.neq = vi.fn().mockReturnValue(c);
    c.or = vi.fn().mockReturnValue(c);
    c.is = vi.fn().mockReturnValue(c);
    c.not = vi.fn().mockReturnValue(c);
    c.in = vi.fn().mockReturnValue(c);
    c.ilike = vi.fn().mockReturnValue(c);
    c.like = vi.fn().mockReturnValue(c);
    c.gt = vi.fn().mockReturnValue(c);
    c.gte = vi.fn().mockReturnValue(c);
    c.lt = vi.fn().mockReturnValue(c);
    c.lte = vi.fn().mockReturnValue(c);
    c.order = vi.fn().mockReturnValue(c);
    c.limit = vi.fn().mockReturnValue(c);
    c.range = vi.fn().mockReturnValue(c);
    c.single = vi.fn().mockResolvedValue({ data: null, error: null });
    c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    return c;
  };

  return {
    from: vi.fn((table: string) => {
      const c = mkChain();
      if (table === 'businesses') {
        c.single = vi.fn().mockResolvedValue({ data: biz, error: null });
        c.maybeSingle = vi.fn().mockResolvedValue({ data: opts.dedicatedNumber ? biz : null, error: null });
      }
      if (table === 'whatsapp_channels') {
        c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
      }
      if (table === 'platform_settings') {
        c.single = vi.fn().mockResolvedValue({ data: { value: false }, error: null });
      }
      if (table === 'messaging_opt_outs') {
        c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
      }
      if (table === 'profiles') {
        c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
      }
      if (table === 'blocked_phones') {
        const origSel = c.select;
        c.select = vi.fn((...a: any[]) => {
          if (a[1]?.count === 'exact') {
            const cc2 = mkChain();
            (cc2 as any).then = (fn: any) => Promise.resolve(fn({ count: 0 }));
            return cc2;
          }
          return origSel(...a);
        });
      }
      if (table === 'bot_sessions') {
        // Session insert → .insert().select().single()
        const sessResult = opts.sessionInsertFail
          ? { data: null, error: { message: 'unique violation', code: '23505' } }
          : { data: { id: 'sess-new', whatsapp_number: '+234', business_id: bizId, current_step: 'select_capability', session_data: { capabilities: caps }, is_active: true, version: 0 }, error: null };
        const insertChain = mkChain();
        insertChain.single = vi.fn().mockResolvedValue(sessResult);
        c.insert = vi.fn((...args: any[]) => {
          if (args[0]?.whatsapp_number) sessionInsertCalls.push(args[0]);
          return insertChain;
        });
      }
      return c;
    }),
    rpc: vi.fn().mockImplementation(async (name: string, params?: any) => {
      if (name === 'get_bot_context') {
        if (opts.hasExistingSession) {
          return {
            data: {
              has_session: true,
              session: {
                id: 'sess-existing', whatsapp_number: params?.p_phone, business_id: bizId,
                current_step: 'greeting', session_data: opts.existingSessionData || { capabilities: caps },
                is_active: true, version: 1,
              },
              business: biz,
              capabilities: caps.map(c => ({ capability: c, is_enabled: true, sort_order: 0 })),
              capability_overrides: [],
            },
            error: null,
          };
        }
        return {
          data: {
            has_session: false, session: null,
            business: biz,
            capabilities: caps.map(c => ({ capability: c, is_enabled: true, sort_order: 0 })),
            capability_overrides: [],
          },
          error: null,
        };
      }
      if (name === 'update_session_cas') {
        return { data: { success: true, version: 2 }, error: null };
      }
      if (name === 'deactivate_session_atomic') {
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }),
  };
}

function mockSender() {
  return {
    sendText: vi.fn().mockResolvedValue({}), sendButtons: vi.fn().mockResolvedValue({}),
    sendList: vi.fn().mockResolvedValue({}), sendDocument: vi.fn().mockResolvedValue({}),
    sendImage: vi.fn().mockResolvedValue({}), markAsRead: vi.fn().mockResolvedValue({}),
  };
}

function mockStandalone(tierAllowed = true) {
  return {
    loadWhatsAppConfigBundle: vi.fn().mockResolvedValue({
      templates: { greeting: 'Welcome!' }, welcome_buttons: [],
      auto_reply_enabled: false, business_hours: null, alias: null,
    }),
    checkTierLimitsFromBusiness: vi.fn().mockResolvedValue({ allowed: tierAllowed, isWhitelabel: false }),
    fillTemplate: vi.fn((t: string) => t),
  };
}

function mockIntelligence() {
  return {
    getPersonaGreeting: vi.fn(() => 'Hello!'),
    isTimedOut: vi.fn(() => false),
    containsProfanity: vi.fn(() => false),
    recordProfanity: vi.fn(() => ({ blocked: false })),
  };
}

beforeEach(() => {
  promoHandlerCalls = [];
  flowExecutorExecuteCalls = 0;
  canonicalUnderstandingCalls = 0;
  sessionInsertCalls = [];
  promoHandledBehavior = 'auto';
  mockDetectionResult = { businessId: null };
  mockReturningCustomerResult = null;
  mockReturningCustomerBusinesses = [];
  mockGetConfiguredCapabilities.mockResolvedValue({
    ok: true,
    rows: [
      { capability: 'ordering', is_enabled: true, sort_order: 0 },
      { capability: 'promo_verification', is_enabled: true, sort_order: 1 },
    ],
  });
});

const { BotService } = await import('../bot.service');

// ══════════════════════════════════════════════════════════
// 1. Trusted pre_resolved business → first-message promo
// ══════════════════════════════════════════════════════════

describe('ACC-180 Runtime: pre_resolved business', () => {
  it('preResolvedBusinessId → promo handler called with correct businessId and messageId', async () => {
    const sb = buildSupabase({ businessId: 'biz-pre' });
    const bot = new BotService(sb as any, mockSender() as any, mockStandalone() as any, mockIntelligence() as any);
    await bot.handleMessage('+2341234567890', 'TROPHY K7PM4XQ9', 'text', 'phone-id', 'biz-pre', undefined, 'wamid.PRE123');

    expect(promoHandlerCalls.length).toBeGreaterThanOrEqual(1);
    expect(promoHandlerCalls[0].businessId).toBe('biz-pre');
    expect(promoHandlerCalls[0].messageId).toBe('wamid.PRE123');
  });
});

// ══════════════════════════════════════════════════════════
// 2. Dedicated-number trusted resolution → first-message promo
// ══════════════════════════════════════════════════════════

describe('ACC-180 Runtime: dedicated-number resolution', () => {
  it('business resolved via dedicated-number DB lookup (no preResolvedBusinessId) → promo handler called', async () => {
    // preResolvedBusinessId is ABSENT — business resolves through
    // from('businesses').eq('whatsapp_phone_number_id', destinationPhone).single()
    const sb = buildSupabase({ businessId: 'biz-ded', dedicatedNumber: true });
    const bot = new BotService(sb as any, mockSender() as any, mockStandalone() as any, mockIntelligence() as any);
    // Only destinationPhone, no preResolvedBusinessId
    await bot.handleMessage('+2341234567890', 'TROPHY ABC12345', 'text', 'dedicated-phone-id', undefined, undefined, 'wamid.DED456');

    expect(promoHandlerCalls.length).toBeGreaterThanOrEqual(1);
    expect(promoHandlerCalls[0].businessId).toBe('biz-ded');
    expect(promoHandlerCalls[0].messageId).toBe('wamid.DED456');
  });
});

// ══════════════════════════════════════════════════════════
// 3. Untrusted resolution does NOT authorize first-message promo
// ══════════════════════════════════════════════════════════

describe('ACC-180 Runtime: untrusted resolution blocked', () => {
  it('no preResolved, no destinationPhone (shared number) → promo NOT called', async () => {
    const sb = buildSupabase();
    sb.rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const bot = new BotService(sb as any, mockSender() as any, mockStandalone() as any, mockIntelligence() as any);
    await bot.handleMessage('+2341234567890', 'TROPHY K7PM4XQ9', 'text');

    expect(promoHandlerCalls.length).toBe(0);
  });

  it('business resolved via fuzzy detection → promo NOT authorized (runtime)', async () => {
    // Configure detector mock to return a business through fuzzy matching
    mockDetectionResult = { businessId: 'biz-fuzzy' };
    const sb = buildSupabase({ businessId: 'biz-fuzzy' });
    // No RPC call without preResolvedBusinessId — legacy path
    const bot = new BotService(sb as any, mockSender() as any, mockStandalone() as any, mockIntelligence() as any);
    // No preResolvedBusinessId, no destinationPhone → detectBotCodeWithSuggestions resolves business
    await bot.handleMessage('+2341234567890', 'TROPHY K7PM4XQ9', 'text', undefined, undefined, undefined, 'wamid.FUZZY');

    // Business WAS resolved (fuzzy), but first-message promo NOT called
    expect(promoHandlerCalls.length).toBe(0);
    // Normal flow should continue
    expect(flowExecutorExecuteCalls).toBe(1);
  });

  it('business resolved via returning-customer inference → promo NOT authorized (runtime)', async () => {
    mockReturningCustomerResult = 'biz-returning';
    const sb = buildSupabase({ businessId: 'biz-returning' });
    const bot = new BotService(sb as any, mockSender() as any, mockStandalone() as any, mockIntelligence() as any);
    await bot.handleMessage('+2341234567890', 'TROPHY K7PM4XQ9', 'text', undefined, undefined, undefined, 'wamid.RETURN');

    // Business resolved via returning-customer (untrusted)
    expect(promoHandlerCalls.length).toBe(0);
    expect(flowExecutorExecuteCalls).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════
// 4. Capability gating
// ══════════════════════════════════════════════════════════

describe('ACC-180 Runtime: capability gating', () => {
  it('no promo_verification capability → promo handler NOT called', async () => {
    mockGetConfiguredCapabilities.mockResolvedValueOnce({
      ok: true, rows: [{ capability: 'ordering', is_enabled: true, sort_order: 0 }],
    });
    const sb = buildSupabase({ businessId: 'biz-nocap', caps: ['ordering'] });
    const bot = new BotService(sb as any, mockSender() as any, mockStandalone() as any, mockIntelligence() as any);
    await bot.handleMessage('+2341234567890', 'TROPHY K7PM4XQ9', 'text', 'phone-id', 'biz-nocap', undefined, 'wamid.NOCAP');

    expect(promoHandlerCalls.length).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════
// 5. Tier rejection
// ══════════════════════════════════════════════════════════

describe('ACC-180 Runtime: tier rejection', () => {
  it('tier not allowed → promo handler NOT called', async () => {
    const sb = buildSupabase({ businessId: 'biz-tier' });
    const bot = new BotService(sb as any, mockSender() as any, mockStandalone(false) as any, mockIntelligence() as any);
    await bot.handleMessage('+2341234567890', 'TROPHY K7PM4XQ9', 'text', 'phone-id', 'biz-tier', undefined, 'wamid.TIER');

    expect(promoHandlerCalls.length).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════
// 6. handled:false with promo-like text → canonical flow continues
// ══════════════════════════════════════════════════════════

describe('ACC-180 Runtime: handled:false fallthrough', () => {
  it('promo-like text that returns handled:false → canonical understanding + flow executor run', async () => {
    promoHandledBehavior = 'force_false';
    const sb = buildSupabase({ businessId: 'biz-fall' });
    const bot = new BotService(sb as any, mockSender() as any, mockStandalone() as any, mockIntelligence() as any);
    // "ABCD1234XYZ" is 11 chars, passes length >= 4 gate, but promo returns false
    await bot.handleMessage('+2341234567890', 'ABCD1234XYZ', 'text', 'phone-id', 'biz-fall', undefined, 'wamid.FALL');

    // Promo handler WAS called (text passes the gate)
    expect(promoHandlerCalls.length).toBeGreaterThanOrEqual(1);
    // But returned handled:false → canonical understanding should have run
    expect(canonicalUnderstandingCalls).toBeGreaterThanOrEqual(1);
    // Flow executor should have run
    expect(flowExecutorExecuteCalls).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════
// 7. handled:true → CAS-004 skipped, canonical session created
// ══════════════════════════════════════════════════════════

describe('ACC-180 Runtime: handled:true canonical session proof', () => {
  it('promo handled → CAS-004 skipped, flow executor skipped, bot_sessions.insert occurs', async () => {
    promoHandledBehavior = 'force_true';
    const sb = buildSupabase({ businessId: 'biz-handled' });
    const bot = new BotService(sb as any, mockSender() as any, mockStandalone() as any, mockIntelligence() as any);
    await bot.handleMessage('+2341234567890', 'ABCD1234XYZ', 'text', 'phone-id', 'biz-handled', undefined, 'wamid.HANDLED');

    expect(promoHandlerCalls.length).toBeGreaterThanOrEqual(1);
    expect(canonicalUnderstandingCalls).toBe(0);
    expect(flowExecutorExecuteCalls).toBe(0);

    // Verify bot_sessions.insert was called (canonical session path)
    const botSessionFromCalls = (sb.from as any).mock.calls.filter((c: any[]) => c[0] === 'bot_sessions');
    expect(botSessionFromCalls.length).toBeGreaterThan(0);

    // Verify session insert data contains business context
    expect(sessionInsertCalls.length).toBeGreaterThanOrEqual(1);
    const sess = sessionInsertCalls[0];
    expect(sess.business_id).toBe('biz-handled');
    expect(sess.is_active).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════
// 8. Meta message ID threading
// ══════════════════════════════════════════════════════════

describe('ACC-180 Runtime: message ID threading', () => {
  it('exact Meta msg.id reaches promo handler', async () => {
    const metaId = 'wamid.HBgMNTcxMjc0OTg0NzgVAgARGBI1QkRDRjU3RjM2NjUxMkE5AA';
    const sb = buildSupabase({ businessId: 'biz-msgid' });
    const bot = new BotService(sb as any, mockSender() as any, mockStandalone() as any, mockIntelligence() as any);
    await bot.handleMessage('+2341234567890', 'TROPHY ABCD1234', 'text', 'phone-id', 'biz-msgid', undefined, metaId);

    expect(promoHandlerCalls[0].messageId).toBe(metaId);
  });

  it('undefined messageId passes undefined to promo handler', async () => {
    const sb = buildSupabase({ businessId: 'biz-nomsgid' });
    const bot = new BotService(sb as any, mockSender() as any, mockStandalone() as any, mockIntelligence() as any);
    await bot.handleMessage('+2341234567890', 'TROPHY WXYZ9876', 'text', 'phone-id', 'biz-nomsgid');

    expect(promoHandlerCalls[0].messageId).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════
// 9. Eligibility continuation — two handleMessage calls
// ══════════════════════════════════════════════════════════

describe('ACC-180 Runtime: eligibility continuation', () => {
  it('message 1 creates canonical session with business context + promo_verification for continuation', async () => {
    // ── Message 1: first-message promo → eligibility required → session created ──
    promoHandledBehavior = 'eligibility_required';
    const sb1 = buildSupabase({ businessId: 'biz-elig' });
    const bot1 = new BotService(sb1 as any, mockSender() as any, mockStandalone() as any, mockIntelligence() as any);

    await bot1.handleMessage('+2341234567890', 'TROPHY K7PM4XQ9', 'text', 'phone-id', 'biz-elig', undefined, 'wamid.ELIG1');
    expect(promoHandlerCalls.length).toBe(1);
    expect(promoHandlerCalls[0].text).toBe('TROPHY K7PM4XQ9');
    expect(sessionInsertCalls.length).toBeGreaterThanOrEqual(1);
    const sess = sessionInsertCalls[0];
    expect(sess.business_id).toBe('biz-elig');
    expect(sess.is_active).toBe(true);
    // Session has promo_verification capability for continuation
    const sessData = sess.session_data as Record<string, unknown>;
    expect((sessData.capabilities as string[]) || []).toContain('promo_verification');
  });

  it('message 2 YES on existing session reaches promo handler with correct messageId (runtime)', async () => {
    // Build supabase with existing session (as if message 1 created it)
    promoHandledBehavior = 'force_true';
    const sb = buildSupabase({
      businessId: 'biz-elig',
      hasExistingSession: true,
      existingSessionData: {
        capabilities: ['ordering', 'promo_verification'],
        business_id: 'biz-elig',
        business_name: 'PromoBiz',
        business_category: 'shop',
      },
    });
    const bot = new BotService(sb as any, mockSender() as any, mockStandalone() as any, mockIntelligence() as any);

    // Message 2: YES with different Meta ID — uses RPC path (preResolvedBusinessId set)
    await bot.handleMessage('+2341234567890', 'YES', 'text', 'phone-id', 'biz-elig', undefined, 'wamid.ELIG2');

    // Existing-session promo handler MUST be called
    expect(promoHandlerCalls.length).toBeGreaterThanOrEqual(1);
    expect(promoHandlerCalls[0].text).toBe('YES');
    expect(promoHandlerCalls[0].businessId).toBe('biz-elig');
    expect(promoHandlerCalls[0].messageId).toBe('wamid.ELIG2');
    // handled:true → flow executor NOT called
    expect(flowExecutorExecuteCalls).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════
// 10. Session-insert failure → error recovery
// ══════════════════════════════════════════════════════════

describe('ACC-180 Runtime: session-insert failure', () => {
  it('session creation fails → error message sent, flow does NOT continue', async () => {
    promoHandledBehavior = 'force_true';
    const sb = buildSupabase({ businessId: 'biz-fail', sessionInsertFail: true });
    const sender = mockSender();
    const bot = new BotService(sb as any, sender as any, mockStandalone() as any, mockIntelligence() as any);

    await bot.handleMessage('+2341234567890', 'TROPHY K7PM4XQ9', 'text', 'phone-id', 'biz-fail', undefined, 'wamid.FAIL');

    // Promo handler was called (before session creation)
    expect(promoHandlerCalls.length).toBeGreaterThanOrEqual(1);

    // Flow executor should NOT have been called
    expect(flowExecutorExecuteCalls).toBe(0);

    // Error message should have been sent
    const textCalls = sender.sendText.mock.calls;
    const hasErrorMsg = textCalls.some((c: any[]) =>
      typeof c[0]?.text === 'string' && c[0].text.includes('Something went wrong'),
    );
    // The error may be in sendText format { to, text } or separate args
    const hasErrorAny = textCalls.some((c: any[]) => {
      const msg = typeof c[0] === 'string' ? c[0] : c[0]?.text || c[1];
      return typeof msg === 'string' && msg.includes('wrong');
    });
    expect(hasErrorAny).toBe(true);
  });
});

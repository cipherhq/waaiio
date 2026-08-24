/**
 * ACC-180: BotService runtime behavioral tests for first-message promo routing.
 *
 * Executes actual bot.handleMessage() calls with mocked dependencies.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Tracking state ──
let promoHandlerCalls: Array<{ businessId: string; messageId?: string; text: string }> = [];
let flowExecutorExecuteCalls = 0;
let canonicalUnderstandingCalls = 0;

// ── Mock modules BEFORE imports ──

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => buildMockChainClient(),
}));

const mockGetConfiguredCapabilities = vi.fn().mockResolvedValue({ ok: true, rows: [{ capability: 'ordering', is_enabled: true, sort_order: 0 }, { capability: 'promo_verification', is_enabled: true, sort_order: 1 }] });
vi.mock('@/lib/capabilities/service', () => ({
  getConfiguredCapabilities: (...args: any[]) => mockGetConfiguredCapabilities(...args),
  getCapabilityCustomLabels: vi.fn().mockResolvedValue({}),
}));

vi.mock('../handlers/promo-verification', () => ({
  handlePromoVerification: vi.fn(async (_sb: any, _send: any, _from: string, text: string, businessId: string, messageId?: string, caps?: string[]) => {
    promoHandlerCalls.push({ businessId, messageId, text });
    if (!caps?.includes('promo_verification')) return { handled: false };
    // Keyword mode: "TROPHY CODE" has 2+ tokens
    if (text.trim().split(/\s+/).length >= 2) return { handled: true };
    return { handled: false };
  }),
}));

vi.mock('../flows/executor', () => ({
  FlowExecutor: class { async execute() { flowExecutorExecuteCalls++; } },
}));

vi.mock('../canonical-understanding', () => ({
  understandCanonicalMessage: vi.fn(async () => {
    canonicalUnderstandingCalls++;
    return { confidence: 0, broadIntent: null, semanticFamily: null, requestedAction: null, entities: {}, language: 'en', languageBlocked: false, languageEntitlement: { allowedLanguages: ['en'] }, allowedLanguageNames: ['English'] };
  }),
}));

// ── Helper: chainable supabase mock ──

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
    c.gte = vi.fn().mockReturnValue(c);
    c.lte = vi.fn().mockReturnValue(c);
    c.order = vi.fn().mockReturnValue(c);
    c.limit = vi.fn().mockReturnValue(c);
    c.single = vi.fn().mockResolvedValue({ data: null, error: null });
    c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    return c;
  };
  return { from: vi.fn(() => mkChain()), rpc: vi.fn().mockResolvedValue({ data: null, error: null }) };
}

// ── Build a supabase mock with configurable bot context RPC ──

function buildSupabase(opts: { businessId?: string; caps?: string[]; tierAllowed?: boolean } = {}) {
  const bizId = opts.businessId || 'biz-test';
  const caps = opts.caps || ['ordering', 'promo_verification'];
  const tierAllowed = opts.tierAllowed !== false;

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
    c.gte = vi.fn().mockReturnValue(c);
    c.lte = vi.fn().mockReturnValue(c);
    c.order = vi.fn().mockReturnValue(c);
    c.limit = vi.fn().mockReturnValue(c);
    c.single = vi.fn().mockResolvedValue({
      data: { id: 'sess-new', whatsapp_number: '+234', business_id: bizId, current_step: 'select_capability', session_data: { capabilities: caps }, is_active: true, version: 0 },
      error: null,
    });
    c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    return c;
  };

  const bizData = { id: bizId, name: 'PromoBiz', slug: 'promobiz', category: 'shop', flow_type: 'ordering', subscription_tier: 'growth', trial_ends_at: null, metadata: {}, country_code: 'NG', is_whitelabel: false, payment_gateway: null, operating_hours: null, status: 'active', whatsapp_phone_number_id: null, bot_code: null, total_bookings: 0, rating_avg: 0 };

  const sb: Record<string, any> = {
    from: vi.fn((table: string) => {
      const c = mkChain();
      if (table === 'businesses') {
        c.single = vi.fn().mockResolvedValue({ data: bizData, error: null });
        c.maybeSingle = vi.fn().mockResolvedValue({ data: bizData, error: null });
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
      return c;
    }),
    rpc: vi.fn().mockImplementation(async (name: string) => {
      if (name === 'get_bot_context') {
        return {
          data: {
            has_session: false, session: null,
            business: { id: bizId, name: 'PromoBiz', slug: 'promobiz', category: 'shop', flow_type: 'ordering', subscription_tier: 'growth', trial_ends_at: null, metadata: {}, country_code: 'NG', is_whitelabel: false, payment_gateway: null, operating_hours: null, status: 'active' },
            capabilities: caps.map(c => ({ capability: c, is_enabled: true, sort_order: 0 })),
            capability_overrides: [],
          },
          error: null,
        };
      }
      return { data: null, error: null };
    }),
  };

  return sb;
}

function mockSender() {
  return { sendText: vi.fn().mockResolvedValue({}), sendButtons: vi.fn().mockResolvedValue({}), sendList: vi.fn().mockResolvedValue({}), sendDocument: vi.fn().mockResolvedValue({}), sendImage: vi.fn().mockResolvedValue({}), markAsRead: vi.fn().mockResolvedValue({}) };
}

function mockStandalone(tierAllowed = true) {
  return {
    loadWhatsAppConfigBundle: vi.fn().mockResolvedValue({ templates: { greeting: 'Welcome!' }, welcome_buttons: [], auto_reply_enabled: false, business_hours: null, alias: null }),
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

// ── Reset ──

beforeEach(() => {
  promoHandlerCalls = [];
  flowExecutorExecuteCalls = 0;
  canonicalUnderstandingCalls = 0;
});

// ── Import BotService AFTER mocks ──

const { BotService } = await import('../bot.service');

// ══════════════════════════════════════════════════════════
// RUNTIME TESTS
// ══════════════════════════════════════════════════════════

describe('ACC-180 Runtime: trusted pre_resolved → first-message promo', () => {
  it('preResolvedBusinessId → promo handler called with correct businessId and messageId', async () => {
    const sb = buildSupabase({ businessId: 'biz-promo-1' });
    const bot = new BotService(sb as any, mockSender() as any, mockStandalone() as any, mockIntelligence() as any);

    await bot.handleMessage('+2341234567890', 'TROPHY K7PM4XQ9', 'text', 'phone-num-id', 'biz-promo-1', undefined, 'wamid.META123');

    expect(promoHandlerCalls.length).toBeGreaterThanOrEqual(1);
    expect(promoHandlerCalls[0].businessId).toBe('biz-promo-1');
    expect(promoHandlerCalls[0].messageId).toBe('wamid.META123');
  });
});

describe('ACC-180 Runtime: handled:true skips CAS-004', () => {
  it('promo handled → canonical understanding NOT called, flow executor NOT called', async () => {
    const sb = buildSupabase({ businessId: 'biz-promo-2' });
    const bot = new BotService(sb as any, mockSender() as any, mockStandalone() as any, mockIntelligence() as any);

    await bot.handleMessage('+2341234567890', 'TROPHY K7PM4XQ9', 'text', 'phone-id', 'biz-promo-2', undefined, 'wamid.META456');

    expect(promoHandlerCalls.length).toBeGreaterThanOrEqual(1);
    expect(canonicalUnderstandingCalls).toBe(0);
    expect(flowExecutorExecuteCalls).toBe(0);
  });
});

describe('ACC-180 Runtime: handled:false → normal flow', () => {
  it('non-promo text → flow executor runs', async () => {
    const sb = buildSupabase({ businessId: 'biz-normal' });
    const bot = new BotService(sb as any, mockSender() as any, mockStandalone() as any, mockIntelligence() as any);

    await bot.handleMessage('+2341234567890', 'Hi', 'text', 'phone-id', 'biz-normal', undefined, 'wamid.NORMAL');

    expect(flowExecutorExecuteCalls).toBe(1);
  });
});

describe('ACC-180 Runtime: untrusted resolution blocked', () => {
  it('no preResolved, no destinationPhone → promo handler NOT called', async () => {
    const sb = buildSupabase();
    // Override RPC to return no business (shared number, unresolved)
    sb.rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const bot = new BotService(sb as any, mockSender() as any, mockStandalone() as any, mockIntelligence() as any);

    await bot.handleMessage('+2341234567890', 'TROPHY K7PM4XQ9', 'text');

    expect(promoHandlerCalls.length).toBe(0);
  });
});

describe('ACC-180 Runtime: capability gating', () => {
  it('no promo_verification capability → promo handler NOT called', async () => {
    // Override capability mock to exclude promo_verification
    mockGetConfiguredCapabilities.mockResolvedValueOnce({
      ok: true,
      rows: [{ capability: 'ordering', is_enabled: true, sort_order: 0 }, { capability: 'payment', is_enabled: true, sort_order: 1 }],
    });
    const sb = buildSupabase({ businessId: 'biz-nocap', caps: ['ordering', 'payment'] });
    const bot = new BotService(sb as any, mockSender() as any, mockStandalone() as any, mockIntelligence() as any);

    await bot.handleMessage('+2341234567890', 'TROPHY K7PM4XQ9', 'text', 'phone-id', 'biz-nocap', undefined, 'wamid.NOCAP');

    expect(promoHandlerCalls.length).toBe(0);
  });
});

describe('ACC-180 Runtime: tier rejection', () => {
  it('tier not allowed → promo handler NOT called', async () => {
    const sb = buildSupabase({ businessId: 'biz-tier' });
    const bot = new BotService(sb as any, mockSender() as any, mockStandalone(false) as any, mockIntelligence() as any);

    await bot.handleMessage('+2341234567890', 'TROPHY K7PM4XQ9', 'text', 'phone-id', 'biz-tier', undefined, 'wamid.TIER');

    expect(promoHandlerCalls.length).toBe(0);
  });
});

describe('ACC-180 Runtime: message ID threading', () => {
  it('exact Meta msg.id reaches promo handler', async () => {
    const sb = buildSupabase({ businessId: 'biz-msgid' });
    const bot = new BotService(sb as any, mockSender() as any, mockStandalone() as any, mockIntelligence() as any);

    const metaId = 'wamid.HBgMNTcxMjc0OTg0NzgVAgARGBI1QkRDRjU3RjM2NjUxMkE5AA';
    await bot.handleMessage('+2341234567890', 'TROPHY ABCD1234', 'text', 'phone-id', 'biz-msgid', undefined, metaId);

    expect(promoHandlerCalls.length).toBeGreaterThanOrEqual(1);
    expect(promoHandlerCalls[0].messageId).toBe(metaId);
  });

  it('undefined messageId passes undefined to promo handler', async () => {
    const sb = buildSupabase({ businessId: 'biz-nomsgid' });
    const bot = new BotService(sb as any, mockSender() as any, mockStandalone() as any, mockIntelligence() as any);

    await bot.handleMessage('+2341234567890', 'TROPHY WXYZ9876', 'text', 'phone-id', 'biz-nomsgid');

    expect(promoHandlerCalls.length).toBeGreaterThanOrEqual(1);
    expect(promoHandlerCalls[0].messageId).toBeUndefined();
  });
});

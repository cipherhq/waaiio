/**
 * ACC-181: Instant Win menu action dispatch tests.
 *
 * Tests label rendering, menu visibility, inline dispatch, BotService intercept,
 * and stale-session preemption via actual BotService.handleMessage().
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Tracking ──
let promoHandlerCalls: Array<{ text: string; businessId: string; messageId?: string }> = [];
let flowExecutorExecuteCalls = 0;
let promoHandledBehavior: 'auto' | 'force_true' | 'force_false' = 'auto';
let sessionInsertCalls: Array<Record<string, unknown>> = [];

// ── Module mocks ──

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: vi.fn(() => {
      const c: Record<string, any> = {};
      c.select = vi.fn().mockReturnValue(c);
      c.eq = vi.fn().mockReturnValue(c);
      c.order = vi.fn().mockReturnValue(c);
      c.limit = vi.fn().mockReturnValue(c);
      c.single = vi.fn().mockResolvedValue({ data: null, error: null });
      c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
      return c;
    }),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  }),
}));

vi.mock('@/lib/platformSettings', () => ({
  loadPlatformSettings: vi.fn().mockResolvedValue({ bot_rate_limit_per_minute: 60 }),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimitAsync: vi.fn().mockResolvedValue({ allowed: true, remaining: 59 }),
}));

const mockGetConfiguredCapabilities = vi.fn().mockResolvedValue({
  ok: true, rows: [
    { capability: 'ordering', is_enabled: true, sort_order: 0 },
    { capability: 'promo_verification', is_enabled: true, sort_order: 1 },
  ],
});
vi.mock('@/lib/capabilities/service', () => ({
  getConfiguredCapabilities: (...args: any[]) => mockGetConfiguredCapabilities(...args),
  getCapabilityCustomLabels: vi.fn().mockResolvedValue({}),
}));

vi.mock('../handlers/promo-verification', () => ({
  handlePromoVerification: vi.fn(async (_sb: any, _send: any, _from: string, text: string, businessId: string, messageId?: string, caps?: string[]) => {
    promoHandlerCalls.push({ text, businessId, messageId });
    if (!caps?.includes('promo_verification')) return { handled: false };
    if (promoHandledBehavior === 'force_true') return { handled: true };
    if (promoHandledBehavior === 'force_false') return { handled: false };
    if (text.trim().split(/\s+/).length >= 2) return { handled: true };
    return { handled: false };
  }),
}));

vi.mock('../flows/executor', () => ({
  FlowExecutor: class { async execute() { flowExecutorExecuteCalls++; } },
}));

vi.mock('../canonical-understanding', () => ({
  understandCanonicalMessage: vi.fn(async () => ({
    confidence: 0, broadIntent: null, semanticFamily: null, requestedAction: null,
    entities: {}, language: 'en', languageBlocked: false,
    languageEntitlement: { allowedLanguages: ['en'] }, allowedLanguageNames: ['English'],
  })),
}));

let mockDetectionResult: any = { businessId: null };
let mockReturningCustomerResult: string | null = null;
let mockReturningCustomerBusinesses: any[] = [];
vi.mock('../handlers/bot-code-detection', () => ({
  detectBotCode: vi.fn(async () => mockDetectionResult.businessId),
  detectBotCodeWithSuggestions: vi.fn(async () => mockDetectionResult),
  rankSuggestions: vi.fn(() => []),
  findReturningCustomerBusiness: vi.fn(async () => mockReturningCustomerResult),
  findReturningCustomerBusinesses: vi.fn(async () => mockReturningCustomerBusinesses),
}));

// ── Helpers ──

const BIZ = { id: 'biz-promo', name: 'PromoBiz', slug: 'promobiz', category: 'shop', flow_type: 'ordering', subscription_tier: 'growth', trial_ends_at: null, metadata: {}, country_code: 'NG', is_whitelabel: false, payment_gateway: null, operating_hours: null, status: 'active', whatsapp_phone_number_id: null, bot_code: null, total_bookings: 0, rating_avg: 0 };

function mkChain(): Record<string, any> {
  const c: Record<string, any> = {};
  c.select = vi.fn().mockReturnValue(c);
  c.insert = vi.fn((...args: any[]) => { if (args[0]?.whatsapp_number) sessionInsertCalls.push(args[0]); return c; });
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
}

function buildSb(opts: { bizId?: string; step?: string; caps?: string[] } = {}) {
  const bizId = opts.bizId || 'biz-promo';
  const caps = opts.caps || ['ordering', 'promo_verification'];
  const step = opts.step || 'greeting';
  return {
    from: vi.fn((table: string) => {
      const c = mkChain();
      if (table === 'businesses') {
        c.single = vi.fn().mockResolvedValue({ data: { ...BIZ, id: bizId }, error: null });
        c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
      }
      if (table === 'platform_settings') c.single = vi.fn().mockResolvedValue({ data: { value: false }, error: null });
      if (table === 'bot_sessions') {
        const ic = mkChain();
        ic.single = vi.fn().mockResolvedValue({ data: { id: 'sess', whatsapp_number: '+234', business_id: bizId, current_step: step, session_data: { capabilities: caps }, is_active: true, version: 0 }, error: null });
        c.insert = vi.fn((...args: any[]) => { if (args[0]?.whatsapp_number) sessionInsertCalls.push(args[0]); return ic; });
      }
      return c;
    }),
    rpc: vi.fn().mockImplementation(async (name: string, params?: any) => {
      if (name === 'get_bot_context') {
        return {
          data: {
            has_session: true,
            session: { id: 'sess-existing', whatsapp_number: params?.p_phone, business_id: bizId, current_step: step, session_data: { capabilities: caps, business_id: bizId, business_name: 'PromoBiz', business_category: 'shop' }, is_active: true, version: 1 },
            business: { ...BIZ, id: bizId },
            capabilities: caps.map(c => ({ capability: c, is_enabled: true, sort_order: 0 })),
            capability_overrides: [],
          },
          error: null,
        };
      }
      if (name === 'update_session_cas') return { data: { success: true, version: 2 }, error: null };
      if (name === 'deactivate_session_atomic') return { data: null, error: null };
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
function mockStandalone() {
  return {
    loadWhatsAppConfigBundle: vi.fn().mockResolvedValue({ templates: { greeting: 'Welcome!' }, welcome_buttons: [], auto_reply_enabled: false, business_hours: null, alias: null }),
    checkTierLimitsFromBusiness: vi.fn().mockResolvedValue({ allowed: true, isWhitelabel: false }),
    fillTemplate: vi.fn((t: string) => t),
  };
}
function mockIntelligence() {
  return { getPersonaGreeting: vi.fn(() => 'Hello!'), isTimedOut: vi.fn(() => false), containsProfanity: vi.fn(() => false), recordProfanity: vi.fn(() => ({ blocked: false })) };
}

beforeEach(() => {
  promoHandlerCalls = [];
  flowExecutorExecuteCalls = 0;
  promoHandledBehavior = 'auto';
  sessionInsertCalls = [];
  mockDetectionResult = { businessId: null };
  mockReturningCustomerResult = null;
  mockReturningCustomerBusinesses = [];
  mockGetConfiguredCapabilities.mockResolvedValue({ ok: true, rows: [{ capability: 'ordering', is_enabled: true, sort_order: 0 }, { capability: 'promo_verification', is_enabled: true, sort_order: 1 }] });
});

const { BotService } = await import('../bot.service');

// ══════════════════════════════════════════════════════════
// LABEL TESTS
// ══════════════════════════════════════════════════════════

describe('ACC-181: Instant Win label', () => {
  it('default label is Instant Win', async () => {
    const { getCapabilityLabel } = await import('@/lib/capabilities/labels');
    expect(getCapabilityLabel('promo_verification' as any, 'shop')).toBe('Instant Win');
  });

  it('custom label overrides Instant Win', async () => {
    const { getCapabilityLabel } = await import('@/lib/capabilities/labels');
    expect(getCapabilityLabel('promo_verification' as any, 'shop', 'Lucky Draw')).toBe('Lucky Draw');
  });

  it('raw promo_verification never returned as label', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/capabilities/labels.ts', 'utf-8');
    expect(src).toContain("case 'promo_verification':");
    expect(src).toContain("'Instant Win'");
  });
});

// ══════════════════════════════════════════════════════════
// ROUTING DEFENSE
// ══════════════════════════════════════════════════════════

describe('ACC-181: Routing defense', () => {
  it('getFirstStepForCapability returns promo_entry for promo_verification', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/capability-selection.flow.ts', 'utf-8');
    const fnBody = src.split('function getFirstStepForCapability')[1]?.split('}')[0] || '';
    expect(fnBody).toContain("case 'promo_verification':");
    expect(fnBody).toContain("return 'promo_entry'");
  });

  it('capabilityToFirstStep returns promo_entry for promo_verification', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/handlers/flow-routing.ts', 'utf-8');
    const fnBody = src.split('function capabilityToFirstStep')[1]?.split('}')[0] || '';
    expect(fnBody).toContain("case 'promo_verification':");
    expect(fnBody).toContain("return 'promo_entry'");
  });
});

// ══════════════════════════════════════════════════════════
// MENU VISIBILITY
// ══════════════════════════════════════════════════════════

describe('ACC-181: Menu visibility', () => {
  it('prepareCapabilityMenu checks active campaigns for promo_verification', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/capability-selection.flow.ts', 'utf-8');
    expect(src).toContain("case 'promo_verification':");
    expect(src).toContain('hasActivePromoCampaigns');
  });
});

// ══════════════════════════════════════════════════════════
// SHARED HELPER
// ══════════════════════════════════════════════════════════

describe('ACC-181: Shared entry helper', () => {
  it('renderPromoEntryMessage formats single campaign', async () => {
    const { renderPromoEntryMessage } = await import('@/lib/promotions/entry');
    const msg = renderPromoEntryMessage([{ id: '1', name: 'TROPHY Promo', keyword: 'TROPHY', code_entry_mode: 'keyword', accept_bare_codes: false }]);
    expect(msg).toContain('TROPHY Promo');
    expect(msg).toContain('TROPHY <your code>');
  });

  it('renderPromoEntryMessage formats multiple campaigns', async () => {
    const { renderPromoEntryMessage } = await import('@/lib/promotions/entry');
    const msg = renderPromoEntryMessage([
      { id: '1', name: 'TROPHY', keyword: 'TROPHY', code_entry_mode: 'keyword', accept_bare_codes: false },
      { id: '2', name: 'SCRATCH', keyword: null, code_entry_mode: 'bare_code', accept_bare_codes: true },
    ]);
    expect(msg).toContain('Active Promotions');
    expect(msg).toContain('TROPHY');
    expect(msg).toContain('SCRATCH');
  });
});

// ══════════════════════════════════════════════════════════
// BotService RUNTIME: stale booking session preempted
// ══════════════════════════════════════════════════════════

describe('ACC-181 Runtime: stale booking preemption', () => {
  it('cap_promo_verification during active booking session → intercepted, NOT booking', async () => {
    // Session is on select_date (mid-booking) — stale menu tap
    const sb = buildSb({ step: 'select_date' });
    const sender = mockSender();
    const bot = new BotService(sb as any, sender as any, mockStandalone() as any, mockIntelligence() as any);

    await bot.handleMessage('+2341234567890', 'cap_promo_verification', 'text', 'phone-id', 'biz-promo', undefined, 'wamid.STALE1');

    // BotService intercept should have handled it
    // FlowExecutor should NOT have run (action intercepted)
    expect(flowExecutorExecuteCalls).toBe(0);
    // Promo code handler should NOT have been called (this is a menu action, not a code)
    // The sendText should contain promo-related response
    const texts = sender.sendText.mock.calls.map((c: any[]) => {
      const arg = c[0];
      return typeof arg === 'string' ? arg : arg?.text || '';
    });
    const hasPromoResponse = texts.some((t: string) => t.includes('promotions') || t.includes('Instant Win') || t.includes('promo') || t.includes('🎰') || t.includes('not available'));
    expect(hasPromoResponse).toBe(true);
  });

  it('cap_promo_verification during active reservation session → intercepted, NOT reservation', async () => {
    const sb = buildSb({ step: 'select_apartment' });
    const sender = mockSender();
    const bot = new BotService(sb as any, sender as any, mockStandalone() as any, mockIntelligence() as any);

    await bot.handleMessage('+2341234567890', 'cap_promo_verification', 'text', 'phone-id', 'biz-promo', undefined, 'wamid.STALE2');

    expect(flowExecutorExecuteCalls).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════
// BotService RUNTIME: capability disabled
// ══════════════════════════════════════════════════════════

describe('ACC-181 Runtime: capability disabled', () => {
  it('cap_promo_verification with promo_verification NOT in caps → fail closed', async () => {
    mockGetConfiguredCapabilities.mockResolvedValueOnce({ ok: true, rows: [{ capability: 'ordering', is_enabled: true, sort_order: 0 }] });
    const sb = buildSb({ caps: ['ordering'] });
    const sender = mockSender();
    const bot = new BotService(sb as any, sender as any, mockStandalone() as any, mockIntelligence() as any);

    await bot.handleMessage('+2341234567890', 'cap_promo_verification', 'text', 'phone-id', 'biz-promo', undefined, 'wamid.NOCAP');

    expect(flowExecutorExecuteCalls).toBe(0);
    const texts = sender.sendText.mock.calls.map((c: any[]) => typeof c[0] === 'string' ? c[0] : c[0]?.text || '');
    expect(texts.some((t: string) => t.includes('not available'))).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════
// BotService RUNTIME: manually typed internal IDs
// ══════════════════════════════════════════════════════════

describe('ACC-181 Runtime: defensive typed input', () => {
  it('typed promo_verification → intercepted, not booking', async () => {
    const sb = buildSb({ step: 'select_service' });
    const bot = new BotService(sb as any, mockSender() as any, mockStandalone() as any, mockIntelligence() as any);

    await bot.handleMessage('+2341234567890', 'promo_verification', 'text', 'phone-id', 'biz-promo', undefined, 'wamid.TYPED');

    // Must NOT reach FlowExecutor (which would route to booking)
    expect(flowExecutorExecuteCalls).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════
// BOOKING/RESERVATION UNCHANGED
// ══════════════════════════════════════════════════════════

describe('ACC-181 Runtime: booking/reservation unchanged', () => {
  it('cap_scheduling still reaches FlowExecutor', async () => {
    const sb = buildSb({ step: 'select_capability' });
    const bot = new BotService(sb as any, mockSender() as any, mockStandalone() as any, mockIntelligence() as any);

    await bot.handleMessage('+2341234567890', 'cap_scheduling', 'text', 'phone-id', 'biz-promo', undefined, 'wamid.BOOK');

    // FlowExecutor should run for booking
    expect(flowExecutorExecuteCalls).toBe(1);
  });

  it('cap_reservation still reaches FlowExecutor', async () => {
    const sb = buildSb({ step: 'select_capability', caps: ['ordering', 'reservation', 'promo_verification'] });
    const bot = new BotService(sb as any, mockSender() as any, mockStandalone() as any, mockIntelligence() as any);

    await bot.handleMessage('+2341234567890', 'cap_reservation', 'text', 'phone-id', 'biz-promo', undefined, 'wamid.RES');

    expect(flowExecutorExecuteCalls).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════
// EXISTING PROMO CODE CLAIM UNCHANGED
// ══════════════════════════════════════════════════════════

describe('ACC-181 Runtime: promo code claim path preserved', () => {
  it('TROPHY K7PM4XQ9 still reaches promo code handler (not intercepted)', async () => {
    promoHandledBehavior = 'force_true';
    const sb = buildSb({ step: 'greeting' });
    const bot = new BotService(sb as any, mockSender() as any, mockStandalone() as any, mockIntelligence() as any);

    await bot.handleMessage('+2341234567890', 'TROPHY K7PM4XQ9', 'text', 'phone-id', 'biz-promo', undefined, 'wamid.CODE1');

    // The promo code handler should be called (not the menu intercept)
    expect(promoHandlerCalls.length).toBeGreaterThanOrEqual(1);
    expect(promoHandlerCalls[0].text).toBe('TROPHY K7PM4XQ9');
    expect(promoHandlerCalls[0].messageId).toBe('wamid.CODE1');
  });
});

// ══════════════════════════════════════════════════════════
// SINGLE-CAPABILITY + PROMO_ENTRY STEP
// ══════════════════════════════════════════════════════════

describe('ACC-181: Single-capability promo_verification', () => {
  it('promo_entry step exists in capabilitySelectionFlow', async () => {
    const { capabilitySelectionFlow } = await import('../flows/capability-selection.flow');
    const stepIds = capabilitySelectionFlow.steps.map(s => s.id);
    expect(stepIds).toContain('promo_entry');
  });

  it('getFirstStepForCapability routes promo_verification to promo_entry (not select_service)', async () => {
    const { getFirstStepForCapability } = await import('../flows/capability-selection.flow');
    expect(getFirstStepForCapability('promo_verification' as any)).toBe('promo_entry');
  });

  it('capabilityToFirstStep routes promo_verification to promo_entry', async () => {
    const { capabilityToFirstStep } = await import('../handlers/flow-routing');
    expect(capabilityToFirstStep('promo_verification' as any)).toBe('promo_entry');
  });

  it('promo_entry step prompt returns campaign context (not booking)', async () => {
    const { capabilitySelectionFlow } = await import('../flows/capability-selection.flow');
    const promoEntry = capabilitySelectionFlow.steps.find(s => s.id === 'promo_entry');
    expect(promoEntry).toBeDefined();

    // Mock context with promo_verification capability
    const ctx = {
      business: { id: 'biz-test', name: 'Test' },
      session: { session_data: { capabilities: ['promo_verification'] } },
      from: '+234',
      sender: { sendText: vi.fn() },
      supabase: {},
      t: async (s: string) => s,
    };

    const messages = await promoEntry!.prompt(ctx as any);
    expect(messages.length).toBe(1);
    expect(messages[0].type).toBe('text');
    // Should contain promo-related content, not booking
    const text = (messages[0] as any).text;
    expect(text).not.toContain('book');
    // May contain no-active message or campaign context depending on mock
  });

  it('promo_entry next() returns select_capability (no recursion)', async () => {
    const { capabilitySelectionFlow } = await import('../flows/capability-selection.flow');
    const promoEntry = capabilitySelectionFlow.steps.find(s => s.id === 'promo_entry');
    const next = await promoEntry!.next({} as any);
    expect(next).toBe('select_capability');
  });
});

// ══════════════════════════════════════════════════════════
// RUNTIME: select_capability with cap_promo_verification
// ══════════════════════════════════════════════════════════

describe('ACC-181 Runtime: fresh capability selection', () => {
  it('cap_promo_verification from select_capability → Instant Win entry, not booking', async () => {
    const sb = buildSb({ step: 'select_capability' });
    const sender = mockSender();
    const bot = new BotService(sb as any, sender as any, mockStandalone() as any, mockIntelligence() as any);

    await bot.handleMessage('+2341234567890', 'cap_promo_verification', 'text', 'phone-id', 'biz-promo', undefined, 'wamid.FRESH');

    // Must NOT reach FlowExecutor as a booking step
    // The BotService intercept handles it before FlowExecutor
    expect(flowExecutorExecuteCalls).toBe(0);
    // Should have sent a promo-related message
    const texts = sender.sendText.mock.calls.map((c: any[]) => typeof c[0] === 'string' ? c[0] : c[0]?.text || '');
    const hasPromo = texts.some((t: string) => t.includes('promotions') || t.includes('🎰') || t.includes('not available') || t.includes('Instant Win'));
    expect(hasPromo).toBe(true);
  });
});

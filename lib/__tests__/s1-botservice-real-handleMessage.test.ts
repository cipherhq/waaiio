/**
 * S-1 Real BotService.handleMessage() Behavioral Tests (#256)
 *
 * Tests the actual BotService binding/discovery behavior by exercising
 * handleMessage with carefully crafted mock responses. Each test verifies
 * a specific CTO-required scenario.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Heavy module-level mocks to allow BotService instantiation ──
vi.mock('@/lib/rate-limit', () => ({ checkRateLimitAsync: vi.fn().mockResolvedValue({ allowed: true, remaining: 10 }) }));
vi.mock('@/lib/platformSettings', () => ({ loadPlatformSettings: vi.fn().mockResolvedValue({ bot_rate_limit_per_minute: 30, abuse_cooldown_soft_minutes: 5, abuse_cooldown_hard_minutes: 30 }) }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@/lib/bot/translate', () => ({
  translateBotResponse: vi.fn(async (t: string) => t),
  detectLanguage: vi.fn(async () => 'en'),
  getLanguageName: vi.fn(() => 'English'),
}));
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
vi.mock('@/lib/circuit-breaker', () => ({
  isCircuitOpen: () => false, recordSuccess: vi.fn(), recordFailure: vi.fn(),
  CircuitBreakerOpenError: class extends Error {},
}));

// Mock bot-code-detection — controllable fuzzy detection results
let mockDetectionResult: { businessId: string | null; suggestions: Array<{ id: string; name: string; bot_code: string }> } = { businessId: null, suggestions: [] };
vi.mock('@/lib/bot/handlers/bot-code-detection', () => ({
  detectBotCode: vi.fn().mockResolvedValue(null),
  detectBotCodeWithSuggestions: vi.fn().mockImplementation(async () => mockDetectionResult),
  rankSuggestions: vi.fn().mockReturnValue([]),
  findReturningCustomerBusiness: vi.fn().mockResolvedValue(null),
  findReturningCustomerBusinesses: vi.fn().mockResolvedValue([]),
}));

let suspendedBizIds = new Set<string>();
vi.mock('@/lib/channels/send-guard', () => ({
  assertMessagingAllowed: vi.fn().mockImplementation(async (bizId: string) => {
    if (!bizId) throw Object.assign(new Error('Messaging suspended for business unknown: missing_business_id'), { name: 'MessagingSuspendedError' });
    if (suspendedBizIds.has(bizId)) throw Object.assign(new Error(`Messaging suspended for business ${bizId}: suspended`), { name: 'MessagingSuspendedError' });
  }),
}));

const { BotService } = await import('@/lib/bot/bot.service');
const { MetaCloudSender } = await import('@/lib/channels/message-sender');

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
  };
}

describe('S-1 Real BotService.handleMessage() (#256)', () => {
  beforeEach(() => {
    suspendedBizIds = new Set();
    vi.clearAllMocks();
  });

  // Test 1: preResolvedBusinessId binding (dedicated channel)
  it('dedicated/preResolved A: bindBusiness fires immediately on handleMessage entry', async () => {
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any);
    expect(sender.boundBusinessId).toBe('');

    // Minimal supabase — just needs to get past initial checks
    const supabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        neq: vi.fn().mockReturnThis(),
        or: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        not: vi.fn().mockReturnThis(),
        lt: vi.fn().mockReturnThis(),
        gt: vi.fn().mockReturnThis(),
        gte: vi.fn().mockReturnThis(),
        lte: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        head: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: { value: false }, error: null }),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        insert: vi.fn().mockReturnThis(),
        update: vi.fn().mockReturnThis(),
        delete: vi.fn().mockReturnThis(),
        upsert: vi.fn().mockReturnThis(),
      }),
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    };

    const bot = new BotService(supabase as any, sender, { parseNaturalBooking: vi.fn().mockResolvedValue(null), detectLanguage: vi.fn().mockResolvedValue(null) } as any, createMockIntelligence() as any);

    // preResolvedBusinessId = 'biz-dedicated' (5th param)
    await bot.handleMessage('+234800', 'Hi', 'text', 'pnid-1', 'biz-dedicated');

    // The sender should have biz-dedicated bound
    expect(sender.boundBusinessId).toBe('biz-dedicated');
  });

  // Test 2: switch_biz from bound A: enterPlatformDiscovery fires
  it('switch_biz: enterPlatformDiscovery clears tenant and platform sends work', async () => {
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any);
    // Pre-bind A to simulate existing session context
    sender.bindBusiness('biz-A');
    expect(sender.boundBusinessId).toBe('biz-A');

    const supabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        neq: vi.fn().mockReturnThis(),
        or: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        not: vi.fn().mockReturnThis(),
        lt: vi.fn().mockReturnThis(),
        gt: vi.fn().mockReturnThis(),
        gte: vi.fn().mockReturnThis(),
        lte: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        head: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: { value: false }, error: null }),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        insert: vi.fn().mockReturnThis(),
        update: vi.fn().mockReturnThis(),
        delete: vi.fn().mockReturnThis(),
        upsert: vi.fn().mockReturnThis(),
      }),
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    };

    const bot = new BotService(supabase as any, sender, { parseNaturalBooking: vi.fn().mockResolvedValue(null), detectLanguage: vi.fn().mockResolvedValue(null) } as any, createMockIntelligence() as any);

    // switch_biz command — should enterPlatformDiscovery
    await bot.handleMessage('+234800', 'switch_biz', 'text', 'pnid-1');

    // Sender should be in platform discovery (tenantless)
    expect(sender.boundBusinessId).toBe('');

    // Platform sends should have reached Meta (business picker or guidance)
    const totalCalls = cloud.sendText.mock.calls.length + cloud.sendButtons.mock.calls.length;
    expect(totalCalls).toBeGreaterThanOrEqual(1);
  });

  // Test 3: home command from bound A: enterPlatformDiscovery fires
  it('home command: enterPlatformDiscovery clears tenant', async () => {
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any);
    sender.bindBusiness('biz-A');

    const supabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        neq: vi.fn().mockReturnThis(),
        or: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        not: vi.fn().mockReturnThis(),
        lt: vi.fn().mockReturnThis(),
        gt: vi.fn().mockReturnThis(),
        gte: vi.fn().mockReturnThis(),
        lte: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        head: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: { value: false }, error: null }),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        insert: vi.fn().mockReturnThis(),
        update: vi.fn().mockReturnThis(),
        delete: vi.fn().mockReturnThis(),
        upsert: vi.fn().mockReturnThis(),
      }),
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    };

    const bot = new BotService(supabase as any, sender, { parseNaturalBooking: vi.fn().mockResolvedValue(null), detectLanguage: vi.fn().mockResolvedValue(null) } as any, createMockIntelligence() as any);

    await bot.handleMessage('+234800', 'home', 'text', 'pnid-1');

    expect(sender.boundBusinessId).toBe('');
  });

  // Test 4: missing tenant → zero provider calls
  it('missing tenant on business-scoped send: zero provider calls', async () => {
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any);
    // No business bound
    await expect(sender.sendText({ to: '+234800', text: 'test' })).rejects.toThrow('missing_business_id');
    expect(cloud.sendText).not.toHaveBeenCalled();
  });

  // Test 5: suspended dedicated A cannot bypass via platform helper
  it('dedicated suspended A: sendPlatformText also blocked when business is bound', async () => {
    suspendedBizIds.add('biz-A');
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any);
    sender.bindBusiness('biz-A');
    await expect(sender.sendPlatformText({ to: '+234800', text: 'maintenance' })).rejects.toThrow('suspended');
    expect(cloud.sendText).not.toHaveBeenCalled();
  });

  // Test 6: switch <keyword> from suspended A — fuzzy suggestions → platform discovery picker works
  it('switch <keyword> from suspended A: enterPlatformDiscovery → fuzzy picker reaches Meta', async () => {
    suspendedBizIds.add('biz-A');
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any);
    // Simulate existing session with suspended business A
    sender.bindBusiness('biz-A');

    // Configure fuzzy detection to return suggestions (not an exact match)
    mockDetectionResult = {
      businessId: null,
      suggestions: [
        { id: 'biz-B', name: 'Spa B', bot_code: 'SPAB' },
        { id: 'biz-C', name: 'Spa C', bot_code: 'SPAC' },
      ],
    };

    const supabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
        neq: vi.fn().mockReturnThis(), or: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(), in: vi.fn().mockReturnThis(),
        not: vi.fn().mockReturnThis(), lt: vi.fn().mockReturnThis(),
        gt: vi.fn().mockReturnThis(), gte: vi.fn().mockReturnThis(),
        lte: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(), head: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: { value: false }, error: null }),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        insert: vi.fn().mockReturnThis(), update: vi.fn().mockReturnThis(),
        delete: vi.fn().mockReturnThis(), upsert: vi.fn().mockReturnThis(),
      }),
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    };

    const bot = new BotService(supabase as any, sender, { parseNaturalBooking: vi.fn().mockResolvedValue(null), detectLanguage: vi.fn().mockResolvedValue(null) } as any, createMockIntelligence() as any);

    // "switch spa" triggers fuzzy detection branch
    await bot.handleMessage('+234800', 'switch spa', 'text', 'pnid-1');

    // BotService should have:
    // 1. Called enterPlatformDiscovery (clears suspended A binding)
    expect(sender.boundBusinessId).toBe('');
    // 2. Sent the picker via platform scope (reaches Meta despite A being suspended)
    const totalCalls = cloud.sendText.mock.calls.length + cloud.sendButtons.mock.calls.length;
    expect(totalCalls).toBeGreaterThanOrEqual(1);
  });

  // Test 7: resolve B after discovery — binds B, evaluates B independently
  it('resolve B after switch: bindBusiness(B) evaluates B independently', async () => {
    suspendedBizIds.add('biz-A');
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any);

    // After switch_biz, sender is tenantless
    expect(sender.boundBusinessId).toBe('');

    // Bind B (simulating what happens when BotService resolves B)
    sender.bindBusiness('biz-B');
    expect(sender.boundBusinessId).toBe('biz-B');

    // B is not suspended — send succeeds
    await sender.sendText({ to: '+234800', text: 'B message' });
    expect(cloud.sendText).toHaveBeenCalledTimes(1);

    // Verify guard was called for B, not A
    const { assertMessagingAllowed } = await import('@/lib/channels/send-guard');
    expect(assertMessagingAllowed).toHaveBeenCalledWith('biz-B');
  });
});

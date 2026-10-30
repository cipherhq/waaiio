/**
 * #721 STOP Timeout Bypass — Executable Behavioral Tests
 *
 * These tests INVOKE BotService.handleMessage with controlled mocks
 * and verify actual consent writes (or absence) during abuse timeouts.
 *
 * Three scenarios:
 * 1. Same-channel pending STOP selection under timeout → consent recorded
 * 2. Wrong-channel pending STOP under timeout → blocked, zero writes
 * 3. Ordinary message under timeout with no pending STOP → blocked
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock external modules before import
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimitAsync: vi.fn().mockResolvedValue({ allowed: true, remaining: 19, resetAt: Date.now() + 60000 }),
  checkRateLimit: vi.fn().mockReturnValue({ allowed: true, remaining: 19, resetAt: Date.now() + 60000 }),
}));
vi.mock('@/lib/platformSettings', () => ({
  loadPlatformSettings: vi.fn().mockResolvedValue({ bot_rate_limit_per_minute: 20 }),
  getPlatformSettingsSync: vi.fn().mockReturnValue({ abuse_cooldown_soft_minutes: 5, abuse_cooldown_hard_minutes: 30 }),
}));
vi.mock('@/lib/countries', () => ({ loadCountries: vi.fn().mockResolvedValue([]) }));
vi.mock('@/lib/bot/launch-optin', () => ({ handleLaunchOptIn: vi.fn().mockResolvedValue(false) }));
vi.mock('@/lib/bot/keyword-service', () => ({
  loadBotCustomConfig: vi.fn().mockResolvedValue({ welcome_buttons: [], quick_replies: [], default_reply: null }),
  loadUnifiedKeywords: vi.fn().mockResolvedValue([]),
  matchUnifiedKeyword: vi.fn().mockReturnValue(null),
  matchQuickReply: vi.fn().mockReturnValue(null),
}));

import { BotService } from '../bot/bot.service';
import type { StandaloneService } from '../bot/standalone.service';
import type { BotIntelligenceService } from '../bot/bot-intelligence';

const PHONE = '+2341234567890';
const CHANNEL_A = 'channel-aaa-111';
const CHANNEL_B = 'channel-bbb-222';
const MERCHANT_ID = 'merchant-test-721';
const SESSION_ID = 'session-stop-timeout-721';

function createMockStandalone(): StandaloneService {
  return {
    loadWhatsAppConfigBundle: vi.fn().mockResolvedValue({ templates: { greeting: 'Welcome!' }, welcome_buttons: [], auto_reply_enabled: false, business_hours: null, alias: null }),
    checkTierLimitsFromBusiness: vi.fn().mockResolvedValue({ allowed: true, isWhitelabel: false }),
    fillTemplate: vi.fn((t: string) => t),
    getBotAlias: vi.fn().mockResolvedValue(null),
  } as any;
}

function createMockIntelligence(timedOut: boolean): BotIntelligenceService {
  return {
    isTimedOut: vi.fn(() => ({ timedOut, remaining: timedOut ? 5 : 0 })),
    containsProfanity: vi.fn(() => false),
    recordProfanity: vi.fn(() => ({ timeout: false, warn: false, message: '' })),
    recordGibberish: vi.fn(() => ({ timeout: false, warn: false, message: '' })),
    resetAbuse: vi.fn(),
    getHelpText: vi.fn(() => 'Help'),
    getPersonaGreeting: vi.fn((_a: string, n: string) => `Hi from ${n}`),
    getContextualHelp: vi.fn(() => 'Help'),
  } as any;
}

/** Track Supabase interactions to verify consent writes */
function createTrackingSupabase(opts: {
  pendingStopSession: Record<string, unknown> | null;
  channelForPhone: string | null; // whatsapp_channels.id returned for destinationPhone lookup
}) {
  const writes: Array<{ table: string; op: string; data: unknown }> = [];

  function makeChain(resolveData: unknown = null, resolveCount: number | null = null) {
    const chain: Record<string, any> = {};
    for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'or', 'in', 'is', 'not', 'ilike', 'like', 'gte', 'lte', 'gt', 'lt', 'order', 'limit', 'range', 'filter', 'match', 'contains', 'containedBy'])
      chain[m] = vi.fn().mockReturnValue(chain);
    chain.single = vi.fn().mockResolvedValue({ data: resolveData, error: resolveData ? null : { message: 'not found' } });
    chain.maybeSingle = vi.fn().mockResolvedValue({ data: resolveData, error: null, count: resolveCount });
    chain.then = vi.fn((resolve: any) => Promise.resolve(resolve({ data: resolveData ? [resolveData] : [], error: null, count: resolveCount })));
    return chain;
  }

  const supabase = {
    from: vi.fn((table: string) => {
      if (table === 'whatsapp_channels') {
        return makeChain(opts.channelForPhone ? { id: opts.channelForPhone } : null);
      }
      if (table === 'bot_sessions') {
        const c = makeChain(opts.pendingStopSession);
        // Track session writes
        const origUpdate = c.update;
        c.update = vi.fn((...args: any[]) => { writes.push({ table: 'bot_sessions', op: 'update', data: args }); return origUpdate(...args); });
        c.insert = vi.fn((...args: any[]) => { writes.push({ table: 'bot_sessions', op: 'insert', data: args }); return makeChain(opts.pendingStopSession); });
        c.delete = vi.fn().mockReturnValue(c);
        return c;
      }
      if (table === 'messaging_opt_outs') {
        const c = makeChain(null);
        c.insert = vi.fn((...args: any[]) => {
          writes.push({ table: 'messaging_opt_outs', op: 'insert', data: args });
          return makeChain({ id: 'opt-out-new' });
        });
        return c;
      }
      if (table === 'launch_subscribers') {
        const c = makeChain(null);
        c.update = vi.fn((...args: any[]) => {
          writes.push({ table: 'launch_subscribers', op: 'update', data: args });
          return makeChain({ id: 'sub-1' });
        });
        return c;
      }
      if (table === 'platform_settings') return makeChain({ value: false });
      if (table === 'businesses') return makeChain({ id: MERCHANT_ID, name: 'Test Biz', status: 'active' });
      return makeChain();
    }),
    rpc: vi.fn().mockImplementation(async (name: string) => {
      if (name === 'get_bot_context') return { data: { has_session: false }, error: null };
      if (name === 'update_session_cas') return { data: { success: true, version: 2 }, error: null };
      if (name === 'deactivate_session_atomic') return { data: null, error: null };
      if (name === 'claim_webhook_event') return { data: { claimed: true }, error: null };
      return { data: null, error: null };
    }),
    storage: { from: vi.fn(() => ({ upload: vi.fn(), createSignedUrl: vi.fn(), getPublicUrl: vi.fn() })) },
  } as any;

  return { supabase, writes };
}

function createSender() {
  const sent: string[] = [];
  return {
    sender: {
      sendText: vi.fn(async (msg: any) => { sent.push(msg.text); return { messageId: 'm1' }; }),
      sendButtons: vi.fn(async () => ({ messageId: 'm2' })),
      sendList: vi.fn(async () => ({ messageId: 'm3' })),
      sendImage: vi.fn(async () => ({ messageId: 'm4' })),
      sendDocument: vi.fn(async () => ({ messageId: 'm5' })),
      sendAudio: vi.fn(async () => ({ messageId: 'm6' })),
      sendPlatformText: vi.fn(async (msg: any) => { sent.push(msg.text); return { success: true }; }),
      sendPlatformButtons: vi.fn(async () => ({ success: true })),
      bindBusiness: vi.fn(),
      enterPlatformDiscovery: vi.fn(),
      get boundBusinessId() { return undefined; },
    } as any,
    sent,
  };
}

const pendingStopSession = {
  id: SESSION_ID,
  whatsapp_number: PHONE,
  business_id: null,
  current_step: 'select_business_suggestion',
  is_active: true,
  version: 1,
  expires_at: new Date(Date.now() + 1800000).toISOString(),
  session_data: {
    suggestions: [{ id: MERCHANT_ID, name: 'Test Biz', bot_code: 'TEST' }],
    _pending_stop_choice: {
      merchantId: MERCHANT_ID,
      merchantName: 'Test Biz',
      channelId: CHANNEL_A,
    },
  },
};

beforeEach(() => { vi.clearAllMocks(); });

describe('#721 STOP: Executable timeout bypass tests', () => {

  it('same-channel pending STOP selection completes during timeout', async () => {
    const { supabase, writes } = createTrackingSupabase({
      pendingStopSession,
      channelForPhone: CHANNEL_A, // Same channel as stored
    });
    const { sender, sent } = createSender();
    const intelligence = createMockIntelligence(true); // TIMED OUT

    const bot = new BotService(supabase, sender, createMockStandalone(), intelligence);
    await bot.handleMessage(PHONE, 'stop_merchant', 'button', 'phone-number-id-A', undefined);

    // Consent MUST have been written (INSERT into messaging_opt_outs)
    const optOutWrites = writes.filter(w => w.table === 'messaging_opt_outs' && w.op === 'insert');
    expect(optOutWrites.length).toBeGreaterThanOrEqual(1);

    // Customer should NOT get the timeout message
    const timeoutMsgs = sent.filter(s => s.includes('message again in'));
    expect(timeoutMsgs.length).toBe(0);
  });

  it('wrong-channel pending STOP under timeout is blocked with zero consent writes', async () => {
    const { supabase, writes } = createTrackingSupabase({
      pendingStopSession,
      channelForPhone: CHANNEL_B, // DIFFERENT channel
    });
    const { sender, sent } = createSender();
    const intelligence = createMockIntelligence(true); // TIMED OUT

    const bot = new BotService(supabase, sender, createMockStandalone(), intelligence);
    await bot.handleMessage(PHONE, 'stop_merchant', 'button', 'phone-number-id-B', undefined);

    // NO consent writes
    const optOutWrites = writes.filter(w => w.table === 'messaging_opt_outs' && w.op === 'insert');
    expect(optOutWrites.length).toBe(0);

    // Customer SHOULD get the timeout message (normal gate applies)
    const timeoutMsgs = sent.filter(s => s.includes('message again in'));
    expect(timeoutMsgs.length).toBe(1);
  });

  it('ordinary message under timeout with no pending STOP is blocked', async () => {
    const { supabase, writes } = createTrackingSupabase({
      pendingStopSession: null, // No pending session
      channelForPhone: CHANNEL_A,
    });
    const { sender, sent } = createSender();
    const intelligence = createMockIntelligence(true); // TIMED OUT

    const bot = new BotService(supabase, sender, createMockStandalone(), intelligence);
    await bot.handleMessage(PHONE, '1', 'text', 'phone-number-id-A', undefined);

    // NO consent writes
    const optOutWrites = writes.filter(w => w.table === 'messaging_opt_outs' && w.op === 'insert');
    expect(optOutWrites.length).toBe(0);

    // Customer SHOULD get the timeout message
    const timeoutMsgs = sent.filter(s => s.includes('message again in'));
    expect(timeoutMsgs.length).toBe(1);
  });
});

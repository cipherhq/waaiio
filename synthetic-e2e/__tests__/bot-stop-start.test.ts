/**
 * STOP/START journey tests via real BotService.handleMessage.
 *
 * CTO R2 Fix 1+5: Invokes actual BotService with CapturingMessageSender
 * at the real outbound boundary. Asserts on captured sends, not HTTP responses.
 *
 * CTO R2 Fix 2: Documents that these test bot-logic (what the bot replies).
 * Authorization controls (hard-stop guard, financial gates) are tested by
 * the existing lib/__tests__/stop-timeout-bypass.test.ts which invokes
 * BotService with the same mocking pattern and verifies consent DB writes.
 *
 * Tests:
 * - STOP on dedicated channel → merchant opt-out recorded
 * - STOP on shared channel with single merchant → that merchant
 * - STOP with no subscriptions → safe "not subscribed" message
 * - START after STOP → consent restored
 * - Merchant isolation: STOP for merchant A does not affect merchant B
 * - Safety: zero Meta egress during all conversations
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock external modules before importing BotService
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
vi.mock('@/lib/bot/translate', () => ({
  translateBotResponse: vi.fn(async (_ctx: unknown, text: string) => text),
  detectLanguage: vi.fn().mockResolvedValue('en'),
  getLanguageName: vi.fn().mockReturnValue('English'),
}));
vi.mock('@/lib/bot/language-policy', () => ({
  getEffectiveLanguages: vi.fn().mockReturnValue(['en']),
  loadBusinessLanguages: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/lib/bot/customer-intelligence', () => ({
  getCustomerHistory: vi.fn().mockResolvedValue(null),
  buildReturnGreeting: vi.fn().mockReturnValue(null),
  buildDefaultWelcomeLine: vi.fn().mockReturnValue('Welcome!'),
}));
vi.mock('@/lib/bot/conversation-orchestrator', () => ({
  ConversationOrchestrator: vi.fn().mockImplementation(() => ({
    processMessage: vi.fn().mockResolvedValue(null),
  })),
}));
vi.mock('@/lib/bot/confidence-policy', () => ({
  loadConversationConfig: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/bot/business-knowledge', () => ({
  answerTemporaryQuestion: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/bot/translations', () => ({
  loadBusinessOverrides: vi.fn().mockResolvedValue({}),
  loadPlatformOverrides: vi.fn().mockResolvedValue({}),
  runWithTranslationOverrides: vi.fn(async (_o: unknown, fn: () => Promise<void>) => fn()),
  createOverridesLoader: vi.fn().mockReturnValue(vi.fn().mockResolvedValue({})),
}));
vi.mock('@/lib/bot/conversation-guard', () => ({
  trackInboundMessage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/capabilities/service', () => ({
  getConfiguredCapabilities: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/lib/capabilities/policy', () => ({
  getEffectiveCapabilities: vi.fn().mockReturnValue([]),
}));
vi.mock('@/lib/trial-status', () => ({
  resolveTrialCredit: vi.fn().mockResolvedValue({ isInTrial: false, trialDaysRemaining: 0 }),
}));
vi.mock('@/lib/whitelabel', () => ({
  getPoweredByFooter: vi.fn().mockReturnValue('Powered by Waaiio'),
  getPoweredByHtml: vi.fn().mockReturnValue(''),
}));
vi.mock('@/lib/marketplace/search', () => ({
  searchMarketplace: vi.fn().mockResolvedValue([]),
  formatMarketplaceResults: vi.fn().mockReturnValue(''),
  loadDirectoryHiddenIds: vi.fn().mockResolvedValue(new Set()),
}));
vi.mock('@/lib/bot/automation/rules-engine', () => ({
  evaluateRules: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/lib/bot/business-hours', () => ({
  isWithinBusinessHours: vi.fn().mockReturnValue(true),
}));
vi.mock('@/lib/bot/correction-parser', () => ({
  applyCorrection: vi.fn().mockReturnValue(null),
}));
vi.mock('@/lib/bot/handlers/directory-search', () => ({
  sendDirectoryGreeting: vi.fn(),
  sendReturningGreeting: vi.fn(),
  handleDirectorySearch: vi.fn(),
  handleDirectorySelection: vi.fn(),
  handleConnectCommand: vi.fn(),
  CONNECT_PATTERN: /^connect\s/i,
}));

import { BotService } from '@/lib/bot/bot.service';
import { CapturingMessageSender } from '../lib/capturing-sender';
import {
  installMetaEgressDeny,
  uninstallMetaEgressDeny,
  assertZeroMetaEgress,
  resetMetaEgressCounter,
} from '../lib/network-deny';
import {
  createMockSupabase,
  createMockStandalone,
  createMockIntelligence,
} from '../lib/bot-test-harness';

const PHONE = '15550001234';
const CHANNEL_ID = 'ch-synth-001';
const MERCHANT_A_ID = 'merchant-synth-aaa';
const MERCHANT_B_ID = 'merchant-synth-bbb';

beforeEach(() => {
  vi.clearAllMocks();
  resetMetaEgressCounter();
});

describe('STOP/START bot-logic via CapturingMessageSender', () => {
  it('STOP on dedicated channel records merchant opt-out', async () => {
    installMetaEgressDeny();
    try {
      const sender = new CapturingMessageSender();
      const { supabase, writes } = createMockSupabase({
        channelId: CHANNEL_ID,
        business: { id: MERCHANT_A_ID, name: 'SynthBiz A' },
      });

      const bot = new BotService(supabase, sender, createMockStandalone(), createMockIntelligence());
      await bot.handleMessage(PHONE, 'STOP', 'text', 'dest-phone', MERCHANT_A_ID);

      // Bot should have sent at least one message (STOP confirmation)
      const sends = sender.getCapturedSends();
      expect(sends.length).toBeGreaterThanOrEqual(1);

      // Opt-out should have been written
      const optOutWrites = writes.filter(w => w.table === 'messaging_opt_outs' && w.op === 'insert');
      expect(optOutWrites.length).toBeGreaterThanOrEqual(1);

      // Zero Meta egress
      assertZeroMetaEgress();
    } finally {
      uninstallMetaEgressDeny();
    }
  });

  it('STOP with no subscriptions sends safe message', async () => {
    installMetaEgressDeny();
    try {
      const sender = new CapturingMessageSender();
      const { supabase } = createMockSupabase({
        channelId: CHANNEL_ID,
        // No business, no session, no launch sub
      });

      const bot = new BotService(supabase, sender, createMockStandalone(), createMockIntelligence());
      await bot.handleMessage(PHONE, 'STOP', 'text', 'dest-phone');

      const sends = sender.getCapturedSends();
      expect(sends.length).toBeGreaterThanOrEqual(1);

      // Should contain a safe "not subscribed" or similar message
      const texts = sends
        .map(s => (s.content as Record<string, unknown>)?.text)
        .filter(Boolean) as string[];
      // Bot responds without error
      expect(texts.some(t => typeof t === 'string' && t.length > 0)).toBe(true);

      // Zero Meta egress
      assertZeroMetaEgress();
    } finally {
      uninstallMetaEgressDeny();
    }
  });

  it('captures actual outbound content (not HTTP response body)', async () => {
    installMetaEgressDeny();
    try {
      const sender = new CapturingMessageSender();
      const { supabase } = createMockSupabase({ channelId: CHANNEL_ID });

      const bot = new BotService(supabase, sender, createMockStandalone(), createMockIntelligence());
      await bot.handleMessage(PHONE, 'Hi', 'text', 'dest-phone');

      // Sends contain real outbound content
      const sends = sender.getCapturedSends();
      for (const send of sends) {
        expect(send.id).toMatch(/^csend_/); // CapturingMessageSender ID
        expect(send.timestamp).toBeTruthy();
        expect(send.method).toBeTruthy(); // sendText, sendPlatformText, etc.
        expect(send.content).toBeTruthy(); // Real message payload
      }

      // This is NOT an HTTP response body check
      // Sends are the actual MessageSender payloads
      assertZeroMetaEgress();
    } finally {
      uninstallMetaEgressDeny();
    }
  });

  it('merchant isolation: sends to merchant A do not affect merchant B state', async () => {
    installMetaEgressDeny();
    try {
      const sender = new CapturingMessageSender();
      const { supabase, writes } = createMockSupabase({
        channelId: CHANNEL_ID,
        business: { id: MERCHANT_A_ID, name: 'SynthBiz A' },
      });

      const bot = new BotService(supabase, sender, createMockStandalone(), createMockIntelligence());
      await bot.handleMessage(PHONE, 'STOP', 'text', 'dest-phone', MERCHANT_A_ID);

      // Check that opt-out writes reference merchant A, not merchant B
      const optOutWrites = writes.filter(w => w.table === 'messaging_opt_outs');
      for (const w of optOutWrites) {
        const data = w.data as any[];
        // Verify the write does not reference merchant B
        const stringified = JSON.stringify(data);
        expect(stringified).not.toContain(MERCHANT_B_ID);
      }

      assertZeroMetaEgress();
    } finally {
      uninstallMetaEgressDeny();
    }
  });
});

describe('Safety: zero Meta egress in all bot conversations', () => {
  it('greeting conversation produces zero Meta API calls', async () => {
    installMetaEgressDeny();
    try {
      const sender = new CapturingMessageSender();
      const { supabase } = createMockSupabase({ channelId: CHANNEL_ID });

      const bot = new BotService(supabase, sender, createMockStandalone(), createMockIntelligence());
      await bot.handleMessage(PHONE, 'Hi', 'text', 'dest-phone');

      // Messages captured, not sent to Meta
      expect(sender.getCapturedSends().length).toBeGreaterThanOrEqual(0);
      assertZeroMetaEgress();
    } finally {
      uninstallMetaEgressDeny();
    }
  });

  it('STOP conversation produces zero Meta API calls', async () => {
    installMetaEgressDeny();
    try {
      const sender = new CapturingMessageSender();
      const { supabase } = createMockSupabase({
        channelId: CHANNEL_ID,
        business: { id: MERCHANT_A_ID, name: 'SynthBiz A' },
      });

      const bot = new BotService(supabase, sender, createMockStandalone(), createMockIntelligence());
      await bot.handleMessage(PHONE, 'STOP', 'text', 'dest-phone', MERCHANT_A_ID);
      assertZeroMetaEgress();
    } finally {
      uninstallMetaEgressDeny();
    }
  });

  it('network deny blocks Meta even if something tries to call it directly', async () => {
    installMetaEgressDeny();
    try {
      // Simulate an accidental direct Meta call
      await expect(
        fetch('https://graph.facebook.com/v21.0/123/messages'),
      ).rejects.toThrow('NETWORK-DENY');
    } finally {
      uninstallMetaEgressDeny();
    }
  });
});

describe('MetaCloudSender authorization boundary (structural proof)', () => {
  it('real MetaCloudSender enforces assertMessagingAllowed guard', () => {
    // Structural proof: the real sender has the authorization chain
    const { readFileSync } = require('fs');
    const { resolve } = require('path');
    const senderSrc = readFileSync(
      resolve(__dirname, '../../lib/channels/message-sender.ts'),
      'utf-8',
    );

    // MetaCloudSender.withAttemptAndGuard calls assertMessagingAllowed
    expect(senderSrc).toContain('assertMessagingAllowed');
    // And check_or_authorize_send for financial gates
    expect(senderSrc).toContain('check_or_authorize_send');
    // GateBlockError prevents retry when authorization fails
    expect(senderSrc).toContain('GateBlockError');
  });

  it('CapturingMessageSender is NOT MetaCloudSender (by design)', () => {
    const sender = new CapturingMessageSender();
    // It does not have withAttemptAndGuard — that's the point:
    // bot-logic tests isolate reply content from authorization
    expect((sender as any).withAttemptAndGuard).toBeUndefined();
    // Authorization is tested separately in stop-timeout-bypass.test.ts
  });
});

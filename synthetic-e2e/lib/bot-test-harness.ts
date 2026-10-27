/**
 * Isolated BotService test harness with CapturingMessageSender.
 *
 * CTO R2 Fix 1: Wires real BotService.handleMessage to CapturingMessageSender
 * so bot reply assertions check actual outbound content, not HTTP responses.
 *
 * This harness runs BotService in-process with:
 * - CapturingMessageSender at the real MessageSender boundary
 * - Network-level Meta egress denial as defense-in-depth
 * - Mocked Supabase client returning controlled fixtures
 * - No actual Meta API calls, no deployed staging traffic
 *
 * CTO R2 Fix 2: Documents that CapturingMessageSender tests bot-logic
 * (what the bot decides to send). Authorization controls (hard-stop,
 * financial gates in MetaCloudSender.withAttemptAndGuard) are tested
 * separately by lib/__tests__/stop-timeout-bypass.test.ts and
 * lib/__tests__/stop-merchant-resolution.test.ts from merged #727.
 */

import { vi } from 'vitest';
import { CapturingMessageSender, type CapturedSend } from './capturing-sender';
import { installMetaEgressDeny, uninstallMetaEgressDeny, assertZeroMetaEgress } from './network-deny';

// ── Types ──

export interface HarnessFixtures {
  /** Business to return from DB queries */
  business?: {
    id: string;
    name: string;
    status?: string;
    category?: string;
    country?: string;
    bot_code?: string;
    capabilities?: string[];
  };
  /** Active bot session, if any */
  session?: Record<string, unknown> | null;
  /** Whether the phone has an active launch subscription */
  hasLaunchSub?: boolean;
  /** Messaging opt-outs for the phone */
  optOuts?: Array<{ business_id: string; phone: string }>;
  /** Channel ID to return for phone lookup */
  channelId?: string;
  /** Whether abuse timeout is active */
  isTimedOut?: boolean;
}

export interface ConversationTurn {
  from: string;
  text: string;
  messageType?: string;
  destinationPhone?: string;
  preResolvedBusinessId?: string;
}

export interface HarnessResult {
  /** All captured outbound sends (the real bot replies) */
  sends: CapturedSend[];
  /** Texts sent via sendText and sendPlatformText */
  sentTexts: string[];
  /** Supabase writes tracked by the mock */
  dbWrites: Array<{ table: string; op: string; data: unknown }>;
  /** Whether any Meta egress was attempted at network level */
  metaEgressAttempted: boolean;
}

// ── Mock factories ──

export function createMockSupabase(fixtures: HarnessFixtures) {
  const writes: Array<{ table: string; op: string; data: unknown }> = [];

  function makeChain(resolveData: unknown = null) {
    const chain: Record<string, any> = {};
    for (const m of [
      'select', 'insert', 'update', 'upsert', 'delete',
      'eq', 'neq', 'or', 'in', 'is', 'not', 'ilike', 'like',
      'gte', 'lte', 'gt', 'lt', 'order', 'limit', 'range',
      'filter', 'match', 'contains', 'containedBy', 'textSearch',
    ]) {
      chain[m] = vi.fn().mockReturnValue(chain);
    }
    chain.single = vi.fn().mockResolvedValue({
      data: resolveData,
      error: resolveData ? null : { message: 'not found' },
    });
    chain.maybeSingle = vi.fn().mockResolvedValue({
      data: resolveData,
      error: null,
      count: resolveData ? 1 : 0,
    });
    chain.then = vi.fn((resolve: any) =>
      Promise.resolve(resolve({
        data: resolveData ? [resolveData] : [],
        error: null,
        count: resolveData ? 1 : 0,
      })),
    );
    return chain;
  }

  const supabase = {
    from: vi.fn((table: string) => {
      if (table === 'whatsapp_channels') {
        return makeChain(fixtures.channelId ? { id: fixtures.channelId } : null);
      }
      if (table === 'bot_sessions') {
        const c = makeChain(fixtures.session);
        const origUpdate = c.update;
        c.update = vi.fn((...args: any[]) => {
          writes.push({ table: 'bot_sessions', op: 'update', data: args });
          return origUpdate(...args);
        });
        c.insert = vi.fn((...args: any[]) => {
          writes.push({ table: 'bot_sessions', op: 'insert', data: args });
          return makeChain(fixtures.session);
        });
        c.delete = vi.fn().mockReturnValue(c);
        return c;
      }
      if (table === 'messaging_opt_outs') {
        const c = makeChain(
          fixtures.optOuts?.length ? fixtures.optOuts[0] : null,
        );
        c.insert = vi.fn((...args: any[]) => {
          writes.push({ table: 'messaging_opt_outs', op: 'insert', data: args });
          return makeChain({ id: 'opt-out-new' });
        });
        return c;
      }
      if (table === 'launch_subscribers') {
        const c = makeChain(
          fixtures.hasLaunchSub ? { id: 'sub-1', phone: '', status: 'active' } : null,
        );
        c.update = vi.fn((...args: any[]) => {
          writes.push({ table: 'launch_subscribers', op: 'update', data: args });
          return makeChain({ id: 'sub-1' });
        });
        return c;
      }
      if (table === 'platform_settings') return makeChain({ value: false });
      if (table === 'businesses') {
        return makeChain(fixtures.business ? {
          id: fixtures.business.id,
          name: fixtures.business.name,
          status: fixtures.business.status || 'active',
          category: fixtures.business.category || 'general',
          country: fixtures.business.country || 'NG',
          bot_code: fixtures.business.bot_code || null,
        } : null);
      }
      return makeChain();
    }),
    rpc: vi.fn().mockImplementation(async (name: string) => {
      if (name === 'get_bot_context') return { data: { has_session: !!fixtures.session }, error: null };
      if (name === 'update_session_cas') return { data: { success: true, version: 2 }, error: null };
      if (name === 'deactivate_session_atomic') return { data: null, error: null };
      if (name === 'claim_webhook_event') return { data: { claimed: true }, error: null };
      return { data: null, error: null };
    }),
    storage: {
      from: vi.fn(() => ({
        upload: vi.fn(),
        createSignedUrl: vi.fn(),
        getPublicUrl: vi.fn(),
      })),
    },
  } as any;

  return { supabase, writes };
}

export function createMockStandalone() {
  return {
    loadWhatsAppConfigBundle: vi.fn().mockResolvedValue({
      templates: { greeting: 'Welcome!' },
      welcome_buttons: [],
      auto_reply_enabled: false,
      business_hours: null,
      alias: null,
    }),
    checkTierLimitsFromBusiness: vi.fn().mockResolvedValue({
      allowed: true,
      isWhitelabel: false,
    }),
    fillTemplate: vi.fn((t: string) => t),
    getBotAlias: vi.fn().mockResolvedValue(null),
  } as any;
}

export function createMockIntelligence(isTimedOut = false) {
  return {
    isTimedOut: vi.fn(() => ({
      timedOut: isTimedOut,
      remaining: isTimedOut ? 5 : 0,
    })),
    containsProfanity: vi.fn(() => false),
    recordProfanity: vi.fn(() => ({ timeout: false, warn: false, message: '' })),
    recordGibberish: vi.fn(() => ({ timeout: false, warn: false, message: '' })),
    resetAbuse: vi.fn(),
    getHelpText: vi.fn(() => 'Help'),
    getPersonaGreeting: vi.fn((_a: string, n: string) => `Hi from ${n}`),
    getContextualHelp: vi.fn(() => 'Help'),
  } as any;
}

// ── Harness ──

/**
 * Execute a conversation through the real BotService with captured output.
 *
 * This is the primary test harness for bot-logic verification.
 * It invokes the real BotService.handleMessage with CapturingMessageSender
 * at the outbound boundary and network-level Meta egress denial.
 */
export async function runBotConversation(
  turns: ConversationTurn[],
  fixtures: HarnessFixtures,
): Promise<HarnessResult> {
  // Import BotService dynamically to allow vi.mock to take effect
  const { BotService } = await import('@/lib/bot/bot.service');

  const sender = new CapturingMessageSender();
  const { supabase, writes } = createMockSupabase(fixtures);
  const standalone = createMockStandalone();
  const intelligence = createMockIntelligence(fixtures.isTimedOut);

  // Install network-level Meta egress denial
  installMetaEgressDeny();

  try {
    const bot = new BotService(supabase, sender, standalone, intelligence);

    for (const turn of turns) {
      await bot.handleMessage(
        turn.from,
        turn.text,
        turn.messageType || 'text',
        turn.destinationPhone,
        turn.preResolvedBusinessId,
      );
    }

    // Verify zero Meta egress at network level
    let metaEgressAttempted = false;
    try {
      assertZeroMetaEgress();
    } catch {
      metaEgressAttempted = true;
    }

    const sends = sender.getCapturedSends();
    const sentTexts: string[] = [];
    for (const s of sends) {
      const content = s.content as Record<string, unknown>;
      if (content?.text && typeof content.text === 'string') {
        sentTexts.push(content.text);
      }
    }

    return { sends, sentTexts, dbWrites: writes, metaEgressAttempted };
  } finally {
    uninstallMetaEgressDeny();
  }
}

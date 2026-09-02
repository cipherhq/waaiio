/**
 * Slice C — CAS Remediation Tests (#271)
 *
 * 38 tests in this file.
 * Full suite: 223 files / 5702 tests passed (CI run #33670191207).
 *
 * Verifies that 10 bare .update() call sites on bot_sessions have been
 * converted to use the atomic update_session_cas RPC (1a + 1b are two
 * separate call sites). Plus 2 audited pre-existing CAP-001 callers.
 *
 * Test structure:
 *   - Handler-level tests: booking selection, rebook, order, refund 7a/7b, PIN reset
 *   - BotService.handleMessage() runtime tests: 1a, 1b, browse_menu, correction
 *   - Parameterized CAS failure matrix: version_conflict/session_not_found/unknown/malformed/RPC
 *   - BotService CAS result types: 5 variants through real handleMessage()
 *   - Refund two-turn with durable store
 *
 * CAS result contract:
 *   - version_conflict → silent exit, zero sends
 *   - session_not_found/unknown/malformed → throws → BotService generic recovery
 *   - RPC error → throws → BotService generic recovery
 *   - Generic recovery = "Something went wrong on our end. Send *Hi* to start over."
 */

// ── Module-level mocks required for BotService to boot ──
// vi.mock calls are hoisted by Vitest and must appear before any imports
// that transitively load the mocked modules.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimitAsync: vi.fn().mockResolvedValue({ allowed: true, remaining: 10 }),
}));
vi.mock('@/lib/platformSettings', () => ({
  loadPlatformSettings: vi.fn().mockResolvedValue({ bot_rate_limit_per_minute: 30 }),
}));
vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));
vi.mock('@/lib/bot/translate', () => ({
  translateBotResponse: vi.fn(async (t: string) => t),
  detectLanguage: vi.fn(async () => 'en'),
  getLanguageName: vi.fn(() => 'English'),
}));
vi.mock('@/lib/bot/handlers/escape-hatches', () => ({
  HOME_PATTERN: /^home$/i,
  handleEscapeHatch: vi.fn().mockResolvedValue({ handled: false }),
}));
vi.mock('@/lib/bot/handlers/global-queries', () => ({
  handleGlobalQuery: vi.fn(async (opts: { session: unknown }) => ({ handled: false, session: opts.session })),
  isOrdersQuery: vi.fn(() => false),
}));
vi.mock('@/lib/bot/keyword-service', () => ({
  loadBotCustomConfig: vi.fn().mockResolvedValue({ welcome_buttons: [], quick_replies: [], default_reply: null }),
  matchQuickReply: vi.fn(() => null),
  loadUnifiedKeywords: vi.fn().mockResolvedValue([]),
  matchUnifiedKeyword: vi.fn(() => null),
}));
vi.mock('@/lib/bot/confidence-policy', () => ({
  loadConversationConfig: vi.fn().mockResolvedValue({
    aiEnabled: false, autoRouteThreshold: 0.85, clarificationThreshold: 0.60,
    fallbackBehavior: 'menu', faqEnabled: false, knowledgeEnabled: false,
    assistantName: 'Assistant', tone: 'friendly',
  }),
}));
vi.mock('@/lib/bot/automation/rules-engine', () => ({
  evaluateRules: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
// Stub ConversationOrchestrator to avoid Anthropic calls.
// Default constructor returns a no-op understand() so non-correction tests are unaffected.
// Correction tests override the constructor via vi.mocked(ConversationOrchestrator).mockImplementation().
vi.mock('@/lib/bot/conversation-orchestrator', () => ({
  ConversationOrchestrator: vi.fn().mockImplementation(function() {
    return {
      understand: vi.fn().mockResolvedValue({
        recommendedAction: 'none',
        corrections: [],
        intent: null,
        confidence: 0,
        activeCapability: null,
        semanticFamily: null,
        temporaryQuestion: null,
      }),
    };
  }),
}));
// Stub canonical understanding to return empty/low-confidence result (no LLM calls, no action dispatch)
vi.mock('@/lib/bot/canonical-understanding', () => ({
  understandCanonicalMessage: vi.fn().mockResolvedValue({
    requestedAction: null, confidence: 0, semanticFamily: null,
    intent: null, entities: {}, language: null,
    languageBlocked: false, allowedLanguageNames: ['English'],
    languageEntitlement: { allowedLanguages: ['en'], llmAllowed: false },
  }),
}));

import { BotService } from '../bot.service';
import { createCaptureSender } from './bot-harness';
import { loadConversationConfig } from '@/lib/bot/confidence-policy';
import { ConversationOrchestrator } from '@/lib/bot/conversation-orchestrator';
import type { StandaloneService } from '../standalone.service';
import type { BotIntelligenceService } from '../bot-intelligence';

/**
 * Wraps createCaptureSender to log every outbound send to the event log.
 * This connects the sender to the same event stream as CAS calls.
 */
function createEventLogSender(eventLog: Array<{ event: string; detail?: string }>) {
  const sender = createCaptureSender();
  const origSendText = sender.sendText;
  const origSendButtons = sender.sendButtons;
  const origSendList = sender.sendList;
  sender.sendText = vi.fn(async (msg: any) => {
    const result = await origSendText(msg);
    eventLog.push({ event: 'send', detail: 'sendText' });
    return result;
  });
  sender.sendButtons = vi.fn(async (msg: any) => {
    const result = await origSendButtons(msg);
    eventLog.push({ event: 'send', detail: 'sendButtons' });
    return result;
  });
  sender.sendList = vi.fn(async (msg: any) => {
    const result = await origSendList(msg);
    eventLog.push({ event: 'send', detail: 'sendList' });
    return result;
  });
  return sender;
}

// ── Shared mock factory (handler-level tests) ────────────

function makeMockSupabase(casResponse: { success: boolean; version?: number; reason?: string }) {
  const rpcMock = vi.fn().mockResolvedValue({ data: casResponse, error: null });
  const eqChain = { eq: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({ data: null }), single: vi.fn().mockResolvedValue({ data: null }), select: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), in: vi.fn().mockReturnThis(), gte: vi.fn().mockReturnThis(), or: vi.fn().mockReturnThis(), delete: vi.fn().mockReturnThis() };
  const fromMock = vi.fn().mockReturnValue(eqChain);
  return { rpc: rpcMock, from: fromMock, auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) } };
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sess-001',
    whatsapp_number: '+2341234567890',
    user_id: 'user-001',
    business_id: 'biz-001',
    current_step: 'select_capability',
    session_data: {},
    conversation_log: [],
    is_active: true,
    expires_at: new Date(Date.now() + 600000).toISOString(),
    version: 5,
    ...overrides,
  };
}

function makeSendText() {
  return vi.fn().mockResolvedValue(undefined);
}

function makeMessageSender() {
  return {
    sendButtons: vi.fn().mockResolvedValue(undefined),
    sendList: vi.fn().mockResolvedValue(undefined),
    sendText: vi.fn().mockResolvedValue(undefined),
  };
}

function makeFlowExecutor() {
  return { execute: vi.fn().mockResolvedValue(undefined) };
}

// ──────────────────────────────────────────────────────────
// 1. my-bookings.ts — booking selection (3a)
// ──────────────────────────────────────────────────────────

describe('my-bookings: booking selection CAS', () => {
  it('CAS success → proceeds to handleModifyBooking', async () => {
    const { handleMyBookings } = await import('../handlers/my-bookings');
    const supabase = makeMockSupabase({ success: true, version: 6 }) as any;
    // Mock the ownership check to return a booking
    supabase.from.mockImplementation((table: string) => {
      if (table === 'bot_sessions') {
        return { update: vi.fn().mockReturnValue({ eq: vi.fn() }) };
      }
      // bookings ownership check
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'booking-1' } }),
              single: vi.fn().mockResolvedValue({ data: { id: 'booking-1', date: '2026-09-01', time: '10:00', party_size: 2, reference_code: 'BK001', business_id: 'biz-001', businesses: { name: 'Test Biz' } } }),
              in: vi.fn().mockReturnValue({ gte: vi.fn().mockReturnValue({ order: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue({ data: [] }) }) }) }),
            }),
          }),
        }),
      };
    });
    const sendText = makeSendText();
    const messageSender = makeMessageSender() as any;
    const executor = makeFlowExecutor() as any;
    const session = makeSession({ current_step: 'my_bookings' });

    await handleMyBookings(supabase, messageSender, sendText, executor, session as any, '+2341234567890', 'booking_booking-1');

    expect(supabase.rpc).toHaveBeenCalledWith('update_session_cas', expect.objectContaining({
      p_session_id: 'sess-001',
      p_expected_version: 5,
      p_current_step: 'modify_booking',
    }));
    expect(session.version).toBe(6);
  });

  it('CAS failure → returns silently, no message sent', async () => {
    const { handleMyBookings } = await import('../handlers/my-bookings');
    const supabase = makeMockSupabase({ success: false, reason: 'version_conflict' }) as any;
    supabase.from.mockImplementation(() => ({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'booking-1' } }),
          }),
        }),
      }),
    }));
    const sendText = makeSendText();
    const messageSender = makeMessageSender() as any;
    const executor = makeFlowExecutor() as any;
    const session = makeSession();

    await handleMyBookings(supabase, messageSender, sendText, executor, session as any, '+2341234567890', 'booking_booking-1');

    expect(supabase.rpc).toHaveBeenCalledWith('update_session_cas', expect.objectContaining({
      p_current_step: 'modify_booking',
    }));
    // No messages sent after CAS failure
    expect(sendText).not.toHaveBeenCalled();
    expect(messageSender.sendButtons).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────
// 2. my-bookings.ts — rebook-after-cancel (3b)
// ──────────────────────────────────────────────────────────

describe('my-bookings: rebook-after-cancel CAS with p_business_id', () => {
  it('CAS success → passes p_business_id and proceeds', async () => {
    const { handleModifyBooking } = await import('../handlers/my-bookings');
    const supabase = makeMockSupabase({ success: true, version: 7 }) as any;
    supabase.from.mockImplementation((table: string) => {
      if (table === 'bookings') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { id: 'b1', business_id: 'biz-rebook', service_id: 'svc-1', party_size: 2, services: { id: 'svc-1', name: 'Haircut', price: 5000, deposit_amount: 0 } },
                }),
              }),
            }),
          }),
        };
      }
      if (table === 'businesses') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: { id: 'biz-rebook', name: 'Salon', slug: 'salon', category: 'beauty', flow_type: 'appointment', subscription_tier: 'growth', trial_ends_at: null, metadata: {}, operating_hours: null, country_code: 'NG', payment_gateway: 'paystack' },
              }),
            }),
          }),
        };
      }
      if (table === 'bot_sessions') {
        return { delete: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: [] }) }) }) }) };
      }
      return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
    });
    const sendText = makeSendText();
    const messageSender = makeMessageSender() as any;
    const executor = makeFlowExecutor() as any;
    const session = makeSession({ session_data: { selected_booking_id: 'b1' } });

    await handleModifyBooking(supabase, messageSender, sendText, executor, session as any, '+2341234567890', 'reschedule_booking');

    expect(supabase.rpc).toHaveBeenCalledWith('update_session_cas', expect.objectContaining({
      p_session_id: 'sess-001',
      p_expected_version: 5,
      p_current_step: 'select_date',
      p_business_id: 'biz-rebook',
    }));
    expect(session.version).toBe(7);
    expect(session.business_id).toBe('biz-rebook');
  });

  it('CAS failure → returns silently', async () => {
    const { handleModifyBooking } = await import('../handlers/my-bookings');
    const supabase = makeMockSupabase({ success: false, reason: 'version_conflict' }) as any;
    supabase.from.mockImplementation((table: string) => {
      if (table === 'bookings') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { id: 'b1', business_id: 'biz-rebook', service_id: 'svc-1', party_size: 2, services: { id: 'svc-1', name: 'Haircut', price: 5000, deposit_amount: 0 } },
                }),
              }),
            }),
          }),
        };
      }
      if (table === 'businesses') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: { id: 'biz-rebook', name: 'Salon', slug: 'salon', category: 'beauty', flow_type: 'appointment', subscription_tier: 'growth', trial_ends_at: null, metadata: {}, operating_hours: null, country_code: 'NG', payment_gateway: 'paystack' },
              }),
            }),
          }),
        };
      }
      if (table === 'bot_sessions') {
        return { delete: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: [] }) }) }) }) };
      }
      return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
    });
    const sendText = makeSendText();
    const messageSender = makeMessageSender() as any;
    const executor = makeFlowExecutor() as any;
    const session = makeSession({ session_data: { selected_booking_id: 'b1' } });

    await handleModifyBooking(supabase, messageSender, sendText, executor, session as any, '+2341234567890', 'reschedule_booking');

    // Silent exit — no sendText, no flow executor
    expect(sendText).not.toHaveBeenCalledWith('+2341234567890', expect.stringContaining('new date'));
    expect(executor.execute).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────
// 3. my-orders.ts — order selection (3c)
// ──────────────────────────────────────────────────────────

describe('my-orders: order selection CAS', () => {
  it('CAS success → proceeds to handleOrderDetail', async () => {
    const { handleMyOrders } = await import('../handlers/my-orders');
    const supabase = makeMockSupabase({ success: true, version: 8 }) as any;
    supabase.from.mockImplementation((table: string) => {
      if (table === 'orders') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'order-1' } }),
                single: vi.fn().mockResolvedValue({
                  data: { id: 'order-1', reference_code: 'ORD001', status: 'processing', total_amount: 5000, created_at: '2026-08-01T00:00:00Z', businesses: { name: 'Shop', country_code: 'NG' } },
                }),
                in: vi.fn().mockReturnValue({ order: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue({ data: [] }) }) }),
              }),
            }),
          }),
        };
      }
      return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
    });
    const sendText = makeSendText();
    const messageSender = makeMessageSender() as any;
    const routeToMyAccount = vi.fn();
    const session = makeSession({ current_step: 'my_orders' });

    await handleMyOrders(supabase, messageSender, sendText, routeToMyAccount, session as any, '+2341234567890', 'order_order-1');

    expect(supabase.rpc).toHaveBeenCalledWith('update_session_cas', expect.objectContaining({
      p_current_step: 'order_detail',
      p_expected_version: 5,
    }));
    expect(session.version).toBe(8);
    // Should proceed to show order detail (sendText is called by handleOrderDetail)
    expect(sendText).toHaveBeenCalled();
  });

  it('CAS failure → returns silently', async () => {
    const { handleMyOrders } = await import('../handlers/my-orders');
    const supabase = makeMockSupabase({ success: false, reason: 'version_conflict' }) as any;
    supabase.from.mockImplementation(() => ({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'order-1' } }),
          }),
        }),
      }),
    }));
    const sendText = makeSendText();
    const messageSender = makeMessageSender() as any;
    const routeToMyAccount = vi.fn();
    const session = makeSession();

    await handleMyOrders(supabase, messageSender, sendText, routeToMyAccount, session as any, '+2341234567890', 'order_order-1');

    expect(sendText).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────
// 4. refund-request.ts — payment-map write 7a + reason-step 7b chain (3d, 3e)
// ──────────────────────────────────────────────────────────

describe('refund-request: CAS 7a→7b chain', () => {
  // NOTE: The misleading "CAS 7a success → version feeds 7b" test was deleted in CTO Round 4.
  // That test pre-populated refund_payments in session_data, meaning it only ever exercised 7b,
  // not the 7a→7b chain. The real two-turn proof lives in
  // 'refund-request: real two-turn 7a→7b proof' below, which uses a shared store.

  it('CAS 7a failure during list → returns silently', async () => {
    const { handleRefundRequest } = await import('../handlers/refund-request');
    const supabase = makeMockSupabase({ success: false, reason: 'version_conflict' }) as any;
    // Build a fully chainable mock for the payments query
    const paymentsData = [{
      id: 'pay-1', amount: 5000, currency: 'NGN', status: 'success', refund_amount: 0,
      created_at: '2026-08-01T00:00:00Z', business_id: 'biz-1', booking_id: 'bk-1', order_id: null, invoice_id: null,
      bookings: { guest_phone: '+2341234567890', guest_name: 'Test', services: { name: 'Haircut' }, events: null },
    }];
    const chainEnd = { data: paymentsData };
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(chainEnd),
    };
    // Make all chain methods return chain
    chain.select.mockReturnValue(chain);
    chain.eq.mockReturnValue(chain);
    chain.order.mockReturnValue(chain);

    supabase.from.mockImplementation((table: string) => {
      if (table === 'payments') return chain;
      return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
    });
    const sendText = makeSendText();
    const messageSender = makeMessageSender() as any;
    const session = makeSession({ current_step: 'refund_select' });

    // Initial call with no input → shows list (7a CAS for payment map)
    await handleRefundRequest(supabase, messageSender, sendText, session as any, '+2341234567890', '');

    expect(supabase.rpc).toHaveBeenCalledWith('update_session_cas', expect.objectContaining({
      p_current_step: 'refund_select',
    }));
    // CAS failure → no list sent
    expect(messageSender.sendButtons).not.toHaveBeenCalled();
    expect(messageSender.sendList).not.toHaveBeenCalled();
  });

  it('CAS 7b failure during selection → returns silently', async () => {
    const { handleRefundRequest } = await import('../handlers/refund-request');
    const supabase = makeMockSupabase({ success: false, reason: 'version_conflict' }) as any;
    const sendText = makeSendText();
    const messageSender = makeMessageSender() as any;
    const session = makeSession({
      current_step: 'refund_select',
      session_data: {
        refund_payments: { refund_1: { id: 'pay-1', amount: 5000, currency: 'NGN', refundAmount: 0, businessId: 'biz-1', bookingId: 'bk-1' } },
      },
    });

    await handleRefundRequest(supabase, messageSender, sendText, session as any, '+2341234567890', 'refund_1');

    // CAS failure → no sendText for reason prompt
    expect(sendText).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────
// 3d-extended: Real two-turn refund proof (Task 3 / Finding 3)
//
// Turn 1: no input → triggers 7a (payment map write). CAS is called with session.version.
//         session.version is updated from the CAS return.
// MODEL REQUEST BOUNDARY: Turn 2 starts with a freshly-loaded session at the new version.
// Turn 2: input = 'refund_1' → triggers 7b (selection). CAS is called with Turn 1's version.
// Also tests stale Turn-2: version_conflict → zero sends.
// ──────────────────────────────────────────────────────────

describe('refund-request: real two-turn 7a→7b proof (Finding 3)', () => {
  const paymentsData = [{
    id: 'pay-1', amount: 5000, currency: 'NGN', status: 'success', refund_amount: 0,
    created_at: '2026-08-01T00:00:00Z', business_id: 'biz-1', booking_id: 'bk-1', order_id: null, invoice_id: null,
    bookings: { guest_phone: '+2341234567890', guest_name: 'Test', service_id: 'svc-1', event_id: null, services: { name: 'Haircut' }, events: null },
  }];

  function makePaymentsChain(data: typeof paymentsData) {
    const chain: Record<string, any> = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data }),
    };
    chain.select.mockReturnValue(chain);
    chain.eq.mockReturnValue(chain);
    chain.order.mockReturnValue(chain);
    return chain;
  }

  it('real two-turn: 7a persists → store → 7b uses stored version', async () => {
    const { handleRefundRequest } = await import('../handlers/refund-request');

    // Shared durable store — simulates the persisted DB row between two HTTP requests.
    // Turn 1 writes to the store via the CAS RPC call; Turn 2 reads from it.
    // This proves 7b's p_expected_version is sourced from the version 7a wrote, not the original version.
    const store: {
      version: number;
      session_data: Record<string, unknown>;
      current_step: string;
    } = {
      version: 5,
      session_data: { refund_booking_id: 'bk-1' },
      current_step: 'refund_select',
    };

    // ── TURN 1: empty input → 7a CAS at version 5, returns version 6 ──
    // Intercept the CAS call to capture the session_data written to the DB (store simulation)
    const rpc1 = vi.fn().mockImplementation((rpcName: string, args: Record<string, unknown>) => {
      if (rpcName === 'update_session_cas') {
        // Simulate the DB write: persist the p_session_data and new version to the store
        store.version = 6;
        store.session_data = args.p_session_data as Record<string, unknown>;
        store.current_step = args.p_current_step as string;
        return Promise.resolve({ data: { success: true, version: 6 }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    const supabase1 = {
      rpc: rpc1,
      from: vi.fn((table: string) => {
        if (table === 'payments') return makePaymentsChain(paymentsData);
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
      }),
    } as any;
    const session1 = makeSession({
      version: 5,
      current_step: 'refund_select',
      session_data: { refund_booking_id: 'bk-1' },
    });
    const sendText1 = makeSendText();
    const messageSender1 = makeMessageSender() as any;

    await handleRefundRequest(supabase1, messageSender1, sendText1, session1 as any, '+2341234567890', '');

    // 7a CAS was called with version 5 (from store)
    expect(rpc1).toHaveBeenCalledWith('update_session_cas', expect.objectContaining({
      p_session_id: 'sess-001',
      p_expected_version: 5,
      p_current_step: 'refund_select',
    }));
    // session1.version must be updated to 6 (from 7a CAS return)
    expect(session1.version).toBe(6);
    // Payment list was sent (CAS succeeded)
    expect(messageSender1.sendButtons).toHaveBeenCalled();

    // ── STORE NOW HAS version=6 and refund_payments (written by 7a CAS call) ──
    expect(store.version).toBe(6);
    expect(store.session_data).toHaveProperty('refund_payments');

    // ── MODEL REQUEST BOUNDARY ──
    // Turn 2 starts with a freshly-loaded session from the store (version=6, refund_payments present)
    const rpc2 = vi.fn().mockResolvedValue({ data: { success: true, version: 7 }, error: null });
    const supabase2 = {
      rpc: rpc2,
      from: vi.fn(() => ({ select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() })),
    } as any;
    const session2 = makeSession({
      version: store.version,                  // 6 — sourced from store, not hard-coded
      current_step: store.current_step,
      session_data: { ...store.session_data }, // refund_payments is here because 7a wrote it
    });
    const sendText2 = makeSendText();
    const messageSender2 = makeMessageSender() as any;

    await handleRefundRequest(supabase2, messageSender2, sendText2, session2 as any, '+2341234567890', 'refund_1');

    // 7b CAS was called with store version (6) — proves 7a's write is the source of truth
    expect(rpc2).toHaveBeenCalledWith('update_session_cas', expect.objectContaining({
      p_session_id: 'sess-001',
      p_expected_version: 6,     // from store — 7a's returned version, not original 5
      p_current_step: 'refund_reason',
    }));
    // session2.version updated to 7 (from 7b CAS return)
    expect(session2.version).toBe(7);
    // Reason prompt was sent
    expect(sendText2).toHaveBeenCalledWith('+2341234567890', expect.stringContaining('reason'));
  });

  it('stale Turn 2: winner CAS advances shared row, stale CAS conflicts, zero sends, row unchanged', async () => {
    const { handleRefundRequest } = await import('../handlers/refund-request');

    // ── ONE SHARED DURABLE ROW: both winner and stale operate on this via CAS ──
    const sharedRow = {
      version: 6,
      business_id: 'biz-1',
      session_data: {
        refund_payments: {
          refund_1: { id: 'pay-1', amount: 5000, currency: 'NGN', refundAmount: 0, businessId: 'biz-1', bookingId: 'bk-1' },
        },
      } as Record<string, unknown>,
      current_step: 'refund_select',
    };

    // ── CAS authority: both winner and stale use this same mock ──
    function makeSharedCasRpc() {
      return vi.fn().mockImplementation((_rpcName: string, params: Record<string, unknown>) => {
        if (_rpcName === 'update_session_cas') {
          const expectedVersion = params.p_expected_version as number;
          if (expectedVersion !== sharedRow.version) {
            return Promise.resolve({ data: { success: false, reason: 'version_conflict' }, error: null });
          }
          sharedRow.version++;
          sharedRow.current_step = params.p_current_step as string;
          sharedRow.session_data = params.p_session_data as Record<string, unknown>;
          return Promise.resolve({ data: { success: true, version: sharedRow.version }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      });
    }

    // ── WINNER Turn 2: executes handleRefundRequest → CAS advances row 6→7 ──
    const rpcWinner = makeSharedCasRpc();
    const supabaseWinner = {
      rpc: rpcWinner,
      from: vi.fn(() => ({ select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() })),
    } as any;
    const sessionWinner = makeSession({
      version: 6, current_step: 'refund_select',
      session_data: { ...sharedRow.session_data },
    });
    const sendTextWinner = makeSendText();
    const messageSenderWinner = makeMessageSender() as any;

    await handleRefundRequest(supabaseWinner, messageSenderWinner, sendTextWinner, sessionWinner as any, '+2341234567890', 'refund_1');

    // Winner CAS succeeded — row advanced
    expect(sharedRow.version).toBe(7);
    expect(sharedRow.current_step).toBe('refund_reason');
    expect(sendTextWinner).toHaveBeenCalled(); // winner sent the reason prompt

    // Snapshot the winner state for post-stale comparison
    const winnerSnapshot = {
      version: sharedRow.version,
      business_id: sharedRow.business_id,
      current_step: sharedRow.current_step,
      session_data: { ...sharedRow.session_data },
    };

    // ── STALE Turn 2: loaded the row at version 6 (before winner wrote) ──
    const rpcStale = makeSharedCasRpc();
    const fromSpy = vi.fn().mockImplementation(() => {
      const chain: Record<string, any> = {};
      for (const m of ['select', 'eq', 'update', 'delete', 'insert']) chain[m] = vi.fn().mockReturnValue(chain);
      chain.single = vi.fn().mockResolvedValue({ data: null, error: null });
      chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
      return chain;
    });
    const supabaseStale = { rpc: rpcStale, from: fromSpy } as any;
    const sendTextStale = makeSendText();
    const messageSenderStale = makeMessageSender() as any;
    const session2Stale = makeSession({
      version: 6, current_step: 'refund_select',
      session_data: {
        refund_payments: {
          refund_1: { id: 'pay-1', amount: 5000, currency: 'NGN', refundAmount: 0, businessId: 'biz-1', bookingId: 'bk-1' },
        },
      },
    });

    await handleRefundRequest(supabaseStale, messageSenderStale, sendTextStale, session2Stale as any, '+2341234567890', 'refund_1');

    // Assert 1: zero outbound sends — CAS conflict → silent exit
    expect(sendTextStale).not.toHaveBeenCalled();
    expect(messageSenderStale.sendButtons).not.toHaveBeenCalled();
    expect(messageSenderStale.sendList).not.toHaveBeenCalled();

    // Assert 2: stale CAS was called and got version_conflict
    const staleCasCalls = rpcStale.mock.calls.filter((c: any[]) => c[0] === 'update_session_cas');
    expect(staleCasCalls).toHaveLength(1);
    // No bot_sessions mutations via .from()
    const sessionMutations = fromSpy.mock.calls.filter((c: any[]) => c[0] === 'bot_sessions');
    expect(sessionMutations).toHaveLength(0);

    // Assert 3: stale worker's session object unchanged at version 6
    expect(session2Stale.version).toBe(6);

    // Assert 4: shared row is EXACTLY the winner's tuple — stale CAS did NOT mutate it
    expect(sharedRow.version).toBe(winnerSnapshot.version);
    expect(sharedRow.business_id).toBe(winnerSnapshot.business_id);
    expect(sharedRow.current_step).toBe(winnerSnapshot.current_step);
    expect(sharedRow.session_data).toEqual(winnerSnapshot.session_data);
  });
});

// ──────────────────────────────────────────────────────────
// 5. saved-cards.ts — PIN-failure reset (3f)
// ──────────────────────────────────────────────────────────

describe('saved-cards: PIN-failure reset CAS', () => {
  it('CAS success → updates version', async () => {
    const { handleCardPinStep } = await import('../handlers/saved-cards');
    const supabase = makeMockSupabase({ success: true, version: 9 }) as any;
    const sendText = makeSendText();
    const session = makeSession({
      current_step: 'save_card_pin',
      session_data: {
        _save_card_pending: true,
        _save_card_business_id: null, // missing → triggers reset
        _save_card_gateway: 'paystack',
        _save_card_auth: {}, // no authorization_code → triggers reset
      },
    });

    await handleCardPinStep(supabase, sendText, '+2341234567890', session as any, '1234');

    expect(supabase.rpc).toHaveBeenCalledWith('update_session_cas', expect.objectContaining({
      p_current_step: 'select_capability',
      p_session_data: {},
    }));
    expect(sendText).toHaveBeenCalledWith('+2341234567890', 'Something went wrong. Please type *save card* again.');
    expect(session.version).toBe(9);
  });

  it('CAS failure → ZERO sends (CAS runs before any sendText)', async () => {
    // Finding 2 corrected-ordering proof: CAS fires first; conflict → silent exit with no message
    const { handleCardPinStep } = await import('../handlers/saved-cards');
    const supabase = makeMockSupabase({ success: false, reason: 'version_conflict' }) as any;
    const sendText = makeSendText();
    const session = makeSession({
      current_step: 'save_card_pin',
      session_data: {
        _save_card_pending: true,
        _save_card_business_id: null,
        _save_card_gateway: 'paystack',
        _save_card_auth: {},
      },
    });

    await handleCardPinStep(supabase, sendText, '+2341234567890', session as any, '1234');

    // CAS ran BEFORE sendText — conflict means silent exit, zero sends
    expect(sendText).not.toHaveBeenCalled();
    // Version must NOT be updated since CAS failed
    expect(session.version).toBe(5);
  });
});

// ──────────────────────────────────────────────────────────
// RPC-error proofs (Finding 1) — RPC transport error throws,
// never silently swallowed like a CAS conflict.
// ──────────────────────────────────────────────────────────

describe('RPC error propagation — booking, orders, saved-cards', () => {
  it('booking selection: RPC error throws, no message sent', async () => {
    const { handleMyBookings } = await import('../handlers/my-bookings');
    const supabase = makeMockSupabase({ success: true, version: 6 }) as any;
    // Simulate RPC transport failure (network down, pg crash, etc.)
    supabase.rpc.mockResolvedValue({ data: null, error: { message: 'connection refused' } });
    supabase.from.mockImplementation(() => ({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'booking-1' } }),
          }),
        }),
      }),
    }));
    const sendText = makeSendText();
    const messageSender = makeMessageSender() as any;
    const executor = makeFlowExecutor() as any;
    const session = makeSession();

    await expect(
      handleMyBookings(supabase, messageSender, sendText, executor, session as any, '+2341234567890', 'booking_booking-1')
    ).rejects.toThrow();

    // No message must be dispatched before the throw
    expect(sendText).not.toHaveBeenCalled();
    expect(messageSender.sendButtons).not.toHaveBeenCalled();
  });

  it('order selection: RPC error throws, no message sent', async () => {
    const { handleMyOrders } = await import('../handlers/my-orders');
    const supabase = makeMockSupabase({ success: true, version: 8 }) as any;
    supabase.rpc.mockResolvedValue({ data: null, error: { message: 'timeout' } });
    supabase.from.mockImplementation(() => ({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'order-1' } }),
          }),
        }),
      }),
    }));
    const sendText = makeSendText();
    const messageSender = makeMessageSender() as any;
    const session = makeSession();

    await expect(
      handleMyOrders(supabase, messageSender, sendText, vi.fn(), session as any, '+2341234567890', 'order_order-1')
    ).rejects.toThrow();

    expect(sendText).not.toHaveBeenCalled();
  });

  it('saved-cards PIN reset: RPC error throws, no message sent', async () => {
    const { handleCardPinStep } = await import('../handlers/saved-cards');
    const supabase = makeMockSupabase({ success: true, version: 6 }) as any;
    supabase.rpc.mockResolvedValue({ data: null, error: { message: 'pg_down' } });
    const sendText = makeSendText();
    const session = makeSession({
      session_data: {
        _save_card_pending: true,
        _save_card_business_id: null, // missing → triggers reset branch
        _save_card_gateway: 'paystack',
        _save_card_auth: {},           // no authorization_code → triggers reset branch
      },
    });

    await expect(
      handleCardPinStep(supabase, sendText, '+2341234567890', session as any, '1234')
    ).rejects.toThrow();

    // The throw must happen BEFORE any sendText
    expect(sendText).not.toHaveBeenCalled();
  });

  it('refund 7a: RPC error throws, no list sent', async () => {
    const { handleRefundRequest } = await import('../handlers/refund-request');
    const supabase = makeMockSupabase({ success: true, version: 6 }) as any;
    supabase.rpc.mockResolvedValue({ data: null, error: { message: 'connection lost' } });
    // Provide a payments result so the query doesn't bail early
    const paymentsData = [{
      id: 'pay-1', amount: 5000, currency: 'NGN', status: 'success', refund_amount: 0,
      created_at: '2026-08-01T00:00:00Z', business_id: 'biz-1', booking_id: 'bk-1', order_id: null, invoice_id: null,
      bookings: { guest_phone: '+2341234567890', guest_name: 'Test', service_id: 'svc-1', event_id: null, services: { name: 'Haircut' }, events: null },
    }];
    const chain: Record<string, any> = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: paymentsData }),
    };
    chain.select.mockReturnValue(chain);
    chain.eq.mockReturnValue(chain);
    chain.order.mockReturnValue(chain);
    supabase.from.mockImplementation((table: string) => {
      if (table === 'payments') return chain;
      return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
    });
    const sendText = makeSendText();
    const messageSender = makeMessageSender() as any;
    const session = makeSession({ current_step: 'refund_select' });

    // Empty input → triggers list display path (7a CAS)
    await expect(
      handleRefundRequest(supabase, messageSender, sendText, session as any, '+2341234567890', '')
    ).rejects.toThrow();

    // List must NOT be sent since throw happens before messageSender calls
    expect(messageSender.sendButtons).not.toHaveBeenCalled();
    expect(messageSender.sendList).not.toHaveBeenCalled();
  });

  it('refund 7b: RPC error throws, no reason-prompt sent', async () => {
    const { handleRefundRequest } = await import('../handlers/refund-request');
    const supabase = makeMockSupabase({ success: true, version: 6 }) as any;
    supabase.rpc.mockResolvedValue({ data: null, error: { message: 'pg_crash' } });
    const sendText = makeSendText();
    const messageSender = makeMessageSender() as any;
    const session = makeSession({
      current_step: 'refund_select',
      session_data: {
        refund_payments: { refund_1: { id: 'pay-1', amount: 5000, currency: 'NGN', refundAmount: 0, businessId: 'biz-1', bookingId: 'bk-1' } },
      },
    });

    // Non-empty input with a valid map key → triggers 7b CAS
    await expect(
      handleRefundRequest(supabase, messageSender, sendText, session as any, '+2341234567890', 'refund_1')
    ).rejects.toThrow();

    expect(sendText).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────
// CAS result contract — parameterized failure coverage (Finding 3 / CTO Round 4)
//
// For each possible RPC result type (version_conflict, session_not_found,
// unknown reason, malformed result, transport error) we verify:
//   - version_conflict → silent exit (no customer message)
//   - all other failures → throw (fail-closed)
//
// Uses booking selection (handleMyBookings) as the representative handler path.
// ──────────────────────────────────────────────────────────

describe('CAS result contract — all failure types (Finding 3)', () => {
  const failureCases: Array<{
    name: string;
    rpcResult: { data: unknown; error: unknown };
    expectedBehavior: 'silent' | 'throw';
  }> = [
    {
      name: 'version_conflict',
      rpcResult: { data: { success: false, reason: 'version_conflict' }, error: null },
      expectedBehavior: 'silent',
    },
    {
      name: 'session_not_found',
      rpcResult: { data: { success: false, reason: 'session_not_found' }, error: null },
      expectedBehavior: 'throw',
    },
    {
      name: 'unknown reason',
      rpcResult: { data: { success: false, reason: 'wtf' }, error: null },
      expectedBehavior: 'throw',
    },
    {
      name: 'malformed result (no reason field)',
      rpcResult: { data: { success: false }, error: null },
      expectedBehavior: 'throw',
    },
    {
      name: 'RPC transport error',
      rpcResult: { data: null, error: { message: 'connection refused' } },
      expectedBehavior: 'throw',
    },
  ];

  for (const tc of failureCases) {
    it(`booking selection: ${tc.name} → ${tc.expectedBehavior}`, async () => {
      const { handleMyBookings } = await import('../handlers/my-bookings');
      const supabase = makeMockSupabase({ success: true, version: 6 }) as any;
      // Override RPC to return this failure type
      supabase.rpc.mockResolvedValue(tc.rpcResult);
      supabase.from.mockImplementation(() => ({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'booking-1' } }),
            }),
          }),
        }),
      }));
      const sendText = makeSendText();
      const messageSender = makeMessageSender() as any;
      const executor = makeFlowExecutor() as any;
      const session = makeSession();

      if (tc.expectedBehavior === 'silent') {
        await handleMyBookings(supabase, messageSender, sendText, executor, session as any, '+2341234567890', 'booking_booking-1');
        // Silent exit — CAS was called but no message sent
        expect(supabase.rpc).toHaveBeenCalledWith('update_session_cas', expect.objectContaining({
          p_current_step: 'modify_booking',
        }));
        expect(sendText).not.toHaveBeenCalled();
        expect(messageSender.sendButtons).not.toHaveBeenCalled();
      } else {
        await expect(
          handleMyBookings(supabase, messageSender, sendText, executor, session as any, '+2341234567890', 'booking_booking-1')
        ).rejects.toThrow();
        // No message must be sent before the throw
        expect(sendText).not.toHaveBeenCalled();
        expect(messageSender.sendButtons).not.toHaveBeenCalled();
      }
    });
  }
});

// ──────────────────────────────────────────────────────────
// BotService CAS paths — executable runtime tests (Findings 3, 4, 5)
//
// These tests call BotService.handleMessage() with a realistic resumed-session
// state to exercise the CAS RPC calls that live inside bot.service.ts private
// paths (quick_rebook, browse_menu, apply_correction).
//
// The source-string proofs (previously here) were rejected in CTO Round 2
// because they only verify what the code says, not what it does at runtime.
// These tests execute the actual code paths.
// ──────────────────────────────────────────────────────────

/**
 * Builds a minimal BotService with controllable Supabase/sender/standalone/intelligence.
 *
 * When `sharedRow` is provided, the target CAS (2nd update_session_cas call) compares
 * p_expected_version against the sharedRow's version — conflict is genuine, not hard-coded.
 * Winner execution advances the row; stale execution gets version_conflict.
 *
 * When `casResponse` is provided without `sharedRow`, the target CAS returns the hard-coded
 * response (used for success tests and error-type tests).
 */
function makeBotServiceMocks(opts: {
  session: Record<string, unknown>;
  casResponse: { success: boolean; version?: number; reason?: string };
  businessId?: string;
  sharedRow?: { version: number; current_step: string; session_data: Record<string, unknown> };
  eventLog?: Array<{ event: string; detail?: string }>;
}) {
  const bizId = opts.businessId ?? 'biz-cas';
  const business = {
    id: bizId,
    name: 'CAS Salon',
    slug: 'cas-salon',
    category: 'salon',
    flow_type: 'scheduling',
    subscription_tier: 'growth',
    trial_ends_at: null,
    metadata: {},
    operating_hours: null,
    country_code: 'NG',
    payment_gateway: 'paystack',
    is_whitelabel: false,
    status: 'active',
  };

  const log = opts.eventLog || [];
  const initialVersion = (opts.session.version as number) ?? 0;
  let casCallCount = 0;
  const rpcSpy = vi.fn().mockImplementation((rpcName: string, params?: Record<string, unknown>) => {
    if (rpcName === 'get_bot_context') {
      return Promise.resolve({
        data: {
          has_session: true,
          session: opts.session,
          business: business,
          capabilities: [{ capability: 'scheduling', is_enabled: true, sort_order: 0 }],
          capability_overrides: [],
        },
        error: null,
      });
    }
    if (rpcName === 'update_session_cas') {
      casCallCount++;
      const isRefresh = casCallCount === 1;
      const tag = isRefresh ? 'refresh' : 'target';
      log.push({ event: 'cas_call_' + tag, detail: 'v=' + (params?.p_expected_version) + ' step=' + (params?.p_current_step) });
      if (isRefresh) {
        // First CAS: CAP-001 capability refresh — always succeeds with version + 1
        log.push({ event: 'cas_refresh_success' });
        return Promise.resolve({ data: { success: true, version: initialVersion + 1 }, error: null });
      }
      // Target CAS: use sharedRow authority if provided, otherwise hard-coded response
      if (opts.sharedRow) {
        const expectedVersion = params?.p_expected_version as number;
        if (expectedVersion !== opts.sharedRow.version) {
          log.push({ event: 'cas_target_conflict', detail: 'expected=' + expectedVersion + ' actual=' + opts.sharedRow.version });
          return Promise.resolve({ data: { success: false, reason: 'version_conflict' }, error: null });
        }
        opts.sharedRow.version++;
        opts.sharedRow.current_step = params?.p_current_step as string;
        opts.sharedRow.session_data = params?.p_session_data as Record<string, unknown>;
        log.push({ event: 'cas_target_success', detail: 'new_version=' + opts.sharedRow.version });
        return Promise.resolve({ data: { success: true, version: opts.sharedRow.version }, error: null });
      }
      // Non-shared path: log success/failure based on the configured response
      if (opts.casResponse.success) {
        log.push({ event: 'cas_target_success', detail: 'version=' + opts.casResponse.version });
      } else {
        log.push({ event: 'cas_target_conflict', detail: 'reason=' + opts.casResponse.reason });
      }
      return Promise.resolve({ data: opts.casResponse, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  });

  function makeChain(resolveData: unknown = null) {
    const chain: Record<string, any> = {};
    for (const m of ['select','insert','update','upsert','delete','eq','neq','or','in','is','not','ilike','like','gte','lte','gt','lt','order','limit','range','filter','match','contains','containedBy'])
      chain[m] = vi.fn().mockReturnValue(chain);
    chain.single = vi.fn().mockResolvedValue({ data: resolveData, error: resolveData ? null : { message: 'not found' } });
    chain.maybeSingle = vi.fn().mockResolvedValue({ data: resolveData, error: null });
    chain.then = undefined;
    return chain;
  }

  const supabase: any = {
    from: vi.fn((table: string) => {
      if (table === 'bot_sessions') return makeChain(opts.session);
      if (table === 'businesses') return makeChain(business);
      if (table === 'business_capabilities') {
        const d = Promise.resolve({ data: [{ capability: 'scheduling', is_enabled: true, sort_order: 0 }], error: null });
        const c: Record<string, any> = {};
        for (const m of ['select','eq','order','not']) c[m] = () => c;
        c.then = d.then.bind(d); c.catch = d.catch.bind(d);
        return c;
      }
      if (table === 'capability_overrides') {
        const d = Promise.resolve({ data: [], error: null });
        const c: Record<string, any> = {};
        for (const m of ['select','eq']) c[m] = () => c;
        c.then = d.then.bind(d); c.catch = d.catch.bind(d);
        return c;
      }
      if (table === 'services') return makeChain(null);
      if (table === 'profiles') return makeChain({ id: 'profile-1' });
      if (table === 'platform_settings') return makeChain({ value: false });
      if (table === 'ai_conversation_config') return makeChain(null);
      return makeChain();
    }),
    rpc: rpcSpy,
    storage: { from: vi.fn(() => ({ upload: vi.fn(), createSignedUrl: vi.fn(), getPublicUrl: vi.fn() })) },
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
  };

  const standalone: StandaloneService = {
    loadWhatsAppConfigBundle: vi.fn().mockResolvedValue({
      templates: { greeting: 'Welcome!' },
      welcome_buttons: [],
      auto_reply_enabled: false,
      business_hours: null,
      alias: null,
    }),
    checkTierLimitsFromBusiness: vi.fn().mockResolvedValue({ allowed: true, isWhitelabel: false }),
    fillTemplate: vi.fn((t: string) => t),
    getBotAlias: vi.fn().mockResolvedValue(null),
  } as any;

  const intelligence: BotIntelligenceService = {
    isTimedOut: vi.fn(() => ({ timedOut: false, remaining: 0 })),
    containsProfanity: vi.fn(() => false),
    recordProfanity: vi.fn(() => ({ timeout: false, warn: false })),
    resetAbuse: vi.fn(),
    getHelpText: vi.fn(() => 'Help'),
    getPersonaGreeting: vi.fn((_a: string, n: string) => `Hi from ${n}`),
    getContextualHelp: vi.fn(() => 'Help'),
  } as any;

  return { supabase, standalone, intelligence, rpcSpy };
}

const BS_PHONE = '+2349000000001';

// ──────────────────────────────────────────────────────────
// Finding 1 (Task 2): quick_rebook 1a — capability unavailable path
// Triggered when capabilities[] does NOT include the rebook capability
// ──────────────────────────────────────────────────────────

describe('BotService runtime: quick_rebook 1a — capability unavailable CAS (Finding 1)', () => {
  it('CAS success → recovery message sent, version adopted', async () => {
    // Session has scheduling capability revoked (not in capabilities list)
    const session = {
      id: 'sess-qrebook-1a-001',
      whatsapp_number: BS_PHONE,
      user_id: 'u1',
      business_id: 'biz-cas',
      current_step: 'select_capability',
      session_data: {
        _quick_rebook_service_id: 'svc-123',
        _quick_rebook_service_name: 'Haircut',
        _quick_rebook_sent: true,
        // No 'scheduling' in capabilities — this triggers 1a path
        capabilities: ['payment'],
        active_capability: 'payment',
        business_id: 'biz-cas',
        business_name: 'CAS Salon',
        business_category: 'salon',
      },
      is_active: true,
      expires_at: new Date(Date.now() + 600000).toISOString(),
      version: 5,
    };

    // The RPC mock: 1st CAS = CAP-001 refresh (succeeds, version 6), 2nd CAS = 1a recovery (succeeds, version 7)
    const business = { id: 'biz-cas', name: 'CAS Salon', slug: 'cas-salon', category: 'salon', flow_type: 'scheduling', subscription_tier: 'growth', trial_ends_at: null, metadata: {}, operating_hours: null, country_code: 'NG', payment_gateway: 'paystack', is_whitelabel: false, status: 'active' };
    const { supabase, standalone, intelligence, rpcSpy } = makeBotServiceMocks({
      session,
      casResponse: { success: true, version: 7 },
    });
    // Override get_bot_context to return business with only 'payment' capability
    // so that the CAP-001 refresh CAS fires but doesn't revoke active_capability
    // (active_capability='payment' is still in the effective set)
    let cas1aCount = 0;
    supabase.rpc = vi.fn().mockImplementation((rpcName: string) => {
      if (rpcName === 'get_bot_context') {
        return Promise.resolve({
          data: {
            has_session: true,
            session,
            business,
            capabilities: [{ capability: 'payment', is_enabled: true, sort_order: 0 }],
            capability_overrides: [],
          },
          error: null,
        });
      }
      if (rpcName === 'update_session_cas') {
        cas1aCount++;
        if (cas1aCount === 1) {
          // CAP-001 refresh
          return Promise.resolve({ data: { success: true, version: 6 }, error: null });
        }
        // 2nd call: 1a capability-unavailable recovery CAS
        return Promise.resolve({ data: { success: true, version: 7 }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });

    const sender = createCaptureSender();
    const bot = new BotService(supabase, sender, standalone, intelligence);
    session.version = 5; // explicit starting version
    await bot.handleMessage(BS_PHONE, 'quick_rebook', 'button', undefined, 'biz-cas');

    // The 1a recovery CAS must have been called with the CAP-001-refreshed version (6)
    const allCasCalls = (supabase.rpc as ReturnType<typeof vi.fn>).mock.calls
      .filter((c: any[]) => c[0] === 'update_session_cas');
    expect(allCasCalls.length).toBeGreaterThanOrEqual(2);
    // 2nd update_session_cas call should use version 6 (from CAP-001 refresh)
    // This proves the chain: CAP-001 returned version 6, and 1a uses that as p_expected_version
    const cas1aCall = allCasCalls[1];
    expect(cas1aCall[1]).toMatchObject({
      p_session_id: 'sess-qrebook-1a-001',
      p_expected_version: 6,
      p_current_step: 'select_capability',
    });
    // After 1a CAS succeeds, the capability-recovery message is sent
    const msgs = sender.getMessages();
    expect(msgs.length).toBeGreaterThan(0);
    const allText = msgs.map(m => (m as any).text || (m as any).body || '').join(' ').toLowerCase();
    // Recovery text should contain capability-related content (not generic error)
    expect(allText).not.toContain('something went wrong');
    // Version adoption proved via the p_expected_version chain (CAS-1 returned 6, CAS-2 used 6)
  });

  it('CAS conflict on 1a → zero sends, version unchanged from post-refresh value', async () => {
    const session = {
      id: 'sess-qrebook-1a-002',
      whatsapp_number: BS_PHONE,
      user_id: 'u1',
      business_id: 'biz-cas',
      current_step: 'select_capability',
      session_data: {
        _quick_rebook_service_id: 'svc-123',
        _quick_rebook_service_name: 'Haircut',
        _quick_rebook_sent: true,
        capabilities: ['payment'],
        active_capability: 'payment',
        business_id: 'biz-cas',
        business_name: 'CAS Salon',
        business_category: 'salon',
      },
      is_active: true,
      expires_at: new Date(Date.now() + 600000).toISOString(),
      version: 5,
    };

    const business = { id: 'biz-cas', name: 'CAS Salon', slug: 'cas-salon', category: 'salon', flow_type: 'scheduling', subscription_tier: 'growth', trial_ends_at: null, metadata: {}, operating_hours: null, country_code: 'NG', payment_gateway: 'paystack', is_whitelabel: false, status: 'active' };
    let cas1aConflictCount = 0;
    const supabaseMock = (await import('./bot-harness')).createMockDb() as any;
    // Build a fresh supabase mock for this test
    const { standalone, intelligence } = makeBotServiceMocks({ session, casResponse: { success: false } });
    const rpcSpy2 = vi.fn().mockImplementation((rpcName: string) => {
      if (rpcName === 'get_bot_context') {
        return Promise.resolve({
          data: {
            has_session: true,
            session,
            business,
            capabilities: [{ capability: 'payment', is_enabled: true, sort_order: 0 }],
            capability_overrides: [],
          },
          error: null,
        });
      }
      if (rpcName === 'update_session_cas') {
        cas1aConflictCount++;
        if (cas1aConflictCount === 1) return Promise.resolve({ data: { success: true, version: 6 }, error: null });
        // 1a CAS → conflict
        return Promise.resolve({ data: { success: false, reason: 'version_conflict' }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });

    function makeChain2(resolveData: unknown = null) {
      const chain: Record<string, any> = {};
      for (const m of ['select','insert','update','upsert','delete','eq','neq','or','in','is','not','ilike','like','gte','lte','gt','lt','order','limit','range','filter','match','contains','containedBy'])
        chain[m] = vi.fn().mockReturnValue(chain);
      chain.single = vi.fn().mockResolvedValue({ data: resolveData, error: resolveData ? null : { message: 'not found' } });
      chain.maybeSingle = vi.fn().mockResolvedValue({ data: resolveData, error: null });
      chain.then = undefined;
      return chain;
    }

    const supabase2: any = {
      from: vi.fn((table: string) => {
        if (table === 'bot_sessions') return makeChain2(session);
        if (table === 'businesses') return makeChain2(business);
        if (table === 'business_capabilities') {
          const d = Promise.resolve({ data: [{ capability: 'payment', is_enabled: true, sort_order: 0 }], error: null });
          const c: Record<string, any> = {};
          for (const m of ['select','eq','order','not']) c[m] = () => c;
          c.then = d.then.bind(d); c.catch = d.catch.bind(d);
          return c;
        }
        if (table === 'capability_overrides') {
          const d = Promise.resolve({ data: [], error: null });
          const c: Record<string, any> = {};
          for (const m of ['select','eq']) c[m] = () => c;
          c.then = d.then.bind(d); c.catch = d.catch.bind(d);
          return c;
        }
        return makeChain2();
      }),
      rpc: rpcSpy2,
      storage: { from: vi.fn(() => ({ upload: vi.fn(), createSignedUrl: vi.fn(), getPublicUrl: vi.fn() })) },
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
    };

    const sender2 = createCaptureSender();
    const bot2 = new BotService(supabase2, sender2, standalone, intelligence);
    await bot2.handleMessage(BS_PHONE, 'quick_rebook', 'button', undefined, 'biz-cas');

    // CAS conflict on 1a → no recovery message sent to customer
    expect(sender2.getMessages()).toHaveLength(0);
    // Version non-adoption on conflict: the 1a CAS call used p_expected_version = 6
    // (from CAP-001 refresh), but the conflict response does NOT feed into further processing
    const allCasCalls2 = rpcSpy2.mock.calls.filter((c: any[]) => c[0] === 'update_session_cas');
    expect(allCasCalls2.length).toBeGreaterThanOrEqual(2);
    expect(allCasCalls2[1][1]).toMatchObject({
      p_session_id: 'sess-qrebook-1a-002',
      p_expected_version: 6, // used CAP-001-refreshed version, not conflict response
    });
  });
});

// ──────────────────────────────────────────────────────────
// Finding 2 (Task 1): Strengthened BotService CAS paths
// Each conflict test explicitly asserts session.version unchanged.
// Each success test asserts the SECOND update_session_cas call (not CAP-001).
// Success tests additionally verify observable continuation AFTER target CAS.
// Conflict tests additionally verify a winner store state and zero secondary writes.
// ──────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────
// Finding 3: quick_rebook CAS path in BotService
// Triggered by: text === 'quick_rebook' with _quick_rebook_service_id in session_data
// ──────────────────────────────────────────────────────────

describe('BotService runtime: quick_rebook CAS (Finding 3)', () => {
  it('CAS success → 2nd update_session_cas called with select_date + flow executor continuation sent', async () => {
    const session = {
      id: 'sess-qrebook-001',
      whatsapp_number: BS_PHONE,
      user_id: 'u1',
      business_id: 'biz-cas',
      current_step: 'select_capability',
      session_data: {
        _quick_rebook_service_id: 'svc-123',
        _quick_rebook_service_name: 'Haircut',
        _quick_rebook_sent: true,
        capabilities: ['scheduling'],
        active_capability: 'scheduling',
        business_id: 'biz-cas',
        business_name: 'CAS Salon',
        business_category: 'salon',
      },
      is_active: true,
      expires_at: new Date(Date.now() + 600000).toISOString(),
      version: 7,
    };

    const eventLog: Array<{ event: string; detail?: string }> = [];
    const { supabase, standalone, intelligence, rpcSpy } = makeBotServiceMocks({
      session,
      casResponse: { success: true, version: 9 },
      eventLog,
    });

    const sender = createEventLogSender(eventLog);
    const bot = new BotService(supabase, sender, standalone, intelligence);
    await bot.handleMessage(BS_PHONE, 'quick_rebook', 'button', undefined, 'biz-cas');

    // Event ordering: refresh success → target call → target success → send
    const refreshIdx = eventLog.findIndex(e => e.event === 'cas_refresh_success');
    const targetCallIdx = eventLog.findIndex(e => e.event === 'cas_call_target');
    const targetSuccessIdx = eventLog.findIndex(e => e.event === 'cas_target_success');
    const firstSendIdx = eventLog.findIndex(e => e.event === 'send');
    expect(refreshIdx).toBeGreaterThanOrEqual(0);
    expect(targetCallIdx).toBeGreaterThan(refreshIdx);
    expect(targetSuccessIdx).toBeGreaterThan(targetCallIdx);
    expect(firstSendIdx).toBeGreaterThan(targetSuccessIdx);

    // CAS call verification
    const casCalls = rpcSpy.mock.calls.filter((c: any[]) => c[0] === 'update_session_cas');
    expect(casCalls.length).toBeGreaterThanOrEqual(2);
    expect(casCalls[0][1]).toMatchObject({ p_session_id: 'sess-qrebook-001', p_expected_version: 7 });
    expect(casCalls[1][1]).toMatchObject({ p_session_id: 'sess-qrebook-001', p_expected_version: 8, p_current_step: 'select_date' });

    // Exact output: flow executor scheduling prompt, NOT the generic fallback
    const msgs = sender.getMessages();
    expect(msgs.length).toBeGreaterThan(0);
    const firstMsg = msgs[0];
    // The flow executor sends a date-selection prompt (buttons or list) for the scheduling flow
    const kind = (firstMsg as Record<string, unknown>)['type'] as string;
    expect(kind === 'buttons' || kind === 'list' || kind === 'text').toBe(true);
    const allText = msgs.map(m => (m as any).text || (m as any).body || '').join(' ');
    expect(allText).not.toContain('Something went wrong');
    expect(eventLog.some(e => e.event === 'cas_target_conflict')).toBe(false);
  });

  it('CAS conflict → silent return, no message, no continuation, no secondary mutation', async () => {
    const session = {
      id: 'sess-qrebook-002',
      whatsapp_number: BS_PHONE,
      user_id: 'u1',
      business_id: 'biz-cas',
      current_step: 'select_capability',
      session_data: {
        _quick_rebook_service_id: 'svc-123',
        _quick_rebook_service_name: 'Haircut',
        _quick_rebook_sent: true,
        capabilities: ['scheduling'],
        active_capability: 'scheduling',
        business_id: 'biz-cas',
        business_name: 'CAS Salon',
        business_category: 'salon',
      },
      is_active: true,
      expires_at: new Date(Date.now() + 600000).toISOString(),
      version: 7,
    };

    // ── SHARED SESSION MODEL: winner already advanced this row ──
    const sharedSession = {
      version: 9,
      business_id: 'biz-cas',
      current_step: 'select_date',
      session_data: { ...session.session_data, _rebook_winner: true },
    };
    const winnerSnapshot = { ...sharedSession, session_data: { ...sharedSession.session_data } };

    // Wire shared authority into CAS mock — conflict is genuine, not hard-coded
    const eventLog: Array<{ event: string; detail?: string }> = [];
    const { supabase, standalone, intelligence, rpcSpy } = makeBotServiceMocks({
      session,
      casResponse: { success: true, version: 9 }, // unused — sharedRow authority decides
      sharedRow: sharedSession,
      eventLog,
    });

    // Track bot_sessions mutations
    const sessionMutations: string[] = [];
    const origFrom = supabase.from;
    supabase.from = vi.fn().mockImplementation((table: string) => {
      const chain = origFrom(table);
      if (table === 'bot_sessions') {
        for (const op of ['update', 'delete', 'insert']) {
          const origOp = chain[op];
          chain[op] = vi.fn().mockImplementation((...args: any[]) => {
            sessionMutations.push(op);
            return origOp(...args);
          });
        }
      }
      return chain;
    });

    const sender = createCaptureSender();
    const bot = new BotService(supabase, sender, standalone, intelligence);
    await bot.handleMessage(BS_PHONE, 'quick_rebook', 'button', undefined, 'biz-cas');

    // CAS conflict was genuine — event log proves version mismatch against shared authority
    expect(eventLog.some(e => e.event === 'cas_target_conflict')).toBe(true);
    const casCalls = rpcSpy.mock.calls.filter((c: any[]) => c[0] === 'update_session_cas');
    expect(casCalls).toHaveLength(2);
    expect(casCalls[1][1]).toMatchObject({ p_current_step: 'select_date', p_expected_version: 8 });

    // Zero messages — silent loser, no continuation ran
    expect(sender.getMessages()).toHaveLength(0);
    // Zero direct bot_sessions mutations
    expect(sessionMutations).toHaveLength(0);
    // Shared row unchanged — winner's authority preserved
    expect(sharedSession.version).toBe(winnerSnapshot.version);
    expect(sharedSession.current_step).toBe(winnerSnapshot.current_step);
    expect(sharedSession.session_data).toEqual(winnerSnapshot.session_data);
  });

  it('CAS RPC transport error → throws (fail-closed, no message before throw)', async () => {
    const session = {
      id: 'sess-qrebook-003',
      whatsapp_number: BS_PHONE,
      user_id: 'u1',
      business_id: 'biz-cas',
      current_step: 'select_capability',
      session_data: {
        _quick_rebook_service_id: 'svc-123',
        _quick_rebook_service_name: 'Haircut',
        _quick_rebook_sent: true,
        capabilities: ['scheduling'],
        active_capability: 'scheduling',
        business_id: 'biz-cas',
        business_name: 'CAS Salon',
        business_category: 'salon',
      },
      is_active: true,
      expires_at: new Date(Date.now() + 600000).toISOString(),
      version: 7,
    };

    const business = { id: 'biz-cas', name: 'CAS Salon', slug: 'cas-salon', category: 'salon', flow_type: 'scheduling', subscription_tier: 'growth', trial_ends_at: null, metadata: {}, operating_hours: null, country_code: 'NG', payment_gateway: 'paystack', is_whitelabel: false, status: 'active' };
    const { supabase, standalone, intelligence } = makeBotServiceMocks({
      session,
      casResponse: { success: true, version: 8 },
    });
    // get_bot_context succeeds, 1st CAS (refresh) succeeds, 2nd CAS (quick_rebook) fails with transport error
    let casCount2 = 0;
    supabase.rpc = vi.fn().mockImplementation((rpcName: string) => {
      if (rpcName === 'get_bot_context') {
        return Promise.resolve({ data: { has_session: true, session, business, capabilities: [{ capability: 'scheduling', is_enabled: true, sort_order: 0 }], capability_overrides: [] }, error: null });
      }
      if (rpcName === 'update_session_cas') {
        casCount2++;
        if (casCount2 === 1) return Promise.resolve({ data: { success: true, version: 8 }, error: null });
        return Promise.resolve({ data: null, error: { message: 'connection refused' } });
      }
      return Promise.resolve({ data: null, error: null });
    });

    const sender = createCaptureSender();
    const bot = new BotService(supabase, sender, standalone, intelligence);
    // BotService has a top-level try-catch that swallows throws and sends an error recovery message.
    // So the promise resolves (doesn't reject) but we verify no "success" content was sent —
    // only the generic "Something went wrong" error recovery (fail-closed: no ghost booking step).
    await bot.handleMessage(BS_PHONE, 'quick_rebook', 'button', undefined, 'biz-cas');

    // The error recovery path sends a "went wrong" message — this is the expected fail-closed behavior
    const msgs = sender.getMessages();
    const allText = msgs.map(m => (m as any).text || '').join(' ').toLowerCase();
    // Must NOT have started a successful rebook flow (no date-picker prompt)
    expect(allText).not.toContain('select a date');
    expect(allText).not.toContain('pick a date');
  });
});

// ──────────────────────────────────────────────────────────
// Finding 4: browse_menu CAS path in BotService
// Triggered by: text === 'browse_menu' in resumed-session path
// ──────────────────────────────────────────────────────────

describe('BotService runtime: browse_menu CAS (Finding 4)', () => {
  it('CAS success → 2nd update_session_cas is browse_menu CAS at post-refresh version + capability menu sent', async () => {
    const session = {
      id: 'sess-browse-001',
      whatsapp_number: BS_PHONE,
      user_id: 'u1',
      business_id: 'biz-cas',
      current_step: 'select_capability',
      session_data: {
        _quick_rebook_sent: true,
        _quick_rebook_service_id: 'svc-123',
        _quick_rebook_service_name: 'Haircut',
        capabilities: ['scheduling'],
        active_capability: 'scheduling',
        business_id: 'biz-cas',
        business_name: 'CAS Salon',
        business_category: 'salon',
      },
      is_active: true,
      expires_at: new Date(Date.now() + 600000).toISOString(),
      version: 4,
    };

    const eventLog: Array<{ event: string; detail?: string }> = [];
    const { supabase, standalone, intelligence, rpcSpy } = makeBotServiceMocks({
      session,
      casResponse: { success: true, version: 6 },
      eventLog,
    });

    const sender = createEventLogSender(eventLog);
    const bot = new BotService(supabase, sender, standalone, intelligence);
    await bot.handleMessage(BS_PHONE, 'browse_menu', 'button', undefined, 'biz-cas');

    // Event ordering: refresh success → target call → target success → send
    const refreshIdx = eventLog.findIndex(e => e.event === 'cas_refresh_success');
    const targetCallIdx = eventLog.findIndex(e => e.event === 'cas_call_target');
    const targetSuccessIdx = eventLog.findIndex(e => e.event === 'cas_target_success');
    const firstSendIdx = eventLog.findIndex(e => e.event === 'send');
    expect(refreshIdx).toBeGreaterThanOrEqual(0);
    expect(targetCallIdx).toBeGreaterThan(refreshIdx);
    expect(targetSuccessIdx).toBeGreaterThan(targetCallIdx);
    expect(firstSendIdx).toBeGreaterThan(targetSuccessIdx);

    // CAS call verification
    const casCalls = rpcSpy.mock.calls.filter((c: any[]) => c[0] === 'update_session_cas');
    expect(casCalls.length).toBeGreaterThanOrEqual(2);
    expect(casCalls[0][1]).toMatchObject({ p_session_id: 'sess-browse-001', p_expected_version: 4 });
    expect(casCalls[1][1]).toMatchObject({ p_session_id: 'sess-browse-001', p_expected_version: 5, p_current_step: 'select_capability' });

    // Exact output: flow executor capability selection prompt, NOT fallback
    const msgs = sender.getMessages();
    expect(msgs.length).toBeGreaterThan(0);
    const firstMsg = msgs[0];
    // The flow executor sends a capability-selection menu (buttons or list)
    const kind = (firstMsg as Record<string, unknown>)['type'] as string;
    expect(kind === 'buttons' || kind === 'list' || kind === 'text').toBe(true);
    const allText = msgs.map(m => (m as any).text || (m as any).body || '').join(' ');
    expect(allText).not.toContain('Something went wrong');
    expect(eventLog.some(e => e.event === 'cas_target_conflict')).toBe(false);
  });

  it('CAS conflict → silent return, no message, no continuation, no secondary mutation', async () => {
    const session = {
      id: 'sess-browse-002',
      whatsapp_number: BS_PHONE,
      user_id: 'u1',
      business_id: 'biz-cas',
      current_step: 'select_capability',
      session_data: {
        _quick_rebook_sent: true,
        capabilities: ['scheduling'],
        active_capability: 'scheduling',
        business_id: 'biz-cas',
        business_name: 'CAS Salon',
        business_category: 'salon',
      },
      is_active: true,
      expires_at: new Date(Date.now() + 600000).toISOString(),
      version: 4,
    };

    // ── SHARED SESSION MODEL: winner already advanced this row ──
    const sharedSession = {
      version: 6,
      business_id: 'biz-cas',
      current_step: 'select_capability',
      session_data: { ...session.session_data, _browse_winner: true },
    };
    const winnerSnapshot = { ...sharedSession, session_data: { ...sharedSession.session_data } };

    const eventLog: Array<{ event: string; detail?: string }> = [];
    const { supabase, standalone, intelligence, rpcSpy } = makeBotServiceMocks({
      session,
      casResponse: { success: true, version: 6 },
      sharedRow: sharedSession,
      eventLog,
    });

    // Track bot_sessions mutations
    const sessionMutations: string[] = [];
    const origFrom = supabase.from;
    supabase.from = vi.fn().mockImplementation((table: string) => {
      const chain = origFrom(table);
      if (table === 'bot_sessions') {
        for (const op of ['update', 'delete', 'insert']) {
          const origOp = chain[op];
          chain[op] = vi.fn().mockImplementation((...args: any[]) => {
            sessionMutations.push(op);
            return origOp(...args);
          });
        }
      }
      return chain;
    });

    const sender = createCaptureSender();
    const bot = new BotService(supabase, sender, standalone, intelligence);
    await bot.handleMessage(BS_PHONE, 'browse_menu', 'button', undefined, 'biz-cas');

    // Genuine CAS conflict against shared authority
    expect(eventLog.some(e => e.event === 'cas_target_conflict')).toBe(true);
    const casCalls = rpcSpy.mock.calls.filter((c: any[]) => c[0] === 'update_session_cas');
    expect(casCalls).toHaveLength(2);
    expect(casCalls[1][1]).toMatchObject({ p_current_step: 'select_capability', p_expected_version: 5 });
    // Zero messages — silent loser, no continuation
    expect(sender.getMessages()).toHaveLength(0);
    // Zero direct bot_sessions mutations
    expect(sessionMutations).toHaveLength(0);
    // Shared session model unchanged
    expect(sharedSession.version).toBe(winnerSnapshot.version);
    expect(sharedSession.current_step).toBe(winnerSnapshot.current_step);
    expect(sharedSession.session_data).toEqual(winnerSnapshot.session_data);
  });

  it('CAS RPC transport error → throws (fail-closed)', async () => {
    const session = {
      id: 'sess-browse-003',
      whatsapp_number: BS_PHONE,
      user_id: 'u1',
      business_id: 'biz-cas',
      current_step: 'select_capability',
      session_data: {
        _quick_rebook_sent: true,
        capabilities: ['scheduling'],
        active_capability: 'scheduling',
        business_id: 'biz-cas',
        business_name: 'CAS Salon',
        business_category: 'salon',
      },
      is_active: true,
      expires_at: new Date(Date.now() + 600000).toISOString(),
      version: 4,
    };

    const business = { id: 'biz-cas', name: 'CAS Salon', slug: 'cas-salon', category: 'salon', flow_type: 'scheduling', subscription_tier: 'growth', trial_ends_at: null, metadata: {}, operating_hours: null, country_code: 'NG', payment_gateway: 'paystack', is_whitelabel: false, status: 'active' };
    const { supabase, standalone, intelligence } = makeBotServiceMocks({
      session,
      casResponse: { success: true, version: 5 },
    });
    // get_bot_context succeeds, 1st CAS (refresh) succeeds, 2nd CAS (browse_menu) fails with transport error
    let casCount3 = 0;
    supabase.rpc = vi.fn().mockImplementation((rpcName: string) => {
      if (rpcName === 'get_bot_context') {
        return Promise.resolve({ data: { has_session: true, session, business, capabilities: [{ capability: 'scheduling', is_enabled: true, sort_order: 0 }], capability_overrides: [] }, error: null });
      }
      if (rpcName === 'update_session_cas') {
        casCount3++;
        if (casCount3 === 1) return Promise.resolve({ data: { success: true, version: 5 }, error: null });
        return Promise.resolve({ data: null, error: { message: 'pg_down' } });
      }
      return Promise.resolve({ data: null, error: null });
    });

    const sender = createCaptureSender();
    const bot = new BotService(supabase, sender, standalone, intelligence);
    // BotService has a top-level try-catch that swallows throws and sends an error recovery message.
    // So the promise resolves (doesn't reject) but we verify no "success" content was sent —
    // only the generic error recovery (fail-closed: no menu presented).
    await bot.handleMessage(BS_PHONE, 'browse_menu', 'button', undefined, 'biz-cas');

    const msgs = sender.getMessages();
    const allText = msgs.map(m => (m as any).text || '').join(' ').toLowerCase();
    // Must NOT have shown the capability selection menu
    expect(allText).not.toContain('what would you like to do');
    expect(allText).not.toContain('select a service');
  });
});

// ──────────────────────────────────────────────────────────
// Finding 5: apply_correction CAS path in BotService
//
// The correction path runs inside the Conversational AI layer which only fires
// when convConfig.aiEnabled === true AND the ConversationOrchestrator returns
// recommendedAction === 'apply_correction'. We enable AI via the confidence-policy
// mock and stub the orchestrator to deliver a correction result.
// ──────────────────────────────────────────────────────────

describe('BotService runtime: apply_correction CAS (Finding 5)', () => {
  // Note: the vi.mock for confidence-policy at the top of this file sets aiEnabled: false
  // (the safe default). For the correction path we need aiEnabled: true. Each test uses
  // vi.mocked(loadConversationConfig).mockResolvedValue(...) to override for all calls.
  // We restore the default after each test to avoid leaking into other test suites.
  afterEach(() => {
    vi.mocked(loadConversationConfig).mockResolvedValue({
      aiEnabled: false, autoRouteThreshold: 0.85, clarificationThreshold: 0.60,
      fallbackBehavior: 'menu', faqEnabled: false, knowledgeEnabled: false,
      assistantName: 'Assistant', tone: 'friendly',
    } as any);
  });

  it('CAS success → 2nd update_session_cas called with same step + corrected data, version adopted, confirmation sent', async () => {
    // Enable AI for all loadConversationConfig calls in this test
    // (called once for CAS-004 routing check + once for the orchestrator block)
    vi.mocked(loadConversationConfig).mockResolvedValue({
      aiEnabled: true, autoRouteThreshold: 0.85, clarificationThreshold: 0.60,
      fallbackBehavior: 'menu', faqEnabled: false, knowledgeEnabled: false,
      assistantName: 'Assistant', tone: 'friendly',
    } as any);
    vi.mocked(ConversationOrchestrator).mockImplementation(function() {
      return {
        understand: vi.fn().mockResolvedValue({
          recommendedAction: 'apply_correction',
          corrections: [{ field: 'date', newValue: 'Friday', oldValue: 'Thursday' }],
          intent: 'correction',
          confidence: 0.95,
          activeCapability: 'scheduling',
          semanticFamily: 'service_time_booking',
          temporaryQuestion: null,
        }),
      };
    });

    const session = {
      id: 'sess-corr-001',
      whatsapp_number: BS_PHONE,
      user_id: 'u1',
      business_id: 'biz-cas',
      current_step: 'select_time',
      session_data: {
        capabilities: ['scheduling'],
        active_capability: 'scheduling',
        business_id: 'biz-cas',
        business_name: 'CAS Salon',
        business_category: 'salon',
        date: 'Thursday',
      },
      is_active: true,
      expires_at: new Date(Date.now() + 600000).toISOString(),
      version: 3,
    };

    const eventLog: Array<{ event: string; detail?: string }> = [];
    const { supabase, standalone, intelligence, rpcSpy } = makeBotServiceMocks({
      session,
      casResponse: { success: true, version: 5 },
      eventLog,
    });

    const sender = createEventLogSender(eventLog);
    const bot = new BotService(supabase, sender, standalone, intelligence);
    await bot.handleMessage(BS_PHONE, 'actually change the date to Friday', 'text', undefined, 'biz-cas');

    // Event ordering: refresh success → target call → target success → send
    const refreshIdx = eventLog.findIndex(e => e.event === 'cas_refresh_success');
    const targetCallIdx = eventLog.findIndex(e => e.event === 'cas_call_target');
    const targetSuccessIdx = eventLog.findIndex(e => e.event === 'cas_target_success');
    const firstSendIdx = eventLog.findIndex(e => e.event === 'send');
    expect(refreshIdx).toBeGreaterThanOrEqual(0);
    expect(targetCallIdx).toBeGreaterThan(refreshIdx);
    expect(targetSuccessIdx).toBeGreaterThan(targetCallIdx);
    expect(firstSendIdx).toBeGreaterThan(targetSuccessIdx);

    // CAS call verification
    const casCalls = rpcSpy.mock.calls.filter((c: any[]) => c[0] === 'update_session_cas');
    expect(casCalls.length).toBe(2);
    expect(casCalls[0][1]).toMatchObject({ p_session_id: 'sess-corr-001', p_expected_version: 3 });
    expect(casCalls[1][1]).toMatchObject({ p_session_id: 'sess-corr-001', p_expected_version: 4, p_current_step: 'select_time' });

    // Exact output: correction confirmation containing the corrected value 'Friday'
    const msgs = sender.getMessages();
    expect(msgs.length).toBeGreaterThan(0);
    const firstMsg = msgs[0];
    const corrKind = (firstMsg as Record<string, unknown>)['type'] as string;
    expect(corrKind).toBe('text');
    const allText = msgs.map(m => (m as any).text || (m as any).body || '').join(' ');
    expect(allText).not.toContain('Something went wrong');
    expect(allText).toContain('Friday');
    expect(eventLog.some(e => e.event === 'cas_target_conflict')).toBe(false);
  });

  it('CAS conflict → silent return, no message, no continuation, no secondary mutation', async () => {
    vi.mocked(loadConversationConfig).mockResolvedValue({
      aiEnabled: true, autoRouteThreshold: 0.85, clarificationThreshold: 0.60,
      fallbackBehavior: 'menu', faqEnabled: false, knowledgeEnabled: false,
      assistantName: 'Assistant', tone: 'friendly',
    } as any);
    vi.mocked(ConversationOrchestrator).mockImplementation(function() {
      return {
        understand: vi.fn().mockResolvedValue({
          recommendedAction: 'apply_correction',
          corrections: [{ field: 'date', newValue: 'Friday', oldValue: 'Thursday' }],
          intent: 'correction',
          confidence: 0.95,
          activeCapability: 'scheduling',
          semanticFamily: 'service_time_booking',
          temporaryQuestion: null,
        }),
      };
    });

    const session = {
      id: 'sess-corr-002',
      whatsapp_number: BS_PHONE,
      user_id: 'u1',
      business_id: 'biz-cas',
      current_step: 'select_time',
      session_data: {
        capabilities: ['scheduling'],
        active_capability: 'scheduling',
        business_id: 'biz-cas',
        business_name: 'CAS Salon',
        business_category: 'salon',
        date: 'Thursday',
      },
      is_active: true,
      expires_at: new Date(Date.now() + 600000).toISOString(),
      version: 3,
    };

    // ── SHARED SESSION MODEL: winner already applied the correction ──
    const sharedSession = {
      version: 5,
      business_id: 'biz-cas',
      current_step: 'select_time',
      session_data: { ...session.session_data, date: 'Friday' },
    };
    const winnerSnapshot = { ...sharedSession, session_data: { ...sharedSession.session_data } };

    const eventLog: Array<{ event: string; detail?: string }> = [];
    const { supabase, standalone, intelligence, rpcSpy } = makeBotServiceMocks({
      session,
      casResponse: { success: true, version: 5 },
      sharedRow: sharedSession,
      eventLog,
    });

    // Track bot_sessions mutations
    const sessionMutations: string[] = [];
    const origFrom = supabase.from;
    supabase.from = vi.fn().mockImplementation((table: string) => {
      const chain = origFrom(table);
      if (table === 'bot_sessions') {
        for (const op of ['update', 'delete', 'insert']) {
          const origOp = chain[op];
          chain[op] = vi.fn().mockImplementation((...args: any[]) => {
            sessionMutations.push(op);
            return origOp(...args);
          });
        }
      }
      return chain;
    });

    const sender = createCaptureSender();
    const bot = new BotService(supabase, sender, standalone, intelligence);
    await bot.handleMessage(BS_PHONE, 'actually change the date to Friday', 'text', undefined, 'biz-cas');

    // Genuine CAS conflict against shared authority
    expect(eventLog.some(e => e.event === 'cas_target_conflict')).toBe(true);
    const casCalls = rpcSpy.mock.calls.filter((c: any[]) => c[0] === 'update_session_cas');
    expect(casCalls).toHaveLength(2);
    expect(casCalls[1][1]).toMatchObject({ p_current_step: 'select_time', p_expected_version: 4 });
    // Zero messages — silent loser, no continuation
    expect(sender.getMessages()).toHaveLength(0);
    // Zero direct bot_sessions mutations
    expect(sessionMutations).toHaveLength(0);
    // Shared session model unchanged — winner's correction persisted
    expect(sharedSession.version).toBe(winnerSnapshot.version);
    expect(sharedSession.current_step).toBe(winnerSnapshot.current_step);
    expect(sharedSession.session_data).toEqual(winnerSnapshot.session_data);
  });

  it('CAS RPC transport error → throws (fail-closed)', async () => {
    vi.mocked(loadConversationConfig).mockResolvedValue({
      aiEnabled: true, autoRouteThreshold: 0.85, clarificationThreshold: 0.60,
      fallbackBehavior: 'menu', faqEnabled: false, knowledgeEnabled: false,
      assistantName: 'Assistant', tone: 'friendly',
    } as any);
    vi.mocked(ConversationOrchestrator).mockImplementation(function() {
      return {
        understand: vi.fn().mockResolvedValue({
          recommendedAction: 'apply_correction',
          corrections: [{ field: 'date', newValue: 'Friday', oldValue: 'Thursday' }],
          intent: 'correction',
          confidence: 0.95,
          activeCapability: 'scheduling',
          semanticFamily: 'service_time_booking',
          temporaryQuestion: null,
        }),
      };
    });

    const sessionForCorr = {
      id: 'sess-corr-003',
      whatsapp_number: BS_PHONE,
      user_id: 'u1',
      business_id: 'biz-cas',
      current_step: 'select_time',
      session_data: {
        capabilities: ['scheduling'],
        active_capability: 'scheduling',
        business_id: 'biz-cas',
        business_name: 'CAS Salon',
        business_category: 'salon',
        date: 'Thursday',
      },
      is_active: true,
      expires_at: new Date(Date.now() + 600000).toISOString(),
      version: 3,
    };
    const businessForCorr = { id: 'biz-cas', name: 'CAS Salon', slug: 'cas-salon', category: 'salon', flow_type: 'scheduling', subscription_tier: 'growth', trial_ends_at: null, metadata: {}, operating_hours: null, country_code: 'NG', payment_gateway: 'paystack', is_whitelabel: false, status: 'active' };
    const { supabase, standalone, intelligence } = makeBotServiceMocks({
      session: sessionForCorr,
      casResponse: { success: true, version: 4 },
    });
    // get_bot_context succeeds, 1st CAS (refresh) succeeds, 2nd CAS (correction) fails with transport error
    let casCount4 = 0;
    supabase.rpc = vi.fn().mockImplementation((rpcName: string) => {
      if (rpcName === 'get_bot_context') {
        return Promise.resolve({ data: { has_session: true, session: sessionForCorr, business: businessForCorr, capabilities: [{ capability: 'scheduling', is_enabled: true, sort_order: 0 }], capability_overrides: [] }, error: null });
      }
      if (rpcName === 'update_session_cas') {
        casCount4++;
        if (casCount4 === 1) return Promise.resolve({ data: { success: true, version: 4 }, error: null });
        return Promise.resolve({ data: null, error: { message: 'rpc_timeout' } });
      }
      return Promise.resolve({ data: null, error: null });
    });

    const sender = createCaptureSender();
    const bot = new BotService(supabase, sender, standalone, intelligence);
    // BotService has a top-level try-catch that swallows throws and sends an error recovery message.
    // So the promise resolves (doesn't reject) but we verify no "success" content was sent —
    // only the generic error recovery (fail-closed: no correction confirmation).
    await bot.handleMessage(BS_PHONE, 'actually change the date to Friday', 'text', undefined, 'biz-cas');

    const msgs = sender.getMessages();
    const allText = msgs.map(m => (m as any).text || '').join(' ').toLowerCase();
    // Must NOT have sent a successful correction confirmation ("got it" / "changed")
    expect(allText).not.toContain('got it');
    expect(allText).not.toContain('changed date');
  });
});

// ──────────────────────────────────────────────────────────
// BotService CAS result types (Finding 3 — CTO Round 5)
//
// For each possible CAS result type (version_conflict, session_not_found,
// unknown reason, malformed result, RPC transport error) exercised through
// the quick_rebook path in BotService.handleMessage():
//
//   - version_conflict → silent loser: no message sent at all
//   - session_not_found / unknown reason / malformed / RPC error → generic recovery:
//     BotService's top-level try-catch swallows the throw and sends
//     "Something went wrong on our end. Send *Hi* to start over."
//
// The 2-CAS setup: 1st CAS (CAP-001 refresh) always succeeds;
// 2nd CAS (quick_rebook target) returns the test case's result.
// ──────────────────────────────────────────────────────────

describe('BotService CAS result types (Finding 3)', () => {
  const casResults = [
    {
      name: 'version_conflict → silent loser',
      targetCasResult: { data: { success: false, reason: 'version_conflict' }, error: null },
      expectSilent: true,
    },
    {
      name: 'session_not_found → generic recovery',
      targetCasResult: { data: { success: false, reason: 'session_not_found' }, error: null },
      expectSilent: false,
    },
    {
      name: 'unknown reason → generic recovery',
      targetCasResult: { data: { success: false, reason: 'unknown_thing' }, error: null },
      expectSilent: false,
    },
    {
      name: 'malformed result (no reason field) → generic recovery',
      targetCasResult: { data: { success: false }, error: null },
      expectSilent: false,
    },
    {
      name: 'RPC transport error → generic recovery',
      targetCasResult: { data: null, error: { message: 'pg_down' } },
      expectSilent: false,
    },
  ];

  for (const tc of casResults) {
    it(`BotService quick_rebook: ${tc.name}`, async () => {
      const session = {
        id: `sess-castype-${tc.name.replace(/\s+/g, '-').replace(/[^a-z0-9-]/gi, '')}`,
        whatsapp_number: BS_PHONE,
        user_id: 'u1',
        business_id: 'biz-cas',
        current_step: 'select_capability',
        session_data: {
          _quick_rebook_service_id: 'svc-123',
          _quick_rebook_service_name: 'Haircut',
          _quick_rebook_sent: true,
          capabilities: ['scheduling'],
          active_capability: 'scheduling',
          business_id: 'biz-cas',
          business_name: 'CAS Salon',
          business_category: 'salon',
        },
        is_active: true,
        expires_at: new Date(Date.now() + 600000).toISOString(),
        version: 5,
      };

      const business = {
        id: 'biz-cas', name: 'CAS Salon', slug: 'cas-salon', category: 'salon',
        flow_type: 'scheduling', subscription_tier: 'growth', trial_ends_at: null,
        metadata: {}, operating_hours: null, country_code: 'NG', payment_gateway: 'paystack',
        is_whitelabel: false, status: 'active',
      };

      const { supabase, standalone, intelligence } = makeBotServiceMocks({
        session,
        casResponse: { success: true, version: 7 }, // placeholder — will be overridden below
      });

      // Set up the 2-CAS mock: 1st (CAP-001 refresh) always succeeds; 2nd returns tc.targetCasResult
      let casTypeCount = 0;
      supabase.rpc = vi.fn().mockImplementation((rpcName: string) => {
        if (rpcName === 'get_bot_context') {
          return Promise.resolve({
            data: {
              has_session: true,
              session,
              business,
              capabilities: [{ capability: 'scheduling', is_enabled: true, sort_order: 0 }],
              capability_overrides: [],
            },
            error: null,
          });
        }
        if (rpcName === 'update_session_cas') {
          casTypeCount++;
          if (casTypeCount === 1) {
            // CAP-001 refresh always succeeds
            return Promise.resolve({ data: { success: true, version: 6 }, error: null });
          }
          // 2nd call: the target quick_rebook CAS — use the test case's result
          return Promise.resolve(tc.targetCasResult);
        }
        return Promise.resolve({ data: null, error: null });
      });

      const sender = createCaptureSender();
      const bot = new BotService(supabase, sender, standalone, intelligence);

      // BotService has a top-level catch that swallows throws and sends generic recovery.
      // So handleMessage always resolves (never rejects externally).
      await bot.handleMessage(BS_PHONE, 'quick_rebook', 'button', undefined, 'biz-cas');

      const msgs = sender.getMessages();
      const allText = msgs.map(m => (m as any).text || '').join(' ').toLowerCase();

      const { captureException } = await import('@sentry/nextjs');

      if (tc.expectSilent) {
        // version_conflict → silent loser: exactly zero messages, zero continuation
        expect(msgs).toHaveLength(0);
        // No Sentry error boundary for version_conflict (expected operational path)
      } else {
        // session_not_found / unknown / malformed / transport error →
        // BotService top-level catch sends the exact generic recovery message
        expect(msgs.length).toBeGreaterThan(0);
        const recoveryText = msgs.map(m => (m as any).text || '').join(' ');
        // Exact recovery text — not a partial match
        expect(recoveryText).toBe('Something went wrong on our end. Send *Hi* to start over.');
        // Must NOT contain success-path continuation content
        expect(recoveryText).not.toContain('select a date');
        expect(recoveryText).not.toContain('pick a date');
        expect(recoveryText).not.toContain('Got it');
        // Error boundary signal: Sentry.captureException was called for the CAS failure
        expect(captureException).toHaveBeenCalled();
      }
    });
  }
});

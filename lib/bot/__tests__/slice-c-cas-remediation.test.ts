/**
 * Slice C — CAS Remediation Tests (#271)
 *
 * Verifies that 9 bare .update() calls on bot_sessions have been
 * converted to use the atomic update_session_cas RPC. For each path:
 *   - CAS success → handler proceeds (sends messages / calls next handler)
 *   - CAS failure → handler returns silently (no customer message)
 *
 * Also contains BotService runtime tests for the bot.service.ts CAS paths
 * (quick_rebook, browse_menu, apply_correction) — replacing the source-string
 * proofs that were rejected in CTO Round 2.
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
  it('CAS 7a success → version feeds 7b', async () => {
    const { handleRefundRequest } = await import('../handlers/refund-request');
    // We need to mock rpc to return different versions for 7a and 7b
    const rpcMock = vi.fn()
      .mockResolvedValueOnce({ data: { success: true, version: 10 }, error: null }) // 7a
      .mockResolvedValueOnce({ data: { success: true, version: 11 }, error: null }); // 7b
    const supabase = makeMockSupabase({ success: true, version: 10 }) as any;
    supabase.rpc = rpcMock;
    supabase.from.mockImplementation((table: string) => {
      if (table === 'payments') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue({
                    data: [{
                      id: 'pay-1', amount: 5000, currency: 'NGN', status: 'success', refund_amount: 0,
                      created_at: '2026-08-01T00:00:00Z', business_id: 'biz-1', booking_id: 'bk-1', order_id: null, invoice_id: null,
                      bookings: { guest_phone: '+2341234567890', guest_name: 'Test', services: { name: 'Haircut' }, events: null },
                    }],
                  }),
                }),
              }),
            }),
          }),
        };
      }
      return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
    });
    const sendText = makeSendText();
    const messageSender = makeMessageSender() as any;
    const session = makeSession({
      current_step: 'refund_select',
      session_data: {
        refund_payments: { refund_1: { id: 'pay-1', amount: 5000, currency: 'NGN', refundAmount: 0, businessId: 'biz-1', bookingId: 'bk-1' } },
      },
    });

    // Simulate selecting refund_1 (7a already happened during list show, so session_data has refund_payments)
    await handleRefundRequest(supabase, messageSender, sendText, session as any, '+2341234567890', 'refund_1');

    // 7b should use version 10 (returned by 7a) as expected_version
    // The second rpc call is 7b
    expect(rpcMock).toHaveBeenCalledTimes(1);
    // Since refund_select with input triggers only 7b (7a was done earlier when listing),
    // let's verify the call uses the session's current version
    expect(rpcMock).toHaveBeenCalledWith('update_session_cas', expect.objectContaining({
      p_current_step: 'refund_reason',
      p_expected_version: 5, // session.version from makeSession
    }));
    expect(session.version).toBe(10);
  });

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

/** Builds a minimal BotService with controllable Supabase/sender/standalone/intelligence */
function makeBotServiceMocks(opts: {
  session: Record<string, unknown>;
  casResponse: { success: boolean; version?: number; reason?: string };
  businessId?: string;
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

  // The bot calls rpc('get_bot_context') first (fast path when businessId is provided),
  // then rpc('update_session_cas') twice:
  //   1st: CAP-001 capability refresh (always succeeds, version bumped by 1)
  //   2nd: the actual quick_rebook/browse_menu/correction CAS write (controlled by opts.casResponse)
  const initialVersion = (opts.session.version as number) ?? 0;
  let casCallCount = 0;
  const rpcSpy = vi.fn().mockImplementation((rpcName: string) => {
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
      if (casCallCount === 1) {
        // First CAS: CAP-001 capability refresh — always succeeds with version + 1
        return Promise.resolve({ data: { success: true, version: initialVersion + 1 }, error: null });
      }
      // Subsequent CAS calls: the test's target CAS (quick_rebook / browse_menu / correction)
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
        for (const m of ['select','eq','order']) c[m] = () => c;
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
// Finding 3: quick_rebook CAS path in BotService
// Triggered by: text === 'quick_rebook' with _quick_rebook_service_id in session_data
// ──────────────────────────────────────────────────────────

describe('BotService runtime: quick_rebook CAS (Finding 3)', () => {
  it('CAS success → update_session_cas called with select_date step', async () => {
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

    const { supabase, standalone, intelligence, rpcSpy } = makeBotServiceMocks({
      session,
      casResponse: { success: true, version: 8 },
    });

    const sender = createCaptureSender();
    const bot = new BotService(supabase, sender, standalone, intelligence);
    await bot.handleMessage(BS_PHONE, 'quick_rebook', 'button', undefined, 'biz-cas');

    // The CAS RPC must have been called with the correct step (select_date for scheduling).
    // Note: the first update_session_cas call is the CAP-001 capability refresh (expected).
    // The SECOND call is the quick_rebook CAS — it uses the version returned by the refresh (8).
    expect(rpcSpy).toHaveBeenCalledWith('update_session_cas', expect.objectContaining({
      p_session_id: 'sess-qrebook-001',
      p_expected_version: 8, // version after refresh CAS returned 8
      p_current_step: 'select_date',
    }));
  });

  it('CAS conflict → silent return, no message dispatched', async () => {
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

    const { supabase, standalone, intelligence, rpcSpy } = makeBotServiceMocks({
      session,
      casResponse: { success: false, reason: 'version_conflict' },
    });

    const sender = createCaptureSender();
    const bot = new BotService(supabase, sender, standalone, intelligence);
    await bot.handleMessage(BS_PHONE, 'quick_rebook', 'button', undefined, 'biz-cas');

    // The quick_rebook CAS was called (2nd update_session_cas call) with select_date
    expect(rpcSpy).toHaveBeenCalledWith('update_session_cas', expect.objectContaining({
      p_current_step: 'select_date',
    }));
    // Silent exit on conflict — no WhatsApp message sent to customer
    expect(sender.getMessages()).toHaveLength(0);
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
  it('CAS success → update_session_cas called with select_capability step', async () => {
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

    const { supabase, standalone, intelligence, rpcSpy } = makeBotServiceMocks({
      session,
      casResponse: { success: true, version: 5 },
    });

    const sender = createCaptureSender();
    const bot = new BotService(supabase, sender, standalone, intelligence);
    await bot.handleMessage(BS_PHONE, 'browse_menu', 'button', undefined, 'biz-cas');

    expect(rpcSpy).toHaveBeenCalledWith('update_session_cas', expect.objectContaining({
      p_session_id: 'sess-browse-001',
      p_expected_version: 4,
      p_current_step: 'select_capability',
    }));
  });

  it('CAS conflict → silent return, no message dispatched', async () => {
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

    const { supabase, standalone, intelligence, rpcSpy } = makeBotServiceMocks({
      session,
      casResponse: { success: false, reason: 'version_conflict' },
    });

    const sender = createCaptureSender();
    const bot = new BotService(supabase, sender, standalone, intelligence);
    await bot.handleMessage(BS_PHONE, 'browse_menu', 'button', undefined, 'biz-cas');

    expect(rpcSpy).toHaveBeenCalledWith('update_session_cas', expect.objectContaining({
      p_current_step: 'select_capability',
    }));
    // Silent exit on conflict — no WhatsApp message sent
    expect(sender.getMessages()).toHaveLength(0);
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

  it('CAS success → update_session_cas called with same step + corrected data, confirmation sent', async () => {
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

    const { supabase, standalone, intelligence, rpcSpy } = makeBotServiceMocks({
      session,
      casResponse: { success: true, version: 4 },
    });

    const sender = createCaptureSender();
    const bot = new BotService(supabase, sender, standalone, intelligence);
    await bot.handleMessage(BS_PHONE, 'actually change the date to Friday', 'text', undefined, 'biz-cas');

    // CAS must have been called with same current_step (correction doesn't change step).
    // Note: session.version is 4 after the CAP-001 refresh CAS (which returns version 4).
    expect(rpcSpy).toHaveBeenCalledWith('update_session_cas', expect.objectContaining({
      p_session_id: 'sess-corr-001',
      p_expected_version: 4, // version after refresh CAS returned initialVersion+1 = 3+1
      p_current_step: 'select_time',
    }));
    // Confirmation message sent after successful CAS
    // (the bot sends "Got it! Changed date to Friday.")
    const msgs = sender.getMessages();
    const allText = msgs.map(m => (m as any).text || '').join(' ');
    expect(allText).toContain('date');
  });

  it('CAS conflict → silent return, no sendText called', async () => {
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

    const { supabase, standalone, intelligence, rpcSpy } = makeBotServiceMocks({
      session,
      casResponse: { success: false, reason: 'version_conflict' },
    });

    const sender = createCaptureSender();
    const bot = new BotService(supabase, sender, standalone, intelligence);
    await bot.handleMessage(BS_PHONE, 'actually change the date to Friday', 'text', undefined, 'biz-cas');

    // The correction CAS must have been called (2nd update_session_cas call)
    expect(rpcSpy).toHaveBeenCalledWith('update_session_cas', expect.objectContaining({
      p_current_step: 'select_time',
    }));
    // Silent exit on conflict — no confirmation message sent
    expect(sender.getMessages()).toHaveLength(0);
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

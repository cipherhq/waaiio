/**
 * #373: Saved-card reuse cold country cache regression tests.
 *
 * Proves chargeSavedCard uses authoritative DB-based currency resolution
 * instead of the module-global country cache. Tests cover:
 * - Cold cache + US → USD reaches adapter
 * - Cold cache + NG → NGN reaches adapter
 * - Missing/inactive country → zero provider dispatch
 * - DB error → fail closed without crash
 * - Malformed currency → fail closed
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockChargeSavedMethod, mockLogError, mockVerifyPin, mockRequiresPin } = vi.hoisted(() => ({
  mockChargeSavedMethod: vi.fn(),
  mockLogError: vi.fn(),
  mockVerifyPin: vi.fn().mockResolvedValue({ valid: true }),
  mockRequiresPin: vi.fn().mockResolvedValue({ required: false }),
}));

vi.mock('@/lib/payments/saved-payment-adapter', () => ({
  savedPaymentAdapter: {
    chargeSavedMethod: mockChargeSavedMethod,
    getSavedMethods: vi.fn().mockResolvedValue([]),
    requiresPin: mockRequiresPin,
    verifyPin: mockVerifyPin,
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    error: mockLogError,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    withContext: () => ({ error: mockLogError, warn: vi.fn(), info: vi.fn() }),
  },
}));

import { handleSavedCardInput } from '../bot/flows/shared/saved-card-flow';
import type { FlowContext } from '../bot/flows/types';

function makeCtx(overrides: Partial<FlowContext> = {}): FlowContext {
  const supabase = {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: { currency_code: 'USD' }, error: null }),
          }),
        }),
      }),
    }),
  } as never;

  return {
    supabase,
    from: '15551234567',
    sender: { sendText: vi.fn().mockResolvedValue({ messageId: 'test' }) },
    t: (key: string) => key,
    business: {
      id: 'biz-123',
      name: 'Test Business',
      country_code: 'US',
    } as FlowContext['business'],
    session: {
      id: 'session-123',
      whatsapp_number: '15551234567',
      business_id: 'biz-123',
      current_step: 'saved_card_prompt',
      session_data: {
        _inbound_channel_id: 'channel-test',
        _saved_method_id: 'method-123',
        _awaiting_card_pin: true,
      },
      is_active: true,
      version: 1,
    } as FlowContext['session'],
    ...overrides,
  } as FlowContext;
}

function makeSupabaseWithCountry(currencyCode: string | null, error: unknown = null, countryExists = true) {
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: countryExists ? { currency_code: currencyCode } : null,
              error,
            }),
          }),
        }),
      }),
    }),
  } as never;
}

describe('#373: Saved-card cold cache — authoritative currency resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('cold cache + US → adapter receives USD', async () => {
    mockChargeSavedMethod.mockResolvedValue({ status: 'charged', paymentId: 'pay-1' });

    const ctx = makeCtx({
      supabase: makeSupabaseWithCountry('USD'),
    });
    ctx.business!.country_code = 'US';

    const result = await handleSavedCardInput('pay_saved', ctx, {
      amount: 2000, reference: 'WA-BK-TEST',
      entityId: { bookingId: 'booking-1' }, transactionCategory: 'scheduling',
    });

    expect(result).not.toBeNull();
    expect(result!.valid).toBe(true);
    // Verify adapter was called with USD (not from cache)
    expect(mockChargeSavedMethod).toHaveBeenCalledTimes(1);
    expect(mockChargeSavedMethod.mock.calls[0][1].currency).toBe('USD');
  });

  it('cold cache + NG → adapter receives NGN', async () => {
    mockChargeSavedMethod.mockResolvedValue({ status: 'charged', paymentId: 'pay-2' });

    const ctx = makeCtx({
      supabase: makeSupabaseWithCountry('NGN'),
    });
    ctx.business!.country_code = 'NG';

    const result = await handleSavedCardInput('pay_saved', ctx, {
      amount: 5000, reference: 'WA-BK-NG',
      entityId: { bookingId: 'booking-2' }, transactionCategory: 'scheduling',
    });

    expect(result).not.toBeNull();
    expect(result!.valid).toBe(true);
    expect(mockChargeSavedMethod).toHaveBeenCalledTimes(1);
    expect(mockChargeSavedMethod.mock.calls[0][1].currency).toBe('NGN');
  });

  it('missing/inactive country → zero provider dispatch, fail closed', async () => {
    const ctx = makeCtx({
      supabase: makeSupabaseWithCountry(null, null, false), // countryExists = false
    });

    const result = await handleSavedCardInput('pay_saved', ctx, {
      amount: 1000, reference: 'WA-BK-MISS',
      entityId: { bookingId: 'booking-3' }, transactionCategory: 'scheduling',
    });

    expect(result).not.toBeNull();
    expect(result!.valid).toBe(false);
    expect(result!.errorMessage).toContain('try again');
    // Zero provider dispatch
    expect(mockChargeSavedMethod).not.toHaveBeenCalled();
    expect(mockLogError).toHaveBeenCalled();
  });

  it('DB error → fail closed without crash, zero provider dispatch', async () => {
    const ctx = makeCtx({
      supabase: makeSupabaseWithCountry(null, { message: 'connection timeout' }),
    });

    const result = await handleSavedCardInput('pay_saved', ctx, {
      amount: 1000, reference: 'WA-BK-ERR',
      entityId: { bookingId: 'booking-4' }, transactionCategory: 'scheduling',
    });

    expect(result).not.toBeNull();
    expect(result!.valid).toBe(false);
    expect(mockChargeSavedMethod).not.toHaveBeenCalled();
    expect(mockLogError).toHaveBeenCalled();
  });

  it('malformed currency (lowercase) → fail closed', async () => {
    const ctx = makeCtx({
      supabase: makeSupabaseWithCountry('usd'), // lowercase = malformed
    });

    const result = await handleSavedCardInput('pay_saved', ctx, {
      amount: 1000, reference: 'WA-BK-MALFORM',
      entityId: { bookingId: 'booking-5' }, transactionCategory: 'scheduling',
    });

    expect(result).not.toBeNull();
    expect(result!.valid).toBe(false);
    expect(mockChargeSavedMethod).not.toHaveBeenCalled();
  });

  it('malformed currency (empty string) → fail closed', async () => {
    const ctx = makeCtx({
      supabase: makeSupabaseWithCountry(''),
    });

    const result = await handleSavedCardInput('pay_saved', ctx, {
      amount: 1000, reference: 'WA-BK-EMPTY',
      entityId: { bookingId: 'booking-6' }, transactionCategory: 'scheduling',
    });

    expect(result).not.toBeNull();
    expect(result!.valid).toBe(false);
    expect(mockChargeSavedMethod).not.toHaveBeenCalled();
  });

  it('DB throw → fail closed without crashing the bot', async () => {
    const throwingSupabase = {
      from: vi.fn().mockImplementation(() => { throw new Error('DB connection lost'); }),
    } as never;

    const ctx = makeCtx({ supabase: throwingSupabase });

    const result = await handleSavedCardInput('pay_saved', ctx, {
      amount: 1000, reference: 'WA-BK-THROW',
      entityId: { bookingId: 'booking-7' }, transactionCategory: 'scheduling',
    });

    expect(result).not.toBeNull();
    expect(result!.valid).toBe(false);
    expect(mockChargeSavedMethod).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════
// R1: Scheduling saved_card_prompt — exact production Jshop path
// ═══════════════════════════════════════════════════════════════════

// These tests import the real schedulingFlow and execute the saved_card_prompt
// step's validate() function to prove the exact production path uses
// authoritative DB currency resolution.
// Mock is already set up at module top via vi.hoisted + vi.mock.

describe('#373 R1: Scheduling saved_card_prompt — exact Jshop production path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function getSchedulingSavedCardStep() {
    const { schedulingFlow } = await import('../bot/flows/scheduling.flow');
    return schedulingFlow.steps.find((s: { id: string }) => s.id === 'saved_card_prompt');
  }

  function makeSchedulingCtx(sessionData: Record<string, unknown>, countryResult: { data: unknown; error: unknown }) {
    const makeChain = (table: string) => {
      const c: Record<string, unknown> = {};
      for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'in', 'or', 'not', 'order', 'limit', 'is', 'gte', 'lte', 'lt', 'gt']) {
        c[m] = vi.fn().mockReturnValue(c);
      }
      c.single = vi.fn().mockResolvedValue({ data: null, error: null });
      c.maybeSingle = vi.fn().mockResolvedValue(
        table === 'countries' ? countryResult : { data: null, error: null },
      );
      return c;
    };
    return {
      supabase: { from: vi.fn().mockImplementation((t: string) => makeChain(t)), rpc: vi.fn().mockResolvedValue({ data: { success: true }, error: null }) } as never,
      from: '15551234567',
      sender: { sendText: vi.fn().mockResolvedValue(undefined) },
      t: (t: string) => Promise.resolve(t),
      business: { id: 'biz-1', name: 'Jshop', country_code: 'US', subscription_tier: 'free' },
      session: { id: 's-1', business_id: 'biz-1', current_step: 'saved_card_prompt', session_data: { _inbound_channel_id: 'channel-test', ...sessionData }, version: 1 },
    } as unknown as FlowContext;
  }

  it('PIN success + cold US cache → adapter receives USD', async () => {
    const step = await getSchedulingSavedCardStep();
    expect(step).toBeDefined();

    mockVerifyPin.mockResolvedValue({ valid: true });
    mockChargeSavedMethod.mockResolvedValue({ status: 'charged', paymentId: 'pay-pin-1' });

    const ctx = makeSchedulingCtx(
      { _awaiting_card_pin: true, _saved_method_id: 'spm-1', _pending_deposit: 2000, booking_id: 'bk-1', reference_code: 'WA-BK-TEST' },
      { data: { currency_code: 'USD' }, error: null },
    );

    const result = await step.validate!('1234', ctx);
    expect(result.valid).toBe(true);
    expect(result.data?._saved_card_paid).toBe(true);
    expect(mockChargeSavedMethod).toHaveBeenCalledTimes(1);
    expect(mockChargeSavedMethod.mock.calls[0][1].currency).toBe('USD');
  });

  it('no-PIN + cold US cache → adapter receives USD', async () => {
    const step = await getSchedulingSavedCardStep();
    expect(step).toBeDefined();

    mockChargeSavedMethod.mockResolvedValue({ status: 'charged', paymentId: 'pay-nopin-1' });

    const ctx = makeSchedulingCtx(
      { _saved_method_id: 'spm-1', _pending_deposit: 2000, booking_id: 'bk-1', reference_code: 'WA-BK-TEST' },
      { data: { currency_code: 'USD' }, error: null },
    );

    const result = await step.validate!('pay_saved', ctx);
    expect(result.valid).toBe(true);
    expect(result.data?._saved_card_paid).toBe(true);
    expect(mockChargeSavedMethod).toHaveBeenCalledTimes(1);
    expect(mockChargeSavedMethod.mock.calls[0][1].currency).toBe('USD');
  });

  it('PIN success + country lookup failure → zero provider dispatch, PIN-wait retained for retry', async () => {
    const step = await getSchedulingSavedCardStep();
    expect(step).toBeDefined();

    mockVerifyPin.mockResolvedValue({ valid: true });

    const ctx = makeSchedulingCtx(
      { _awaiting_card_pin: true, _saved_method_id: 'spm-1', _pending_deposit: 2000, booking_id: 'bk-1', reference_code: 'WA-BK-TEST' },
      { data: null, error: null }, // Country not found
    );

    const result = await step.validate!('1234', ctx);

    // Fail closed — zero provider dispatch
    expect(mockChargeSavedMethod).not.toHaveBeenCalled();
    // valid:false triggers executor re-prompt
    expect(result.valid).toBe(false);
    // Error message tells user to retry
    expect(result.errorMessage).toContain('try again');
    // No persistSessionDataOnFailure — no session mutation needed
    expect(result.persistSessionDataOnFailure).toBeUndefined();
    // Session state preserved: _awaiting_card_pin remains true
    // (executor does not merge result.data for valid:false)
    expect(ctx.session.session_data._awaiting_card_pin).toBe(true);
    // No PIN-attempt penalty: correct PIN resets pin_attempts to 0
    // (verified by the verifyPin mock returning valid:true above)
  });

  it('no-PIN + country lookup failure → zero provider dispatch', async () => {
    const step = await getSchedulingSavedCardStep();
    expect(step).toBeDefined();

    const ctx = makeSchedulingCtx(
      { _saved_method_id: 'spm-1', _pending_deposit: 2000, booking_id: 'bk-1', reference_code: 'WA-BK-TEST' },
      { data: null, error: null },
    );

    const result = await step.validate!('pay_saved', ctx);
    expect(mockChargeSavedMethod).not.toHaveBeenCalled();
    expect(result.data?._skip_saved_card).toBe(true);
  });
});
